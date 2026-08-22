import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeSignature } from './signature.js';

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

/** "RIFF" + a size + a four-character format, which is the container's shape. */
function riff(format: string): Uint8Array {
  const out = new Uint8Array(16);
  out.set([0x52, 0x49, 0x46, 0x46], 0);
  out.set([0, 0, 0, 0], 4);
  for (let i = 0; i < 4; i += 1) out[8 + i] = format.charCodeAt(i);
  return out;
}

describe('describeSignature', () => {
  it('recognises the formats a drive is actually full of', () => {
    assert.equal(describeSignature(bytes(0xff, 0xd8, 0xff, 0xe0)), 'a JPEG image');
    assert.equal(describeSignature(bytes(0x25, 0x50, 0x44, 0x46, 0x2d)), 'a PDF document');
    assert.match(describeSignature(bytes(0x50, 0x4b, 0x03, 0x04))!, /ZIP/);
  });

  it('reads a signature that does not start at the beginning', () => {
    // An MP4 names itself four bytes in, after the length of the first box.
    assert.equal(
      describeSignature(bytes(0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d)),
      'an MP4 or QuickTime video',
    );
  });

  it('tells a WebP from the AVI it shares a container with', () => {
    // Both are RIFF. Matching the container first would call a photo a video.
    assert.equal(describeSignature(riff('WEBP')), 'a WebP image');
    assert.match(describeSignature(riff('AVI '))!, /RIFF/);
  });

  it('says nothing rather than guessing', () => {
    assert.equal(describeSignature(bytes(0x68, 0x65, 0x6c, 0x6c, 0x6f)), null);
    assert.equal(describeSignature(bytes()), null);
  });

  it('does not match a signature longer than the bytes read', () => {
    // The first page of a file can be shorter than the signature being tested.
    assert.equal(describeSignature(bytes(0x89, 0x50)), null);
  });
});
