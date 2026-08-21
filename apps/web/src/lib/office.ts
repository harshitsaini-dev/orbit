import { bufferSource, readZipDirectory, readZipText, type ByteSource, type ZipEntry } from './zip.js';

/**
 * Reading .xlsx, .docx and .pptx.
 *
 * All three are ZIPs of XML, which the reader next door already opens, so this
 * is parsing rather than a new dependency. That is not only tidiness: the
 * maintained build of the usual spreadsheet library is not published to npm,
 * and the version that is has an unpatched prototype-pollution advisory — which
 * is not a thing to point at files somebody else wrote.
 *
 * These are previews. Values, text and structure are read; formulas, styling,
 * charts and images are not. Where that shows, the viewer says so rather than
 * quietly presenting a partial document as the whole one.
 */

// --- shared XML helpers ---------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

export function decodeXml(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return ENTITIES[entity] ?? whole;
  });
}

/** Every match of a tag, with its attribute string and its inner XML. */
function* elements(xml: string, name: string): Generator<{ attrs: string; inner: string }> {
  const pattern = new RegExp(`<${name}(\\s[^>]*?)?(/>|>([\\s\\S]*?)</${name}>)`, 'g');
  let match = pattern.exec(xml);
  while (match) {
    yield { attrs: match[1] ?? '', inner: match[3] ?? '' };
    match = pattern.exec(xml);
  }
}

function attribute(attrs: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return match ? decodeXml(match[1]!) : undefined;
}

/** All text inside an element, entities decoded, tags dropped. */
function textOf(xml: string, tag: string): string {
  let out = '';
  for (const element of elements(xml, tag)) out += decodeXml(element.inner);
  return out;
}

// --- spreadsheets ---------------------------------------------------------

export interface Sheet {
  name: string;
  rows: string[][];
  /** Rows beyond the cap, which are counted but not read. */
  truncatedRows: number;
}

/** A sheet can be a million rows; a preview that renders them all is a hang. */
const MAX_ROWS = 1000;

/**
 * Turns a column reference into an index: A is 0, Z is 25, AA is 26.
 *
 * Needed because a row only lists the cells that have something in them - a
 * row with A1 and D1 gives two cells, and without this the D would land in
 * column B and every sheet with a gap would be silently wrong.
 */
