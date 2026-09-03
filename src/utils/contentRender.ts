import { Citation } from '../types';

const GROK_RENDER_RE =
  /<grok:render\b[^>]*>([\s\S]*?)<\/grok:render>/gi;

const CITATION_ID_RE =
  /type\s*=\s*["']render_inline_citation["'][\s\S]*?<argument\s+name\s*=\s*["']citation_id["']\s*>\s*(\d+)\s*<\/argument>/i;

const CITATION_ID_LOOSE_RE =
  /<argument\s+name\s*=\s*["']citation_id["']\s*>\s*(\d+)\s*<\/argument>/i;

/** Placeholder embedded in message text for markdown-safe citation chips */
export const CITE_PLACEHOLDER = (id: string) => `⟦cite:${id}⟧`;
export const CITE_PLACEHOLDER_RE = /⟦cite:(\d+)⟧/g;

/**
 * Strip Grok render tags from content and collect citation ids.
 * Inline citation tags become ⟦cite:N⟧ placeholders; other render cards are removed.
 */
export function processGrokRenderTags(content: string): {
  cleanContent: string;
  citationIds: string[];
} {
  if (!content || !content.includes('grok:render')) {
    return { cleanContent: content || '', citationIds: [] };
  }

  const citationIds: string[] = [];

  const cleanContent = content.replace(GROK_RENDER_RE, (full, inner: string) => {
    const isCitation =
      /render_inline_citation/i.test(full) ||
      /card_type\s*=\s*["']citation_card["']/i.test(full);

    if (isCitation) {
      const match =
        full.match(CITATION_ID_RE) ||
        full.match(CITATION_ID_LOOSE_RE) ||
        String(inner).match(CITATION_ID_LOOSE_RE);
      if (match?.[1]) {
        citationIds.push(match[1]);
        return CITE_PLACEHOLDER(match[1]);
      }
    }

    // Unknown card types: drop silently so XML never shows in the UI
    return '';
  });

  return {
    cleanContent: cleanContent.replace(/\n{3,}/g, '\n\n').trim(),
    citationIds: [...new Set(citationIds)],
  };
}

/**
 * Map citation ids to entries from web_search_results.
 * Tries 0-based then 1-based indexing.
 */
export function resolveCitations(
  ids: string[],
  webSearchResults?: Citation[] | Array<Record<string, unknown>> | null
): Citation[] {
  if (!ids.length) return [];

  const results = (webSearchResults || []).map((raw, idx) => normalizeSearchResult(raw, idx));

  return ids.map((id) => {
    const n = parseInt(id, 10);
    if (!Number.isFinite(n) || results.length === 0) {
      return { id };
    }

    // Prefer 0-based, then 1-based
    let hit = results[n] ?? results[n - 1];
    if (!hit) {
      hit = results.find((r) => r.id === id);
    }

    if (!hit) return { id };

    return {
      id,
      url: hit.url,
      title: hit.title,
      preview: hit.preview,
      siteName: hit.siteName,
    };
  });
}

function normalizeSearchResult(
  raw: Citation | Record<string, unknown>,
  idx: number
): Citation {
  if (!raw || typeof raw !== 'object') {
    return { id: String(idx) };
  }

  const r = raw as Record<string, unknown>;
  return {
    id: String(r.id ?? idx),
    url: typeof r.url === 'string' ? r.url : undefined,
    title:
      (typeof r.title === 'string' && r.title) ||
      (typeof r.metadata_title === 'string' && r.metadata_title) ||
      undefined,
    preview:
      (typeof r.preview === 'string' && r.preview) ||
      (typeof r.description === 'string' && r.description) ||
      (typeof r.search_engine_text === 'string' && r.search_engine_text) ||
      undefined,
    siteName:
      (typeof r.site_name === 'string' && r.site_name) ||
      (typeof r.siteName === 'string' && r.siteName) ||
      undefined,
  };
}

/** Convert web_search_results array from a raw export message into Citations */
export function webSearchResultsToCitations(raw: unknown): Citation[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, idx) => normalizeSearchResult(item as Record<string, unknown>, idx));
}
