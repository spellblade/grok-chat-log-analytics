/**
 * Native parser for X/xAI prod-grok-backend.json export format.
 *
 * Observed structure (as of 2026):
 * [
 *   {
 *     conversation: { id, title, create_time, ... },
 *     responses: [
 *       { response: { _id, parent_response_id, sender, message, ... }, share_link?: {} },
 *       ...
 *     ]
 *   },
 *   ...
 * ]
 *
 * Assets live under prod-mc-asset-server/<uuid>/content (no extension).
 * Images: response.generated_image_urls (URLs) + response.file_attachments (UUIDs).
 */

import { Conversation, Message, MessageMedia, Citation } from '../types';
import { parseThinkBlock } from './parser';
import { processGrokRenderTags, resolveCitations, webSearchResultsToCitations } from './contentRender';
import { annotateBranches } from './branchTree';
import { formatThinkingTrace, formatAgentThinkingTraces } from './formatThinking';
import { extractAssetIdsFromString } from './assetDecode';

export interface AssetResolver {
  /** Resolve an asset UUID or path to a displayable media item */
  resolve(ref: string): MessageMedia | null;
  /** All known asset folder ids (for deep-scan matching) */
  assetIds: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Detect official wrapped Grok backend export */
export function isGrokBackendWrapped(data: unknown): boolean {
  if (!Array.isArray(data) || data.length === 0) {
    // Also accept { conversations: [...] } or { data: [...] }
    if (isRecord(data)) {
      for (const key of ['conversations', 'data', 'items', 'grok_conversations']) {
        const arr = data[key];
        if (Array.isArray(arr) && arr.length > 0) return isGrokBackendWrapped(arr);
      }
    }
    return false;
  }
  const first = data[0];
  if (!isRecord(first)) return false;
  // Wrapped conversation unit
  if (isRecord(first.conversation) && Array.isArray(first.responses)) return true;
  // Sometimes top-level is already unwrapped conversation with responses
  if (Array.isArray(first.responses) && (first.id || first._id || first.title)) return true;
  return false;
}

function normalizeRole(sender: unknown): 'user' | 'assistant' | 'system' {
  if (sender == null) return 'assistant';
  const s = String(sender).toLowerCase();
  if (s === 'human' || s === 'user' || s === 'you' || s === 'me') return 'user';
  if (s === 'system' || s === 'developer') return 'system';
  // "assistant", "ASSISTANT", "grok-3", "grok-4", model names → assistant
  return 'assistant';
}

function parseBsonOrIso(value: unknown): string | undefined {
  if (value == null) return undefined;
  try {
    if (typeof value === 'string') {
      const d = new Date(value);
      return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
    }
    if (typeof value === 'number') {
      const ms = value < 1e12 ? value * 1000 : value;
      return new Date(ms).toISOString();
    }
    if (isRecord(value) && value.$date != null) {
      const d = value.$date;
      if (isRecord(d) && d.$numberLong != null) {
        return new Date(parseInt(String(d.$numberLong), 10)).toISOString();
      }
      return new Date(d as string | number).toISOString();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function unwrapResponse(entry: unknown): Record<string, unknown> | null {
  if (!isRecord(entry)) return null;
  // { response: {...}, share_link?: {} }
  if (isRecord(entry.response)) return entry.response as Record<string, unknown>;
  // Already a response document
  if ('message' in entry || 'sender' in entry || 'parent_response_id' in entry) {
    return entry;
  }
  return null;
}

function extractText(resp: Record<string, unknown>): string {
  const candidates = [resp.message, resp.content, resp.text, resp.query];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c;
  }
  // Empty string is valid (image-only turns)
  if (typeof resp.message === 'string') return resp.message;
  return '';
}

const ATTACHMENT_ID_KEYS = [
  'id',
  '_id',
  'asset_id',
  'assetId',
  'file_id',
  'fileId',
  'file_uri',
  'fileUri',
  'media_id',
  'mediaId',
  'image_id',
  'imageId',
] as const;

const ATTACHMENT_URL_KEYS = [
  'url',
  'src',
  'href',
  'asset_url',
  'assetUrl',
  'media_url',
  'mediaUrl',
  'image_url',
  'imageUrl',
  'download_url',
  'downloadUrl',
] as const;

function resolveRef(ref: string, assets?: AssetResolver, alt = 'Attachment'): MessageMedia | null {
  if (!ref || !ref.trim()) return null;
  const cleaned = ref.trim();

  // Prefer local asset when id appears in the string
  if (assets) {
    const ids = extractAssetIdsFromString(cleaned);
    for (const id of ids) {
      const local = assets.resolve(id);
      if (local) return { ...local, alt: alt || local.alt };
    }
    // Direct resolve of full ref / basename
    const direct = assets.resolve(cleaned);
    if (direct) return { ...direct, alt: alt || direct.alt };
    const base = cleaned.split('/').filter(Boolean).pop();
    if (base && base !== cleaned) {
      const byBase = assets.resolve(base);
      if (byBase) return { ...byBase, alt: alt || byBase.alt };
    }
  }

  if (/^https?:\/\//i.test(cleaned)) {
    return { id: cleaned, kind: 'image', url: cleaned, alt };
  }

  if (assets) {
    // Unresolved local id — keep placeholder for UI
    return {
      id: cleaned,
      kind: 'image',
      assetKey: cleaned,
      alt: `Asset ${cleaned.slice(0, 12)}…`,
    };
  }

  return null;
}

function collectFromUnknown(
  value: unknown,
  assets: AssetResolver | undefined,
  add: (item: MessageMedia | null) => void,
  depth = 0
): void {
  if (value == null || depth > 6) return;

  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return;
    // JSON string?
    if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
      try {
        collectFromUnknown(JSON.parse(s), assets, add, depth + 1);
        return;
      } catch {
        /* plain string */
      }
    }
    if (/^https?:\/\//i.test(s) || extractAssetIdsFromString(s).length > 0) {
      add(resolveRef(s, assets));
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectFromUnknown(item, assets, add, depth + 1);
    return;
  }

  if (!isRecord(value)) return;

  // Prefer explicit url/id fields on this object
  let foundUrl: string | undefined;
  let foundId: string | undefined;
  for (const k of ATTACHMENT_URL_KEYS) {
    if (typeof value[k] === 'string' && (value[k] as string).trim()) {
      foundUrl = String(value[k]).trim();
      break;
    }
  }
  for (const k of ATTACHMENT_ID_KEYS) {
    if (typeof value[k] === 'string' && (value[k] as string).trim()) {
      foundId = String(value[k]).trim();
      break;
    }
  }

  const typeHint = String(value.type || value.mime_type || value.mimeType || value.content_type || '').toLowerCase();
  const nameHint = String(value.name || value.filename || value.file_name || value.alt || 'Attachment');
  const looksImage =
    typeHint.includes('image') ||
    /\.(jpe?g|png|gif|webp|avif|bmp)$/i.test(nameHint) ||
    typeHint === '' ||
    !!foundUrl;

  if (looksImage && (foundUrl || foundId)) {
    const ref = foundId || foundUrl!;
    const resolved = resolveRef(foundUrl || foundId!, assets, nameHint);
    if (resolved) {
      add(resolved);
    } else if (foundUrl) {
      add({ id: foundUrl, kind: 'image', url: foundUrl, alt: nameHint });
    } else if (foundId) {
      add({ id: foundId, kind: 'image', assetKey: foundId, alt: nameHint });
    }
    void ref;
  }

  // Recurse into nested structures (skip huge known non-media)
  for (const [k, v] of Object.entries(value)) {
    if (
      k === 'thinking_trace' ||
      k === 'agent_thinking_traces' ||
      k === 'message' ||
      k === 'web_search_results' ||
      k === 'cited_web_search_results'
    ) {
      continue;
    }
    if (v && typeof v === 'object') {
      collectFromUnknown(v, assets, add, depth + 1);
    }
  }
}

function extractMedia(
  resp: Record<string, unknown>,
  assets?: AssetResolver
): MessageMedia[] {
  const media: MessageMedia[] = [];
  const seen = new Set<string>();

  const add = (item: MessageMedia | null) => {
    if (!item || !item.id) return;
    const key = item.assetKey || item.url || item.id;
    if (seen.has(key)) return;
    seen.add(key);
    media.push(item);
  };

  // Primary Grok fields
  collectFromUnknown(resp.generated_image_urls ?? resp.generatedImageUrls, assets, add);
  collectFromUnknown(resp.file_attachments ?? resp.fileAttachments, assets, add);
  collectFromUnknown(resp.attachments, assets, add);
  collectFromUnknown(resp.media, assets, add);
  collectFromUnknown(resp.images, assets, add);

  // card_attachments_json (string or structured)
  collectFromUnknown(resp.card_attachments_json ?? resp.cardAttachmentsJson, assets, add);

  // steps / tool chain may embed image results
  collectFromUnknown(resp.steps, assets, add);
  collectFromUnknown(resp.tool_usage_results ?? resp.toolUsageResults, assets, add);

  // Single-field asset ids
  for (const k of ATTACHMENT_ID_KEYS) {
    const v = resp[k];
    if (typeof v === 'string' && v.trim()) add(resolveRef(v, assets));
  }

  // Deep-scan: any known asset id appearing anywhere in this response JSON
  if (assets && assets.assetIds.length > 0) {
    let blob = '';
    try {
      blob = JSON.stringify(resp);
    } catch {
      blob = '';
    }
    if (blob) {
      const blobLower = blob.toLowerCase();
      for (const id of assets.assetIds) {
        if (id.length >= 8 && blobLower.includes(id.toLowerCase())) {
          add(assets.resolve(id));
        }
      }
      // Also pick UUIDs present in blob that resolve
      for (const id of extractAssetIdsFromString(blob)) {
        add(assets.resolve(id));
      }
    }
  }

  // Markdown / bare URLs in message text
  const text = extractText(resp);
  if (text) {
    for (const m of text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/gi)) {
      add(resolveRef(m[1], assets, 'Embedded image'));
    }
    for (const m of text.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
      const u = m[0];
      if (/\.(jpe?g|png|gif|webp|avif)(\?|$)/i.test(u) || extractAssetIdsFromString(u).length) {
        add(resolveRef(u, assets, 'Image URL'));
      }
    }
  }

  return media;
}

function extractThinking(resp: Record<string, unknown>): string | undefined {
  // Prefer agent_thinking_traces (structured steps) when present
  const traces = resp.agent_thinking_traces ?? resp.agentThinkingTraces;
  if (traces != null) {
    const formatted = formatAgentThinkingTraces(traces);
    if (formatted) return formatted;
  }

  if (resp.thinking_trace != null) {
    const formatted = formatThinkingTrace(resp.thinking_trace);
    if (formatted) return formatted;
  }

  if (resp.thinkContent != null) {
    const formatted = formatThinkingTrace(resp.thinkContent);
    if (formatted) return formatted;
  }

  return undefined;
}

function toMessage(resp: Record<string, unknown>, assets?: AssetResolver): Message {
  const id = String(resp._id ?? resp.id ?? `msg_${Math.random().toString(36).slice(2)}`);
  const role = normalizeRole(resp.sender ?? resp.role);
  const rawText = extractText(resp);

  const fromTags = processGrokRenderTags(rawText);
  const fromThinkBlock = parseThinkBlock(fromTags.cleanContent);
  const thinkFromField = extractThinking(resp);
  const thinkContent = fromThinkBlock.thinkContent || thinkFromField;
  const content = fromThinkBlock.cleanContent;

  const webSearchResults = webSearchResultsToCitations(
    resp.web_search_results ||
      resp.webSearchResults ||
      resp.cited_web_search_results ||
      resp.citedWebSearchResults
  );
  const citations = resolveCitations(fromTags.citationIds, webSearchResults);

  // Also map cited_web_search_results directly as citations if no inline ids
  let finalCitations = citations;
  if (finalCitations.length === 0 && webSearchResults.length > 0) {
    finalCitations = webSearchResults;
  }

  const parentRaw =
    resp.parent_response_id ??
    resp.parent_id ??
    resp.parentId ??
    resp.parent ??
    resp.in_reply_to;
  const parentId =
    parentRaw != null && parentRaw !== '' && parentRaw !== 'null'
      ? String(parentRaw)
      : undefined;

  const media = extractMedia(resp, assets);
  const timestamp = parseBsonOrIso(resp.create_time ?? resp.created_at ?? resp.timestamp);

  return {
    id,
    role,
    senderName: role === 'user' ? 'You' : 'Grok',
    content,
    timestamp,
    thinkContent,
    isThink: !!thinkContent,
    parentId,
    citations: finalCitations.length > 0 ? finalCitations : undefined,
    webSearchResults: webSearchResults.length > 0 ? webSearchResults : undefined,
    media: media.length > 0 ? media : undefined,
  };
}

function computeStats(messages: Message[]) {
  let userMessagesCount = 0;
  let assistantMessagesCount = 0;
  let totalCharacters = 0;
  let userCharacters = 0;
  let assistantCharacters = 0;

  for (const m of messages) {
    const len = m.content.length + (m.thinkContent?.length || 0);
    totalCharacters += len;
    if (m.role === 'user') {
      userMessagesCount++;
      userCharacters += len;
    } else if (m.role === 'assistant') {
      assistantMessagesCount++;
      assistantCharacters += len;
    }
  }

  return {
    messageCount: messages.length,
    userMessagesCount,
    assistantMessagesCount,
    totalCharacters,
    userCharacters,
    assistantCharacters,
    avgMessageLength: messages.length > 0 ? Math.round(totalCharacters / messages.length) : 0,
  };
}

function inferMode(messages: Message[], rawResponses: Record<string, unknown>[]): Conversation['mode'] {
  if (messages.some((m) => m.isThink) || rawResponses.some((r) => r.thinking_trace || r.agent_thinking_traces)) {
    return 'Think';
  }
  if (rawResponses.some((r) => {
    const m = String(r.model || '').toLowerCase();
    return m.includes('fun') || String(r.system_prompt_name || '').toLowerCase().includes('fun');
  })) {
    return 'Fun';
  }
  if (rawResponses.some((r) => {
    const m = String(r.model || '').toLowerCase();
    return m.includes('deepsearch') || m.includes('deep_search');
  })) {
    return 'DeepSearch';
  }
  return 'Normal';
}

function parseOneConversationUnit(
  unit: Record<string, unknown>,
  assets?: AssetResolver
): Conversation | null {
  const conv = isRecord(unit.conversation) ? unit.conversation : unit;
  const responsesRaw = Array.isArray(unit.responses)
    ? unit.responses
    : Array.isArray(unit.messages)
      ? unit.messages
      : [];

  const rawResponses: Record<string, unknown>[] = [];
  for (const entry of responsesRaw) {
    const resp = unwrapResponse(entry);
    if (resp) rawResponses.push(resp);
  }

  if (rawResponses.length === 0 && !conv.id && !conv._id && !conv.title) {
    return null;
  }

  let messages = rawResponses.map((r) => toMessage(r, assets));
  messages = annotateBranches(messages);

  const id = String(conv.id ?? conv._id ?? conv.conversation_id ?? `conv_${Math.random().toString(36).slice(2)}`);
  let title = String(conv.title ?? conv.name ?? conv.summary ?? '').trim();
  let titleSource: 'export' | 'inferred' = title ? 'export' : 'inferred';
  if (!title) {
    const firstUser = messages.find((m) => m.role === 'user' && m.content.trim());
    title = firstUser
      ? firstUser.content.slice(0, 50) + (firstUser.content.length > 50 ? '...' : '')
      : `Conversation ${id.slice(0, 8)}`;
  }

  const createdAt =
    parseBsonOrIso(conv.create_time ?? conv.created_at ?? conv.createdAt) ||
    messages.find((m) => m.timestamp)?.timestamp ||
    new Date().toISOString();

  const model =
    (rawResponses.map((r) => r.model).find((m) => typeof m === 'string' && m) as string) ||
    'Grok';

  return {
    id,
    title,
    createdAt,
    messages,
    model: String(model),
    mode: inferMode(messages, rawResponses),
    titleSource,
    stats: computeStats(messages),
  };
}

/**
 * Parse prod-grok-backend.json (wrapped or lightly nested) into Conversations.
 */
export function parseGrokBackendJson(data: unknown, assets?: AssetResolver): Conversation[] {
  let units: unknown[] = [];

  if (Array.isArray(data)) {
    units = data;
  } else if (isRecord(data)) {
    for (const key of ['conversations', 'data', 'items', 'grok_conversations']) {
      if (Array.isArray(data[key])) {
        units = data[key] as unknown[];
        break;
      }
    }
    // Single conversation unit
    if (units.length === 0 && (data.conversation || data.responses)) {
      units = [data];
    }
  }

  const out: Conversation[] = [];
  for (const unit of units) {
    if (!isRecord(unit)) continue;
    // Skip pure message rows that slipped in
    if (!unit.conversation && !unit.responses && !unit.title && isRecord(unit.response)) {
      // lone response wrapper — skip at this level
      continue;
    }
    const conv = parseOneConversationUnit(unit, assets);
    if (conv && (conv.messages.length > 0 || conv.title)) {
      out.push(conv);
    }
  }

  return out;
}

/**
 * Also handle a flat array of response documents (legacy / extracted),
 * grouped by conversation_id, with native Grok fields.
 */
export function parseFlatGrokResponses(
  rows: Record<string, unknown>[],
  assets?: AssetResolver,
  titleByConvId?: Map<string, string>
): Conversation[] {
  const groups = new Map<string, Record<string, unknown>[]>();

  for (const row of rows) {
    const resp = unwrapResponse(row) || row;
    const cId = String(
      resp.conversation_id ?? resp.conversationId ?? row.conversation_id ?? 'unknown'
    );
    const list = groups.get(cId) || [];
    list.push(resp);
    groups.set(cId, list);
  }

  const out: Conversation[] = [];
  for (const [cId, resps] of groups) {
    // Sort by time
    resps.sort((a, b) => {
      const ta = parseBsonOrIso(a.create_time) || '';
      const tb = parseBsonOrIso(b.create_time) || '';
      return ta.localeCompare(tb);
    });

    const unit = {
      conversation: {
        id: cId,
        title: titleByConvId?.get(cId) || '',
        create_time: resps[0]?.create_time,
      },
      responses: resps.map((r) => ({ response: r })),
    };
    const conv = parseOneConversationUnit(unit, assets);
    if (conv) out.push(conv);
  }
  return out;
}
