/**
 * The Google One style storage breakdown: how much of a drive is photos, video,
 * documents, and so on.
 *
 * Classification is by mime type first and file extension second. Extensions
 * matter because object stores hand back `application/octet-stream` for almost
 * everything, and because Drive reports its own `vnd.google-apps.*` types that
 * mean nothing to anyone else.
 */

export const FILE_CATEGORIES = ['image', 'video', 'audio', 'document', 'archive', 'code', 'design', 'system', 'other'] as const;
export type FileCategory = (typeof FILE_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<FileCategory, string> = {
  image: 'Photos & images',
  video: 'Videos',
  audio: 'Audio',
  document: 'Documents',
  archive: 'Archives',
  code: 'Code',
  design: 'Design files',
  system: 'Apps & disk images',
  other: 'Other',
};

/** Stable colours, so the same category reads the same in every chart and legend. */
export const CATEGORY_COLOURS: Record<FileCategory, string> = {
  image: '#6c8cff',
  video: '#d95c8a',
  audio: '#8b6cf5',
  document: '#2fa87a',
  archive: '#e08a2e',
  code: '#37a6c4',
  design: '#c4569b',
  system: '#6f7ba8',
  other: '#8a93a8',
};

const EXTENSIONS: Record<string, FileCategory> = {};

function register(category: FileCategory, extensions: string[]): void {
  for (const extension of extensions) EXTENSIONS[extension] = category;
}

register('image', ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'svg', 'heic', 'heif', 'avif', 'ico', 'raw', 'cr2', 'nef', 'arw', 'dng']);
register('video', ['mp4', 'mkv', 'mov', 'avi', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', '3gp', 'ts', 'm2ts', 'ogv']);
register('audio', ['mp3', 'wav', 'flac', 'aac', 'ogg', 'oga', 'm4a', 'wma', 'opus', 'aiff', 'mid', 'midi']);
register('document', ['pdf', 'doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'xls', 'xlsx', 'ods', 'csv', 'tsv', 'ppt', 'pptx', 'odp', 'epub', 'mobi', 'pages', 'numbers', 'key']);
register('archive', ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz', 'zst', 'cab']);
register('code', ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'sql', 'yml', 'yaml', 'toml', 'xml', 'ipynb', 'vue', 'svelte', 'dart', 'lua', 'r', 'pl', 'scala', 'ex', 'exs']);

// Kept apart from images: a layered PSD is not a photograph, and a folder of
// them looking like holiday snaps in the breakdown says nothing useful about
// where a hundred gigabytes went.
register('design', ['psd', 'ai', 'eps', 'fig', 'xd', 'sketch', 'indd', 'afdesign', 'afphoto', 'blend', 'obj', 'fbx', 'stl', '3ds']);

// Apps and disk images, which used to land in "archive" or "other" - the two
// places least likely to be where someone looks for the four gigabytes an ISO
// is taking up.
register('system', ['exe', 'msi', 'apk', 'aab', 'ipa', 'iso', 'dmg', 'pkg', 'deb', 'rpm', 'appimage', 'bin', 'img', 'vmdk', 'vdi', 'jar', 'ttf', 'otf', 'woff', 'woff2']);

/** Google's own document types, which carry no meaningful mime prefix. */
const GOOGLE_APPS: Record<string, FileCategory> = {
  'application/vnd.google-apps.document': 'document',
  'application/vnd.google-apps.spreadsheet': 'document',
  'application/vnd.google-apps.presentation': 'document',
  'application/vnd.google-apps.form': 'document',
  'application/vnd.google-apps.drawing': 'image',
  'application/vnd.google-apps.script': 'code',
  'application/vnd.google-apps.jam': 'document',
};

const MIME_EXACT: Record<string, FileCategory> = {
  'application/pdf': 'document',
  'application/rtf': 'document',
  'application/msword': 'document',
  'application/json': 'code',
  'application/xml': 'code',
  'text/csv': 'document',
  'text/markdown': 'document',
  'application/zip': 'archive',
  'application/x-tar': 'archive',
  'application/gzip': 'archive',
  'application/x-7z-compressed': 'archive',
  'application/vnd.rar': 'archive',
};

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Classifies one file. `mimeType` is trusted when it is specific; the extension
 * decides when it is not, which is most of the time outside Drive.
 */
export function categorise(mimeType: string | undefined, name = ''): FileCategory {
  const mime = (mimeType ?? '').toLowerCase();

  if (mime in GOOGLE_APPS) return GOOGLE_APPS[mime]!;
  if (mime in MIME_EXACT) return MIME_EXACT[mime]!;

  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';

  // Everything below falls through to the extension, because a generic mime
  // type tells us nothing: object stores label almost every object
  // application/octet-stream.
  const byExtension = EXTENSIONS[extensionOf(name)];
  if (byExtension) return byExtension;

  // text/plain last, not in the exact table: providers label source files with
  // it as readily as they label prose, so it is a generic type like
  // octet-stream and the extension is the better answer when there is one.
  if (mime.startsWith('text/')) return 'document';

  return 'other';
}

export interface CategoryTotal {
  category: FileCategory;
  fileCount: number;
  sizeBytes: number;
}

export interface StorageBreakdown {
  accountId: string;
  totals: CategoryTotal[];
  fileCount: number;
  sizeBytes: number;
  /** True when the scan hit its page limit and stopped early. */
  partial: boolean;
  scannedAt: string;
}

/** Sums a set of files into per-category totals, largest first. */
export function summarise(
  files: Array<{ mimeType?: string; name?: string; sizeBytes?: number; isFolder?: boolean }>,
): CategoryTotal[] {
  const byCategory = new Map<FileCategory, CategoryTotal>();

  for (const file of files) {
    // Folders are containers, not content; counting them would double-count.
    if (file.isFolder) continue;

    const category = categorise(file.mimeType, file.name ?? '');
    const total = byCategory.get(category) ?? { category, fileCount: 0, sizeBytes: 0 };
    total.fileCount += 1;
    total.sizeBytes += file.sizeBytes ?? 0;
    byCategory.set(category, total);
  }

  return [...byCategory.values()].sort((a, b) => b.sizeBytes - a.sizeBytes || b.fileCount - a.fileCount);
}

/**
 * Real media types by extension, for providers that report none.
 *
 * Dropbox and OneDrive describe a file only as "image" or "video", and the
 * adapters turned that into `image/*`. That is a match pattern, not a media
 * type: it is meaningless in a `<video>` source, in a `Content-Type`, and to
 * anything that compares against a specific type rather than a prefix.
 *
 * Only the types worth naming are here. Anything else stays
 * `application/octet-stream`, which is at least honest.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  heic: 'image/heic',
  heif: 'image/heif',

  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  '3gp': 'video/3gpp',

  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  m4a: 'audio/mp4',
  aiff: 'audio/aiff',
  mid: 'audio/midi',
  midi: 'audio/midi',

  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  rtf: 'application/rtf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  epub: 'application/epub+zip',

  zip: 'application/zip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  bz2: 'application/x-bzip2',
  xz: 'application/x-xz',
  zst: 'application/zstd',

  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  ts: 'text/typescript',
  yml: 'application/yaml',
  yaml: 'application/yaml',

  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

/**
 * A media type for a file whose provider did not give one.
 *
 * Falls back to `application/octet-stream` rather than to a wildcard: a
 * consumer can reason about "unknown", but `image/*` claims to be a type and
 * then fails every comparison made against it.
 */
export function mimeForName(name: string): string {
  return MIME_BY_EXTENSION[extensionOf(name)] ?? 'application/octet-stream';
}
