/**
 * What a file actually is, from its first few bytes.
 *
 * The name and the provider's mime type are both claims made by whoever
 * uploaded it. The magic number is the file's own account of itself, and when
 * the two disagree it is usually the interesting half - a `.jpg` that is really
 * a ZIP, or a file with no extension at all.
 *
 * Deliberately short. This exists to caption a hex dump, not to be a format
 * database, and every entry here is one somebody might plausibly meet in a
 * drive.
 */

interface Signature {
  label: string;
  /** Bytes that must match, or null for a wildcard at that position. */
  magic: Array<number | null>;
  offset?: number;
}

const SIGNATURES: Signature[] = [
  { label: 'a JPEG image', magic: [0xff, 0xd8, 0xff] },
  { label: 'a PNG image', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { label: 'a GIF image', magic: [0x47, 0x49, 0x46, 0x38] },
  { label: 'a BMP image', magic: [0x42, 0x4d] },
  { label: 'a PDF document', magic: [0x25, 0x50, 0x44, 0x46] },
  // ZIP, and everything built on it: Office documents, ODF, EPUB, JAR, APK.
  { label: 'a ZIP archive (or something built on one)', magic: [0x50, 0x4b, 0x03, 0x04] },
  { label: 'a RAR archive', magic: [0x52, 0x61, 0x72, 0x21] },
  { label: 'a 7-Zip archive', magic: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
  { label: 'a gzip stream', magic: [0x1f, 0x8b] },
  { label: 'a Zstandard stream', magic: [0x28, 0xb5, 0x2f, 0xfd] },
  { label: 'an MP3 with an ID3 tag', magic: [0x49, 0x44, 0x33] },
  { label: 'a FLAC stream', magic: [0x66, 0x4c, 0x61, 0x43] },
  { label: 'an Ogg stream', magic: [0x4f, 0x67, 0x67, 0x53] },
  // The four bytes before ftyp are the box length, which varies.
  { label: 'an MP4 or QuickTime video', magic: [0x66, 0x74, 0x79, 0x70], offset: 4 },
  { label: 'a Matroska or WebM video', magic: [0x1a, 0x45, 0xdf, 0xa3] },
  { label: 'a RIFF container (WAV or AVI)', magic: [0x52, 0x49, 0x46, 0x46] },
  { label: 'a TrueType font', magic: [0x00, 0x01, 0x00, 0x00, 0x00] },
  { label: 'an OpenType font', magic: [0x4f, 0x54, 0x54, 0x4f] },
  { label: 'a WOFF font', magic: [0x77, 0x4f, 0x46, 0x46] },
  { label: 'a WOFF2 font', magic: [0x77, 0x4f, 0x46, 0x32] },
  { label: 'a Windows executable', magic: [0x4d, 0x5a] },
  { label: 'a Linux executable', magic: [0x7f, 0x45, 0x4c, 0x46] },
  { label: 'a SQLite database', magic: [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65] },
  { label: 'a TIFF or raw photo', magic: [0x49, 0x49, 0x2a, 0x00] },
  { label: 'a TIFF or raw photo', magic: [0x4d, 0x4d, 0x00, 0x2a] },
];

/** A caption for a hex dump, or null when the bytes say nothing recognisable. */
export function describeSignature(bytes: Uint8Array): string | null {
  /*
   * WEBP first, because it is a RIFF container: the generic entry below would
   * match it and call somebody's photo an AVI. The format is named four bytes
   * after the container, which is why it is not a signature of its own.
   */
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'a WebP image';
  }

  for (const { label, magic, offset = 0 } of SIGNATURES) {
    if (bytes.length < offset + magic.length) continue;

    const matches = magic.every((byte, index) => byte === null || bytes[offset + index] === byte);
    if (matches) return label;
  }

  return null;
}
