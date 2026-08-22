import { useCallback, useEffect, useRef, useState } from 'react';
import type { OrbitFile } from '@orbit/shared-types';
import { api } from '../lib/api.js';
import { readImage, stopOcr } from '../lib/ocr.js';
import { Modal, DialogActions } from './Modal.js';

/**
 * Reading the text out of pictures, one at a time, while somebody watches.
 *
 * Deliberately not silent and not automatic. A scan is minutes of a laptop's
 * fans and six megabytes of engine on the first run, and a product that
 * started that on its own the moment somebody opened a folder of four hundred
 * photos would be a product that had decided how to spend their battery.
 *
 * So it is asked for, it says what it will cost before it starts, it can be
 * stopped in the middle, and everything read up to that point is kept - a
 * cancelled scan of forty photos leaves thirty-eight scanned, not nothing.
 */

interface Props {
  files: OrbitFile[];
  accountId: string;
  /** How to fetch a file's bytes. The dialog does not know Orbit's API shape. */
  contentUrl: (file: OrbitFile) => string;
  onClose: () => void;
  /** Told how many readings landed, so a page can refresh what it shows. */
  onDone?: (stored: number) => void;
}

type Phase = 'asking' | 'running' | 'finished';

export function ScanDialog({ files, accountId, contentUrl, onClose, onDone }: Props) {
  const [phase, setPhase] = useState<Phase>('asking');
  const [done, setDone] = useState(0);
  const [stored, setStored] = useState(0);
  const [current, setCurrent] = useState('');
  const [ratio, setRatio] = useState(0);
  const [failed, setFailed] = useState(0);
  const [skipped, setSkipped] = useState(0);

  /*
   * Read inside the loop rather than depended on by it. A cancel has to be
   * seen by a loop already running, and state would still be the old value
   * inside the closure that loop was started with.
   */
  const stopped = useRef(false);

  // Whatever the outcome - finished, cancelled, or the dialog closed halfway -
  // the engine's six megabytes go back.
  useEffect(() => {
    /*
     * Cleared on the way in as well as set on the way out. StrictMode mounts,
     * unmounts and mounts again in development, so the cleanup runs once
     * before anybody has pressed anything - and a flag only ever set to true
     * meant the loop stopped on its first check, every time, in a way that
     * looked exactly like OCR finding nothing.
     */
    stopped.current = false;

    return () => {
      stopped.current = true;
      void stopOcr();
    };
  }, []);

  const run = useCallback(async () => {
    stopped.current = false;
    setPhase('running');

    /*
     * Anything already read is skipped. The alternative is spending minutes
     * to arrive at an answer that is already in the database, and somebody
     * who scans a folder, adds two photos and scans again should pay for the
     * two.
     */
    let known: string[] = [];

    try {
      const result = await api<{ scanned: string[] }>('/api/text/known', {
        method: 'POST',
        body: { accountId, remoteIds: files.map((file) => file.remoteId) },
      });
      known = result.scanned;
    } catch {
      // Not knowing means scanning again, which is slow rather than wrong.
    }

    let kept = 0;
    let lost = 0;
    let past = 0;

    for (const file of files) {
      if (stopped.current) break;

      if (known.includes(file.remoteId)) {
        past += 1;
        setSkipped(past);
        setDone((n) => n + 1);
        continue;
      }

      setCurrent(file.name);
      setRatio(0);

      try {
        const response = await fetch(contentUrl(file), { credentials: 'include' });
        if (!response.ok) throw new Error('fetch');

        const reading = await readImage(await response.blob(), setRatio);
        if (stopped.current) break;

        const { stored: wasStored } = await api<{ stored: boolean }>('/api/text', {
          method: 'POST',
          body: {
            accountId,
            remoteId: file.remoteId,
            name: file.name,
            virtualPath: file.virtualPath,
            text: reading.text,
            confidence: reading.confidence,
          },
        });

        if (wasStored) {
          kept += 1;
          setStored(kept);
        }
      } catch {
        // One unreadable file is not a failed scan. It is counted and the
        // rest of the folder carries on.
        lost += 1;
        setFailed(lost);
      }

      setDone((n) => n + 1);
    }

    setPhase('finished');
    void stopOcr();
    onDone?.(kept);
  }, [accountId, contentUrl, files, onDone]);

  const total = files.length;
  const overall = total === 0 ? 0 : (done + (phase === 'running' ? ratio : 0)) / total;

  return (
    <Modal
      title={total === 1 ? 'Read the text in this picture' : `Read the text in ${total} pictures`}
      description="Runs on this device. The pictures are not uploaded anywhere and no service is called - only the words that come out are saved, so the file can be found by them."
      onClose={onClose}
    >
      <div style={{ display: 'grid', gap: '0.9rem' }}>
        {phase === 'asking' && (
          <>
            <p className="share-hint" style={{ margin: 0 }}>
              About a second or two each, and roughly six megabytes of engine the first time you
              ever do this. You can stop partway - anything already read is kept.
            </p>
            <p className="share-hint" style={{ margin: 0 }}>
              Pictures that have been read before are skipped.
            </p>
          </>
        )}

        {phase !== 'asking' && (
          <>
            <div
              className="clay-sunken"
              style={{ height: 8, borderRadius: 999, overflow: 'hidden' }}
              role="progressbar"
              aria-valuenow={Math.round(overall * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Reading"
            >
              <div
                style={{
                  height: '100%',
                  width: `${Math.min(100, overall * 100)}%`,
                  background: 'var(--accent)',
                  transition: 'width var(--dur-fast) linear',
                }}
              />
            </div>

            <p style={{ margin: 0, fontSize: 13.5, color: 'var(--text-muted)' }}>
              {phase === 'running' ? (
                <>
                  {done} of {total} · <span style={{ overflowWrap: 'anywhere' }}>{current}</span>
                </>
              ) : (
                <>
                  Read {done} of {total}.
                </>
              )}
            </p>

            <p className="share-hint" style={{ margin: 0 }}>
              {stored} with text found
              {skipped > 0 && ` · ${skipped} already read`}
              {failed > 0 && ` · ${failed} could not be read`}
            </p>

            {phase === 'finished' && stored > 0 && (
              <p className="share-hint" style={{ margin: 0 }}>
                Search for anything written in them and they will come up.
              </p>
            )}
          </>
        )}

        <DialogActions>
          {phase === 'asking' && (
            <>
              <button type="button" className="clay-button" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="clay-button clay-button--accent"
                onClick={() => void run()}
              >
                Read {total === 1 ? 'it' : `all ${total}`}
              </button>
            </>
          )}

          {phase === 'running' && (
            <button
              type="button"
              className="clay-button"
              onClick={() => {
                stopped.current = true;
              }}
            >
              Stop
            </button>
          )}

          {phase === 'finished' && (
            <button type="button" className="clay-button clay-button--accent" onClick={onClose}>
              Done
            </button>
          )}
        </DialogActions>
      </div>
    </Modal>
  );
}