export function columnIndex(reference: string): number {
  const letters = /^([A-Z]+)/.exec(reference.toUpperCase())?.[1] ?? '';
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

/** Excel counts days from 1900, with a deliberate bug: it thinks 1900 was a leap year. */
export function excelDate(serial: number): Date {
  const asMilliseconds = Math.round((serial - 25569) * 86400 * 1000);
  return new Date(asMilliseconds);
}

/** Built-in number format ids that mean a date or a time. */
const DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

export async function readSpreadsheet(bytes: Uint8Array): Promise<Sheet[]> {
  const source = bufferSource(bytes);
  const entries = await readZipDirectory(source);

  const workbook = await readZipText(source, entries, 'xl/workbook.xml');
  if (!workbook) throw new Error('This spreadsheet is missing its workbook.');

  const shared = await readSharedStrings(source, entries);
  const dateStyles = await readDateStyles(source, entries);

  // Sheets are named in the workbook and stored under ids that the rels file
  // maps to file names - the order in the folder means nothing.
  const rels = (await readZipText(source, entries, 'xl/_rels/workbook.xml.rels')) ?? '';
  const targets = new Map<string, string>();
  for (const { attrs } of elements(rels, 'Relationship')) {
    const id = attribute(attrs, 'Id');
    const target = attribute(attrs, 'Target');
    if (id && target) targets.set(id, target.replace(/^\/?xl\//, '').replace(/^\//, ''));
  }

  const sheets: Sheet[] = [];

  for (const { attrs } of elements(workbook, 'sheet')) {
    const name = attribute(attrs, 'name') ?? `Sheet ${sheets.length + 1}`;
    const relationId = attribute(attrs, 'r:id') ?? attribute(attrs, 'id');
    const target = relationId ? targets.get(relationId) : undefined;

    const path = `xl/${target ?? `worksheets/sheet${sheets.length + 1}.xml`}`;
    const xml = await readZipText(source, entries, path);
    if (!xml) continue;

    sheets.push({ name, ...readSheet(xml, shared, dateStyles) });
  }

  if (sheets.length === 0) throw new Error('This spreadsheet has no readable sheets.');
  return sheets;
}

async function readSharedStrings(source: ByteSource, entries: ZipEntry[]): Promise<string[]> {
  const xml = await readZipText(source, entries, 'xl/sharedStrings.xml');
  if (!xml) return [];

  // Every <si> is one string, but it may be split across several <t> runs when
  // parts of it are formatted differently, so the runs are joined.
  const strings: string[] = [];
  for (const item of elements(xml, 'si')) strings.push(textOf(item.inner, 't'));
  return strings;
}

/** Which style indexes mean "this number is a date". */
async function readDateStyles(source: ByteSource, entries: ZipEntry[]): Promise<Set<number>> {
  const xml = await readZipText(source, entries, 'xl/styles.xml');
  const dateStyles = new Set<number>();
  if (!xml) return dateStyles;

  const customDateFormats = new Set<number>();
  for (const { attrs } of elements(xml, 'numFmt')) {
    const id = Number(attribute(attrs, 'numFmtId'));
    const code = attribute(attrs, 'formatCode') ?? '';
    // A custom format is a date if it mentions one. Stripping quoted literals
    // first, or a format like "Month"0 would look like one because of the m.
    const bare = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '');
    if (/[dmyhs]/i.test(bare) && !/^[#0.,%\s]*$/.test(bare)) customDateFormats.add(id);
  }

  // cellXfs is indexed by a cell's s= attribute, so position is the key.
  const cellXfs = [...elements(xml, 'cellXfs')][0]?.inner ?? '';
  let index = 0;
  for (const { attrs } of elements(cellXfs, 'xf')) {
    const formatId = Number(attribute(attrs, 'numFmtId') ?? '0');
    if (DATE_FORMAT_IDS.has(formatId) || customDateFormats.has(formatId)) dateStyles.add(index);
    index += 1;
  }

  return dateStyles;
}

function readSheet(
  xml: string,
  shared: string[],
  dateStyles: Set<number>,
): { rows: string[][]; truncatedRows: number } {
  const rows: string[][] = [];
  // Counted separately from trimming: rows dropped for being past the cap are
  // rows the reader is hiding, whereas trailing blanks are an artefact of where
  // someone once clicked. Reporting the second as the first told the user five
  // rows were missing from a sheet that had none.
  let overCap = 0;

  for (const row of elements(xml, 'row')) {
    if (rows.length >= MAX_ROWS) {
      overCap += 1;
      continue;
    }

    const cells: string[] = [];

    for (const cell of elements(row.inner, 'c')) {
      const reference = attribute(cell.attrs, 'r') ?? '';
      const type = attribute(cell.attrs, 't');
      const style = Number(attribute(cell.attrs, 's') ?? '-1');

      let value: string;
      if (type === 's') {
        value = shared[Number(textOf(cell.inner, 'v'))] ?? '';
      } else if (type === 'inlineStr') {
        value = textOf(cell.inner, 't');
      } else if (type === 'e') {
        // A formula error is worth showing as itself rather than as blank.
        value = textOf(cell.inner, 'v');
      } else {
        const raw = textOf(cell.inner, 'v');
        value =
          raw !== '' && dateStyles.has(style) && Number.isFinite(Number(raw))
            ? formatDate(excelDate(Number(raw)))
            : raw;
      }

      const column = reference ? columnIndex(reference) : cells.length;
      while (cells.length < column) cells.push('');
      cells[column] = value;
    }

    rows.push(cells);
  }

  // Trailing empty rows and columns are an artefact of where someone once
  // clicked, not content, and they make a preview look broken.
  while (rows.length > 0 && rows.at(-1)!.every((cell) => cell === '')) rows.pop();

  return { rows, truncatedRows: overCap };
}

function formatDate(date: Date): string {
  if (Number.isNaN(date.getTime())) return '';
  const iso = date.toISOString();
  // Midnight almost always means the value was a date, not a moment.
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 16).replace('T', ' ');
}

// --- documents ------------------------------------------------------------

export interface DocBlock {
  kind: 'heading' | 'paragraph' | 'list' | 'table';
  /** Heading level, 1 to 6. */
  level?: number;
  text?: string;
  rows?: string[][];
}

export async function readDocument(bytes: Uint8Array): Promise<DocBlock[]> {
  const source = bufferSource(bytes);
  const entries = await readZipDirectory(source);

  const xml = await readZipText(source, entries, 'word/document.xml');
  if (!xml) throw new Error('This document is missing its body.');

  const body = [...elements(xml, 'w:body')][0]?.inner ?? xml;
  const blocks: DocBlock[] = [];

  // Paragraphs and tables interleave, and reading each kind separately would
  // put every table at the end of the document.
  const pattern = /<w:(p|tbl)(?:\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/w:\1>)/g;
  let match = pattern.exec(body);

  while (match) {
    const kind = match[1];
    const inner = match[2] ?? '';

    if (kind === 'tbl') {
      const rows: string[][] = [];
      for (const row of elements(inner, 'w:tr')) {
        const cells: string[] = [];
        for (const cell of elements(row.inner, 'w:tc')) cells.push(textOf(cell.inner, 'w:t').trim());
        rows.push(cells);
      }
      if (rows.length > 0) blocks.push({ kind: 'table', rows });
    } else {
      const text = textOf(inner, 'w:t').trim();
      const style = [...elements(inner, 'w:pStyle')][0]?.attrs ?? '';
      const styleName = attribute(style, 'w:val') ?? '';
      const heading = /^Heading(\d)$/i.exec(styleName);
      // Numbering can live on the paragraph or only in the style it points at,
      // and Word's own list styles ("ListBullet", "ListNumber") take the second
      // route - so a paragraph with no numPr can still be a list item.
      const isList = inner.includes('<w:numPr') || /^List/i.test(styleName);

      if (text === '') {
        // An empty paragraph is spacing, not content - but two in a row are how
        // a document separates sections, so one is kept as a break.
        if (blocks.at(-1)?.kind !== 'paragraph' || blocks.at(-1)?.text !== '') {
          blocks.push({ kind: 'paragraph', text: '' });
        }
      } else if (heading) {
        blocks.push({ kind: 'heading', level: Math.min(6, Number(heading[1])), text });
      } else if (isList) {
        blocks.push({ kind: 'list', text });
      } else {
        blocks.push({ kind: 'paragraph', text });
      }
    }

    match = pattern.exec(body);
  }

  if (blocks.length === 0) throw new Error('This document appears to be empty.');
  return blocks;
}

// --- presentations --------------------------------------------------------

export interface Slide {
  number: number;
  /** One entry per shape, in the order the file lists them. */
  blocks: string[];
  notes: string | null;
}

export async function readPresentation(bytes: Uint8Array): Promise<Slide[]> {
  const source = bufferSource(bytes);
  const entries = await readZipDirectory(source);

  const slideEntries = entries
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.name))
    // slide10 must not sort before slide2, which is what a plain sort gives.
    .sort((a, b) => slideNumber(a.name) - slideNumber(b.name));

  if (slideEntries.length === 0) throw new Error('This presentation has no slides.');

  const slides: Slide[] = [];

  for (const entry of slideEntries) {
    const xml = (await readZipText(source, entries, entry.name)) ?? '';
    const number = slideNumber(entry.name);

    // Each <a:p> is a paragraph within a shape; joining per shape keeps a
    // title separate from the bullets under it.
    const blocks: string[] = [];
    for (const shape of elements(xml, 'p:sp')) {
      const lines: string[] = [];
      for (const paragraph of elements(shape.inner, 'a:p')) {
        const line = textOf(paragraph.inner, 'a:t').trim();
        if (line) lines.push(line);
      }
      if (lines.length > 0) blocks.push(lines.join('\n'));
    }

    const notesXml = await readZipText(source, entries, `ppt/notesSlides/notesSlide${number}.xml`);
    const notes = notesXml ? textOf(notesXml, 'a:t').trim() : '';

    slides.push({ number, blocks, notes: notes || null });
  }

  return slides;
}

function slideNumber(path: string): number {
  return Number(/(\d+)\.xml$/.exec(path)?.[1] ?? '0');
}
