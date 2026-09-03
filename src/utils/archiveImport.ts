import { Conversation, MessageMedia } from '../types';
import { parseUploadedJson } from './parser';
import { saveAssetToIdb } from './storage';
import {
  isGrokBackendWrapped,
  parseGrokBackendJson,
  parseFlatGrokResponses,
  AssetResolver,
} from './grokBackend';
import { decodeAssetFile } from './assetDecode';

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp|svg|avif)$/i;
const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const TITLE_KEYS = [
  'title',
  'name',
  'summary',
  'conversation_title',
  'conversationTitle',
  'display_name',
  'displayName',
  'subject',
] as const;

export interface ArchiveImportResult {
  conversations: Conversation[];
  stats: {
    jsonFiles: number;
    messageRecords: number;
    titleHits: number;
    assetsIndexed: number;
    assetsDecoded: number;
    assetsLinked: number;
    messagesWithMedia: number;
    format: string;
    branchGroups: number;
  };
}

/** Raw files keyed by folder id / path segments before decoding */
export interface AssetIndex {
  /** folder-id → preferred File (content or preview-image) */
  byFolderId: Map<string, File>;
  /** all keys → file */
  byKey: Map<string, File>;
}

export interface MaterializedAsset {
  blob: Blob;
  mime: string;
  kind: 'image' | 'file';
  assetKey: string;
  fileName: string;
  blobUrl: string;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '');
}

function isImageFile(file: File, path: string): boolean {
  if (file.type.startsWith('image/')) return true;
  return IMAGE_EXT.test(path) || IMAGE_EXT.test(file.name);
}

function isJsonFile(file: File, path: string): boolean {
  return (
    file.type === 'application/json' ||
    path.toLowerCase().endsWith('.json') ||
    file.name.toLowerCase().endsWith('.json')
  );
}

function scoreAssetFile(file: File, path: string): number {
  const name = file.name.toLowerCase();
  // Prefer real images / preview for display
  if (name === 'preview-image' || name.startsWith('preview')) return 100;
  if (isImageFile(file, path)) return 90;
  if (name === 'content') return 50;
  return 10;
}

/** Build multi-key lookup for asset files in the export folder. */
export function buildAssetIndex(files: File[]): AssetIndex {
  const byKey = new Map<string, File>();
  const byFolderId = new Map<string, File>();
  const folderScore = new Map<string, number>();

  for (const file of files) {
    const rel = normalizePath(
      (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
    );

    const underAssetServer =
      rel.toLowerCase().includes('prod-mc-asset-server') ||
      rel.toLowerCase().includes('asset-server');

    if (!isImageFile(file, rel) && !underAssetServer) continue;

    const keys = new Set<string>();
    keys.add(rel);
    keys.add(rel.toLowerCase());
    keys.add(file.name);
    keys.add(file.name.toLowerCase());

    const parts = rel.split('/').filter(Boolean);
    for (const part of parts) {
      keys.add(part);
      keys.add(part.toLowerCase());
    }

    let folderId: string | null = null;
    const assetIdx = parts.findIndex(
      (p) => p.toLowerCase().includes('asset-server') || p === 'prod-mc-asset-server'
    );
    if (assetIdx >= 0 && parts[assetIdx + 1]) {
      folderId = parts[assetIdx + 1];
    } else if (parts.length >= 2) {
      folderId = parts[parts.length - 2];
    }

    const score = scoreAssetFile(file, rel);

    if (folderId) {
      keys.add(folderId);
      keys.add(folderId.toLowerCase());
      const prev = folderScore.get(folderId) ?? -1;
      if (score >= prev) {
        byFolderId.set(folderId, file);
        byFolderId.set(folderId.toLowerCase(), file);
        folderScore.set(folderId, score);
        folderScore.set(folderId.toLowerCase(), score);
      }
    }

    const uuids = rel.match(UUID_RE) || [];
    for (const u of uuids) {
      keys.add(u);
      keys.add(u.toLowerCase());
      const prev = folderScore.get(u.toLowerCase()) ?? -1;
      if (score >= prev) {
        byFolderId.set(u, file);
        byFolderId.set(u.toLowerCase(), file);
        folderScore.set(u.toLowerCase(), score);
      }
    }

    for (const key of keys) {
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, file);
      } else if (scoreAssetFile(file, rel) > scoreAssetFile(existing, existing.name)) {
        byKey.set(key, file);
      }
    }
  }

  return { byKey, byFolderId };
}

