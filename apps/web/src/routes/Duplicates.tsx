import { useCallback, useEffect, useState } from 'react';
import { catalogueEntry, mimeForName, type OrbitFile } from '@orbit/shared-types';
import { Checkbox } from '../components/Checkbox.js';
import { DragSelectBox, useDragSelect } from '../components/DragSelect.js';
import { FileIcon } from '../components/FileIcon.js';
import { FilePreview } from '../components/FilePreview.js';
import { GridViewIcon, ListViewIcon } from '../components/Icons.js';
import { ConfirmDialog } from '../components/NameDialog.js';
import { ProviderIcon } from '../components/ProviderIcon.js';
import { FileListSkeleton } from '../components/Skeleton.js';
import { StatusScreen, statusKindFor } from '../components/StatusScreen.js';
import { ApiError, api } from '../lib/api.js';
import { formatBytes } from '../lib/format.js';
import { fetchThumbnail, mightHaveThumbnail } from '../lib/thumbnails.js';

/**
 * The same file, found in more than one place.
 *
 * The distinction between certain and probable is the whole design. A checksum
 * that both sides published and that agree proves two files are the same; a
 * matching size and name does not, and presenting the second as the first is
 * how somebody deletes their only copy. So the two are labelled, sorted apart,
 * and a probable group never pre-selects anything.
 *
 * Everything else here follows from the same worry. A set can be opened and
 * looked at before anything is deleted, shown as pictures rather than as
 * filenames when that helps more, and dismissed outright when the answer is
 * that they were never duplicates.
 */

const API_BASE = import.meta.env.VITE_API_URL ?? '';

interface DuplicateFile {
  accountId: string;
  accountNickname: string;
  provider: string;
  catalogueKey: string | null;
  remoteId: string;
  name: string;
  virtualPath: string;
  sizeBytes: number;
}

interface Group {
  key: string;
  kind: 'identical' | 'probable';
  checksum?: string;
  sizeBytes: number;
  files: DuplicateFile[];
  reclaimableBytes: number;
}

interface Drive {
  accountId: string;
  nickname: string;
  files: number;
}

interface Report {
  groups: Group[];
  scanned: number;
  withoutChecksum: number;
  ignored: number;
  drives: Drive[];
}

type View = 'list' | 'grid';

/** The viewer wants a whole file; a duplicate row carries most of one. */
function asOrbitFile(file: DuplicateFile): OrbitFile {
  return {
    remoteId: file.remoteId,
    name: file.name,
    virtualPath: file.virtualPath,
    // The mirror stores no mime type, so the name supplies it. That is the same
    // thing the object stores do anyway.
    mimeType: mimeForName(file.name),
    sizeBytes: file.sizeBytes,
    isFolder: false,
    starred: false,
    modifiedAt: new Date(0).toISOString(),
  };
}

