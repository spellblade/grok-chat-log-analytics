import React, { useState } from 'react';
import { Citation, MessageMedia } from '../../types';
import { CITE_PLACEHOLDER_RE } from '../../utils/contentRender';
import { Check, Copy, ExternalLink, ImageOff } from 'lucide-react';

interface MessageContentProps {
  content: string;
  highlightQuery?: string;
  messageId: string;
  citations?: Citation[];
  media?: MessageMedia[];
}

export default function MessageContent({
  content,
  highlightQuery = '',
  messageId,
  citations,
  media,
}: MessageContentProps) {
  const [copiedCodeId, setCopiedCodeId] = useState<string | null>(null);
  const citationMap = new Map((citations || []).map((c) => [c.id, c]));

  const handleCopyCode = (codeText: string, blockId: string) => {
    navigator.clipboard.writeText(codeText).then(() => {
      setCopiedCodeId(blockId);
      setTimeout(() => setCopiedCodeId(null), 2000);
    });
  };

  const highlightText = (text: string, query: string, elementKey?: string) => {
    if (!query || !query.trim()) return <span key={elementKey}>{text}</span>;

    const escapedQuery = query.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const parts = text.split(new RegExp(`(${escapedQuery})`, 'gi'));

    return (
      <span key={elementKey}>
        {parts.map((part, idx) =>
          part.toLowerCase() === query.toLowerCase() ? (
            <mark
              key={idx}
              className="bg-elegant-gold/25 text-white font-semibold rounded px-0.5 border-b border-elegant-gold"
            >
              {part}
            </mark>
          ) : (
            part
          )
        )}
      </span>
    );
  };

  const renderCitationChip = (id: string, key: string | number) => {
    const cite = citationMap.get(id);
    const label = cite?.siteName || cite?.title?.slice(0, 24) || id;
    const title = cite?.title || cite?.preview || `Citation ${id}`;

    if (cite?.url) {
      return (
        <a
          key={key}
          href={cite.url}
          target="_blank"
          rel="noopener noreferrer"
          title={title}
          className="inline-flex items-center gap-0.5 mx-0.5 px-1.5 py-0.5 rounded bg-elegant-gold/15 border border-elegant-gold/30 text-elegant-gold text-[10px] font-mono align-super hover:bg-elegant-gold/25 transition-colors no-underline"
        >
          <span>{label}</span>
          <ExternalLink className="w-2.5 h-2.5 opacity-70" />
        </a>
      );
    }

    return (
      <span
        key={key}
        title={title}
        className="inline-flex items-center mx-0.5 px-1.5 py-0.5 rounded bg-elegant-dark border border-elegant-border text-elegant-muted text-[10px] font-mono align-super"
      >
        [{id}]
      </span>
    );
  };

  /** Split text on citation placeholders and interleave chips */
  const renderTextWithCitations = (text: string, query: string, baseKey: string): React.ReactNode => {
    if (!text) return null;
    if (!text.includes('⟦cite:')) {
      return highlightText(text, query, baseKey);
    }

    const parts: React.ReactNode[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    const re = new RegExp(CITE_PLACEHOLDER_RE.source, 'g');
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) {
        parts.push(highlightText(text.slice(last, m.index), query, `${baseKey}-t-${last}`));
      }
      parts.push(renderCitationChip(m[1], `${baseKey}-c-${m.index}`));
      last = m.index + m[0].length;
    }
    if (last < text.length) {
      parts.push(highlightText(text.slice(last), query, `${baseKey}-t-end`));
    }
    return <React.Fragment key={baseKey}>{parts}</React.Fragment>;
  };

  const parseInlineElements = (text: string, query: string): React.ReactNode => {
    if (!text) return '';

    const inlineRegex =
      /(!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]*)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*)/g;
    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    let match;

    while ((match = inlineRegex.exec(text)) !== null) {
      const textBefore = text.substring(lastIndex, match.index);
      if (textBefore) {
        parts.push(renderTextWithCitations(textBefore, query, `before-${lastIndex}`));
      }

      const [fullMatch] = match;

      if (fullMatch.startsWith('![')) {
        const alt = match[2] || '';
        const src = match[3] || '';
        parts.push(
          <span key={`img-${match.index}`} className="block my-2 max-w-lg">
            <img
              src={src}
              alt={alt}
              className="rounded-lg border border-elegant-border max-h-72 object-contain bg-elegant-dark/50"
              referrerPolicy="no-referrer"
              onError={(e) => {
                (e.target as HTMLElement).style.display = 'none';
              }}
            />
            <span className="text-[10px] text-elegant-muted mt-1 block italic">{alt || 'Image'}</span>
          </span>
        );
      } else if (fullMatch.startsWith('[')) {
        const linkText = match[4] || '';
        const href = match[5] || '';
        parts.push(
          <a
            key={`link-${match.index}`}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-elegant-gold hover:underline font-medium break-all"
          >
            {renderTextWithCitations(linkText, query, `lt-${match.index}`)}
          </a>
        );
      } else if (fullMatch.startsWith('`')) {
        const codeText = match[6];
        parts.push(
          <code
            key={`code-${match.index}`}
            className="px-1.5 py-0.5 rounded bg-elegant-dark border border-elegant-border text-elegant-gold font-mono text-xxs select-all"
          >
            {highlightText(codeText, query)}
          </code>
        );
      } else if (fullMatch.startsWith('**')) {
        const boldText = match[7];
        parts.push(
          <strong key={`bold-${match.index}`} className="font-bold text-white">
            {renderTextWithCitations(boldText, query, `b-${match.index}`)}
          </strong>
        );
      } else if (fullMatch.startsWith('*')) {
        const italicText = match[8];
        parts.push(
          <em key={`italic-${match.index}`} className="italic text-elegant-text/90">
            {renderTextWithCitations(italicText, query, `i-${match.index}`)}
          </em>
        );
      }

      lastIndex = inlineRegex.lastIndex;
    }

    const textRemaining = text.substring(lastIndex);
    if (textRemaining) {
      parts.push(renderTextWithCitations(textRemaining, query, `remaining-${lastIndex}`));
    }

    return <React.Fragment>{parts}</React.Fragment>;
  };

  const renderMarkdownParagraphs = (text: string, query: string) => {
    const lines = text.split('\n');
    let currentList: { items: string[]; isOrdered: boolean } | null = null;
    const nodes: React.ReactNode[] = [];

    const flushList = (key: number) => {
      if (currentList) {
        const ListTag = currentList.isOrdered ? 'ol' : 'ul';
        const listClass = currentList.isOrdered
          ? 'list-decimal pl-6 space-y-1.5 my-3 text-elegant-text text-xs md:text-sm'
          : 'list-disc pl-6 space-y-1.5 my-3 text-elegant-text text-xs md:text-sm';

        nodes.push(
          <ListTag key={`list-${key}`} className={listClass}>
            {currentList.items.map((item, i) => (
              <li key={i}>{parseInlineElements(item, query)}</li>
            ))}
          </ListTag>
        );
        currentList = null;
      }
    };

    lines.forEach((line, idx) => {
      const trimmed = line.trim();

      if (trimmed.startsWith('### ')) {
        flushList(idx);
        nodes.push(
          <h4
            key={`h4-${idx}`}
            className="text-xs font-display font-semibold text-white mt-4 mb-2 tracking-wide flex items-center uppercase"
          >
            {parseInlineElements(trimmed.replace('### ', ''), query)}
          </h4>
        );
        return;
      }
      if (trimmed.startsWith('## ')) {
        flushList(idx);
        nodes.push(
          <h3
            key={`h3-${idx}`}
            className="text-sm font-display font-semibold text-white mt-5 mb-2.5 border-b border-elegant-border pb-1 uppercase tracking-wider"
          >
            {parseInlineElements(trimmed.replace('## ', ''), query)}
          </h3>
        );
        return;
      }
      if (trimmed.startsWith('# ')) {
        flushList(idx);
        nodes.push(
          <h2
            key={`h2-${idx}`}
            className="text-base font-display font-bold text-white mt-6 mb-3 tracking-wider uppercase"
          >
            {parseInlineElements(trimmed.replace('# ', ''), query)}
          </h2>
        );
        return;
      }

      if (trimmed.startsWith('> ')) {
        flushList(idx);
        nodes.push(
          <blockquote
            key={`bq-${idx}`}
            className="border-l-2 border-elegant-gold/30 bg-elegant-dark/60 p-3 my-3 text-xs md:text-sm text-elegant-muted rounded-r-md italic"
          >
            {parseInlineElements(trimmed.replace('> ', ''), query)}
          </blockquote>
        );
        return;
      }

      if (trimmed.startsWith('* ') || trimmed.startsWith('- ')) {
        if (!currentList || currentList.isOrdered) {
          flushList(idx);
          currentList = { items: [], isOrdered: false };
        }
        currentList.items.push(trimmed.substring(2));
        return;
      }

      const orderedMatch = trimmed.match(/^(\d+)\.\s(.*)/);
      if (orderedMatch) {
        if (!currentList || !currentList.isOrdered) {
          flushList(idx);
          currentList = { items: [], isOrdered: true };
        }
        currentList.items.push(orderedMatch[2]);
        return;
      }

      if (!trimmed) {
        flushList(idx);
        return;
      }

      flushList(idx);
      nodes.push(
        <p key={`p-${idx}`} className="text-xs md:text-sm text-elegant-text leading-relaxed my-2">
          {parseInlineElements(line, query)}
        </p>
      );
    });

    flushList(lines.length);
    return nodes;
  };

  const renderFormattedContent = () => {
    if (!content) return null;

    const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
    const elements: React.ReactNode[] = [];
    let lastIndex = 0;
    let match;
    let blockCounter = 0;

    while ((match = codeBlockRegex.exec(content)) !== null) {
      const textBefore = content.substring(lastIndex, match.index);

      if (textBefore.trim()) {
        elements.push(
          <div key={`text-${lastIndex}`} className="space-y-2 mb-3">
            {renderMarkdownParagraphs(textBefore, highlightQuery)}
          </div>
        );
      }

      const lang = match[1] || 'code';
      const codeText = match[2].trim();
      const blockId = `${messageId}-code-${blockCounter++}`;

      elements.push(
        <div
          key={blockId}
          className="my-4 border border-elegant-border rounded-lg overflow-hidden bg-elegant-dark font-mono text-xs text-elegant-text shadow-inner"
        >
          <div className="flex items-center justify-between bg-elegant-panel px-4 py-2 border-b border-elegant-border text-xxs text-elegant-muted">
            <span className="uppercase tracking-wide font-semibold text-elegant-gold/80">{lang}</span>
            <button
              onClick={() => handleCopyCode(codeText, blockId)}
              className="flex items-center space-x-1 hover:text-elegant-gold transition-colors cursor-pointer font-mono uppercase tracking-wider text-[10px]"
            >
              {copiedCodeId === blockId ? (
                <>
                  <Check className="w-3.5 h-3.5 text-elegant-gold" />
                  <span className="text-elegant-gold font-bold">Copied!</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5 text-elegant-muted" />
                  <span>Copy Code</span>
                </>
              )}
            </button>
          </div>
          <pre className="p-4 overflow-x-auto leading-relaxed max-w-full font-mono bg-elegant-dark">
            <code>{highlightText(codeText, highlightQuery)}</code>
          </pre>
        </div>
      );

      lastIndex = codeBlockRegex.lastIndex;
    }

    const textRemaining = content.substring(lastIndex);
    if (textRemaining.trim()) {
      elements.push(
        <div key="text-end" className="space-y-2">
          {renderMarkdownParagraphs(textRemaining, highlightQuery)}
        </div>
      );
    }

    return elements;
  };

  const hasText = !!(content && content.trim());
  const hasMedia = !!(media && media.length > 0);

  return (
    <div className="space-y-3">
      {hasMedia && (
        <div className="flex flex-wrap gap-3">
          {media!.map((m) =>
            m.url ? (
              <div
                key={m.id}
                className="block max-w-md border border-elegant-border rounded-lg overflow-hidden bg-elegant-dark/50"
              >
                <a href={m.url} target="_blank" rel="noopener noreferrer" className="block">
                  <img
                    src={m.url}
                    alt={m.alt || m.fileName || 'Attachment'}
                    className="max-h-80 w-full object-contain"
                    referrerPolicy="no-referrer"
                    onError={(e) => {
                      const el = e.target as HTMLImageElement;
                      el.style.display = 'none';
                      const fallback = el.parentElement?.parentElement?.querySelector(
                        '[data-media-fallback]'
                      ) as HTMLElement | null;
                      if (fallback) {
                        fallback.classList.remove('hidden');
                        fallback.classList.add('flex');
                      }
                    }}
                  />
                </a>
                <div
                  data-media-fallback
                  className="hidden p-4 items-center gap-2 text-elegant-muted text-xxs border-t border-elegant-border"
                >
                  <ImageOff className="w-4 h-4 shrink-0" />
                  <span className="break-all">
                    Image failed to load
                    {m.url.startsWith('http') ? (
                      <>
                        {' '}
                        (
                        <a
                          href={m.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-elegant-gold underline"
                        >
                          open URL
                        </a>
                        )
                      </>
                    ) : null}
                  </span>
                </div>
                <div className="px-2 py-1 text-[10px] text-elegant-muted border-t border-elegant-border font-mono flex items-center justify-between gap-2">
                  <span className="truncate">{m.alt || m.fileName || 'Image'}</span>
                  {m.fetchStatus === 'ok' && m.remoteUrl && (
                    <span className="text-elegant-gold shrink-0 uppercase tracking-wider text-[9px]">
                      Saved local
                    </span>
                  )}
                  {m.fetchStatus === 'cors' && (
                    <span className="text-red-400/90 shrink-0 uppercase tracking-wider text-[9px]">
                      CORS blocked
                    </span>
                  )}
                  {m.fetchStatus === 'failed' && (
                    <span className="text-red-400/90 shrink-0 uppercase tracking-wider text-[9px]">
                      Fetch failed
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <div
                key={m.id}
                className="p-4 border border-elegant-border rounded-lg bg-elegant-dark/50 text-elegant-muted text-xxs flex items-center gap-2 max-w-md"
              >
                <ImageOff className="w-4 h-4 shrink-0" />
                <span>
                  Image asset referenced (
                  {(m.assetKey || m.id || '').toString().slice(0, 12)}
                  …) — re-import the full export folder including{' '}
                  <code className="text-elegant-gold">prod-mc-asset-server</code>
                </span>
              </div>
            )
          )}
        </div>
      )}
      {hasText ? (
        renderFormattedContent()
      ) : hasMedia ? null : (
        <p className="text-xxs text-elegant-muted italic">Empty message</p>
      )}
    </div>
  );
}
