/**
 * Turn raw Grok thinking traces into human-readable text.
 *
 * Handles:
 * - Full agent objects: { agent_id, thinking_trace: "..." }
 * - JSON strings of those objects
 * - agent_thinking_traces arrays
 * - Glued step titles: "requestDrafting the plotWriting the scene" → newlines
 * - <xai:tool_usage_card> tool-call XML → short summary lines
 */

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Pull plain thinking text out of one value (string, object, or nested). */
function extractTraceText(value: unknown): string {
  if (value == null) return '';

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return '';

    // Cached dumps sometimes stored the whole object as a string
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed = JSON.parse(trimmed);
        const nested = extractTraceText(parsed);
        if (nested) return nested;
      } catch {
        // not JSON — fall through
      }
    }
    return trimmed;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => extractTraceText(item))
      .filter(Boolean)
      .join('\n\n');
  }

  if (isRecord(value)) {
    // Prefer real prose fields; never surface agent_id / rollout metadata
    const keys = [
      'thinking_trace',
      'thinkingTrace',
      'trace',
      'text',
      'content',
      'thinking',
      'summary',
      'thought',
      'reasoning',
    ] as const;

    for (const k of keys) {
      if (k in value) {
        const t = extractTraceText(value[k]);
        if (t) return t;
      }
    }

    // Some shapes nest under agent_* wrappers
    for (const [k, v] of Object.entries(value)) {
      if (k === 'agent_id' || k === 'agentId' || k === 'rollout_id' || k === 'id') continue;
      if (typeof v === 'string' || isRecord(v) || Array.isArray(v)) {
        const t = extractTraceText(v);
        if (t) return t;
      }
    }

    return '';
  }

  return '';
}

