/**
 * Retry downloading remote (https) image URLs into IndexedDB + blob: URLs.
 * Success → save permanently. Failure → leave that media entry unchanged (except fetchStatus).
 */

import { Conversation, MessageMedia } from '../types';
import { saveAssetToIdb } from './storage';
import { sniffMime, extractAssetIdsFromString } from './assetDecode';

export type RemoteDownloadStats = {
  candidates: number;
  saved: number;
  failed: number;
  cors: number;
  http: number;
  skipped: number;
};

export type DownloadProgress = {
  done: number;
  total: number;
  currentUrl?: string;
};

type Candidate = {
  convIndex: number;
  msgIndex: number;
  mediaIndex: number;
  url: string;
};

const FETCH_TIMEOUT_MS = 18_000;
const CONCURRENCY = 3;

function isRemoteUrl(s: string | undefined): s is string {
  return !!s && /^https?:\/\//i.test(s);
}

function isLocalBlob(url: string | undefined): boolean {
  return !!url && url.startsWith('blob:');
}

/** Media that still needs a durable local copy from a remote URL */
export function getRemoteUrlForMedia(m: MessageMedia): string | null {
  if (m.kind === 'file') return null;

  // Already promoted successfully
  if (isLocalBlob(m.url) && m.assetKey && m.fetchStatus === 'ok') return null;
  if (isLocalBlob(m.url) && m.assetKey && !m.remoteUrl) return null;

  if (isRemoteUrl(m.url)) return m.url;
  if (isRemoteUrl(m.remoteUrl) && !isLocalBlob(m.url)) return m.remoteUrl;
  if (isRemoteUrl(m.id) && !isLocalBlob(m.url)) return m.id;

  return null;
}

export function countRemoteImageCandidates(
  conversations: Conversation[],
  conversationId?: string
): number {
  let n = 0;
  for (const c of conversations) {
    if (conversationId && c.id !== conversationId) continue;
    for (const m of c.messages) {
      for (const media of m.media || []) {
        if (getRemoteUrlForMedia(media)) n++;
      }
    }
  }
  return n;
}

function simpleHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function assetKeyForUrl(url: string): string {
  const ids = extractAssetIdsFromString(url);
  if (ids[0]) return ids[0];
  return `remote_${simpleHash(url)}`;
}

function collectCandidates(
  conversations: Conversation[],
  conversationId?: string
): Candidate[] {
  const out: Candidate[] = [];
  conversations.forEach((c, convIndex) => {
    if (conversationId && c.id !== conversationId) return;
    c.messages.forEach((m, msgIndex) => {
      (m.media || []).forEach((media, mediaIndex) => {
        const url = getRemoteUrlForMedia(media);
        if (url) out.push({ convIndex, msgIndex, mediaIndex, url });
      });
    });
  });
  return out;
}

async function fetchAsImageBlob(
  url: string
): Promise<{ blob: Blob; error?: 'cors' | 'http' | 'failed' }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      return { blob: new Blob(), error: 'http' };
    }

    const rawBlob = await res.blob();
    const buf = new Uint8Array(await rawBlob.arrayBuffer());
    if (buf.length < 32) {
      return { blob: new Blob(), error: 'failed' };
    }

    let mime = rawBlob.type;
    const sniffed = sniffMime(buf);
    if (sniffed) mime = sniffed;
    if (!mime.startsWith('image/')) {
      return { blob: new Blob(), error: 'failed' };
    }

    const blob = new Blob([buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)], {
      type: mime,
    });
    return { blob };
  } catch (e) {
    clearTimeout(timer);
    const msg = e instanceof Error ? e.message : String(e);
    // TypeError / Failed to fetch often = CORS or network
    if (
      msg.toLowerCase().includes('cors') ||
      msg.toLowerCase().includes('failed to fetch') ||
      msg.toLowerCase().includes('networkerror') ||
      (e instanceof TypeError)
    ) {
      // Try canvas fallback (only works if CDN sends ACAO)
      try {
        const canvasBlob = await loadImageViaCanvas(url);
        if (canvasBlob) return { blob: canvasBlob };
      } catch {
        /* ignore */
      }
      return { blob: new Blob(), error: 'cors' };
    }
    return { blob: new Blob(), error: 'failed' };
  }
}

