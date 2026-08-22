import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import sharp from 'sharp';
import type { AccountTokens, ProviderAdapter } from '@orbit/shared-types';
import {
  canRender,
  clearThumbnailCache,
  MAX_SOURCE_BYTES,
  renderThumbnail,
  thumbnailCacheSize,
} from './thumbnails.js';

const TOKENS: AccountTokens = { accessToken: 'x' };

/** A real image, so sharp is exercised rather than mocked. */
async function makeImage(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 40, b: 90 } },
  })
    .png()
    .toBuffer();
}

let fetched = 0;

function fakeAdapter(bytes: Buffer): ProviderAdapter {
  return {
    getFileStream: async () => {
      fetched += 1;
      return {
        stream: new Blob([bytes as unknown as BlobPart]).stream(),
        contentType: 'image/png',
      };
    },
  } as unknown as ProviderAdapter;
}

beforeEach(() => {
  clearThumbnailCache();
  fetched = 0;
});

describe('canRender', () => {
  it('accepts the image types a store labels properly', () => {
    assert.equal(canRender('a.png', 'image/png'), true);
    assert.equal(canRender('a.jpg', 'image/jpeg'), true);
  });

  it('falls back to the name, since object stores label everything octet-stream', () => {
    assert.equal(canRender('photo.jpeg', 'application/octet-stream'), true);
    assert.equal(canRender('photo.HEIC', 'application/octet-stream'), true);
  });

  it('declines things that are not images', () => {
    assert.equal(canRender('notes.txt', 'text/plain'), false);
    assert.equal(canRender('clip.mp4', 'video/mp4'), false);
    assert.equal(canRender('archive.zip', 'application/zip'), false);
  });

  it('declines SVG', () => {
    // sharp renders it, but rendering an untrusted SVG runs its references
    // through a parser to make a picture nobody asked to be safe.
    assert.equal(canRender('logo.svg', 'image/svg+xml'), false);
    assert.equal(canRender('logo.svg', 'application/octet-stream'), false);
  });
});

describe('renderThumbnail', () => {
  it('produces something much smaller than the original', async () => {
    // The whole point: a grid of forty tiles must not pull tens of megabytes to
    // draw a few hundred pixels each.
    const source = await makeImage(2000, 1500);

    const thumbnail = await renderThumbnail({
      adapter: fakeAdapter(source),
      tokens: TOKENS,
      remoteId: 'big.png',
      name: 'big.png',
      mimeType: 'image/png',
      sizeBytes: source.byteLength,
      size: 400,
    });

    assert.ok(thumbnail);
    assert.equal(thumbnail.contentType, 'image/webp');
    assert.ok(
      thumbnail.bytes.byteLength < source.byteLength / 4,
      `${thumbnail.bytes.byteLength} should be far under ${source.byteLength}`,
    );
  });

  it('fits inside the box rather than cropping to it', async () => {
    // A grid of photos with their edges cut off is worse than one with
    // letterboxing.
    const source = await makeImage(1200, 400);

    const thumbnail = await renderThumbnail({
      adapter: fakeAdapter(source),
      tokens: TOKENS,
      remoteId: 'wide.png',
      name: 'wide.png',
      mimeType: 'image/png',
      sizeBytes: source.byteLength,
      size: 300,
    });

    const meta = await sharp(thumbnail!.bytes).metadata();
    assert.equal(meta.width, 300);
    assert.equal(meta.height, 100, 'the aspect ratio survives');
  });

  it('does not enlarge an image that is already small', async () => {
    const source = await makeImage(80, 60);

    const thumbnail = await renderThumbnail({
      adapter: fakeAdapter(source),
      tokens: TOKENS,
      remoteId: 'tiny.png',
      name: 'tiny.png',
      mimeType: 'image/png',
      sizeBytes: source.byteLength,
      size: 400,
    });

    const meta = await sharp(thumbnail!.bytes).metadata();
    assert.equal(meta.width, 80);
  });

  it('fetches once however many tiles ask for it', async () => {
    // Forty tiles of the same image would otherwise be forty downloads and
    // forty decodes.
    const source = await makeImage(600, 600);
    const adapter = fakeAdapter(source);

    const input = {
      adapter,
      tokens: TOKENS,
      remoteId: 'shared.png',
      name: 'shared.png',
      mimeType: 'image/png',
      sizeBytes: source.byteLength,
      size: 400,
    };

    await Promise.all([
      renderThumbnail(input),
      renderThumbnail(input),
      renderThumbnail(input),
    ]);

    assert.equal(fetched, 1);
  });

  it('serves the second request from memory', async () => {
    const source = await makeImage(600, 600);
    const input = {
      adapter: fakeAdapter(source),
      tokens: TOKENS,
      remoteId: 'again.png',
      name: 'again.png',
      mimeType: 'image/png',
      sizeBytes: source.byteLength,
      size: 400,
    };

    await renderThumbnail(input);
    await renderThumbnail(input);

    assert.equal(fetched, 1);
    assert.equal(thumbnailCacheSize().count, 1);
  });

  it('declines a source too large to be worth fetching', async () => {
    const source = await makeImage(10, 10);

    const thumbnail = await renderThumbnail({
      adapter: fakeAdapter(source),
      tokens: TOKENS,
      remoteId: 'huge.png',
      name: 'huge.png',
      mimeType: 'image/png',
      sizeBytes: MAX_SOURCE_BYTES + 1,
      size: 400,
    });

    assert.equal(thumbnail, null);
    assert.equal(fetched, 0, 'and does not fetch it to find out');
  });

  it('returns nothing rather than throwing on a file that will not decode', async () => {
    // The grid shows an icon, which is what it would show anyway.
    const notAnImage = Buffer.from('this is not a picture');

    const thumbnail = await renderThumbnail({
      adapter: fakeAdapter(notAnImage),
      tokens: TOKENS,
      remoteId: 'broken.png',
      name: 'broken.png',
      mimeType: 'image/png',
      sizeBytes: notAnImage.byteLength,
      size: 400,
    });

    assert.equal(thumbnail, null);
  });
});
