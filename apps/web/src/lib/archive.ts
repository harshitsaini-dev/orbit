import { readRar } from './rar.js';
import { gunzip, readTar, readTarEntry, tarKind, type TarEntry } from './tar.js';
import {
  bufferSource,
  readZipDirectory,
  readZipEntry,
  urlSource,
  type ByteSource,
  type FlatEntry,
  type ZipEntry,
} from './zip.js';

/**
 * One way in for every archive Orbit can open, hiding how differently they
 * behave underneath.
 *
 * The three differ in the only way that matters here — where the index is:
 *
 * - **ZIP** keeps it at the end, so a listing is a ranged read of the tail
 *   however large the archive is, and any entry can be fetched on demand.
 * - **tar** has no index at all: it is headers and data interleaved from the
 *   start, so it must be read through. Compressed, it cannot even be entered
 *   part-way, which is why a large .tar.gz is declined rather than quietly
 *   downloaded.
 * - **RAR** can be read far enough to list, but not to extract: its
 *   decompression is proprietary and no browser implements it.
 *
 * The result is that a ZIP is fully browsable at any size, a tar is browsable
 * up to a size worth downloading, and a RAR shows its contents and says why
 * that is as far as it goes.
 */

export type ArchiveFormat = 'zip' | 'tar' | 'rar';

export interface OpenArchive {
  format: ArchiveFormat;
  entries: FlatEntry[];
  /** Why entries cannot be opened, when they cannot. */
  readOnlyReason: string | null;
  read: ((entry: FlatEntry) => Promise<Uint8Array>) | null;
}

/**
 * A tar has to be held whole to be read. Past this, downloading the archive is
 * the better answer than pulling it into the page to look at a file list.
 */
export const WHOLE_FILE_LIMIT = 100 * 1024 * 1024;

export function archiveFormat(name: string, mimeType: string): ArchiveFormat | null {
  const lower = name.toLowerCase();

  if (tarKind(lower)) return 'tar';
  if (/\.(rar|cbr)$/.test(lower) || /rar/.test(mimeType)) return 'rar';
  if (/\.(zip|cbz|jar|apk|epub|odt|ods|odp|xlsx|docx|pptx)$/.test(lower)) return 'zip';
  if (mimeType === 'application/zip') return 'zip';
  if (/\.(tar)$/.test(lower) || mimeType === 'application/x-tar') return 'tar';

  return null;
}

export async function openArchive(
  src: string,
  name: string,
  mimeType: string,
  sizeBytes: number,
): Promise<OpenArchive> {
  const format = archiveFormat(name, mimeType);
  if (!format) throw new Error('Orbit cannot read this kind of archive.');

  if (format === 'zip') {
    // The one format that never needs the whole file.
    const source: ByteSource = urlSource(src, sizeBytes);
    const entries = await readZipDirectory(source);

    return {
      format,
      entries,
      readOnlyReason: null,
      read: async (entry) => {
        if (!entry.entry) throw new Error('This entry cannot be read.');
        return readZipEntry(source, entry.entry);
      },
    };
  }

  if (sizeBytes > WHOLE_FILE_LIMIT) {
    throw new Error(
      format === 'tar'
        ? 'This archive has no index, so listing it means reading the whole file — too large to do here. Download it instead.'
        : 'This archive is too large to list here. Download it instead.',
    );
  }

  const response = await fetch(src, { credentials: 'include' });
  if (!response.ok) throw new Error(`Could not read this archive (HTTP ${response.status}).`);
  const raw = new Uint8Array(await response.arrayBuffer());

  if (format === 'rar') {
    return {
      format,
      entries: readRar(raw).map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory,
        uncompressedSize: entry.sizeBytes,
        modifiedAt: entry.modifiedAt,
      })),
      readOnlyReason:
        'RAR compression is proprietary and no browser can decompress it, so the contents are listed but not opened. Download the archive to extract anything.',
      read: null,
    };
  }

  const bytes = tarKind(name) === 'tar.gz' ? await gunzip(raw) : raw;
  const entries = readTar(bytes);

  return {
    format,
    entries: entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory,
      uncompressedSize: entry.sizeBytes,
      modifiedAt: entry.modifiedAt,
      // Carried through the opaque slot so the reader below can find it again
      // without the viewer knowing which format it is looking at.
      entry: entry as unknown as ZipEntry,
    })),
    readOnlyReason: null,
    read: async (entry) => readTarEntry(bytes, entry.entry as unknown as TarEntry),
  };
}

export { bufferSource };