function loadImageViaCanvas(url: string): Promise<Blob | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const timeout = setTimeout(() => {
      img.src = '';
      resolve(null);
    }, FETCH_TIMEOUT_MS);

    img.onload = () => {
      clearTimeout(timeout);
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        if (canvas.width < 1 || canvas.height < 1) {
          resolve(null);
          return;
        }
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(null);
          return;
        }
        ctx.drawImage(img, 0, 0);
        canvas.toBlob(
          (b) => resolve(b),
          'image/png'
        );
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => {
      clearTimeout(timeout);
      resolve(null);
    };
    img.src = url;
  });
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Download remote images in scope. Successful items are saved to IDB and converted to blob URLs.
 * Failed items keep original url; only fetchStatus is updated.
 */
export async function downloadRemoteImages(
  conversations: Conversation[],
  opts: {
    conversationId?: string;
    onProgress?: (p: DownloadProgress) => void;
  } = {}
): Promise<{ conversations: Conversation[]; stats: RemoteDownloadStats }> {
  // Deep-ish clone so we can update immutably-ish
  const next: Conversation[] = conversations.map((c) => ({
    ...c,
    messages: c.messages.map((m) => ({
      ...m,
      media: m.media ? m.media.map((med) => ({ ...med })) : m.media,
    })),
  }));

  const candidates = collectCandidates(next, opts.conversationId);
  const stats: RemoteDownloadStats = {
    candidates: candidates.length,
    saved: 0,
    failed: 0,
    cors: 0,
    http: 0,
    skipped: 0,
  };

  if (candidates.length === 0) {
    return { conversations: next, stats };
  }

  let done = 0;
  opts.onProgress?.({ done: 0, total: candidates.length });

  await mapPool(candidates, CONCURRENCY, async (cand) => {
    const { convIndex, msgIndex, mediaIndex, url } = cand;
    const media = next[convIndex].messages[msgIndex].media![mediaIndex];

    // Mark pending (in-place on clone)
    media.fetchStatus = 'pending';

    const result = await fetchAsImageBlob(url);
    done++;
    opts.onProgress?.({ done, total: candidates.length, currentUrl: url });

    if (result.error || !result.blob || result.blob.size < 32) {
      if (result.error === 'cors') {
        stats.cors++;
        media.fetchStatus = 'cors';
      } else if (result.error === 'http') {
        stats.http++;
        media.fetchStatus = 'failed';
      } else {
        stats.failed++;
        media.fetchStatus = 'failed';
      }
      // Keep original url / id — "rollback" for this item
      return;
    }

    const assetKey = assetKeyForUrl(url);
    try {
      await saveAssetToIdb(assetKey, result.blob);
      const blobUrl = URL.createObjectURL(result.blob);
      media.remoteUrl = url;
      media.assetKey = assetKey;
      media.url = blobUrl;
      media.kind = 'image';
      media.fetchStatus = 'ok';
      if (!media.alt) media.alt = 'Downloaded image';
      stats.saved++;
    } catch {
      stats.failed++;
      media.fetchStatus = 'failed';
      // No IDB write completed cleanly — leave url as remote
    }
  });

  return { conversations: next, stats };
}

/** Human summary for toast */
export function formatDownloadStats(stats: RemoteDownloadStats): string {
  if (stats.candidates === 0) {
    return 'No remote images to download in this scope.';
  }
  const failTotal = stats.failed + stats.http + stats.cors;
  let detail = `Remote images: ${stats.saved} saved`;
  if (failTotal) {
    const reasons: string[] = [];
    if (stats.cors) reasons.push(`${stats.cors} CORS`);
    if (stats.http) reasons.push(`${stats.http} HTTP`);
    if (stats.failed) reasons.push(`${stats.failed} other`);
    detail += `, ${failTotal} failed${reasons.length ? ` (${reasons.join(' / ')})` : ''}`;
  }
  detail += ` · ${stats.candidates} attempted`;
  return detail;
}
