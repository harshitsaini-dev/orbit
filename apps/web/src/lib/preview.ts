import type { OrbitFile } from '@orbit/shared-types';
import { extensionOf } from '@orbit/shared-types';

export type PreviewKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'none';

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
 * Google's own document formats are deliberately `none`: Orbit exports them to
 * Office formats on download, and no browser renders a .docx inline. Embedding
 * Google's viewer would mean handing the provider's URL to the client, which is
 * the one thing the proxy exists to avoid.
 */
export function previewKindFor(file: Pick<OrbitFile, 'mimeType' | 'name' | 'sizeBytes' | 'isFolder'>): PreviewKind {
  if (file.isFolder) return 'none';

  const mime = (file.mimeType || '').toLowerCase();
  if (mime.startsWith('application/vnd.google-apps.')) return 'none';

  if (mime.startsWith('image/')) {
    // SVG is a script-capable document, so it is offered as a download rather
    // than rendered inside the app.
    return mime === 'image/svg+xml' ? 'none' : 'image';
  }
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';

  if (NEVER_INLINE.test(mime)) {
    // The mime type is generic, so fall through to the extension below.
    if (mime !== 'application/octet-stream') return 'none';
  }

  const extension = extensionOf(file.name);

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
