import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeXmlText, eachTag, firstTag, parseS3Error } from './xml.js';

describe('firstTag', () => {
  it('reads the text of an element', () => {
    assert.equal(firstTag('<a><Key>photo.jpg</Key></a>', 'Key'), 'photo.jpg');
  });

  it('returns undefined rather than an empty string when absent', () => {
    // The caller has to be able to tell "not present" from "present and empty".
    assert.equal(firstTag('<a></a>', 'Key'), undefined);
    assert.equal(firstTag('<a><Key></Key></a>', 'Key'), '');
  });

  it('reads an element that carries attributes', () => {
    assert.equal(firstTag('<Key xmlns="x">v</Key>', 'Key'), 'v');
  });

  it('does not match a longer element with the same beginning', () => {
    // <KeyCount> is a real neighbour of <Key> in a ListObjectsV2 response.
    assert.equal(firstTag('<KeyCount>7</KeyCount><Key>a</Key>', 'Key'), 'a');
  });
});

describe('eachTag', () => {
  it('returns every match in document order', () => {
    const blocks = eachTag('<C><K>a</K></C><C><K>b</K></C>', 'C');
    assert.deepEqual(blocks.map((block) => firstTag(block, 'K')), ['a', 'b']);
  });

  it('returns nothing for an element that is not there', () => {
    assert.deepEqual(eachTag('<ListBucketResult></ListBucketResult>', 'Contents'), []);
  });
});

describe('decodeXmlText', () => {
  it('decodes the five named entities', () => {
    assert.equal(decodeXmlText('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;'), `a & b <c> "d" 'e'`);
  });

  it('decodes numeric references, decimal and hexadecimal', () => {
    assert.equal(decodeXmlText('&#65;&#x42;'), 'AB');
  });

  it('leaves an unknown entity alone rather than dropping it', () => {
    // Losing characters from a key silently would make the object unreachable.
    assert.equal(decodeXmlText('a&nbsp;b'), 'a&nbsp;b');
  });
});

describe('parseS3Error', () => {
  it('keeps the code as well as the message', () => {
    // NoSuchKey and AccessDenied mean different things to the caller, and the
    // HTTP status does not always separate them.
    const error = parseS3Error('<Error><Code>NoSuchKey</Code><Message>gone</Message></Error>');
    assert.deepEqual(error, { code: 'NoSuchKey', message: 'gone' });
  });

  it('copes with a body that is not an error document', () => {
    assert.deepEqual(parseS3Error('<CopyObjectResult/>'), {});
  });
});
