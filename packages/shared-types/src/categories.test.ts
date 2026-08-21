import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FILE_CATEGORIES, CATEGORY_COLOURS, CATEGORY_LABELS, categorise, extensionOf, summarise } from './categories.js';

describe('categorise', () => {
  it('trusts a specific mime type', () => {
    assert.equal(categorise('image/png', 'x'), 'image');
    assert.equal(categorise('video/mp4', 'x'), 'video');
    assert.equal(categorise('audio/mpeg', 'x'), 'audio');
    assert.equal(categorise('application/pdf', 'x'), 'document');
  });

  it('falls back to the extension when the mime type is generic', () => {
    // Object stores label almost everything application/octet-stream, so the
    // extension is all there is to go on.
    assert.equal(categorise('application/octet-stream', 'holiday.MP4'), 'video');
    assert.equal(categorise('application/octet-stream', 'song.flac'), 'audio');
    assert.equal(categorise('application/octet-stream', 'backup.tar.gz'), 'archive');
    assert.equal(categorise('binary/octet-stream', 'photo.HEIC'), 'image');
  });

  it('classifies Google-native documents, which have no useful mime prefix', () => {
    assert.equal(categorise('application/vnd.google-apps.document', 'Notes'), 'document');
    assert.equal(categorise('application/vnd.google-apps.spreadsheet', 'Budget'), 'document');
    assert.equal(categorise('application/vnd.google-apps.drawing', 'Sketch'), 'image');
    assert.equal(categorise('application/vnd.google-apps.script', 'Macro'), 'code');
  });

  it('prefers a specific mime type over a misleading extension', () => {
    assert.equal(categorise('image/jpeg', 'not-really.zip'), 'image');
  });

  it('handles a missing mime type and a missing name', () => {
    assert.equal(categorise(undefined, 'clip.mkv'), 'video');
    assert.equal(categorise(undefined, ''), 'other');
    assert.equal(categorise('', ''), 'other');
  });

  it('is case-insensitive about both', () => {
    assert.equal(categorise('IMAGE/PNG', 'X'), 'image');
    assert.equal(categorise('application/octet-stream', 'REPORT.PDF'), 'document');
  });

  it('never invents a category outside the declared set', () => {
    for (const sample of ['application/x-unknown', 'weird', '', 'font/woff2']) {
      assert.ok(FILE_CATEGORIES.includes(categorise(sample, 'file.bin')));
    }
  });
});

describe('extensionOf', () => {
  it('reads the last extension', () => {
    assert.equal(extensionOf('a.tar.gz'), 'gz');
    assert.equal(extensionOf('Photo.JPEG'), 'jpeg');
  });

  it('returns nothing for a name with no usable extension', () => {
    assert.equal(extensionOf('README'), '');
    assert.equal(extensionOf('.gitignore'), '', 'a dotfile has no extension');
    assert.equal(extensionOf('trailing.'), '');
  });
});

describe('summarise', () => {
  it('totals size and count per category, largest first', () => {
    const totals = summarise([
      { mimeType: 'image/jpeg', name: 'a.jpg', sizeBytes: 100 },
      { mimeType: 'image/jpeg', name: 'b.jpg', sizeBytes: 300 },
      { mimeType: 'video/mp4', name: 'c.mp4', sizeBytes: 1000 },
      { mimeType: 'application/pdf', name: 'd.pdf', sizeBytes: 50 },
    ]);

    assert.deepEqual(
      totals.map((t) => [t.category, t.fileCount, t.sizeBytes]),
      [
        ['video', 1, 1000],
        ['image', 2, 400],
        ['document', 1, 50],
      ],
    );
  });

  it('skips folders, which are containers rather than content', () => {
    const totals = summarise([
      { mimeType: 'application/vnd.google-apps.folder', name: 'Photos', isFolder: true, sizeBytes: 0 },
      { mimeType: 'image/png', name: 'a.png', sizeBytes: 10 },
    ]);

    assert.equal(totals.length, 1);
    assert.equal(totals[0]!.fileCount, 1);
  });

  it('counts a zero-byte file rather than dropping it', () => {
    // Google-native documents report no size at all; they still exist.
    const totals = summarise([{ mimeType: 'application/vnd.google-apps.document', name: 'Doc' }]);
    assert.equal(totals[0]!.fileCount, 1);
    assert.equal(totals[0]!.sizeBytes, 0);
  });

  it('returns nothing for an empty set', () => {
    assert.deepEqual(summarise([]), []);
  });
});

describe('presentation tables', () => {
  it('gives every category a label and a colour', () => {
    for (const category of FILE_CATEGORIES) {
      assert.ok(CATEGORY_LABELS[category]);
      assert.match(CATEGORY_COLOURS[category], /^#[0-9a-f]{6}$/i);
    }
  });

  it('uses a distinct colour per category', () => {
    const colours = Object.values(CATEGORY_COLOURS);
    assert.equal(new Set(colours).size, colours.length);
  });
});

describe('generic mime types', () => {
  it('lets the extension win over text/plain', () => {
    // Providers label source files text/plain as readily as prose, so trusting
    // it put every .ts and .py in with the documents.
    assert.equal(categorise('text/plain', 'index.ts'), 'code');
    assert.equal(categorise('text/plain', 'setup.py'), 'code');
  });

  it('still calls plain text a document when nothing better is known', () => {
    assert.equal(categorise('text/plain', 'notes.txt'), 'document');
    assert.equal(categorise('text/plain', 'no-extension'), 'document');
  });

  it('lets the extension win over octet-stream', () => {
    assert.equal(categorise('application/octet-stream', 'clip.mp4'), 'video');
    assert.equal(categorise('application/octet-stream', 'photo.heic'), 'image');
  });
});
