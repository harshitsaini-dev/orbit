import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { catalogueEntry, type OrbitFile, type PublicAccount } from '@orbit/shared-types';
import { api } from '../lib/api.js';
import { searchCache } from '../lib/cache.js';
import { formatBytes } from '../lib/format.js';
import { FileIcon } from './FileIcon.js';
import { ProviderIcon } from './ProviderIcon.js';

/**
 * Search across every connected account, from anywhere, on Ctrl/Cmd + K.
 *
 * The point is the question it answers: "which cloud is that invoice in". So
 * every result carries the service it came from, and the two halves of the
 * search are shown as what they are — matches already on this device appear at
 * once, and the provider's own answer replaces them when it arrives.
 *
 * The local half is deliberately labelled rather than merged silently. It only
 * covers folders that have been opened, so presenting it as the result would be
 * telling someone a file is not there when Orbit simply has not looked.
 */

interface Hit {
  file: OrbitFile;
  accountId: string;
  /** Present on provider results; the cache stores the path instead. */
  location?: string;
}

interface SearchResponse {
  files: Array<OrbitFile & { accountId: string; accountNickname: string; provider: string }>;
}

export function Spotlight({
  accounts,
  onClose,
}: {
  accounts: PublicAccount[];
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);

  const [text, setText] = useState('');
  const [local, setLocal] = useState<Hit[]>([]);
  const [remote, setRemote] = useState<Hit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [active, setActive] = useState(0);

  const byId = useMemo(
    () => new Map(accounts.map((account) => [account.id, account])),
    [accounts],
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // The cache answers immediately; nothing is debounced, because reading an
  // object store is not a request.
  useEffect(() => {
    let cancelled = false;
    void searchCache(text).then((files) => {
      if (!cancelled) {
        setLocal(files.map((file) => ({ file, accountId: file.accountId })));
        setActive(0);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [text]);

  // The provider's answer is a request per account, so it waits for a pause.
  useEffect(() => {
    if (text.trim().length < 2) {
      setRemote(null);
      setSearching(false);
      return;
    }

    const controller = new AbortController();
    setSearching(true);

    const timer = setTimeout(() => {
      api<SearchResponse>(`/api/search?q=${encodeURIComponent(text)}`, {
        signal: controller.signal,
      })
        .then(({ files }) => {
          setRemote(
            files.map((file) => ({
              file,
              accountId: file.accountId,
              location: file.virtualPath.slice(0, file.virtualPath.lastIndexOf('/')) || '/',
            })),
          );
          setActive(0);
        })
        .catch((err: Error) => {
          // An aborted search is the next keystroke, not a failure.
          if (err.name !== 'AbortError') setRemote([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 300);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [text]);

  // The provider's answer supersedes the local one rather than joining it: it
  // covers everything, so showing both would list most files twice.
  const results = remote ?? local;
  const fromCache = remote === null && local.length > 0;

  function open(hit: Hit): void {
    const account = byId.get(hit.accountId);
    if (!account) return;

    const folder = hit.file.isFolder
      ? hit.file.virtualPath
      : hit.file.virtualPath.slice(0, hit.file.virtualPath.lastIndexOf('/')) || '/';

    navigate(`/my-drive?account=${encodeURIComponent(hit.accountId)}&path=${encodeURIComponent(folder)}`);
    onClose();
  }

  return (
    <div
      className="spotlight__scrim"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="clay spotlight" role="dialog" aria-modal="true" aria-label="Search everything">
        <div className="spotlight__field">
          <SearchGlyph />
          <input
            ref={inputRef}
            type="search"
            value={text}
            placeholder="Search every connected account…"
            aria-label="Search every connected account"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                onClose();
              } else if (event.key === 'ArrowDown') {
                setActive((current) => Math.min(current + 1, results.length - 1));
              } else if (event.key === 'ArrowUp') {
                setActive((current) => Math.max(current - 1, 0));
              } else if (event.key === 'Enter') {
                const hit = results[active];
                if (hit) open(hit);
              } else {
                return;
              }
              event.preventDefault();
            }}
          />
          {searching && <span className="spotlight__spinner" aria-label="Searching" />}
        </div>

        {text.trim().length > 0 && (
          <>
            {results.length === 0 && !searching && (
              <p className="spotlight__empty">
                Nothing matches “{text}”{remote === null ? ' on this device yet' : ''}.
              </p>
            )}

            <ul className="spotlight__results">
              {results.map((hit, index) => {
                const account = byId.get(hit.accountId);
                const service = catalogueEntry(account?.catalogueKey ?? '')?.label ?? account?.provider;

                return (
                  <li key={`${hit.accountId}:${hit.file.remoteId}`}>
                    <button
                      type="button"
                      data-active={index === active ? '' : undefined}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => open(hit)}
                    >
                      <FileIcon
                        name={hit.file.name}
                        mimeType={hit.file.mimeType}
                        isFolder={hit.file.isFolder}
                        size={22}
                      />

                      <span className="spotlight__name">
                        <strong>{hit.file.name}</strong>
                        <span>{hit.location ?? hit.file.virtualPath}</span>
                      </span>

                      {/* The whole question this answers is which cloud it is in. */}
                      <span className="spotlight__where">
                        <ProviderIcon provider={account?.catalogueKey ?? account?.provider ?? ''} size={16} />
                        <span>{service}</span>
                        {!hit.file.isFolder && <span>· {formatBytes(hit.file.sizeBytes)}</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>

            {fromCache && (
              <p className="spotlight__note">
                Showing matches already on this device. Still searching every account…
              </p>
            )}
          </>
        )}

        {text.trim().length === 0 && (
          <p className="spotlight__note">
            Type to search every connected account at once. <kbd>Esc</kbd> closes.
          </p>
        )}
      </div>
    </div>
  );
}

/** Opens Spotlight on Ctrl/Cmd + K from anywhere in the workspace. */
export function useSpotlightShortcut(onOpen: () => void): void {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        // The browser's own find-in-page and address bar both live on this
        // combination in some builds; the page wins while it is focused.
        event.preventDefault();
        onOpen();
      }
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onOpen]);
}

const SearchGlyph = () => (
  <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true" style={{ display: 'block', flexShrink: 0 }}>
    <circle cx="10.8" cy="10.8" r="6.4" />
    <path d="M15.5 15.5 20.6 20.6" />
  </svg>
);
