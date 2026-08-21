import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { columnIndex, excelDate, readDocument, readPresentation, readSpreadsheet } from './office.js';

/**
 * Read against real files, written by Excel's and Word's own format through
 * openpyxl, python-docx and python-pptx. A hand-built fixture would only prove
 * the reader agrees with whoever wrote the fixture — which is the same person
 * who wrote the reader.
 *
 * Regenerate with `scripts/make-office-fixtures.py` if the samples change.
 */
async function fixture(name: string): Promise<Uint8Array> {
  const path = fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));
  return new Uint8Array(await readFile(path));
}

describe('readSpreadsheet', () => {
  it('reads every sheet, by name', async () => {
    const sheets = await readSpreadsheet(await fixture('sample.xlsx'));
    assert.deepEqual(sheets.map((sheet) => sheet.name), ['Sales', 'Notes']);
  });

  it('reads headers and values', async () => {
    const [sales] = await readSpreadsheet(await fixture('sample.xlsx'));

    assert.deepEqual(sales!.rows[0], ['Region', 'Units', 'Revenue', 'Signed']);
    assert.equal(sales!.rows[1]![0], 'North');
    assert.equal(sales!.rows[1]![1], '120');
    assert.equal(sales!.rows[1]![2], '4500.5');
  });

  it('turns a date serial back into a date', async () => {
    // Stored as a number with a date format; shown raw it is "46095", which is
    // the single most confusing thing a spreadsheet preview can display.
    const [sales] = await readSpreadsheet(await fixture('sample.xlsx'));
    assert.equal(sales!.rows[1]![3], '2026-03-14');
    assert.equal(sales!.rows[2]![3], '2026-04-01');
  });

  it('keeps a gap in a row as a gap', async () => {
    // A row lists only the cells that hold something. Without reading each
    // cell's reference, a value in column D lands in column B and every sheet
    // with a blank cell is quietly wrong.
    const [sales] = await readSpreadsheet(await fixture('sample.xlsx'));
    const east = sales!.rows.find((row) => row[0] === 'East');

    assert.ok(east, 'the row with a gap should be present');
    assert.equal(east[1], '');
    assert.equal(east[2], '');
    assert.equal(east[3], '2026-05-20');
  });

  it('reads strings that contain quotes and commas', async () => {
    const [, notes] = await readSpreadsheet(await fixture('sample.xlsx'));
    assert.equal(notes!.rows[0]![0], 'Quoted, with comma');
    assert.equal(notes!.rows[1]![0], 'He said "hi"');
  });

  it('refuses something that is not a spreadsheet', async () => {
    // A .docx is also a ZIP, so it opens - and then has no workbook in it.
    const notASheet = await fixture('sample.docx');
    await assert.rejects(() => readSpreadsheet(notASheet), /workbook/);
  });
});

describe('columnIndex', () => {
  it('maps a column reference to a position', () => {
    assert.equal(columnIndex('A1'), 0);
    assert.equal(columnIndex('D5'), 3);
    assert.equal(columnIndex('Z1'), 25);
    // The place a naive base-26 conversion goes wrong: there is no zero digit.
    assert.equal(columnIndex('AA1'), 26);
    assert.equal(columnIndex('AB1'), 27);
  });
});

describe('excelDate', () => {
  it('converts a serial to the date Excel shows', () => {
    assert.equal(excelDate(46095).toISOString().slice(0, 10), '2026-03-14');
  });
});

describe('readDocument', () => {
  it('keeps headings, paragraphs and lists apart', async () => {
    const blocks = await readDocument(await fixture('sample.docx'));

    const heading = blocks.find((block) => block.kind === 'heading');
    assert.equal(heading?.text, 'Quarterly report');
    assert.equal(heading?.level, 1);

    assert.ok(blocks.some((block) => block.kind === 'list' && block.text === 'First finding'));
    assert.ok(
      blocks.some((block) => block.kind === 'paragraph' && block.text?.startsWith('An ordinary')),
    );
  });

  it('reads a table as rows and cells', async () => {
    const blocks = await readDocument(await fixture('sample.docx'));
    const table = blocks.find((block) => block.kind === 'table');

    assert.deepEqual(table?.rows, [
      ['Metric', 'Value'],
      ['Units', '200'],
    ]);
  });

  it('keeps a table where it belongs in the document', async () => {
    // Reading paragraphs and tables separately would put every table at the
    // end, which is not what anyone wrote.
    const blocks = await readDocument(await fixture('sample.docx'));
    const tableAt = blocks.findIndex((block) => block.kind === 'table');
    const closingAt = blocks.findIndex((block) => block.text?.startsWith('Closing'));

    assert.ok(tableAt >= 0 && closingAt >= 0);
    assert.ok(tableAt < closingAt, 'the table comes before the closing paragraph');
  });
});

describe('readPresentation', () => {
  it('reads slides in order', async () => {
    const slides = await readPresentation(await fixture('sample.pptx'));

    assert.equal(slides.length, 2);
    assert.deepEqual(slides.map((slide) => slide.number), [1, 2]);
    assert.ok(slides[0]!.blocks[0]?.includes('Orbit'));
    assert.ok(slides[1]!.blocks[0]?.includes('Second slide'));
  });

  it('keeps a shape\'s lines together', async () => {
    const [first] = await readPresentation(await fixture('sample.pptx'));
    const body = first!.blocks.find((block) => block.includes('One workspace'));

    assert.ok(body?.includes('Every cloud'), 'both lines belong to the same shape');
  });

  it('reads speaker notes when there are any', async () => {
    const slides = await readPresentation(await fixture('sample.pptx'));

    assert.match(slides[0]!.notes ?? '', /proxy/);
    assert.equal(slides[1]!.notes, null);
  });
});
