import { Fragment, type ReactNode } from 'react';

// Minimal inline markdown renderer tuned for streaming LLM output.
//
// Supports only the constructs the chat / narrate endpoints are
// instructed to emit: `## heading`, `### subheading`, `- bullet`,
// `* bullet`, `1. numbered`, `**bold**`, `*italic*`, `` `code` ``,
// and plain paragraphs. Everything else passes through as literal
// text.
//
// Designed to be streaming-safe:
//   * Partial `**bo` at the end of the current text doesn't throw or
//     render nonsense — the regex only matches complete `**…**`
//     pairs. The next token completes it and the whole paragraph
//     re-renders.
//   * The parser processes the text top-to-bottom per line, so
//     heading / bullet detection activates as soon as the terminating
//     character arrives.
//
// This is deliberately NOT a full markdown-ast implementation.
// Pulling in ``react-markdown`` + ``remark-gfm`` would add ~60KB to
// the main bundle for features we don't use. If we ever need tables,
// footnotes, or HTML, swap this file for that library.

// ── Inline formatting: bold → code → italic ──────────────────────
//
// Order matters. We split on bold first so the italic pass can't
// accidentally grab one of the asterisks from a bold marker.
function renderInline(text: string): ReactNode[] {
  // Split on bold markers.
  const boldParts = text.split(/(\*\*[^*\n]+\*\*)/g);
  const out: ReactNode[] = [];
  let key = 0;

  for (const part of boldParts) {
    if (part.startsWith('**') && part.endsWith('**')) {
      out.push(
        <strong key={key++} className="font-semibold text-fg">
          {part.slice(2, -2)}
        </strong>,
      );
      continue;
    }
    // Within non-bold text, split on inline code.
    const codeParts = part.split(/(`[^`\n]+`)/g);
    for (const cp of codeParts) {
      if (cp.startsWith('`') && cp.endsWith('`') && cp.length >= 2) {
        out.push(
          <code
            key={key++}
            className="rounded bg-surface-2 px-1 py-px font-mono text-[10px] text-fg-secondary"
          >
            {cp.slice(1, -1)}
          </code>,
        );
        continue;
      }
      // Within non-code text, handle italic. Match `*text*` but NOT
      // `**text**` (caught above). Also skip bare `*` that's a list
      // marker — the line-level parser already stripped those.
      const italicParts = cp.split(/(?<!\*)\*(?!\*)([^\n*]+?)(?<!\*)\*(?!\*)/g);
      for (let i = 0; i < italicParts.length; i++) {
        const segment = italicParts[i];
        // split() with a capture group alternates non-match / match,
        // so even indices are plain text and odd indices are italic
        // content.
        if (i % 2 === 1) {
          out.push(
            <em key={key++} className="italic">
              {segment}
            </em>,
          );
        } else if (segment) {
          out.push(<Fragment key={key++}>{segment}</Fragment>);
        }
      }
    }
  }
  return out;
}

export interface MarkdownProps {
  text: string;
  /** Optional density override. Defaults to the wider spacing used
      in the OCPM narrative. Set to "compact" for inline chat. */
  variant?: 'default' | 'compact';
}

export function Markdown({ text, variant = 'default' }: MarkdownProps) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  const compact = variant === 'compact';

  const textSize = compact ? 'text-[12px]' : 'text-[12px]';
  const headingSpacing = compact ? 'mt-2' : 'mt-3';
  const listSpacing = compact ? 'mt-0.5 space-y-0.5' : 'mt-1 space-y-1';
  const paraSpacing = compact ? 'mt-0.5' : 'mt-1';
  const containerSpacing = compact ? 'space-y-0.5' : 'space-y-1';

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trimEnd();

    if (!line.trim()) {
      i += 1;
      continue;
    }

    // # Heading (H1)
    if (/^#\s+/.test(line)) {
      blocks.push(
        <h3
          key={key++}
          className={`${headingSpacing} ${compact ? 'text-[13px]' : 'text-[14px]'} font-bold text-fg first:mt-0`}
        >
          {renderInline(line.replace(/^#\s+/, ''))}
        </h3>,
      );
      i += 1;
      continue;
    }

    // ## Heading
    if (/^##\s+/.test(line)) {
      blocks.push(
        <h4
          key={key++}
          className={`${headingSpacing} ${textSize} font-semibold uppercase tracking-wide text-accent first:mt-0`}
        >
          {renderInline(line.replace(/^##\s+/, ''))}
        </h4>,
      );
      i += 1;
      continue;
    }

    // ### Subheading
    if (/^###\s+/.test(line)) {
      blocks.push(
        <h5
          key={key++}
          className={`${headingSpacing} ${textSize} font-semibold text-fg first:mt-0`}
        >
          {renderInline(line.replace(/^###\s+/, ''))}
        </h5>,
      );
      i += 1;
      continue;
    }

    // Bullet group: `- foo` or `* foo`
    if (/^[-*]\s+/.test(line)) {
      const items: ReactNode[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        const body = lines[i].trim().replace(/^[-*]\s+/, '');
        items.push(
          <li key={key++} className="leading-relaxed">
            {renderInline(body)}
          </li>,
        );
        i += 1;
      }
      blocks.push(
        <ul
          key={key++}
          className={`${listSpacing} list-disc pl-5 ${textSize} text-fg-secondary`}
        >
          {items}
        </ul>,
      );
      continue;
    }

    // Numbered list: `1. foo` / `10. foo`
    if (/^\d+\.\s+/.test(line)) {
      const items: ReactNode[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        const body = lines[i].trim().replace(/^\d+\.\s+/, '');
        items.push(
          <li key={key++} className="leading-relaxed">
            {renderInline(body)}
          </li>,
        );
        i += 1;
      }
      blocks.push(
        <ol
          key={key++}
          className={`${listSpacing} list-decimal pl-5 ${textSize} text-fg-secondary`}
        >
          {items}
        </ol>,
      );
      continue;
    }

    // Paragraph: gather until blank / heading / bullet / numbered
    const para: string[] = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^##\s+/.test(lines[i].trim()) &&
      !/^###\s+/.test(lines[i].trim()) &&
      !/^[-*]\s+/.test(lines[i].trim()) &&
      !/^\d+\.\s+/.test(lines[i].trim())
    ) {
      para.push(lines[i].trimEnd());
      i += 1;
    }
    blocks.push(
      <p
        key={key++}
        className={`${paraSpacing} ${textSize} leading-relaxed text-fg-secondary`}
      >
        {renderInline(para.join(' '))}
      </p>,
    );
  }

  return <div className={containerSpacing}>{blocks}</div>;
}

export default Markdown;
