import { CATEGORY_COLOURS, categorise, type FileCategory } from '@orbit/shared-types';

/**
 * The shapes a file can take in the list.
 *
 * Colour alone was doing all the work here, and colour alone is not enough: a
 * spreadsheet and a PDF are both "document" green, six categories are hard to
 * hold in your head, and someone who cannot separate green from blue got no
 * signal at all. The silhouettes differ now, and the common formats worth
 * recognising at a glance - a PDF, a spreadsheet, a deck - get their own rather
 * than sharing the one their category implies.
 */
type Shape =
  | 'folder'
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'sheet'
  | 'slides'
  | 'document'
  | 'archive'
  | 'code'
  | 'design'
  | 'font'
  | 'app'
  | 'disk'
  | 'other';

/** Formats distinctive enough to be worth telling apart inside their category. */
const BY_EXTENSION: Record<string, Shape> = {
  pdf: 'pdf',
  xls: 'sheet',
  xlsx: 'sheet',
  xlsm: 'sheet',
  csv: 'sheet',
  tsv: 'sheet',
  ods: 'sheet',
  numbers: 'sheet',
  ppt: 'slides',
  pptx: 'slides',
  odp: 'slides',
  key: 'slides',
  // "system" covers three quite different things, and an installer, a disk
  // image and a typeface have nothing to do with each other on screen.
  ttf: 'font',
  otf: 'font',
  woff: 'font',
  woff2: 'font',
  exe: 'app',
  msi: 'app',
  apk: 'app',
  aab: 'app',
  ipa: 'app',
  deb: 'app',
  rpm: 'app',
  pkg: 'app',
  appimage: 'app',
  iso: 'disk',
  dmg: 'disk',
  img: 'disk',
  vmdk: 'disk',
  vdi: 'disk',
};

const BY_CATEGORY: Record<FileCategory, Shape> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  document: 'document',
  archive: 'archive',
  code: 'code',
  design: 'design',
  system: 'app',
  other: 'other',
};

function shapeFor(name: string, mimeType: string): Shape {
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  const specific = BY_EXTENSION[extension];
  if (specific) return specific;

  // Google's own formats carry no useful extension, so the mime type is the
  // only thing that says whether it is a document, a sheet or a deck.
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.includes('spreadsheet')) return 'sheet';
  if (mimeType.includes('presentation')) return 'slides';

  return BY_CATEGORY[categorise(mimeType, name)];
}

export function FileIcon({
  name,
  mimeType,
  isFolder,
  size = 22,
}: {
  name: string;
  mimeType: string;
  isFolder: boolean;
  size?: number;
}) {
  const shape = isFolder ? 'folder' : shapeFor(name, mimeType);
  const colour = isFolder ? 'var(--accent)' : CATEGORY_COLOURS[categorise(mimeType, name)];

  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <Glyph shape={shape} colour={colour} />
    </svg>
  );
}

/**
 * Every glyph is the same two-tone treatment - a soft body with a firmer detail
 * on top - so that eleven different shapes still read as one set.
 */
