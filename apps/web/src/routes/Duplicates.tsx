import { useCallback, useEffect, useState } from 'react';
import { catalogueEntry } from '@orbit/shared-types';
import { FileIcon } from '../components/FileIcon.js';
import { ConfirmDialog } from '../components/NameDialog.js';
import { ProviderIcon } from '../components/ProviderIcon.js';
import { StatusScreen, statusKindFor } from '../components/StatusScreen.js';
import { ApiError, api } from '../lib/api.js';
import { formatBytes } from '../lib/format.js';

/**
 * The same file, found in more than one place.
 *
 * The distinction between certain and probable is the whole design. A checksum
 * that both sides published and that agree proves two files are the same; a
 * matching size and name does not, and presenting the second as the first is
 * how somebody deletes their only copy. So the two are labelled, sorted apart,
 * and a probable group never pre-selects anything.
 */

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
  kind: 'identical' | 'probable';
  checksum?: string;
  sizeBytes: number;
  files: DuplicateFile[];
  reclaimableBytes: number;
}

interface Report {
  groups: Group[];
  scanned: number;
  withoutChecksum: number;
}

export function Duplicates() {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const keyOf = (file: DuplicateFile) => `${file.accountId}:${file.remoteId}`;

  const load = useCallback(async () => {
    try {
      setReport(await api<Report>('/api/duplicates'));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Could not look for duplicates'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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
    await load();
  }

  if (error && report === null) {
    return (
      <StatusScreen
        kind={error instanceof ApiError ? statusKindFor(error.status) : 'server-error'}
        onRetry={() => void load()}
      />
    );
  }

  const reclaimable = (report?.groups ?? []).reduce(
    (sum, group) => sum + group.reclaimableBytes,
    0,
  );

  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      <section className="clay" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
          <div style={{ display: 'grid', gap: 4 }}>
            <h1 style={{ fontSize: '1.4rem', margin: 0 }}>Duplicates</h1>
            <p style={{ color: 'var(--text-muted)', margin: 0, fontSize: 14 }}>
              {report === null
                ? 'Looking…'
                : report.groups.length === 0
                  ? `Nothing duplicated across ${report.scanned.toLocaleString()} files.`
                  : `${report.groups.length} sets across ${report.scanned.toLocaleString()} files · ${formatBytes(reclaimable)} could be freed.`}
            </p>
          </div>

          <span style={{ flex: 1 }} />

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
        </div>

        {report !== null && report.withoutChecksum > 0 && (
          <p className="share-hint" style={{ marginTop: '0.9rem' }}>
            {report.withoutChecksum.toLocaleString()} of {report.scanned.toLocaleString()} files
            publish no checksum Orbit can compare — those can only ever be matched on size and
            name, which is a guess rather than proof.
          </p>
        )}
      </section>

      {report?.groups.map((group, index) => (
        // eslint-disable-next-line react/no-array-index-key
        <section key={index} className="clay dup-group">
          <header>
            <span className="dup-kind" data-kind={group.kind}>
              {group.kind === 'identical' ? 'Identical' : 'Possibly the same'}
            </span>
            <strong>{group.files[0]!.name}</strong>
            <span className="dup-meta">
              {formatBytes(group.sizeBytes)} each · {formatBytes(group.reclaimableBytes)} spare
            </span>
          </header>

          {group.kind === 'probable' && (
            <p className="dup-warning">
              Same size and name, but neither copy publishes a checksum Orbit can compare against
              the other. Check them before deleting either.
            </p>
          )}

          <ul>
            {group.files.map((file) => (
              <li key={keyOf(file)}>
                <input
                  type="checkbox"
                  checked={selected.has(keyOf(file))}
                  onChange={() => toggle(file)}
                  aria-label={`Select ${file.name} in ${file.accountNickname}`}
                />
                <FileIcon name={file.name} mimeType="" isFolder={false} size={20} />
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
        </section>
      ))}

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