export function Duplicates() {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<View>(() =>
    // Remembered, because it is a preference about how somebody reads rather
    // than a decision about this visit.
    localStorage.getItem('orbit.duplicates.view') === 'grid' ? 'grid' : 'list',
  );
  const [showingIgnored, setShowingIgnored] = useState(false);
  const [previewing, setPreviewing] = useState<{ group: Group; file: DuplicateFile } | null>(null);

  // The same drag-to-select every other list of files has.
  const { containerRef, box } = useDragSelect({
    enabled: !confirming && !previewing,
    onSelect: (keys, additive) =>
      setSelected((current) => (additive ? new Set([...current, ...keys]) : new Set(keys))),
    onClear: () => setSelected(new Set()),
  });

  const keyOf = (file: DuplicateFile) => `${file.accountId}:${file.remoteId}`;

  const load = useCallback(async (includeIgnored: boolean) => {
    try {
      const query = includeIgnored ? '?includeIgnored=1' : '';
      setReport(await api<Report>(`/api/duplicates${query}`));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Could not look for duplicates'));
    }
  }, []);

  useEffect(() => {
    void load(showingIgnored);
  }, [load, showingIgnored]);

  function chooseView(next: View): void {
    setView(next);
    localStorage.setItem('orbit.duplicates.view', next);
  }

  function toggle(file: DuplicateFile): void {
    setSelected((current) => {
      const next = new Set(current);
      const key = keyOf(file);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /**
   * Selects every copy but the first in each certain group.
   *
   * Only the certain ones. Offering to bulk-select guesses is offering to
   * delete files nobody has established are duplicates.
   */
  function selectExtras(): void {
    const next = new Set<string>();
    for (const group of report?.groups ?? []) {
      if (group.kind !== 'identical') continue;
      for (const file of group.files.slice(1)) next.add(keyOf(file));
    }
    setSelected(next);
  }

  /** Every copy but the first, in this one set. */
  function selectExtrasIn(group: Group): void {
    setSelected((current) => {
      const next = new Set(current);
      for (const file of group.files.slice(1)) next.add(keyOf(file));
      return next;
    });
  }

  /**
   * Takes this set back out of the selection.
   *
   * Anything that can be selected in one action has to be unselectable in one
   * action: undoing a mis-click by hand across four copies is how the wrong
   * box ends up left ticked in a dialog that deletes files.
   */
  function clearIn(group: Group): void {
    setSelected((current) => {
      const next = new Set(current);
      for (const file of group.files) next.delete(keyOf(file));
      return next;
    });
  }

  function selectedIn(group: Group): number {
    return group.files.filter((file) => selected.has(keyOf(file))).length;
  }

  async function dismiss(group: Group): Promise<void> {
    // Optimistic: nothing is deleted, so the worst case of being wrong is a
    // row coming back on the next load.
    setReport((current) =>
      current ? { ...current, groups: current.groups.filter((g) => g.key !== group.key) } : current,
    );

    await api('/api/duplicates/ignore', {
      method: 'POST',
      body: { key: group.key, label: group.files[0]?.name ?? '' },
    }).catch(() => void load(showingIgnored));
  }

  async function restore(group: Group): Promise<void> {
    await api('/api/duplicates/ignore', { method: 'DELETE', body: { key: group.key } }).catch(
      () => undefined,
    );
    await load(showingIgnored);
  }

  async function deleteSelected(): Promise<void> {
    setBusy(true);

    // Grouped per account: the delete endpoint takes one account at a time.
    const byAccount = new Map<string, string[]>();
    for (const group of report?.groups ?? []) {
      for (const file of group.files) {
        if (!selected.has(keyOf(file))) continue;
        byAccount.set(file.accountId, [...(byAccount.get(file.accountId) ?? []), file.remoteId]);
      }
    }

    for (const [accountId, remoteIds] of byAccount) {
      await api('/api/files', { method: 'DELETE', body: { accountId, remoteIds } }).catch(
        () => undefined,
      );
    }

    setSelected(new Set());
    setConfirming(false);
    setBusy(false);
    await load(showingIgnored);
  }

  function contentUrlFor(accountId: string) {
    return (file: OrbitFile, download: boolean): string => {
      const query = new URLSearchParams({ accountId });
      if (download) {
        query.set('download', '1');
        query.set('name', file.name);
      }
      return `${API_BASE}/api/files/${encodeURIComponent(file.remoteId)}/content?${query.toString()}`;
    };
  }

  if (error && report === null) {
    return (
      <StatusScreen
        kind={error instanceof ApiError ? statusKindFor(error.status) : 'server-error'}
        onRetry={() => void load(showingIgnored)}
      />
    );
  }

  const reclaimable = (report?.groups ?? []).reduce(
    (sum, group) => sum + group.reclaimableBytes,
    0,
  );

  return (
    <div ref={containerRef} style={{ display: 'grid', gap: '1rem' }}>
      <DragSelectBox box={box} />

      <section className="clay" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
          <div style={{ display: 'grid', gap: 4 }}>
            <h1 className="page-title">Duplicates</h1>
            <p className="page-subtitle">
              {report === null
                ? 'Comparing every file Orbit has indexed…'
                : report.groups.length === 0
                  ? `Nothing duplicated across ${report.scanned.toLocaleString()} files.`
                  : `${report.groups.length} sets across ${report.scanned.toLocaleString()} files · ${formatBytes(reclaimable)} could be freed.`}
            </p>
          </div>

          <span style={{ flex: 1 }} />

          <div className="view-toggle" role="group" aria-label="How to show each set">
            <button
              type="button"
              aria-pressed={view === 'list'}
              title="One row per copy, with where it lives"
              onClick={() => chooseView('list')}
            >
              <ListViewIcon size={16} />
              <span>List</span>
            </button>
            <button
              type="button"
              aria-pressed={view === 'grid'}
              title="Bigger pictures, for telling photos apart"
              onClick={() => chooseView('grid')}
            >
              <GridViewIcon size={16} />
              <span>Grid</span>
            </button>
          </div>

          {selected.size > 0 && (
            <button
              type="button"
              className="clay-button"
              style={{ color: 'var(--danger)' }}
              onClick={() => setConfirming(true)}
            >
              Delete {selected.size} selected
            </button>
          )}

          {(report?.groups.some((group) => group.kind === 'identical') ?? false) && (
            <button type="button" className="clay-button" onClick={selectExtras}>
              Select the spare copies
            </button>
          )}

          {selected.size > 0 && (
            <button type="button" className="clay-button" onClick={() => setSelected(new Set())}>
              Clear selection
            </button>
          )}
        </div>

        {/* The scan reads the mirror, not the providers. A drive that has never
            been synced contributes nothing, and a report that quietly leaves
            one out is worse than one that says so. */}
        {report !== null && report.drives.length > 0 && (
          <p className="share-hint" style={{ marginTop: '0.9rem' }}>
            Across {report.drives.length} {report.drives.length === 1 ? 'drive' : 'drives'}:{' '}
            {report.drives.map((drive, index) => (
              <span key={drive.accountId}>
                {index > 0 && ', '}
                {drive.nickname}{' '}
                <span style={{ opacity: 0.7 }}>({drive.files.toLocaleString()})</span>
              </span>
            ))}
            {report.drives.some((drive) => drive.files === 0) && (
              <> — a drive showing none has nothing indexed yet; sync it to include it.</>
            )}
          </p>
        )}

        {report !== null && report.withoutChecksum > 0 && (
          <p className="share-hint" style={{ marginTop: '0.9rem' }}>
            {report.withoutChecksum.toLocaleString()} of {report.scanned.toLocaleString()} files
            publish no checksum Orbit can compare — those can only ever be matched on size and
            name, which is a guess rather than proof.
          </p>
        )}

        {/* A dismissal that cannot be undone is a decision people are right to
            avoid making, so the way back is on the page rather than buried. */}
        {report !== null && (report.ignored > 0 || showingIgnored) && (
          <p className="share-hint" style={{ marginTop: '0.6rem' }}>
            {showingIgnored
              ? 'Showing the sets you dismissed as well.'
              : `${report.ignored} ${report.ignored === 1 ? 'set is' : 'sets are'} hidden because you said they are not duplicates.`}{' '}
            <button
              type="button"
              className="link-button"
              onClick={() => setShowingIgnored((current) => !current)}
            >
              {showingIgnored ? 'Hide them again' : 'Show them'}
            </button>
          </p>
        )}
      </section>

      {report === null && (
        <section className="clay" style={{ padding: '0.75rem' }}>
          <FileListSkeleton rows={6} />
        </section>
      )}

      {report?.groups.map((group) => (
        <section key={group.key} className="clay dup-group">
          <header>
            <span className="dup-kind" data-kind={group.kind}>
              {group.kind === 'identical' ? 'Identical' : 'Possibly the same'}
            </span>
            <strong>{group.files[0]!.name}</strong>
            <span className="dup-meta">
              {formatBytes(group.sizeBytes)} each · {formatBytes(group.reclaimableBytes)} spare
            </span>

            <span className="dup-actions">
              {/* Anything selectable in one action has to be unselectable in
                  one action, so the two sit together rather than the second
                  being an undo somebody has to do by hand. */}
              {selectedIn(group) > 0 ? (
                <button type="button" className="clay-button" onClick={() => clearIn(group)}>
                  Unselect {selectedIn(group)}
                </button>
              ) : (
                group.kind === 'identical' && (
                  <button
                    type="button"
                    className="clay-button"
                    title="Every copy in this set but the first"
                    onClick={() => selectExtrasIn(group)}
                  >
                    Select spares
                  </button>
                )
              )}

              <button
                type="button"
                className="clay-button"
                title="These are not duplicates. Nothing is deleted; the set stops being raised."
                onClick={() => (showingIgnored ? void restore(group) : void dismiss(group))}
              >
                {showingIgnored ? 'Bring back' : 'Not duplicates'}
              </button>
            </span>
          </header>

          {group.kind === 'probable' && (
            <p className="dup-warning">
              Same size and name, but neither copy publishes a checksum Orbit can compare against
              the other. Check them before deleting either.
            </p>
          )}

          {view === 'list' ? (
            <ul>
              {group.files.map((file) => (
                <li
                  key={keyOf(file)}
                  data-file={keyOf(file)}
                  data-selected={selected.has(keyOf(file)) ? '' : undefined}
                >
                  <Checkbox
                    checked={selected.has(keyOf(file))}
                    onChange={() => toggle(file)}
                    aria-label={`Select ${file.name} in ${file.accountNickname}`}
                    size={18}
                  />

                  <button
                    type="button"
                    className="dup-open"
                    title="Open it, before deciding anything"
                    onClick={() => setPreviewing({ group, file })}
                  >
                    <Tile file={file} size={34} />
                  </button>

                  <span className="dup-file">
                    <strong>{file.name}</strong>
                    <span>{file.virtualPath}</span>
                  </span>
                  <span className="dup-where">
                    <ProviderIcon provider={file.catalogueKey ?? file.provider} size={15} />
                    <span>
                      {catalogueEntry(file.catalogueKey ?? '')?.label ?? file.provider} ·{' '}
                      {file.accountNickname}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <ul className="dup-grid">
              {group.files.map((file) => (
                <li
                  key={keyOf(file)}
                  data-file={keyOf(file)}
                  data-selected={selected.has(keyOf(file)) ? '' : undefined}
                >
                  <span className="dup-grid__pick">
                    <Checkbox
                      checked={selected.has(keyOf(file))}
                      onChange={() => toggle(file)}
                      aria-label={`Select ${file.name} in ${file.accountNickname}`}
                      size={18}
                    />
                  </span>

                  <button
                    type="button"
                    className="dup-grid__tile"
                    onClick={() => setPreviewing({ group, file })}
                  >
                    <Tile file={file} size={92} />
                  </button>

                  <span className="dup-grid__where">
                    <ProviderIcon provider={file.catalogueKey ?? file.provider} size={14} />
                    <span>{file.accountNickname}</span>
                  </span>
                  <span className="dup-grid__path" title={file.virtualPath}>
                    {file.virtualPath}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}

      {previewing && (
        <FilePreview
          file={asOrbitFile(previewing.file)}
          // The other copies, so the arrow keys step between them — which is
          // exactly the comparison this page exists to help somebody make.
          siblings={previewing.group.files.map(asOrbitFile)}
          contentUrl={contentUrlFor(previewing.file.accountId)}
          onSelect={(next) => {
            const match = previewing.group.files.find((f) => f.remoteId === next.remoteId);
            if (match) setPreviewing({ group: previewing.group, file: match });
          }}
          onClose={() => setPreviewing(null)}
        />
      )}

      {confirming && (
        <ConfirmDialog
          title={`Delete ${selected.size} ${selected.size === 1 ? 'file' : 'files'}?`}
          description="They go to each provider's own trash, where they can still be recovered. Orbit does not check that another copy survives — that is what the selection is for."
          confirmLabel="Move to trash"
          destructive
          busy={busy}
          onConfirm={() => void deleteSelected()}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

/**
 * A thumbnail, or the file's icon.
 *
 * Fetched through the same queue the drive grid uses, so opening a report with
 * two hundred copies in it cannot saturate the connection.
 */
function Tile({ file, size }: { file: DuplicateFile; size: number }) {
  const [url, setUrl] = useState<string | null>(null);
  const orbitFile = asOrbitFile(file);

  useEffect(() => {
    if (!mightHaveThumbnail(orbitFile)) return;

    const controller = new AbortController();
    let created: string | null = null;

    const target = `${API_BASE}/api/files/${encodeURIComponent(file.remoteId)}/thumbnail?accountId=${encodeURIComponent(file.accountId)}&size=${size * 2}`;

    fetchThumbnail(target, controller.signal)
      .then((objectUrl) => {
        created = objectUrl;
        setUrl(objectUrl);
      })
      .catch(() => undefined);

    return () => {
      controller.abort();
      if (created) URL.revokeObjectURL(created);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.accountId, file.remoteId, size]);

  if (!url) {
    return <FileIcon name={file.name} mimeType={orbitFile.mimeType} isFolder={false} size={size > 40 ? 34 : 20} />;
  }

  return <img src={url} alt="" decoding="async" />;
}
