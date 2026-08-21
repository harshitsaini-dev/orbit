/**
 * Reading .tar, and .tar.gz.
 *
 * A tar has no index. It is a plain run of 512-byte headers, each followed by
 * its file's bytes, so listing one means walking it from the start — the
 * opposite of a ZIP, whose index is at the end. That difference decides how
 * each is handled: a ZIP is listed from a ranged read of its tail, a tar has to
 * be read through.
 *
 * gzip is the browser's own `DecompressionStream`, so .tar.gz costs no library
 * either. What it does cost is the whole file, since a gzip stream cannot be
 * entered part-way — which is why the viewer declines a very large one rather
 * than quietly downloading it.
 */

export interface TarEntry {
  name: string;
  isDirectory: boolean;
  sizeBytes: number;
  modifiedAt: Date | null;
  /** Offset of the entry's data within the uncompressed tar. */
  offset: number;
}

const BLOCK = 512;

/** Trailing NULs pad every field; some writers use spaces as well. */
function readString(bytes: Uint8Array, start: number, length: number): string {
  const slice = bytes.subarray(start, start + length);
  let end = slice.indexOf(0);
  if (end === -1) end = slice.length;
  return new TextDecoder().decode(slice.subarray(0, end)).replace(/\0+$/, '').trim();
}

/** Numeric fields are octal text, not binary. */
function readOctal(bytes: Uint8Array, start: number, length: number): number {
  const text = readString(bytes, start, length).replace(/[^0-7]/g, '');
  return text === '' ? 0 : Number.parseInt(text, 8);
}

/**
 * The header's own checksum, which is how a header is told from padding.
 *
 * Without it a run of zeros in the middle of a corrupt archive reads as a file
 * named "" of size 0, and the walk never ends.
 */
function checksumMatches(header: Uint8Array): boolean {
  const stated = readOctal(header, 148, 8);
  if (stated === 0) return false;

  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    // The checksum field itself counts as spaces.
    sum += index >= 148 && index < 156 ? 32 : header[index]!;
  }
  return sum === stated;
}

/**
 * Extended attributes, as modern tar writes them.
 *
 * A pax header is a pseudo-entry whose data is a run of
 * `"<length> <key>=<value>\n"` records describing the entry that follows. It is
 * how a path too long for the 100-byte header field is carried now - GNU's
 * older long-name entry is the same idea with a different spelling - and
 * ignoring it gives a truncated name plus a phantom file called @PaxHeader
 * beside every real one.
 */
function readPaxRecords(bytes: Uint8Array, at: number, size: number): Map<string, string> {
  const text = new TextDecoder().decode(bytes.subarray(at, at + size));
  const records = new Map<string, string>();
  let offset = 0;

  while (offset < text.length) {
    const space = text.indexOf(' ', offset);
    if (space === -1) break;

    const length = Number.parseInt(text.slice(offset, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;

    const record = text.slice(space + 1, offset + length).replace(/\n$/, '');
    const equals = record.indexOf('=');
    if (equals > 0) records.set(record.slice(0, equals), record.slice(equals + 1));

    offset += length;
  }

  return records;
}

export function readTar(bytes: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  /** GNU stores a name too long for the header in an entry of its own. */
  let pendingLongName: string | null = null;
  /** Whatever the last pax header said about the entry that follows it. */
  let pendingPax: Map<string, string> | null = null;

  while (offset + BLOCK <= bytes.byteLength) {
    const header = bytes.subarray(offset, offset + BLOCK);

    // Two zero blocks mark the end; one may just be padding.
    if (header.every((byte) => byte === 0)) break;
    if (!checksumMatches(header)) break;

    const size = readOctal(header, 124, 12);
    const type = String.fromCharCode(header[156]!);
    const dataAt = offset + BLOCK;

    if (type === 'L') {
      pendingLongName = readString(bytes, dataAt, size);
    } else if (type === 'x') {
      pendingPax = readPaxRecords(bytes, dataAt, size);
    } else if (type === 'g' || type === 'K') {
      // Global attributes and long link names, neither of which a listing needs.
    } else {
      const prefix = readString(header, 345, 155);
      const base = readString(header, 0, 100);
      // Most specific first: a pax record overrides a GNU long name, which
      // overrides the header's own truncated field.
      const name = pendingPax?.get('path') ?? pendingLongName ?? (prefix ? `${prefix}/${base}` : base);
      const paxSize = Number(pendingPax?.get('size'));

      pendingLongName = null;
      pendingPax = null;

      if (name !== '' && name !== './' && name !== '.') {
        const mtime = readOctal(header, 136, 12);
        entries.push({
          name: name.replace(/^\.\//, ''),
          isDirectory: type === '5' || name.endsWith('/'),
          sizeBytes: type === '5' ? 0 : Number.isFinite(paxSize) ? paxSize : size,
          modifiedAt: mtime > 0 ? new Date(mtime * 1000) : null,
          offset: dataAt,
        });
      }
    }

    // Data is padded up to the next block boundary.
    offset = dataAt + Math.ceil(size / BLOCK) * BLOCK;
  }

  return entries;
}

export function readTarEntry(bytes: Uint8Array, entry: TarEntry): Uint8Array {
  return bytes.subarray(entry.offset, entry.offset + entry.sizeBytes);
}

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as unknown as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Whether a name is a tar, and whether it is compressed. */
export function tarKind(name: string): 'tar' | 'tar.gz' | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.tar')) return 'tar';
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz';
  return null;
}
