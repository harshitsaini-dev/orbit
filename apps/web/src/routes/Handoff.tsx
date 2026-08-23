import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { formatBytes } from '../lib/format.js';
import { newHandoff, receive, send, type Handle, type Progress } from '../lib/p2p.js';

/**
 * Sending a file straight to somebody, without it going anywhere first.
 *
 * The bytes travel browser to browser. They do not reach Orbit's server, they
 * are not put in a drive, and nothing is left behind when the tab closes -
 * which is the point: the alternative is uploading a file somewhere just so
 * that a second person can take it down again.
 *
 * The cost of that honesty is that it does not always work. Two networks that
 * cannot see each other need a relay in the middle, a relay is bandwidth
 * somebody pays for, and Orbit does not have one - so about one attempt in ten
 * cannot connect. That is said here in advance rather than discovered by
 * watching a bar that never moves, and the ordinary path is one link away.
 */

function speed(rate: number): string {
  return rate > 0 ? `${formatBytes(rate)}/s` : '—';
}

export function Handoff() {
  const location = useLocation();

  /*
   * Read from the fragment, never the path.
   *
   * The id is the whole capability - anyone holding it is one end of the
   * transfer - and a fragment is the one part of a URL a browser never sends to
   * a server. It is therefore not in Orbit's logs, not in Vercel's, and not in
   * any proxy in between.
   */
  const joining = location.hash.slice(1);

  return joining ? <Receiving handoff={joining} /> : <Sending />;
}

function Sending() {
  const [file, setFile] = useState<File | null>(null);
  const [handoff, setHandoff] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const handleRef = useRef<Handle | null>(null);

  useEffect(() => {
    return () => handleRef.current?.cancel();
  }, []);

  const start = useCallback((chosen: File) => {
    const id = newHandoff();
    setFile(chosen);
    setHandoff(id);
    handleRef.current = send(id, chosen, setProgress);
  }, []);

  const link = handoff ? `${window.location.origin}/handoff#${handoff}` : '';

  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      <section className="clay" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)', display: 'grid', gap: '0.9rem' }}>
        <div style={{ display: 'grid', gap: 4 }}>
          <h1 className="page-title">Send a file directly</h1>
          <p className="page-subtitle">
            Straight from this browser to theirs. It is not uploaded to Orbit, it is not put in a
            drive, and nothing is left behind when you close the tab.
          </p>
        </div>

        {!file && (
          <>
            <input
              ref={inputRef}
              type="file"
              aria-label="Choose a file to send"
              style={{ display: 'none' }}
              onChange={(event) => {
                const chosen = event.target.files?.[0];
                if (chosen) start(chosen);
                event.target.value = '';
              }}
            />

            <div>
              <button
                type="button"
                className="clay-button clay-button--accent"
                onClick={() => inputRef.current?.click()}
              >
                Choose a file
              </button>
            </div>

            <p className="share-hint" style={{ margin: 0 }}>
              Both tabs have to stay open until it finishes — there is nowhere for a half-sent file
              to wait.
            </p>
          </>
        )}

        {file && handoff && (
          <>
            <p style={{ margin: 0, fontSize: 14 }}>
              <strong style={{ overflowWrap: 'anywhere' }}>{file.name}</strong>
              <br />
              <span style={{ color: 'var(--text-muted)' }}>{formatBytes(file.size)}</span>
            </p>

            <div className="share-link">
              <input readOnly value={link} aria-label="Link to give them" />
              <button
                type="button"
                className="clay-button clay-button--accent"
                onClick={() => {
                  void navigator.clipboard.writeText(link).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1600);
                  });
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>

            <p className="share-hint" style={{ margin: 0 }}>
              Give them this link. It carries the whole transfer — anyone who has it is the other
              end, so send it the way you would send the file.
            </p>

            <Status progress={progress} />
          </>
        )}
      </section>
    </div>
  );
}

function Receiving({ handoff }: { handoff: string }) {
  const [progress, setProgress] = useState<Progress | null>(null);
  const [ready, setReady] = useState<File | null>(null);
  const handleRef = useRef<Handle | null>(null);

  useEffect(() => {
    handleRef.current = receive(handoff, setProgress, setReady);
    return () => handleRef.current?.cancel();
  }, [handoff]);

  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      <section className="clay" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)', display: 'grid', gap: '0.9rem' }}>
        <div style={{ display: 'grid', gap: 4 }}>
          <h1 className="page-title">Someone is sending you a file</h1>
          <p className="page-subtitle">
            It comes straight from their browser to yours. Keep this tab open until it finishes.
          </p>
        </div>

        <Status progress={progress} />

        {ready && (
          <div>
            <button
              type="button"
              className="clay-button clay-button--accent"
              onClick={() => {
                const url = URL.createObjectURL(ready);
                const link = document.createElement('a');
                link.href = url;
                link.download = ready.name;
                link.click();
                setTimeout(() => URL.revokeObjectURL(url), 30_000);
              }}
            >
              Save {ready.name}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

/** The one place either end says what is happening, so both say it the same way. */
function Status({ progress }: { progress: Progress | null }) {
  if (!progress) return null;

  const pct = progress.total > 0 ? Math.min(100, (progress.bytes / progress.total) * 100) : 0;

  if (progress.phase === 'unreachable') {
    return (
      <div style={{ display: 'grid', gap: '0.5rem' }}>
        <p style={{ margin: 0, color: 'var(--danger)', fontSize: 14, lineHeight: 1.6 }}>
          These two networks cannot reach each other directly.
        </p>
        <p className="share-hint" style={{ margin: 0 }}>
          A direct transfer needs a path between the two browsers, and some pairs of networks have
          none. Bridging that needs a relay, which is bandwidth somebody pays for — Orbit does not
          run one, which is why this feature costs nothing.
        </p>
        <p className="share-hint" style={{ margin: 0 }}>
          The ordinary way still works: <Link to="/my-drive">upload it to a drive</Link> and share
          the link.
        </p>
      </div>
    );
  }

  if (progress.phase === 'left') {
    return (
      <p style={{ margin: 0, color: 'var(--danger)', fontSize: 14 }}>
        The other side closed their tab before it finished. Nothing was saved — there is nowhere
        for half a file to wait.
      </p>
    );
  }

  if (progress.phase === 'failed') {
    return (
      <p role="alert" style={{ margin: 0, color: 'var(--danger)', fontSize: 14 }}>
        {progress.error ?? 'The transfer stopped.'}
      </p>
    );
  }

  return (
    <div style={{ display: 'grid', gap: '0.5rem' }}>
      <div
        className="clay-sunken"
        style={{ height: 8, borderRadius: 999, overflow: 'hidden' }}
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Transfer"
      >
        <div
          style={{
            height: '100%',
            width: `${pct}%`,
            background: 'var(--accent)',
            transition: 'width var(--dur-fast) linear',
          }}
        />
      </div>

      <p style={{ margin: 0, fontSize: 13.5, color: 'var(--text-muted)' }} data-testid="handoff-status">
        {progress.phase === 'waiting' && 'Waiting for the other side to open the link…'}
        {progress.phase === 'connecting' && 'Connecting…'}
        {progress.phase === 'transferring' &&
          `${formatBytes(progress.bytes)} of ${formatBytes(progress.total)} · ${speed(progress.rate)}`}
        {progress.phase === 'done' && 'Done.'}
      </p>
    </div>
  );
}