function Glyph({ shape, colour }: { shape: Shape; colour: string }) {
  const body = { fill: colour, opacity: 0.22 };
  const mid = { fill: colour, opacity: 0.55 };
  const strong = { fill: colour, opacity: 0.85 };

  switch (shape) {
    case 'folder':
      return (
        <>
          <path
            d="M3.2 6.6c0-1 .8-1.8 1.8-1.8h3.6l2 2.2h8.4c1 0 1.8.8 1.8 1.8v8.6c0 1-.8 1.8-1.8 1.8H5c-1 0-1.8-.8-1.8-1.8z"
            {...body}
            opacity={0.4}
          />
          <path d="M3.2 10.4h17.6v7c0 1-.8 1.8-1.8 1.8H5c-1 0-1.8-.8-1.8-1.8z" {...strong} />
        </>
      );

    case 'image':
      return (
        <>
          <rect x="3.2" y="5" width="17.6" height="14" rx="2.4" {...body} />
          <circle cx="8.6" cy="9.8" r="1.7" {...strong} />
          {/* Two overlapping hills, the universal shorthand for a photograph. */}
          <path d="M4.6 18.2 10 12.6l3.4 3.6 2.6-2.4 3.4 4.4z" {...mid} />
        </>
      );

    case 'video':
      return (
        <>
          <rect x="2.6" y="5" width="18.8" height="14" rx="2.4" {...body} />
          {/* Sprocket holes down both edges: a film strip, not just a frame. */}
          <path
            d="M4.6 7h1.8v1.8H4.6zm0 4.1h1.8v1.8H4.6zm0 4.1h1.8V17H4.6zM17.6 7h1.8v1.8h-1.8zm0 4.1h1.8v1.8h-1.8zm0 4.1h1.8V17h-1.8z"
            {...mid}
          />
          <path d="M10.2 8.9 15.4 12l-5.2 3.1z" {...strong} />
        </>
      );

    case 'audio':
      return (
        <>
          <circle cx="12" cy="12" r="9" {...body} />
          <path d="M14.6 5.6v8.1a2.6 2.6 0 1 1-1.6-2.4V7.4l-4.2 1v6.9a2.6 2.6 0 1 1-1.6-2.4V7z" {...strong} />
        </>
      );

    case 'pdf':
      return (
        <>
          <Page body={body} mid={mid} />
          {/* A band across the page is how a PDF badge reads at 22px; letters
              would be a smear at this size. */}
          <rect x="6.4" y="13.4" width="11.2" height="5" rx="1.4" {...strong} />
          <path
            d="M8.7 14.9h1.5c.6 0 1 .4 1 .9s-.4.9-1 .9H9.4v.9H8.7zm3.1 0h1.4c.9 0 1.4.5 1.4 1.4s-.5 1.4-1.4 1.4h-1.4zm3.5 0h2.1v.7h-1.4v.5h1.2v.7h-1.2v.8h-.7z"
            fill="#fff"
            opacity="0.92"
          />
        </>
      );

    case 'sheet':
      return (
        <>
          <Page body={body} mid={mid} />
          <path
            d="M6.6 12.4h10.8v6.6H6.6zm.9.9v1.4h3.6v-1.4zm4.5 0v1.4h3.9v-1.4zm-4.5 2.3v1.4h3.6v-1.4zm4.5 0v1.4h3.9v-1.4zm-4.5 2.3v1.4h3.6V17.9zm4.5 0v1.4h3.9V17.9z"
            {...strong}
          />
        </>
      );

    case 'slides':
      return (
        <>
          <Page body={body} mid={mid} />
          <rect x="6.6" y="12.6" width="10.8" height="5.4" rx="1.1" {...strong} />
          <path d="M11.6 18h.8v1.9h-.8z" {...strong} />
          <path d="M9.4 20.6h5.2v.9H9.4z" {...mid} />
        </>
      );

    case 'document':
      return (
        <>
          <Page body={body} mid={mid} />
          <rect x="7.6" y="12.4" width="8.8" height="1.5" rx="0.75" {...strong} />
          <rect x="7.6" y="15.6" width="6.2" height="1.5" rx="0.75" {...mid} />
        </>
      );

    case 'archive':
      return (
        <>
          <path d="M3.2 7.4c0-1 .8-1.8 1.8-1.8h14c1 0 1.8.8 1.8 1.8v11c0 1-.8 1.8-1.8 1.8H5c-1 0-1.8-.8-1.8-1.8z" {...body} />
          <path d="M3.2 9.6h17.6v1.9H3.2z" {...mid} />
          {/* The zip's own pull tab, offset so the box does not read as a folder. */}
          <path d="M10.9 5.6h2.2v3h-2.2zm0 4.6h2.2v2.2h-2.2zm.1 3.4h2v3.6a1 1 0 0 1-2 0z" {...strong} />
        </>
      );

    case 'design':
      return (
        <>
          <rect x="3.2" y="3.4" width="17.6" height="17.2" rx="3" {...body} />
          {/* A pen nib: the mark every design tool uses for itself. */}
          <path d="M12 6.4 15.4 13a3.8 3.8 0 1 1-6.8 0z" {...strong} />
          <path d="M12 14.6v3.2" {...mid} />
        </>
      );

    case 'font':
      return (
        <>
          <Page body={body} mid={mid} />
          {/* A serif A, which is what a typeface file previews as anywhere. */}
          <path d="M11 11.4h2l3.2 8.2h-1.9l-.7-2h-3.2l-.7 2H7.8zm.3 4.7h2.2L12.4 13z" {...strong} />
        </>
      );

    case 'app':
      return (
        <>
          <rect x="3.4" y="3.4" width="17.2" height="17.2" rx="4.2" {...body} />
          {/* Rounded square with a launch arrow: an installer, not a document. */}
          <path d="M12 15.6V7.8" {...strong} />
          <path d="M8.9 10.9 12 7.8l3.1 3.1" {...strong} />
          <path d="M7.6 16.4h8.8" {...mid} />
        </>
      );

    case 'disk':
      return (
        <>
          <circle cx="12" cy="12" r="8.6" {...body} />
          <circle cx="12" cy="12" r="4.4" {...mid} />
          <circle cx="12" cy="12" r="1.6" fill="var(--surface)" />
          <path d="M12 3.4a8.6 8.6 0 0 1 7.5 4.4l-3.8 2.2A4.4 4.4 0 0 0 12 7.8z" {...strong} />
        </>
      );

    case 'code':
      return (
        <>
          <rect x="2.8" y="4.6" width="18.4" height="14.8" rx="2.4" {...body} />
          <path d="M2.8 7.9h18.4v1.5H2.8z" {...mid} />
          <path
            d="M9.3 11.6 6.2 14.7l3.1 3.1 1.1-1.1-2-2 2-2zm5.4 0-1.1 1.1 2 2-2 2 1.1 1.1 3.1-3.1z"
            {...strong}
          />
        </>
      );

    case 'other':
    default:
      return (
        <>
          <Page body={body} mid={mid} />
          <rect x="7.6" y="13.4" width="8.8" height="1.5" rx="0.75" {...mid} />
        </>
      );
  }
}

/** The folded-corner sheet the document-ish glyphs are all built on. */
function Page({ body, mid }: { body: object; mid: object }) {
  return (
    <>
      <path d="M6 3.4h7.2L19 9.2v11.4c0 .6-.5 1-1 1H6c-.6 0-1-.4-1-1V4.4c0-.6.4-1 1-1z" {...body} />
      <path d="M13.2 3.4 19 9.2h-4.8a1 1 0 0 1-1-1z" {...mid} />
    </>
  );
}
