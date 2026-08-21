import { useEffect, useId, useState } from 'react';

/**
 * A typeface, shown as itself.
 *
 * The only way to preview a font is to install it and set some text in it, so
 * that is what this does: the bytes become an `@font-face` under a name unique
 * to this preview, and the samples below use it. The name is scoped because two
 * fonts previewed in one session must not fight over one family name, and the
 * rule is removed on unmount so a font nobody is looking at is not left
 * installed on the page.
 */

const SAMPLES = [
  'The quick brown fox jumps over the lazy dog',
  'Sphinx of black quartz, judge my vow',
  '0123456789 &@#$%â€¢ (){}[] <>/\\ .,;:!?',
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  'abcdefghijklmnopqrstuvwxyz',
];

const SIZES = [14, 18, 24, 32, 44, 60, 84];

export function FontViewer({ src, name }: { src: string; name: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const family = `orbit-preview-${id}`;

  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [size, setSize] = useState(32);
  const [custom, setCustom] = useState('');

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setFailed(false);

    void (async () => {
      try {
        const response = await fetch(src, { credentials: 'include' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const face = new FontFace(family, await response.arrayBuffer());
        await face.load();
        if (cancelled) return;

        // The document's font set, not a style element: this way the browser
        // reports a font it cannot parse as a rejection rather than silently
        // rendering everything in a fallback and looking like a bad preview.
        document.fonts.add(face);
        setReady(true);

        return () => document.fonts.delete(face);
      } catch {
        if (!cancelled) setFailed(true);
      }
      return undefined;
    })();

    return () => {
      cancelled = true;
    };
  }, [src, family]);

  if (failed) {
    return (
      <div className="office-view office-view--message">
        <p style={{ color: 'var(--danger)' }}>
          {name} could not be loaded as a font. It may be damaged, or in a format this browser does
          not read.
        </p>
      </div>
    );
  }

  return (
    <div className="office-view">
      <div className="office-view__tabs font-view__bar">
        <label>
          Size
          <input
            type="range"
            min={0}
            max={SIZES.length - 1}
            value={SIZES.indexOf(size) === -1 ? 3 : SIZES.indexOf(size)}
            onChange={(event) => setSize(SIZES[Number(event.target.value)] ?? 32)}
            aria-label="Sample size"
          />
          <span className="font-view__size">{size}px</span>
        </label>

        <input
          className="clay-sunken font-view__input"
          placeholder="Type to see your own text…"
          value={custom}
          onChange={(event) => setCustom(event.target.value)}
          aria-label="Custom sample text"
        />
      </div>

      <div className="office-view__scroll">
        <div className="font-view__samples" style={{ fontFamily: ready ? family : 'inherit' }}>
          {custom && (
            <p style={{ fontSize: size }} className="font-view__line">
              {custom}
            </p>
          )}

          {SAMPLES.map((sample) => (
            <p key={sample} style={{ fontSize: size }} className="font-view__line">
              {sample}
            </p>
          ))}
        </div>
      </div>

      <p className="office-view__note">
        {ready ? `Set in ${name}.` : `Loading ${name}…`} Only the characters this font actually
        contains will render in it.
      </p>
    </div>
  );
}
