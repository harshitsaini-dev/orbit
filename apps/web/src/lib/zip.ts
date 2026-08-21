/**
 * Reading a ZIP without downloading it.
 *
 * A ZIP's index is at the *end* of the file, which is the useful fact: the
 * contents can be listed by fetching the last few kilobytes and reading the
 * central directory, and one file inside it costs one more ranged request. The
 * obvious alternative — hand the whole thing to a ZIP library — needs the
 * entire archive in memory first, so listing what is inside a 2GB backup would
 * download 2GB.
 *
 * Decompression is the browser's own `DecompressionStream`, so there is no
 * library here at all. This also backs the Office previews, since .xlsx, .docx
 * and .pptx are ZIPs of XML.
 */

export interface ZipEntry {
  name: string;
  isDirectory: boolean;
  compressedSize: number;
  uncompressedSize: number;
  /** 0 = stored, 8 = deflate. Anything else this reader declines. */
  method: number;
  offset: number;
  modifiedAt: Date | null;
}

/** Where the bytes come from: a ranged URL, or something already in memory. */
export interface ByteSource {
  size: number;
  read: (start: number, end: number) => Promise<Uint8Array>;
}

const EOCD_SIGNATURE = 0x06054b50;
const EOCD64_LOCATOR_SIGNATURE = 0x07064b50;
const EOCD64_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;

/** The end record is 22 bytes plus a comment of up to 64KB. */
const EOCD_SEARCH_BYTES = 66 * 1024;

export function bufferSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.byteLength,
    read: async (start, end) => bytes.subarray(start, end),
  };
}

export function urlSource(url: string, size: number): ByteSource {
  return {
    size,
    read: async (start, end) => {
      const response = await fetch(url, {
        credentials: 'include',
        headers: { range: `bytes=${start}-${end - 1}` },
      });

      // A server that ignores Range answers 200 with the whole file, which
      // would quietly turn "read 64KB" into "download everything".
      if (response.status !== 206) {
        throw new Error('This file cannot be read in parts, so its contents cannot be listed.');
      }

      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

/** Reads the central directory and returns every entry. */
export async function readZipDirectory(source: ByteSource): Promise<ZipEntry[]> {
  const tailLength = Math.min(EOCD_SEARCH_BYTES, source.size);
  const tail = await source.read(source.size - tailLength, source.size);
  const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);

  const eocd = findSignature(tailView, EOCD_SIGNATURE);
  if (eocd < 0) throw new Error('This does not look like a ZIP archive.');

  let entryCount = tailView.getUint16(eocd + 10, true);
  let directorySize = tailView.getUint32(eocd + 12, true);
  let directoryOffset = tailView.getUint32(eocd + 16, true);

  // 0xffffffff is ZIP64's "look in the other record", used once an archive
  // passes 4GB or 65535 entries - which is exactly the size of archive this
  // reader exists for.
  if (directoryOffset === 0xffffffff || entryCount === 0xffff) {
    const locator = findSignature(tailView, EOCD64_LOCATOR_SIGNATURE);
    if (locator < 0) throw new Error('This ZIP is too large to read without its ZIP64 index.');

    const eocd64Offset = Number(tailView.getBigUint64(locator + 8, true));
    const header = await source.read(eocd64Offset, eocd64Offset + 56);
    const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);

    if (headerView.getUint32(0, true) !== EOCD64_SIGNATURE) {
      throw new Error('This ZIP has a damaged index.');
    }

    entryCount = Number(headerView.getBigUint64(32, true));
    directorySize = Number(headerView.getBigUint64(40, true));
    directoryOffset = Number(headerView.getBigUint64(48, true));
  }

  const directory = await source.read(directoryOffset, directoryOffset + directorySize);
  return parseCentralDirectory(directory, entryCount);
}

function findSignature(view: DataView, signature: number): number {
  // Backwards: the record is at the end, and a file whose *contents* happen to
  // contain the signature would otherwise be found first.
  for (let offset = view.byteLength - 4; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === signature) return offset;
  }
  return -1;
}