function parseToolArgs(cardXml: string): Record<string, unknown> {
  const cdata = cardXml.match(/<!\[CDATA\[([\s\S]*?)\]\]>/i);
  let raw = cdata?.[1]?.trim() || '';
  if (!raw) {
    const argsMatch = cardXml.match(/<xai:tool_args\b[^>]*>\s*([\s\S]*?)\s*<\/xai:tool_args>/i);
    raw = argsMatch?.[1]?.trim() || '';
  }
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function quoteSnippet(s: string, max = 120): string {
  const cleaned = s.replace(/\s+/g, ' ').trim();
  if (!cleaned) return '…';
  const cut = cleaned.length > max ? cleaned.slice(0, max - 1) + '…' : cleaned;
  return `"${cut}"`;
}

/** Map one tool_usage_card to a short human line (no personal dumps). */
function summarizeToolCard(cardXml: string): string {
  const nameMatch = cardXml.match(/<xai:tool_name>\s*([^<]+?)\s*<\/xai:tool_name>/i);
  const name = (nameMatch?.[1] || 'unknown').trim().toLowerCase();
  const args = parseToolArgs(cardXml);

  const query =
    (typeof args.query === 'string' && args.query) ||
    (typeof args.q === 'string' && args.q) ||
    (typeof args.search_query === 'string' && args.search_query) ||
    '';

  const url =
    (typeof args.url === 'string' && args.url) ||
    (typeof args.uri === 'string' && args.uri) ||
    '';

  switch (name) {
    case 'web_search':
    case 'web_search_with_snippets':
    case 'search_web':
      return query ? `Searched web: ${quoteSnippet(query)}` : 'Searched the web';

    case 'browse_page':
    case 'open_page':
    case 'open_url':
    case 'visit_page':
      return url ? `Opened page: ${quoteSnippet(url, 80)}` : 'Opened a web page';

    case 'x_keyword_search':
    case 'x_semantic_search':
    case 'x_search':
    case 'twitter_search':
      return query ? `Searched X: ${quoteSnippet(query)}` : 'Searched X';

    case 'x_thread_fetch':
    case 'x_user_search':
      return `Used X tool: ${name}`;

    case 'edit_memory':
    case 'update_memory':
    case 'memory_edit':
      // Privacy: never dump old_str / new_str (can contain personal profile text)
      return 'Updated memory';

    case 'code_execution':
    case 'run_code':
    case 'python':
      return 'Ran code';

    case 'image_gen':
    case 'generate_image':
      return 'Generated an image';

    case 'web_fetch':
    case 'fetch_url':
      return url ? `Fetched: ${quoteSnippet(url, 80)}` : 'Fetched a URL';

    default: {
      if (query) return `Used ${name}: ${quoteSnippet(query)}`;
      if (url) return `Used ${name}: ${quoteSnippet(url, 80)}`;
      return `Used tool: ${name}`;
    }
  }
}

/**
 * Replace <xai:tool_usage_card>…</xai:tool_usage_card> with human summary lines.
 * Also strip any leftover xai XML tags.
 */
function rewriteToolUsageCards(text: string): string {
  if (!text || !text.includes('tool_usage_card') && !text.includes('<xai:')) {
    // Fast path: still strip stray xai tags if any
    if (!text.includes('<xai:')) return text;
  }

  let s = text;

  // Full cards → summary lines (surrounded by newlines so they become bullets)
  s = s.replace(
    /<xai:tool_usage_card\b[^>]*>[\s\S]*?<\/xai:tool_usage_card>/gi,
    (card) => `\n${summarizeToolCard(card)}\n`
  );

  // Self-closing or truncated cards
  s = s.replace(/<xai:tool_usage_card\b[^>]*\/>/gi, '\nUsed a tool\n');

  // Any remaining xai tags (orphaned open/close/partial)
  s = s.replace(/<\/?xai:[^>\n]+>/gi, '');
  s = s.replace(/<!\[CDATA\[[\s\S]*?\]\]>/gi, '');

  return s;
}

/**
 * Split camelCase / PascalCase glued step titles into separate lines.
 * "Thinking about your requestDrafting the plot" → two lines.
 * Avoid splitting inside already-clean tool summary lines.
 */
function splitGluedSteps(text: string): string {
  if (!text) return '';

  let s = text.replace(/\r\n/g, '\n');

  // Insert break when lowercase (or digit) is followed by uppercase (new step title)
  // But don't break inside quoted tool queries unnecessarily: only apply to non-quote runs
  s = s
    .split('\n')
    .map((line) => {
      // Tool summary lines already human — leave them alone
      if (
        /^(Searched |Opened |Used |Updated |Ran |Generated |Fetched )/i.test(line.trim())
      ) {
        return line.trim();
      }
      return line.replace(/([a-z0-9])([A-Z])/g, '$1\n$2');
    })
    .join('\n');

  // If steps are separated by " • " or " | " or " → "
  s = s.replace(/\s*[•|→]\s*/g, '\n');

  const lines = s
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return dedupeLines(lines).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function dedupeLines(lines: string[]): string[] {
  const deduped: string[] = [];
  for (const line of lines) {
    if (deduped.length === 0 || deduped[deduped.length - 1] !== line) {
      deduped.push(line);
    }
  }

  // If the whole list is an exact repeated block (common with dual agent rollouts)
  if (deduped.length >= 4 && deduped.length % 2 === 0) {
    const mid = deduped.length / 2;
    const first = deduped.slice(0, mid);
    const second = deduped.slice(mid);
    if (first.every((l, i) => l === second[i])) {
      return first;
    }
  }

  // Also: if second half starts with the same first 3 lines as the start, drop the repeat
  if (deduped.length >= 6) {
    const mid = Math.floor(deduped.length / 2);
    // Find first line of second copy
    const start = deduped[0];
    const secondStart = deduped.indexOf(start, 1);
    if (secondStart > 0 && secondStart >= Math.floor(deduped.length * 0.4)) {
      const a = deduped.slice(0, secondStart);
      const b = deduped.slice(secondStart, secondStart + a.length);
      if (b.length === a.length && a.every((l, i) => l === b[i])) {
        return a;
      }
    }
  }

  return deduped;
}

/**
 * Format any raw thinking payload for UI / storage.
 * Never returns raw JSON object dumps or tool XML.
 */
export function formatThinkingTrace(raw: unknown): string {
  const extracted = extractTraceText(raw);
  if (!extracted) return '';
  const withoutTools = rewriteToolUsageCards(extracted);
  return splitGluedSteps(withoutTools);
}

/**
 * Format a list of agent_thinking_traces entries into one panel string.
 */
export function formatAgentThinkingTraces(traces: unknown): string {
  if (!traces) return '';
  if (!Array.isArray(traces)) return formatThinkingTrace(traces);

  const parts = traces
    .map((t) => formatThinkingTrace(t))
    .filter(Boolean);

  // Dedupe identical consecutive agent traces
  const deduped: string[] = [];
  for (const p of parts) {
    if (deduped.length === 0 || deduped[deduped.length - 1] !== p) {
      deduped.push(p);
    }
  }

  // If two full agent traces are identical, keep one
  const joined = deduped.join('\n');
  return splitGluedSteps(joined); // final line dedupe / block dedupe
}
