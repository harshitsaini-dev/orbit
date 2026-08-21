import {
  attribute,
  decodeXml,
  elements,
  MAX_ROWS,
  type DocBlock,
  type Sheet,
  type Slide,
} from './office.js';
import { bufferSource, readZipDirectory, readZipText } from './zip.js';

/**
 * LibreOffice's formats — .odt, .ods, .odp — and .epub.
 *
 * All of them are ZIPs, like Microsoft's, so the same reader opens them. The
 * vocabulary differs and the whole document lives in one content.xml rather
 * than a file per sheet, but the problem is identical: find the text, keep the
 * structure, ignore the styling. The results are the same shapes the Office
 * readers produce, so one set of viewers renders both.
 */

/** Text with inline formatting elements removed but their text kept. */
function stripTags(xml: string): string {
  return decodeXml(xml.replace(/<text:s\/>/g, ' ').replace(/<[^>]+>/g, ''));
}

async function contentOf(bytes: Uint8Array): Promise<string> {
  const source = bufferSource(bytes);
  const entries = await readZipDirectory(source);

  const content = await readZipText(source, entries, 'content.xml');
  if (!content) throw new Error('This is not an OpenDocument file.');
  return content;
}

/**
 * A run of identical cells is stored once with a repeat count, and ODF pads
 * every row with a trailing run of a thousand empty ones. Expanding that
 * literally gives each sheet a thousand blank columns, so repeats are capped.
 */
const MAX_REPEAT = 256;

export async function readOpenSpreadsheet(bytes: Uint8Array): Promise<Sheet[]> {
  const content = await contentOf(bytes);
  const sheets: Sheet[] = [];

  for (const table of elements(content, 'table:table')) {
    const name = attribute(table.attrs, 'table:name') ?? `Sheet ${sheets.length + 1}`;
    const rows: string[][] = [];
    let overCap = 0;

    for (const row of elements(table.inner, 'table:table-row')) {
      const repeatRow = Number(attribute(row.attrs, 'table:number-rows-repeated') ?? '1');
      const cells: string[] = [];

      for (const cell of elements(row.inner, 'table:table-cell')) {
        const repeat = Math.min(
          Number(attribute(cell.attrs, 'table:number-columns-repeated') ?? '1'),
          MAX_REPEAT,
        );
        const text = stripTags(cell.inner).trim();
        for (let index = 0; index < repeat; index += 1) cells.push(text);
      }

      while (cells.length > 0 && cells.at(-1) === '') cells.pop();

      // An empty repeated row is padding; a repeated row with content is a
      // genuine run, but never a thousand of them in a preview.
      const times = cells.length === 0 ? 1 : Math.min(repeatRow, 64);
      for (let index = 0; index < times; index += 1) {
        if (rows.length >= MAX_ROWS) overCap += 1;
        else rows.push([...cells]);
      }
    }

    while (rows.length > 0 && rows.at(-1)!.every((cell) => cell === '')) rows.pop();
    sheets.push({ name, rows, truncatedRows: overCap });
  }

  if (sheets.length === 0) throw new Error('This spreadsheet has no readable sheets.');
  return sheets;
}

export async function readOpenText(bytes: Uint8Array): Promise<DocBlock[]> {
  const content = await contentOf(bytes);
  const body = [...elements(content, 'office:text')][0]?.inner ?? content;
  const blocks: DocBlock[] = [];

  // Headings, paragraphs, lists and tables interleave; reading each kind
  // separately would put every table at the end of the document.
  const pattern = /<(text:h|text:p|text:list|table:table)((?:\s[^>]*?)?)(?:\/>|>([\s\S]*?)<\/\1>)/g;
  let match = pattern.exec(body);

  while (match) {
    const tag = match[1]!;
    const attrs = match[2] ?? '';
    const inner = match[3] ?? '';

    if (tag === 'table:table') {
      const rows: string[][] = [];
      for (const row of elements(inner, 'table:table-row')) {
        const cells: string[] = [];
        for (const cell of elements(row.inner, 'table:table-cell')) {
          cells.push(stripTags(cell.inner).trim());
        }
        rows.push(cells);
      }
      if (rows.length > 0) blocks.push({ kind: 'table', rows });
    } else if (tag === 'text:h') {
      const level = Number(attribute(attrs, 'text:outline-level') ?? '1');
      const text = stripTags(inner).trim();
      if (text) blocks.push({ kind: 'heading', level: Math.min(6, Math.max(1, level)), text });
    } else if (tag === 'text:list') {
      for (const item of elements(inner, 'text:list-item')) {
        const text = stripTags(item.inner).trim();
        if (text) blocks.push({ kind: 'list', text });
      }
    } else {
      blocks.push({ kind: 'paragraph', text: stripTags(inner).trim() });
    }

    match = pattern.exec(body);
  }

  if (blocks.length === 0) throw new Error('This document appears to be empty.');
  return blocks;
}

