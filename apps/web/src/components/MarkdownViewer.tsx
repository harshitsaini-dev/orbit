import { lazy, Suspense, useState } from 'react';
import { CodeViewer } from './CodeViewer.js';

/**
 * Markdown, rendered or raw.
 *
 * Rendering goes through react-markdown rather than a regex pass of my own: a
 * markdown renderer written by hand is where cross-site scripting lives, and
 * this one escapes by default and is given no plugin that would let raw HTML
 * through. A README is exactly the kind of file that arrives from somewhere
 * else.
 *
 * The raw view is not a fallback but the point of having both — a README is
 * read rendered, a template or a table of front matter is read as source.
 */

const Rendered = lazy(async () => {
  const [{ default: Markdown }, { default: gfm }] = await Promise.all([
    import('react-markdown'),
    import('remark-gfm'),
  ]);

  return {
    default: ({ text }: { text: string }) => (
      <div className="markdown-body">
        {/* GitHub-flavoured: tables, task lists and strikethrough, which is
            what people actually write. No rehype-raw, so embedded HTML stays
            visible as text rather than becoming part of the page. */}
        <Markdown remarkPlugins={[gfm]}>{text}</Markdown>
      </div>
    ),
  };
});

export function MarkdownViewer({ text, name }: { text: string; name: string }) {
  const [raw, setRaw] = useState(false);

  return (
    <div className="office-view">
      <div className="office-view__tabs" role="tablist" aria-label="View">
        <button type="button" role="tab" aria-selected={!raw} onClick={() => setRaw(false)}>
          Rendered
        </button>
        <button type="button" role="tab" aria-selected={raw} onClick={() => setRaw(true)}>
          Source
        </button>
      </div>

      {raw ? (
        <CodeViewer text={text} name={name} />
      ) : (
        <div className="office-view__scroll">
          <Suspense fallback={<p className="office-view__note">Rendering…</p>}>
            <Rendered text={text} />
          </Suspense>
        </div>
      )}
    </div>
  );
}
