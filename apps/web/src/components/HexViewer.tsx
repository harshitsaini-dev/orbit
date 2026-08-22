import { useCallback, useEffect, useState } from 'react';
import { formatBytes } from '../lib/format.js';
import { describeSignature } from '../lib/signature.js';

/**
 * The bytes themselves, for a file nothing can render.
 *
 * The point is not to read a binary in hex - nobody does that here. It is to
 * answer "what actually is this?" for a file whose name and type disagree, or
 * whose extension is missing entirely: the first sixteen bytes usually say,
 * and the answer is on the screen instead of behind a download.
 *
 * A page at a time over a Range request, which the content route already
 * honours. Downloading a 4 GB disk image to look at its header would be the
 * one way to make this worse than not having it.
 */

const PAGE = 4 * 1024;
/** Reading a whole file in hex is not what this is for. */
const CEILING = 256 * 1024;

interface Props {
  src: string;
  name: string;
  sizeBytes: number;
}

function hex(byte: number): string {
  return byte.toString(16).padStart(2, '0');
}

/** Anything outside printable ASCII is a dot, which is the convention. */
function printable(byte: number): string {
  return byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.';
}

export function HexViewer({ src, name, sizeBytes }: Props) {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const reachable = Math.min(sizeBytes || CEILING, CEILING);

  const loadTo = useCallback(
    async (end: number) => {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch(src, {
          credentials: 'include',
          headers: { range: `bytes=0-${end - 1}` },
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const buffer = await response.arrayBuffer();
        /*
         * A provider that ignores Range answers 200 with the whole file, and
         * the browser has already held all of it by the time this runs. The
         * slice keeps the page honest about how much it is showing; it cannot
         * undo the download.
         */
        setBytes(new Uint8Array(buffer.slice(0, end)));
      } catch {
        setError('Could not read this file.');
      } finally {
        setLoading(false);
      }
    },
    [src],
  );

  useEffect(() => {
    void loadTo(Math.min(PAGE, reachable));
  }, [loadTo, reachable]);

  if (error) return <p style={{ color: 'var(--danger)' }}>{error}</p>;
  if (!bytes) return <p style={{ color: 'var(--text-muted)' }}>Reading the first bytes…</p>;

  const rows: number[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16) rows.push(offset);

  const signature = describeSignature(bytes);
  const more = bytes.length < reachable;

  return (
    <div className="code-view hex-view">
      <div className="code-view__bar">
        <strong style={{ fontSize: 12, letterSpacing: '0.04em' }}>BYTES</strong>
        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
          {formatBytes(bytes.length)} of {formatBytes(sizeBytes)} read
          {signature && ` · looks like ${signature}`}
        </span>

        {more && (
          <button
            type="button"
            className="clay-button"
            style={{ padding: '0.25rem 0.8rem', fontSize: 12, marginLeft: 'auto' }}
            disabled={loading}
            onClick={() => void loadTo(Math.min(bytes.length + PAGE, reachable))}
          >
            {loading ? 'Reading…' : 'Read more'}
          </button>
        )}
      </div>

      <div className="hex-view__body">
        <table aria-label={`Bytes of ${name}`}>
          <tbody>
            {rows.map((offset) => {
              const row = bytes.subarray(offset, offset + 16);

              return (
                <tr key={offset}>
                  <th scope="row">{offset.toString(16).padStart(8, '0')}</th>
                  <td className="hex-view__hex">
                    {/* Two groups of eight, which is what makes a row scannable
                        by eye rather than a wall of digits. */}
                    {Array.from(row, hex).join(' ').replace(/^((?:\S\S ){8})/, '$1 ')}
                  </td>
                  <td className="hex-view__text">{Array.from(row, printable).join('')}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