export async function readOpenPresentation(bytes: Uint8Array): Promise<Slide[]> {
  const content = await contentOf(bytes);
  const slides: Slide[] = [];

  for (const page of elements(content, 'draw:page')) {
    const blocks: string[] = [];

    for (const frame of elements(page.inner, 'draw:frame')) {
      const lines: string[] = [];
      for (const paragraph of elements(frame.inner, 'text:p')) {
        const line = stripTags(paragraph.inner).trim();
        if (line) lines.push(line);
      }
      if (lines.length > 0) blocks.push(lines.join('\n'));
    }

    slides.push({ number: slides.length + 1, blocks, notes: null });
  }

  if (slides.length === 0) throw new Error('This presentation has no slides.');
  return slides;
}

/**
 * An EPUB is a ZIP of XHTML chapters listed in an OPF manifest, whose location
 * is named in META-INF/container.xml.
 *
 * Read in the order the spine gives rather than the order the ZIP lists, since
 * chapter10 sorts before chapter2 and a book would open scrambled.
 */
export async function readEpub(bytes: Uint8Array): Promise<DocBlock[]> {
  const source = bufferSource(bytes);
  const entries = await readZipDirectory(source);

  const container = await readZipText(source, entries, 'META-INF/container.xml');
  const opfPath = container
    ? attribute([...elements(container, 'rootfile')][0]?.attrs ?? '', 'full-path')
    : undefined;
  if (!opfPath) throw new Error('This EPUB has no readable index.');

  const opf = await readZipText(source, entries, opfPath);
  if (!opf) throw new Error('This EPUB has no readable index.');

  // Manifest hrefs are relative to the OPF, which is usually in a subfolder.
  const base = opfPath.includes('/') ? `${opfPath.slice(0, opfPath.lastIndexOf('/') + 1)}` : '';

  const manifest = new Map<string, string>();
  for (const { attrs } of elements(opf, 'item')) {
    const id = attribute(attrs, 'id');
    const href = attribute(attrs, 'href');
    if (id && href) manifest.set(id, `${base}${href}`);
  }

  const blocks: DocBlock[] = [];

  for (const { attrs } of elements(opf, 'itemref')) {
    const href = manifest.get(attribute(attrs, 'idref') ?? '');
    if (!href) continue;

    const chapter = await readZipText(source, entries, href);
    if (!chapter) continue;

    const body = [...elements(chapter, 'body')][0]?.inner ?? chapter;
    // Scripts and styles hold no reading text and would otherwise land in the
    // middle of the book as a wall of code.
    const clean = body.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');

    const pattern = /<(h[1-6]|p|li)(?:\s[^>]*?)?>([\s\S]*?)<\/\1>/gi;
    let match = pattern.exec(clean);

    while (match) {
      const tag = match[1]!.toLowerCase();
      const text = stripTags(match[2] ?? '')
        .replace(/\s+/g, ' ')
        .trim();

      if (text) {
        if (tag.startsWith('h')) blocks.push({ kind: 'heading', level: Number(tag[1]), text });
        else if (tag === 'li') blocks.push({ kind: 'list', text });
        else blocks.push({ kind: 'paragraph', text });
      }

      match = pattern.exec(clean);
    }
  }

  if (blocks.length === 0) throw new Error('This EPUB has no readable text.');
  return blocks;
}
