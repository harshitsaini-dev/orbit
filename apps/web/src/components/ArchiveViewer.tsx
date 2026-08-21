import { useEffect, useMemo, useState } from 'react';
import { formatBytes } from '../lib/format.js';
import { openArchive, type OpenArchive } from '../lib/archive.js';
import { listArchiveFolder, type ArchiveNode } from '../lib/zip.js';
import { FileIcon } from './FileIcon.js';
import { CodeViewer } from './CodeViewer.js';

/**
 * Browsing inside a ZIP without downloading it.
 *
 * The index sits at the end of the archive, so the listing costs a few
 * kilobytes however large the file is, and opening one entry costs one more
 * ranged read. A 2GB backup can be looked through over a phone connection.
 *
 * What can be opened in place is deliberately narrow: text and images, which
 * are small and safe to hold in memory. Anything else says what it is and
 * leaves it at that, because extracting a 4GB video inside a preview to then
 * play it is not an improvement on downloading the archive.
 */

/** Big enough for any source file, small enough to never be a problem. */
const INLINE_LIMIT = 2 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'log', 'csv', 'tsv', 'json', 'xml', 'yml', 'yaml', 'toml', 'ini',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'html', 'htm', 'py', 'rb', 'go', 'rs',
  'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'sql', 'gitignore', 'env',
]);

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'ico']);

function extensionOf(name: string): string {
  const cut = name.lastIndexOf('.');
  return cut === -1 ? '' : name.slice(cut + 1).toLowerCase();
}

export function ArchiveViewer({
  src,
  name,
  mimeType,
  sizeBytes,
}: {
  src: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}) {
  const [archive, setArchive] = useState<OpenArchive | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prefix, setPrefix] = useState('');
  const [opened, setOpened] = useState<
    { node: ArchiveNode; kind: 'text'; text: string } | { node: ArchiveNode; kind: 'image'; url: string } | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    setArchive(null);
    setError(null);
    setPrefix('');
    setOpened(null);

    void (async () => {
      try {
        const opened = await openArchive(src, name, mimeType, sizeBytes);
        if (!cancelled) setArchive(opened);
      } catch (err) {
        if (!cancelled) setError((err as Error).message || 'This archive could not be read.');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [src, name, mimeType, sizeBytes]);

  // Object URLs for images opened inside the archive have to be released, or
  // every one looked at stays in memory until the tab closes.
  useEffect(() => {
    if (opened?.kind !== 'image') return;
    const url = opened.url;
    return () => URL.revokeObjectURL(url);
  }, [opened]);

  const nodes = useMemo(
    () => (archive ? listArchiveFolder(archive.entries, prefix) : []),
    [archive, prefix],
  );

  async function open(node: ArchiveNode): Promise<void> {
    if (node.isDirectory) {
      setPrefix(node.path);
      return;
    }
    if (!archive?.read || !node.entry) return;

    const extension = extensionOf(node.name);
    if (node.sizeBytes > INLINE_LIMIT) return;

    const bytes = await archive.read({
      name: node.name,
      isDirectory: false,
      uncompressedSize: node.sizeBytes,
      modifiedAt: node.modifiedAt,
      entry: node.entry,
    });

    if (TEXT_EXTENSIONS.has(extension)) {
      setOpened({ node, kind: 'text', text: new TextDecoder().decode(bytes) });
    } else if (IMAGE_EXTENSIONS.has(extension)) {
      const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart]));
      setOpened({ node, kind: 'image', url });
    }
  }

  function canOpen(node: ArchiveNode): boolean {
    if (node.isDirectory) return true;
    if (!archive?.read) return false;
    if (node.sizeBytes > INLINE_LIMIT) return false;
    const extension = extensionOf(node.name);
    return TEXT_EXTENSIONS.has(extension) || IMAGE_EXTENSIONS.has(extension);
  }

  if (error) {
    return (
      <div className="office-view office-view--message">
        <p style={{ color: 'var(--danger)' }}>{error}</p>
      </div>
    );
  }

  if (!archive) {
    return (
      <div className="office-view office-view--message">
        <p>Reading the index of {name}…</p>
      </div>
    );
  }

  if (opened) {
    return (
      <div className="office-view">
        <div className="office-view__tabs">
          <button type="button" onClick={() => setOpened(null)}>
            ‹ Back to {prefix || name}
          </button>
          <span className="archive__opened">{opened.node.name}</span>
        </div>

        {opened.kind === 'text' ? (
          <CodeViewer text={opened.text} name={opened.node.name} />
        ) : (
          <div className="office-view__scroll archive__image">
            <img src={opened.url} alt={opened.node.name} />
          </div>
        )}
      </div>
    );
  }

  const crumbs = prefix.split('/').filter(Boolean);

  return (
    <div className="office-view">
      <div className="office-view__tabs">
        <button type="button" onClick={() => setPrefix('')} disabled={prefix === ''}>
          {name}
        </button>
        {crumbs.map((crumb, index) => (
          <button
            key={`${crumb}-${index}`}
            type="button"
            onClick={() => setPrefix(`${crumbs.slice(0, index + 1).join('/')}/`)}
            disabled={index === crumbs.length - 1}
          >
            / {crumb}
          </button>
        ))}
      </div>

      <div className="office-view__scroll">
        <ul className="archive__list">
          {nodes.length === 0 && <li className="archive__empty">This folder is empty.</li>}

          {nodes.map((node) => (
            <li key={node.path}>
              <button
                type="button"
                onClick={() => void open(node)}
                disabled={!canOpen(node)}
                title={
                  canOpen(node)
                    ? undefined
                    : (archive.readOnlyReason ?? 'Download the archive to open this')
                }
              >
                <FileIcon name={node.name} mimeType="" isFolder={node.isDirectory} size={20} />
                <span className="archive__name">{node.name}</span>
                <span className="archive__size">
                  {node.isDirectory ? '' : formatBytes(node.sizeBytes)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <p className="office-view__note">
        {archive.readOnlyReason ??
          (archive.format === 'zip'
            ? "Read from the archive's index — the file itself was not downloaded. Text and images inside can be opened; anything larger needs the archive."
            : 'Text and images inside can be opened; anything larger needs the archive.')}
      </p>
    </div>
  );
}
