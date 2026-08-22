import { useMemo, useState } from 'react';
import { HIGHLIGHT_LIMIT, languageLabel, tokenise } from '../lib/highlight.js';

/**
 * Text and source files, with line numbers and colour.
 *
 * Tokens become elements rather than markup, so nothing in a file can be
 * rendered as HTML. Highlighting is per line so the line numbers can stay in a
 * column of their own and remain unselectable - copying a block of code and
 * getting the line numbers with it is the thing that makes a numbered view
 * useless.
 */
export function CodeViewer({ text, name }: { text: string; name: string }) {
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);

  const lines = useMemo(() => {
    const source = text.endsWith('\n') ? text.slice(0, -1) : text;
    // Tokenise once over the whole file so a block comment spanning lines is
    // still one comment, then split the tokens back onto their lines.
    const tokens = tokenise(source, name);
    const out: Array<Array<{ text: string; type: string }>> = [[]];

    for (const token of tokens) {
      const parts = token.text.split('\n');
      parts.forEach((part, index) => {
        if (index > 0) out.push([]);
        if (part) out[out.length - 1]!.push({ text: part, type: token.type });
      });
    }

    return out;
  }, [text, name]);

  const label = languageLabel(name);
  const highlighted = text.length <= HIGHLIGHT_LIMIT;

  return (
    <div className="code-view">
      <div className="code-view__bar">
        <span className="code-view__lang">{label}</span>
        <span className="code-view__meta">
          {lines.length.toLocaleString()} {lines.length === 1 ? 'line' : 'lines'}
          {!highlighted && ' · too large to colour'}
        </span>

        <span style={{ flex: 1 }} />

        <button
          type="button"
          className="clay-button"
          aria-pressed={wrap}
          onClick={() => setWrap((current) => !current)}
        >
          {wrap ? 'No wrap' : 'Wrap'}
        </button>

        <button
          type="button"
          className="clay-button"
          onClick={() => {
            void navigator.clipboard.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            });
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <div className="code-view__scroll" data-wrap={wrap ? '' : undefined}>
        <ol className="code-view__lines" aria-label={`Contents of ${name}`}>
          {lines.map((tokens, index) => (
             
            <li key={index}>
              <code>
                {tokens.map((token, position) => (
                  <span
                     
                    key={position}
                    className={token.type === 'plain' ? undefined : `tok tok--${token.type}`}
                  >
                    {token.text}
                  </span>
                ))}
                {/* An empty line still needs height, and a zero-width space is
                    the only thing that gives it one without being copied. */}
                {tokens.length === 0 ? '​' : null}
              </code>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
