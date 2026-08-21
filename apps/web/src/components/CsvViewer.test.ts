import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseDelimited } from './CsvViewer.js';

describe('parseDelimited', () => {
  it('reads plain rows and columns', () => {
    assert.deepEqual(parseDelimited('a,b\n1,2', ','), [
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('keeps a comma that is inside a quoted field', () => {
    // Splitting on commas would shift every column after this one, and the
    // table would look plausible while being wrong.
    assert.deepEqual(parseDelimited('name,note\nAda,"Lovelace, Ada"', ','), [
      ['name', 'note'],
      ['Ada', 'Lovelace, Ada'],
    ]);
  });

  it('keeps a newline that is inside a quoted field', () => {
    assert.deepEqual(parseDelimited('a\n"one\ntwo"', ','), [['a'], ['one\ntwo']]);
  });

  it('reads a doubled quote as one literal quote', () => {
    assert.deepEqual(parseDelimited('a\n"say ""hi"""', ','), [['a'], ['say "hi"']]);
  });

  it('treats CRLF as one line break', () => {
    // Two breaks would put an empty row between every pair of real ones.
    assert.deepEqual(parseDelimited('a,b\r\n1,2\r\n', ','), [
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('keeps empty fields rather than collapsing them', () => {
    assert.deepEqual(parseDelimited('a,,c', ','), [['a', '', 'c']]);
  });

  it('reads tab-separated files with the same rules', () => {
    assert.deepEqual(parseDelimited('a\tb\n1\t2', '\t'), [
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('returns nothing for an empty file', () => {
    assert.deepEqual(parseDelimited('', ','), []);
  });

  it('does not invent a trailing row for a file ending in a newline', () => {
    assert.deepEqual(parseDelimited('a,b\n', ','), [['a', 'b']]);
  });
});
