import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HIGHLIGHT_LIMIT, languageLabel, tokenise, type Token } from './highlight.js';

/** The tokens are lossless: rendering them back must give the input exactly. */
function rebuild(tokens: Token[]): string {
  return tokens.map((token) => token.text).join('');
}

function typeOf(tokens: Token[], text: string): string | undefined {
  return tokens.find((token) => token.text === text)?.type;
}

describe('tokenise', () => {
  it('never loses or invents a character', () => {
    // The viewer renders tokens instead of the raw string, so anything dropped
    // here is dropped from what the user sees.
    for (const [source, name] of [
      ['const a = 1; // note\n', 'a.ts'],
      ['def f():\n    return "x"\n', 'a.py'],
      ['<a href="x">hi &amp; bye</a>', 'a.html'],
      ['{"k": [1, true, null]}', 'a.json'],
      ['', 'a.ts'],
      ['\n\n\t  ', 'a.ts'],
    ] as const) {
      assert.equal(rebuild(tokenise(source, name)), source, name);
    }
  });

  it('keeps a keyword inside a comment a comment', () => {
    // Rule order is the whole design; get it wrong and every comment is a
    // patchwork of colours.
    const tokens = tokenise('// return this\nlet a = 1;', 'a.ts');
    assert.equal(tokens[0]!.type, 'comment');
    assert.equal(tokens[0]!.text, '// return this');
  });

  it('keeps a keyword inside a string a string', () => {
    const tokens = tokenise('const s = "for while";', 'a.ts');
    assert.equal(typeOf(tokens, '"for while"'), 'string');
  });

  it('marks keywords, numbers and literals separately', () => {
    const tokens = tokenise('const n = 42; let ok = true;', 'a.ts');
    assert.equal(typeOf(tokens, 'const'), 'keyword');
    assert.equal(typeOf(tokens, '42'), 'number');
    assert.equal(typeOf(tokens, 'true'), 'literal');
  });

  it('does not colour a word that merely contains a keyword', () => {
    const tokens = tokenise('formatted', 'a.ts');
    assert.equal(tokens.every((token) => token.type === 'plain'), true);
  });

  it('reads a JSON key differently from a JSON string value', () => {
    const tokens = tokenise('{"name": "orbit"}', 'a.json');
    assert.equal(typeOf(tokens, '"name"'), 'attribute');
    assert.equal(typeOf(tokens, '"orbit"'), 'string');
  });

  it('handles a triple-quoted Python string', () => {
    const source = '"""a\nb"""';
    const tokens = tokenise(source, 'a.py');
    assert.equal(tokens[0]!.type, 'string');
    assert.equal(tokens[0]!.text, source);
  });

  it('matches SQL keywords whatever their case', () => {
    assert.equal(typeOf(tokenise('SELECT * FROM t', 'a.sql'), 'SELECT'), 'keyword');
    assert.equal(typeOf(tokenise('select * from t', 'a.sql'), 'select'), 'keyword');
  });

  it('falls back to plain text for a language it does not know', () => {
    const tokens = tokenise('whatever this is', 'a.xyz');
    assert.deepEqual(tokens, [{ text: 'whatever this is', type: 'plain' }]);
  });

  it('gives up rather than crawling through a very large file', () => {
    const huge = 'const a = 1;\n'.repeat(Math.ceil(HIGHLIGHT_LIMIT / 12) + 10);
    const tokens = tokenise(huge, 'a.ts');
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0]!.type, 'plain');
  });

  it('terminates on input built to confuse it', () => {
    // An unterminated string or comment must not spin: every branch either
    // consumes a match or one character.
    for (const source of ['const s = "never closed', '/* open', '`${', "'"]) {
      assert.equal(rebuild(tokenise(source, 'a.ts')), source);
    }
  });
});

describe('languageLabel', () => {
  it('names the language for the toolbar', () => {
    assert.equal(languageLabel('main.ts'), 'TypeScript');
    assert.equal(languageLabel('script.py'), 'Python');
    assert.equal(languageLabel('notes.txt'), 'Plain text');
  });

  it('falls back rather than showing an extension nobody recognises', () => {
    assert.equal(languageLabel('data.xyz'), 'Plain text');
    assert.equal(languageLabel('LICENSE'), 'Plain text');
  });
});