/**
 * Decode all unique asset files once and create typed blob URLs.
 * Call this BEFORE parsing messages so resolve() returns displayable URLs.
 */
export async function materializeAssets(
  index: AssetIndex
): Promise<{
  byId: Map<string, MaterializedAsset>;
  objectUrls: string[];
  decodedCount: number;
}> {
  const byId = new Map<string, MaterializedAsset>();
  const objectUrls: string[] = [];
  const decodedFiles = new Map<File, MaterializedAsset>();

  // Unique files from folder map
  const entries = [...index.byFolderId.entries()];
  // Prefer lowercase keys only once
  const seenKeys = new Set<string>();

  for (const [key, file] of entries) {
    const norm = key.toLowerCase();
    if (seenKeys.has(norm) && byId.has(norm)) continue;
    seenKeys.add(norm);

    let mat = decodedFiles.get(file);
    if (!mat) {
      try {
        const decoded = await decodeAssetFile(file);
        const blobUrl = URL.createObjectURL(decoded.blob);
        objectUrls.push(blobUrl);
        mat = {
          blob: decoded.blob,
          mime: decoded.mime,
          kind: decoded.kind,
          assetKey: norm,
          fileName: file.name,
          blobUrl,
        };
        decodedFiles.set(file, mat);
        // Persist image blobs for rehydrate
        if (decoded.kind === 'image') {
          try {
            await saveAssetToIdb(norm, decoded.blob);
          } catch {
            /* non-fatal */
          }
        }
      } catch {
        continue;
      }
    }

    // Index under this key and original folder id variants
    byId.set(norm, { ...mat, assetKey: norm });
    byId.set(key, { ...mat, assetKey: norm });
  }

  // Also materialize any byKey files not already covered (loose images)
  for (const [key, file] of index.byKey) {
    const norm = key.toLowerCase();
    if (byId.has(norm)) continue;
    if (decodedFiles.has(file)) {
      const mat = decodedFiles.get(file)!;
      byId.set(norm, { ...mat, assetKey: mat.assetKey });
      continue;
    }
    try {
      const decoded = await decodeAssetFile(file);
      if (decoded.kind !== 'image') continue;
      const blobUrl = URL.createObjectURL(decoded.blob);
      objectUrls.push(blobUrl);
      const mat: MaterializedAsset = {
        blob: decoded.blob,
        mime: decoded.mime,
        kind: decoded.kind,
        assetKey: norm,
        fileName: file.name,
        blobUrl,
      };
      decodedFiles.set(file, mat);
      byId.set(norm, mat);
      try {
        await saveAssetToIdb(norm, decoded.blob);
      } catch {
        /* ignore */
      }
    } catch {
      /* ignore */
    }
  }

  return {
    byId,
    objectUrls,
    decodedCount: [...decodedFiles.values()].filter((m) => m.kind === 'image').length,
  };
}

