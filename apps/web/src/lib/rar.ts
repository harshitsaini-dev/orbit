/**
 * Listing what is inside a .rar — and only listing it.
 *
 * RAR is not a ZIP and shares nothing with it. Its headers can be read, which
 * is enough to say what an archive holds, but its compression is a proprietary
 * algorithm that no browser implements: `DecompressionStream` does gzip and
 * deflate and nothing else. Extracting would mean shipping a multi-megabyte
 * WebAssembly build of unrar, which is a large download to add to every page
 * load for a format most people meet occasionally.
 *
 * So the contents are shown and the files are not opened, and the viewer says
 * exactly that. A list of what is in an archive is most of why anyone opens one
 * before downloading it.
 */

export interface RarEntry {
  name: string;
  isDirectory: boolean;
  sizeBytes: number;
  modifiedAt: Date | null;
}

const RAR5_SIGNATURE = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00];
const RAR4_SIGNATURE = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00];

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

export function isRar(bytes: Uint8Array): boolean {
  return startsWith(bytes, RAR5_SIGNATURE) || startsWith(bytes, RAR4_SIGNATURE);
}

/**
 * RAR5 numbers are variable-length: seven bits per byte, high bit meaning "one
 * more follows". Every field in a RAR5 header is one of these, so getting it
 * wrong desynchronises the whole walk rather than producing one bad value.
 */
function readVint(bytes: Uint8Array, at: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let offset = at;

  while (offset < bytes.byteLength && shift < 64) {
    const byte = bytes[offset]!;
    value += (byte & 0x7f) * 2 ** shift;
    offset += 1;
    if ((byte & 0x80) === 0) return { value, next: offset };
    shift += 7;
  }

  return { value, next: offset };
}

export function readRar(bytes: Uint8Array): RarEntry[] {
  if (startsWith(bytes, RAR5_SIGNATURE)) return readRar5(bytes);
  if (startsWith(bytes, RAR4_SIGNATURE)) return readRar4(bytes);
  throw new Error('This does not look like a RAR archive.');
}

function readRar5(bytes: Uint8Array): RarEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries: RarEntry[] = [];
  let offset = RAR5_SIGNATURE.length;

  while (offset + 8 < bytes.byteLength) {
    // CRC32 of the header, then the header's own size, then its type.
    const afterCrc = offset + 4;
    const size = readVint(bytes, afterCrc);
    const headerStart = size.next;
    const headerEnd = headerStart + size.value;
    if (size.value === 0 || headerEnd > bytes.byteLength) break;

    const type = readVint(bytes, headerStart);
    const flags = readVint(bytes, type.next);
    let cursor = flags.next;

    if ((flags.value & 0x0001) !== 0) cursor = readVint(bytes, cursor).next; // extra area
    let dataSize = 0;
    if ((flags.value & 0x0002) !== 0) {
      const data = readVint(bytes, cursor);
      dataSize = data.value;
      cursor = data.next;
    }

    // 2 is a file header; 3 is a service header (recovery record, and so on).
    if (type.value === 2) {
      const fileFlags = readVint(bytes, cursor);
      const unpacked = readVint(bytes, fileFlags.next);
      const attributes = readVint(bytes, unpacked.next);
      cursor = attributes.next;

      let modifiedAt: Date | null = null;
      if ((fileFlags.value & 0x0002) !== 0) {
        modifiedAt = new Date(view.getUint32(cursor, true) * 1000);
        cursor += 4;
      }
      if ((fileFlags.value & 0x0004) !== 0) cursor += 4; // data CRC

      const compression = readVint(bytes, cursor);
      const hostOs = readVint(bytes, compression.next);
      const nameLength = readVint(bytes, hostOs.next);

      const name = new TextDecoder().decode(
        bytes.subarray(nameLength.next, nameLength.next + nameLength.value),
      );

      entries.push({
        name,
        // 0x0001 is the directory flag.
        isDirectory: (fileFlags.value & 0x0001) !== 0,
        sizeBytes: unpacked.value,
        modifiedAt,
      });
    }

    offset = headerEnd + dataSize;
  }

  return entries;
}

function readRar4(bytes: Uint8Array): RarEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries: RarEntry[] = [];
  let offset = RAR4_SIGNATURE.length;

  while (offset + 7 <= bytes.byteLength) {
    const flags = view.getUint16(offset + 3, true);
    const headerSize = view.getUint16(offset + 5, true);
    const type = bytes[offset + 2]!;
    if (headerSize < 7) break;

    let addedSize = 0;
    // 0x8000 says the header is followed by data of the stated size.
    if ((flags & 0x8000) !== 0 && offset + 11 <= bytes.byteLength) {
      addedSize = view.getUint32(offset + 7, true);
    }

    if (type === 0x74 && offset + 32 <= bytes.byteLength) {
      let unpacked = view.getUint32(offset + 11, true);
      const dosTime = view.getUint32(offset + 20, true);
      const nameLength = view.getUint16(offset + 26, true);
      const attributes = view.getUint32(offset + 28, true);
      let cursor = offset + 32;

      // 0x0100: sizes above 4GB are split into a high and a low word.
      if ((flags & 0x0100) !== 0) {
        const highUnpacked = view.getUint32(cursor + 4, true);
        unpacked += highUnpacked * 2 ** 32;
        cursor += 8;
      }

      const name = new TextDecoder().decode(bytes.subarray(cursor, cursor + nameLength)).split('\0')[0] ?? '';

      entries.push({
        name: name.replace(/\\/g, '/'),
        // 0xe0 in the flags marks a directory in RAR4, as does the DOS
        // directory attribute.
        isDirectory: (flags & 0xe0) === 0xe0 || (attributes & 0x10) !== 0,
        sizeBytes: unpacked,
        modifiedAt: dosDate(dosTime),
      });
    }

    const next = offset + headerSize + addedSize;
    if (next <= offset) break;
    offset = next;
  }

  return entries;
}

/** RAR4 stores time the same way ZIP does: two packed 16-bit words. */
function dosDate(packed: number): Date | null {
  const time = packed & 0xffff;
  const date = (packed >>> 16) & 0xffff;
  if (date === 0) return null;

  const parsed = new Date(
    1980 + ((date >> 9) & 0x7f),
    ((date >> 5) & 0x0f) - 1,
    date & 0x1f,
    (time >> 11) & 0x1f,
    (time >> 5) & 0x3f,
    (time & 0x1f) * 2,
  );
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