function parseCentralDirectory(bytes: Uint8Array, entryCount: number): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries: ZipEntry[] = [];
  let offset = 0;

  for (let index = 0; index < entryCount && offset + 46 <= bytes.byteLength; index += 1) {
    if (view.getUint32(offset, true) !== CENTRAL_SIGNATURE) break;

    const method = view.getUint16(offset + 10, true);
    const time = view.getUint16(offset + 12, true);
    const date = view.getUint16(offset + 14, true);
    let compressedSize = view.getUint32(offset + 20, true);
    let uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    let localOffset = view.getUint32(offset + 42, true);

    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = new TextDecoder().decode(nameBytes);

    // ZIP64 moves any field that overflowed into an extra block, in the order
    // the overflowed fields appear - so which ones are present is implied by
    // which are 0xffffffff rather than stated anywhere.
    if (
      uncompressedSize === 0xffffffff ||
      compressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      const extra = bytes.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength);
      const extraView = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
      let cursor = 0;

      while (cursor + 4 <= extra.byteLength) {
        const id = extraView.getUint16(cursor, true);
        const size = extraView.getUint16(cursor + 2, true);
        if (id === 0x0001) {
          let field = cursor + 4;
          if (uncompressedSize === 0xffffffff) {
            uncompressedSize = Number(extraView.getBigUint64(field, true));
            field += 8;
          }
          if (compressedSize === 0xffffffff) {
            compressedSize = Number(extraView.getBigUint64(field, true));
            field += 8;
          }
          if (localOffset === 0xffffffff) {
            localOffset = Number(extraView.getBigUint64(field, true));
          }
          break;
        }
        cursor += 4 + size;
      }
    }

    entries.push({
      name,
      isDirectory: name.endsWith('/'),
      compressedSize,
      uncompressedSize,
      method,
      offset: localOffset,
      modifiedAt: dosDate(date, time),
    });

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/** MS-DOS packs a date into two 16-bit words, with 1980 as year zero. */
function dosDate(date: number, time: number): Date | null {
  if (date === 0) return null;

  const year = 1980 + ((date >> 9) & 0x7f);
  const month = ((date >> 5) & 0x0f) - 1;
  const day = date & 0x1f;
  const hours = (time >> 11) & 0x1f;
  const minutes = (time >> 5) & 0x3f;
  const seconds = (time & 0x1f) * 2;

  const parsed = new Date(year, month, day, hours, minutes, seconds);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** The uncompressed contents of one entry. */
export async function readZipEntry(source: ByteSource, entry: ZipEntry): Promise<Uint8Array> {
  if (entry.isDirectory) return new Uint8Array();

  // The local header repeats the name and extra field, and its extra field is
  // not always the same length as the central one - so it has to be read
  // rather than assumed.
  const header = await source.read(entry.offset, Math.min(entry.offset + 30, source.size));
  const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);

  const nameLength = headerView.getUint16(26, true);
  const extraLength = headerView.getUint16(28, true);
  const start = entry.offset + 30 + nameLength + extraLength;

  const compressed = await source.read(start, start + entry.compressedSize);

  if (entry.method === 0) return compressed;
  if (entry.method !== 8) {
    throw new Error('This entry uses a compression method Orbit cannot read.');
  }

  const stream = new Blob([compressed as unknown as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));

  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Convenience for the Office readers, which want text out of a known path. */
export async function readZipText(source: ByteSource, entries: ZipEntry[], path: string): Promise<string | null> {
  const entry = entries.find((candidate) => candidate.name === path);
  if (!entry) return null;
  return new TextDecoder().decode(await readZipEntry(source, entry));
}

/**
 * A single level of the archive, folders first, as a file list would show it.
 *
 * ZIP entries are flat paths, and an archive need not contain entries for its
 * own directories, so the folders shown here are inferred from the paths rather
 * than listed anywhere.
 */
export interface ArchiveNode {
  name: string;
  path: string;
  isDirectory: boolean;
  sizeBytes: number;
  modifiedAt: Date | null;
  entry?: ZipEntry;
}

/** The shape every archive reader is normalised into before listing. */
export interface FlatEntry {
  name: string;
  isDirectory: boolean;
  uncompressedSize: number;
  modifiedAt: Date | null;
  entry?: ZipEntry;
}

export function listArchiveFolder(entries: FlatEntry[], prefix: string): ArchiveNode[] {
  const folders = new Map<string, { size: number }>();
  const files: ArchiveNode[] = [];

  for (const entry of entries) {
    if (!entry.name.startsWith(prefix)) continue;

    const rest = entry.name.slice(prefix.length);
    if (rest === '') continue;

    const slash = rest.indexOf('/');

    if (slash === -1) {
      if (entry.isDirectory) continue;
      files.push({
        name: rest,
        path: entry.name,
        isDirectory: false,
        sizeBytes: entry.uncompressedSize,
        modifiedAt: entry.modifiedAt,
        // Only a ZIP entry can be read back; tar and RAR entries carry no
        // handle, which is what makes them listable but not openable.
        ...(entry.entry ? { entry: entry.entry } : {}),
      });
      continue;
    }

    const folder = rest.slice(0, slash);
    const current = folders.get(folder) ?? { size: 0 };
    current.size += entry.uncompressedSize;
    folders.set(folder, current);
  }

  const directories: ArchiveNode[] = [...folders.entries()].map(([name, { size }]) => ({
    name,
    path: `${prefix}${name}/`,
    isDirectory: true,
    sizeBytes: size,
    modifiedAt: null,
  }));

  const byName = (a: ArchiveNode, b: ArchiveNode) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

  return [...directories.sort(byName), ...files.sort(byName)];
}