export function createAssetResolver(
  materialized: Map<string, MaterializedAsset>
): AssetResolver {
  const assetIds = [
    ...new Set(
      [...materialized.keys()].filter((k) => k.length >= 8 && !k.includes('/'))
    ),
  ];

  return {
    assetIds,
    resolve(ref: string): MessageMedia | null {
      if (!ref) return null;
      const cleaned = ref.trim().replace(/^["']|["']$/g, '');
      if (!cleaned) return null;

      if (/^https?:\/\//i.test(cleaned)) {
        // Try local id inside URL first
        const uuidMatch = cleaned.match(
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
        );
        if (uuidMatch) {
          const local = materialized.get(uuidMatch[0].toLowerCase());
          if (local && local.kind === 'image') {
            return {
              id: local.assetKey,
              kind: 'image',
              url: local.blobUrl,
              assetKey: local.assetKey,
              fileName: local.fileName,
              alt: 'Generated image',
            };
          }
        }
        return {
          id: cleaned,
          kind: 'image',
          url: cleaned,
          alt: 'Generated image',
        };
      }

      const candidates = [
        cleaned,
        cleaned.toLowerCase(),
        cleaned.split('/').filter(Boolean).pop() || '',
      ].filter(Boolean);

      const uuidMatch = cleaned.match(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
      );
      if (uuidMatch) candidates.push(uuidMatch[0], uuidMatch[0].toLowerCase());

      for (const c of candidates) {
        const mat = materialized.get(c) || materialized.get(c.toLowerCase());
        if (mat && mat.kind === 'image') {
          return {
            id: mat.assetKey,
            kind: 'image',
            url: mat.blobUrl,
            assetKey: mat.assetKey,
            fileName: mat.fileName,
            alt: 'Generated image',
          };
        }
      }
      return null;
    },
  };
}

function countBranchGroups(conversations: Conversation[]): number {
  let n = 0;
  for (const c of conversations) {
    const seen = new Set<string>();
    for (const m of c.messages) {
      if (m.branchCount && m.branchCount > 1 && m.siblingGroupId && !seen.has(m.siblingGroupId)) {
        seen.add(m.siblingGroupId);
        n++;
      }
    }
  }
  return n;
}

function countMediaStats(conversations: Conversation[]): {
  assetsLinked: number;
  messagesWithMedia: number;
} {
  let assetsLinked = 0;
  let messagesWithMedia = 0;
  for (const c of conversations) {
    for (const m of c.messages) {
      if (m.media && m.media.length > 0) {
        messagesWithMedia++;
        for (const media of m.media) {
          if (media.url) assetsLinked++;
        }
      }
    }
  }
  return { assetsLinked, messagesWithMedia };
}

function extractTitle(obj: Record<string, unknown>): string | null {
  for (const k of TITLE_KEYS) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Import a full Grok/X export folder (File list from webkitdirectory).
 */
export async function importExportFolder(files: File[]): Promise<ArchiveImportResult> {
  const jsonFiles: { path: string; file: File }[] = [];
  const allFiles = [...files];

  for (const file of allFiles) {
    const rel = normalizePath(
      (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
    );
    if (isJsonFile(file, rel)) {
      jsonFiles.push({ path: rel, file });
    }
  }

  // 1) Index + materialize assets BEFORE parsing messages
  const assetIndex = buildAssetIndex(allFiles);
  const { byId: materialized, decodedCount } = await materializeAssets(assetIndex);
  const resolver = createAssetResolver(materialized);

  // Prefer prod-grok-backend.json
  const sortedJson = [...jsonFiles].sort((a, b) => {
    const score = (p: string) => {
      const l = p.toLowerCase();
      if (l.includes('prod-grok-backend')) return 100;
      if (l.includes('grok') && l.includes('backend')) return 90;
      if (l.includes('grok')) return 50;
      return 0;
    };
    return score(b.path) - score(a.path);
  });

  let conversations: Conversation[] = [];
  let format = 'unknown';
  let messageRecords = 0;
  let titleHits = 0;

  // 1) Try native wrapped Grok backend format first
  for (const { path, file } of sortedJson) {
    let text: string;
    try {
      text = await file.text();
    } catch {
      continue;
    }
    if (!text.trim()) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }

    if (isGrokBackendWrapped(parsed)) {
      conversations = parseGrokBackendJson(parsed, resolver);
      format = `grok-backend-wrapped (${path.split('/').pop()})`;
      messageRecords = conversations.reduce((a, c) => a + c.messages.length, 0);
      titleHits = conversations.filter((c) => c.titleSource === 'export').length;
      break;
    }
  }

  // 2) Flat Grok messages
  if (conversations.length === 0) {
    const titleByConvId = new Map<string, string>();
    const flatRows: Record<string, unknown>[] = [];

    for (const { path, file } of sortedJson) {
      const lower = path.toLowerCase();
      if (
        sortedJson.some((j) => j.path.toLowerCase().includes('grok')) &&
        (lower.includes('billing') || lower.includes('auth'))
      ) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(await file.text());
      } catch {
        continue;
      }

      const stack: unknown[] = [parsed];
      while (stack.length) {
        const cur = stack.pop();
        if (!cur) continue;
        if (Array.isArray(cur)) {
          for (const x of cur) stack.push(x);
          continue;
        }
        if (typeof cur !== 'object') continue;
        const obj = cur as Record<string, unknown>;

        if (obj.conversation && typeof obj.conversation === 'object') {
          const c = obj.conversation as Record<string, unknown>;
          const id = c.id ?? c._id;
          const title = extractTitle(c);
          if (id != null && title) titleByConvId.set(String(id), title);
        }

        const title = extractTitle(obj);
        const id = obj.id ?? obj._id ?? obj.conversation_id;
        if (title && id != null && (obj.responses || obj.messages || !('sender' in obj))) {
          titleByConvId.set(String(id), title);
        }

        if (
          ('sender' in obj || 'role' in obj) &&
          ('message' in obj ||
            'content' in obj ||
            'generated_image_urls' in obj ||
            'file_attachments' in obj ||
            'card_attachments_json' in obj)
        ) {
          flatRows.push(obj);
        }

        for (const v of Object.values(obj)) {
          if (v && typeof v === 'object') stack.push(v);
        }
      }
    }

    if (flatRows.length > 0) {
      conversations = parseFlatGrokResponses(flatRows, resolver, titleByConvId);
      format = 'grok-flat-responses';
      messageRecords = flatRows.length;
      titleHits = conversations.filter((c) => c.titleSource === 'export').length;
    }
  }

  // 3) Fallback generic
  if (conversations.length === 0) {
    for (const { path, file } of sortedJson) {
      if (!path.toLowerCase().includes('grok') && sortedJson.length > 1) continue;
      try {
        const parsed = JSON.parse(await file.text());
        conversations = parseUploadedJson(parsed);
        if (conversations.length > 0) {
          format = `generic (${path.split('/').pop()})`;
          messageRecords = conversations.reduce((a, c) => a + c.messages.length, 0);
          // Best-effort: deep-link assets into messages that lack media
          conversations = attachAssetsByDeepScan(conversations, resolver);
          break;
        }
      } catch {
        /* skip */
      }
    }
  }

  const { assetsLinked, messagesWithMedia } = countMediaStats(conversations);

  return {
    conversations,
    stats: {
      jsonFiles: jsonFiles.length,
      messageRecords,
      titleHits,
      assetsIndexed: assetIndex.byFolderId.size,
      assetsDecoded: decodedCount,
      assetsLinked,
      messagesWithMedia,
      format,
      branchGroups: countBranchGroups(conversations),
    },
  };
}

/** For generic parse path: attach local assets when ids appear in message content/json fields */
function attachAssetsByDeepScan(
  conversations: Conversation[],
  resolver: AssetResolver
): Conversation[] {
  return conversations.map((conv) => ({
    ...conv,
    messages: conv.messages.map((m) => {
      if (m.media && m.media.length > 0) return m;
      const found: MessageMedia[] = [];
      const seen = new Set<string>();
      const blob = `${m.content || ''} ${m.id || ''}`;
      for (const id of resolver.assetIds) {
        if (blob.toLowerCase().includes(id.toLowerCase())) {
          const r = resolver.resolve(id);
          if (r && !seen.has(r.id)) {
            seen.add(r.id);
            found.push(r);
          }
        }
      }
      return found.length ? { ...m, media: found } : m;
    }),
  }));
}

export async function importFileList(files: FileList | File[]): Promise<ArchiveImportResult> {
  return importExportFolder(Array.from(files));
}
