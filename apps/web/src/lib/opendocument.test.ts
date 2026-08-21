import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { readOpenPresentation, readOpenSpreadsheet, readOpenText } from './opendocument.js';

/** Written by odfpy, which writes the format LibreOffice writes. */
async function fixture(name: string): Promise<Uint8Array> {
  const path = fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));
  return new Uint8Array(await readFile(path));
}

describe('readOpenSpreadsheet', () => {
  it('reads a sheet by name, with its rows', async () => {
    const [sheet] = await readOpenSpreadsheet(await fixture('sample.ods'));

    assert.equal(sheet!.name, 'Sales');
    assert.deepEqual(sheet!.rows[0], ['Region', 'Units']);
    assert.deepEqual(sheet!.rows[1], ['North', '120']);
  });

  it('does not expand the padding ODF writes at the end of every row', async () => {
    // A row ends with a run of a thousand empty cells stored as one repeated
    // cell. Expanding that literally gives every sheet a thousand columns.
    const [sheet] = await readOpenSpreadsheet(await fixture('sample.ods'));
    assert.ok(sheet!.rows.every((row) => row.length < 10), 'rows should not be padded out');
  });
});

describe('readOpenText', () => {
  it('keeps headings, paragraphs and lists apart', async () => {
    const blocks = await readOpenText(await fixture('sample.odt'));

    const heading = blocks.find((block) => block.kind === 'heading');
    assert.equal(heading?.text, 'Quarterly report');
    assert.equal(heading?.level, 1);

    assert.ok(blocks.some((block) => block.kind === 'list' && block.text === 'First finding'));
    assert.ok(
      blocks.some((block) => block.kind === 'paragraph' && block.text?.startsWith('An ordinary')),
    );
  });

  it('reads a table where it appears, not at the end', async () => {
    const blocks = await readOpenText(await fixture('sample.odt'));
    const tableAt = blocks.findIndex((block) => block.kind === 'table');
    const closingAt = blocks.findIndex((block) => block.text?.startsWith('Closing'));

    assert.ok(tableAt >= 0, 'the table should be read');
    assert.deepEqual(blocks[tableAt]!.rows, [
      ['Metric', 'Value'],
      ['Units', '200'],
    ]);
    assert.ok(tableAt < closingAt, 'and it comes before the closing paragraph');
  });

  it('refuses a file that is not OpenDocument', async () => {
    const notOdf = await fixture('sample.xlsx');
    await assert.rejects(() => readOpenText(notOdf), /not an OpenDocument/);
  });
});

describe('readOpenPresentation', () => {
  it('reads slides in order with their text', async () => {
    const slides = await readOpenPresentation(await fixture('sample.odp'));

    assert.equal(slides.length, 2);
    assert.ok(slides[0]!.blocks.some((block) => block.includes('Orbit')));
    assert.ok(slides[1]!.blocks.some((block) => block.includes('Second slide')));
  });
});
