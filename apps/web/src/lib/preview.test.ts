import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TEXT_PREVIEW_LIMIT, previewKindFor } from './preview.js';

const file = (over: Partial<Parameters<typeof previewKindFor>[0]>) => ({
  mimeType: 'application/octet-stream',
  name: 'file.bin',
  sizeBytes: 1000,
  isFolder: false,
  ...over,
});

describe('previewKindFor', () => {
  it('previews the media types browsers render', () => {
    assert.equal(previewKindFor(file({ mimeType: 'image/png', name: 'a.png' })), 'image');
    assert.equal(previewKindFor(file({ mimeType: 'video/mp4', name: 'a.mp4' })), 'video');
    assert.equal(previewKindFor(file({ mimeType: 'audio/mpeg', name: 'a.mp3' })), 'audio');
    assert.equal(previewKindFor(file({ mimeType: 'application/pdf', name: 'a.pdf' })), 'pdf');
  });

  it('falls back to the extension when the mime type is generic', () => {
    // Object stores label nearly everything application/octet-stream.
    assert.equal(previewKindFor(file({ name: 'holiday.MP4' })), 'video');
    assert.equal(previewKindFor(file({ name: 'photo.jpeg' })), 'image');
    assert.equal(previewKindFor(file({ name: 'track.flac' })), 'audio');
    assert.equal(previewKindFor(file({ name: 'report.pdf' })), 'pdf');
  });

  it('previews text and source files', () => {
    assert.equal(previewKindFor(file({ mimeType: 'text/plain', name: 'notes.txt' })), 'text');
    assert.equal(previewKindFor(file({ name: 'index.ts' })), 'text');
    assert.equal(previewKindFor(file({ name: 'data.json' })), 'text');
  });

  it('declines a text file too large to hold in the page', () => {
    assert.equal(
      previewKindFor(file({ mimeType: 'text/plain', name: 'huge.log', sizeBytes: TEXT_PREVIEW_LIMIT + 1 })),
      'none',
    );
    assert.equal(
      previewKindFor(file({ mimeType: 'text/plain', name: 'ok.log', sizeBytes: TEXT_PREVIEW_LIMIT })),
      'text',
    );
  });

  it('declines SVG, which is a script-capable document', () => {
    assert.equal(previewKindFor(file({ mimeType: 'image/svg+xml', name: 'logo.svg' })), 'none');
  });

  it('previews Google formats as what Drive exports them to', () => {
    // They hold no bytes of their own; the content route asks Drive to convert
    // them, and what comes back is a format Orbit reads.
    assert.equal(
      previewKindFor(file({ mimeType: 'application/vnd.google-apps.spreadsheet', name: 'Budget' })),
      'spreadsheet',
    );
    assert.equal(
      previewKindFor(file({ mimeType: 'application/vnd.google-apps.document', name: 'Notes' })),
      'document',
    );
    assert.equal(
      previewKindFor(file({ mimeType: 'application/vnd.google-apps.presentation', name: 'Deck' })),
      'presentation',
    );
    assert.equal(
      previewKindFor(file({ mimeType: 'application/vnd.google-apps.drawing', name: 'Sketch' })),
      'image',
    );
  });

  it('still declines the Google formats with nothing to export to', () => {
    for (const mime of [
      'application/vnd.google-apps.form',
      'application/vnd.google-apps.jam',
      'application/vnd.google-apps.script',
    ]) {
      assert.equal(previewKindFor(file({ mimeType: mime, name: 'thing' })), 'none', mime);
    }
  });

  it('declines binaries and the archive formats it cannot read', () => {
    assert.equal(previewKindFor(file({ name: 'setup.exe' })), 'none');
    // RAR and 7z are not ZIPs; only ZIP has an index this can walk.
    assert.equal(previewKindFor(file({ mimeType: 'application/vnd.rar', name: 'a.rar' })), 'none');
    assert.equal(previewKindFor(file({ name: 'a.7z' })), 'none');
  });

  it('browses a ZIP whatever its size', () => {
    // Listed from the index at the end of the file, so nothing is downloaded
    // and the size cap that applies to text does not apply here.
    assert.equal(previewKindFor(file({ mimeType: 'application/zip', name: 'a.zip' })), 'archive');
    assert.equal(
      previewKindFor(file({ mimeType: 'application/zip', name: 'big.zip', sizeBytes: 5e9 })),
      'archive',
    );
  });

  it('reads Office files as documents rather than as the ZIPs they are', () => {
    // Every one of these is a ZIP; claiming them as archives would show a
    // folder of XML instead of a spreadsheet.
    assert.equal(previewKindFor(file({ name: 'book.xlsx' })), 'spreadsheet');
    assert.equal(previewKindFor(file({ name: 'report.docx' })), 'document');
    assert.equal(previewKindFor(file({ name: 'deck.pptx' })), 'presentation');
    assert.equal(
      previewKindFor(
        file({
          name: 'no-extension',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }),
      ),
      'spreadsheet',
    );
  });

  it('previews a font as a font, and markdown as markdown', () => {
    assert.equal(previewKindFor(file({ name: 'Inter.ttf' })), 'font');
    assert.equal(previewKindFor(file({ name: 'Inter.woff2' })), 'font');
    assert.equal(previewKindFor(file({ name: 'README.md' })), 'markdown');
  });

  it('declines folders', () => {
    assert.equal(
      previewKindFor(file({ mimeType: 'application/vnd.google-apps.folder', name: 'Photos', isFolder: true })),
      'none',
    );
  });

  it('prefers a specific mime type over a misleading extension', () => {
    assert.equal(previewKindFor(file({ mimeType: 'image/jpeg', name: 'not-really.zip' })), 'image');
  });

  it('copes with a missing mime type', () => {
    assert.equal(previewKindFor(file({ mimeType: '', name: 'clip.webm' })), 'video');
    assert.equal(previewKindFor(file({ mimeType: '', name: 'mystery' })), 'none');
  });
});
