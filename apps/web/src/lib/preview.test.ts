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

  it('declines Google-native documents', () => {
    // They are exported to Office formats on download, and no browser renders
    // a .docx inline. Embedding Google's own viewer would mean handing the
    // provider URL to the client, which the proxy exists to prevent.
    for (const mime of [
      'application/vnd.google-apps.document',
      'application/vnd.google-apps.spreadsheet',
      'application/vnd.google-apps.presentation',
    ]) {
      assert.equal(previewKindFor(file({ mimeType: mime, name: 'Doc' })), 'none');
    }
  });

  it('declines archives and binaries', () => {
    assert.equal(previewKindFor(file({ mimeType: 'application/zip', name: 'a.zip' })), 'none');
    assert.equal(previewKindFor(file({ name: 'setup.exe' })), 'none');
    assert.equal(previewKindFor(file({ mimeType: 'application/vnd.rar', name: 'a.rar' })), 'none');
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
