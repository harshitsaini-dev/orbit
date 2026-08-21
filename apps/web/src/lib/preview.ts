import type { OrbitFile } from '@orbit/shared-types';
import { extensionOf } from '@orbit/shared-types';

export type PreviewKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'text'
  | 'markdown'
  | 'spreadsheet'
  | 'document'
  | 'presentation'
  | 'archive'
  | 'font'
  | 'none';

/** Office formats, by extension and by the mime types providers report. */
const OFFICE: Record<string, PreviewKind> = {
  xlsx: 'spreadsheet',
  xlsm: 'spreadsheet',
  docx: 'document',
  pptx: 'presentation',
};

const OFFICE_MIMES: Record<string, PreviewKind> = {
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'spreadsheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'presentation',
};

const FONT_EXTENSIONS = new Set(['ttf', 'otf', 'woff', 'woff2']);

/**
 * What Drive turns each of its own formats into on export, and therefore what
 * Orbit is really previewing when one is opened.
 */
const GOOGLE_EXPORTS: Record<string, PreviewKind> = {
  'application/vnd.google-apps.document': 'document',
  'application/vnd.google-apps.spreadsheet': 'spreadsheet',
  'application/vnd.google-apps.presentation': 'presentation',
  'application/vnd.google-apps.drawing': 'image',
};

/** Text is fetched into the page, so a "text" file of any real size is declined. */
export const TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'log', 'csv', 'tsv', 'json', 'xml', 'yml', 'yaml', 'toml', 'ini',
  'env', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'html', 'htm', 'py', 'rb', 'go',
  'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'ps1', 'sql',
]);

/** Formats browsers will not render inline whatever the extension says. */
const NEVER_INLINE = /^application\/(zip|x-tar|gzip|x-7z-compressed|vnd\.rar|x-msdownload|octet-stream)$/;

/**
 * What Orbit can show for a file, in its own viewer.
 *
 * Google's own formats are previewable now that Orbit reads Office files: the
 * content route asks Drive to export a Sheet as .xlsx, and the spreadsheet
 * viewer takes it from there. Google's own viewer is still not embedded - that
 * would mean handing the provider's URL to the client, which is the one thing
 * the proxy exists to avoid.
 */
export function previewKindFor(file: Pick<OrbitFile, 'mimeType' | 'name' | 'sizeBytes' | 'isFolder'>): PreviewKind {
  if (file.isFolder) return 'none';

  const mime = (file.mimeType || '').toLowerCase();
  const extension = extensionOf(file.name);

  // Google's own formats hold no bytes of their own; the content route asks
  // Drive to export them, and what comes back is the Office format Orbit now
  // reads. A Sheet is previewable because an .xlsx is.
  const exported = GOOGLE_EXPORTS[mime];
  if (exported) return exported;
  if (mime.startsWith('application/vnd.google-apps.')) return 'none';

  // Mime before extension throughout: a JPEG someone named .zip is a JPEG, and
  // the provider's type is the more reliable of the two.
  if (mime.startsWith('image/')) {
    // SVG is a script-capable document, so it is offered as a download rather
    // than rendered inside the app.
    return mime === 'image/svg+xml' ? 'none' : 'image';
  }
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';

  // Office formats before archives: all three are ZIPs, and claiming them as
  // archives would show a folder of XML instead of a document.
  const office = OFFICE_MIMES[mime] ?? OFFICE[extension];
  if (office) return office;

  if (FONT_EXTENSIONS.has(extension)) return 'font';

  // A ZIP is listed from its index, so its size does not matter.
  if (extension === 'zip' || mime === 'application/zip') return 'archive';

  if (extension === 'md' || extension === 'markdown') {
    return file.sizeBytes <= TEXT_PREVIEW_LIMIT ? 'markdown' : 'none';
  }

  if (NEVER_INLINE.test(mime)) {
    // The mime type is generic, so fall through to the extension below.
    if (mime !== 'application/octet-stream') return 'none';
  }

  if (mime.startsWith('text/') || TEXT_EXTENSIONS.has(extension)) {
    return file.sizeBytes <= TEXT_PREVIEW_LIMIT ? 'text' : 'none';
  }

  // A generic mime type with a media extension still previews.
  if (mime === 'application/octet-stream' || mime === '') {
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp'].includes(extension)) return 'image';
    if (['mp4', 'webm', 'mov', 'm4v', 'ogv'].includes(extension)) return 'video';
    if (['mp3', 'wav', 'flac', 'ogg', 'oga', 'm4a', 'opus'].includes(extension)) return 'audio';
    if (extension === 'pdf') return 'pdf';
  }

  return 'none';
}
