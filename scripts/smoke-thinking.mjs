// Smoke tests for formatThinking (tool cards + camelCase + JSON unwrap)
// Run: node scripts/smoke-thinking.mjs

function isRecord(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function extractTraceText(value) {
  if (value == null) return '';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const nested = extractTraceText(JSON.parse(trimmed));
        if (nested) return nested;
      } catch {}
    }
    return trimmed;
  }
  if (Array.isArray(value)) return value.map(extractTraceText).filter(Boolean).join('\n\n');
  if (isRecord(value)) {
    for (const k of ['thinking_trace', 'thinkingTrace', 'trace', 'text', 'content', 'thinking', 'summary']) {
      if (k in value) {
        const t = extractTraceText(value[k]);
        if (t) return t;
      }
    }
    return '';
  }
  return '';
}
function parseToolArgs(cardXml) {
  const cdata = cardXml.match(/<!\[CDATA\[([\s\S]*?)\]\]>/i);
  let raw = cdata?.[1]?.trim() || '';
  if (!raw) {
    const argsMatch = cardXml.match(/<xai:tool_args\b[^>]*>\s*([\s\S]*?)\s*<\/xai:tool_args>/i);
    raw = argsMatch?.[1]?.trim() || '';
  }
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function quoteSnippet(s, max = 120) {
  const cleaned = s.replace(/\s+/g, ' ').trim();
  if (!cleaned) return '…';
  const cut = cleaned.length > max ? cleaned.slice(0, max - 1) + '…' : cleaned;
  return `"${cut}"`;
}
function summarizeToolCard(cardXml) {
  const nameMatch = cardXml.match(/<xai:tool_name>\s*([^<]+?)\s*<\/xai:tool_name>/i);
  const name = (nameMatch?.[1] || 'unknown').trim().toLowerCase();
  const args = parseToolArgs(cardXml);
  const query = (typeof args.query === 'string' && args.query) || '';
  switch (name) {
    case 'web_search':
      return query ? `Searched web: ${quoteSnippet(query)}` : 'Searched the web';
    case 'edit_memory':
      return 'Updated memory';
    default:
      return `Used tool: ${name}`;
  }
}
function rewriteToolUsageCards(text) {
  let s = text.replace(
    /<xai:tool_usage_card\b[^>]*>[\s\S]*?<\/xai:tool_usage_card>/gi,
    (card) => `\n${summarizeToolCard(card)}\n`
  );
  s = s.replace(/<\/?xai:[^>\n]+>/gi, '');
  s = s.replace(/<!\[CDATA\[[\s\S]*?\]\]>/gi, '');
  return s;
}
function dedupeLines(lines) {
  const deduped = [];
  for (const line of lines) {
    if (deduped.length === 0 || deduped[deduped.length - 1] !== line) deduped.push(line);
  }
  if (deduped.length >= 4 && deduped.length % 2 === 0) {
    const mid = deduped.length / 2;
    const first = deduped.slice(0, mid);
    const second = deduped.slice(mid);
    if (first.every((l, i) => l === second[i])) return first;
  }
  if (deduped.length >= 6) {
    const start = deduped[0];
    const secondStart = deduped.indexOf(start, 1);
    if (secondStart > 0 && secondStart >= Math.floor(deduped.length * 0.4)) {
      const a = deduped.slice(0, secondStart);
      const b = deduped.slice(secondStart, secondStart + a.length);
      if (b.length === a.length && a.every((l, i) => l === b[i])) return a;
    }
  }
  return deduped;
}
function splitGluedSteps(text) {
  let s = text.replace(/\r\n/g, '\n');
  s = s
    .split('\n')
    .map((line) => {
      if (/^(Searched |Opened |Used |Updated |Ran |Generated |Fetched )/i.test(line.trim())) {
        return line.trim();
      }
      return line.replace(/([a-z0-9])([A-Z])/g, '$1\n$2');
    })
    .join('\n');
  const lines = s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return dedupeLines(lines).join('\n');
}
function formatThinkingTrace(raw) {
  const extracted = extractTraceText(raw);
  if (!extracted) return '';
  return splitGluedSteps(rewriteToolUsageCards(extracted));
}

const sample = `Thinking about your request<xai:tool_usage_card>
<xai:tool_usage_card_id>b0b68131-2450-4b97-9866-9e3d73648aae</xai:tool_usage_card_id>
<xai:tool_name>web_search</xai:tool_name>
<xai:tool_args><![CDATA[{"query":"evidence based treatments for androgenetic alopecia 2026","num_results":"10"}]]></xai:tool_args>
</xai:tool_usage_card><xai:tool_usage_card>
<xai:tool_usage_card_id>8b004e23-7f50-40a0-b92d-af3abd7e98c1</xai:tool_usage_card_id>
<xai:tool_name>web_search</xai:tool_name>
<xai:tool_args><![CDATA[{"query":"biotin for hair loss systematic review meta analysis","num_results":"5"}]]></xai:tool_args>
</xai:tool_usage_card>Evaluating supplement efficacy for hair loss<xai:tool_usage_card>
<xai:tool_usage_card_id>b73d0c37-8e0c-4c27-abb4-04ac6d84e040</xai:tool_usage_card_id>
<xai:tool_name>edit_memory</xai:tool_name>
<xai:tool_args><![CDATA[{"old_str":"secret personal stuff","new_str":"secret personal stuff with hair"}]]></xai:tool_args>
</xai:tool_usage_card>Exploring supplements for hair loss
Checking vitamin and mineral levelsThinking about your request<xai:tool_usage_card>
<xai:tool_usage_card_id>b0b68131-2450-4b97-9866-9e3d73648aae</xai:tool_usage_card_id>
<xai:tool_name>web_search</xai:tool_name>
<xai:tool_args><![CDATA[{"query":"evidence based treatments for androgenetic alopecia 2026","num_results":"10"}]]></xai:tool_args>
</xai:tool_usage_card><xai:tool_usage_card>
<xai:tool_usage_card_id>8b004e23-7f50-40a0-b92d-af3abd7e98c1</xai:tool_usage_card_id>
<xai:tool_name>web_search</xai:tool_name>
<xai:tool_args><![CDATA[{"query":"biotin for hair loss systematic review meta analysis","num_results":"5"}]]></xai:tool_args>
</xai:tool_usage_card>Evaluating supplement efficacy for hair loss<xai:tool_usage_card>
<xai:tool_usage_card_id>b73d0c37-8e0c-4c27-abb4-04ac6d84e040</xai:tool_usage_card_id>
<xai:tool_name>edit_memory</xai:tool_name>
<xai:tool_args><![CDATA[{"old_str":"secret personal stuff","new_str":"secret personal stuff with hair"}]]></xai:tool_args>
</xai:tool_usage_card>Exploring supplements for hair loss
Checking vitamin and mineral levels`;

const out = formatThinkingTrace(sample);
console.log(out);
console.log('---');

let failed = 0;
const assert = (n, c) => {
  if (c) console.log('PASS', n);
  else {
    failed++;
    console.log('FAIL', n);
  }
};

assert('no tool_usage_card xml', !out.includes('tool_usage_card'));
assert('no xai tags', !out.includes('<xai:'));
assert('no CDATA', !out.includes('CDATA'));
assert('no secret personal', !out.includes('secret personal'));
assert('has web search line', out.includes('Searched web:'));
assert('has alopecia query', out.includes('androgenetic alopecia'));
assert('has Updated memory', out.includes('Updated memory'));
assert('has Evaluating line', out.includes('Evaluating supplement efficacy'));
// Dedupe: "Thinking about your request" should appear once
const thinkCount = (out.match(/Thinking about your request/g) || []).length;
assert('deduped repeated block', thinkCount === 1);

process.exit(failed ? 1 : 0);
