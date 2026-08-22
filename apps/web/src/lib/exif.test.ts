import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatExposure, readExif } from './exif.js';

/**
 * The photos are built here rather than committed as fixtures.
 *
 * A real JPEG in the repository would be a few hundred kilobytes that nobody
 * can read the contents of, and the interesting cases - a truncated header, a
 * directory claiming a million entries - cannot be produced with a camera.
 */

type Entry = [tag: number, type: number, value: string | number[]];

interface Photo {
  ifd0?: Entry[];
  exif?: Entry[];
  gps?: Entry[];
  /** Big-endian, as Nikon and Canon write it. Little is the default here. */
  bigEndian?: boolean;
  /** Wrap in a JPEG APP1 segment, which is where a real photo keeps it. */
  jpeg?: boolean;
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8 };

function componentCount(type: number, value: string | number[]): number {
  if (type === 2) return (value as string).length + 1;
  // A rational is two longs per component.
  return type === 5 ? (value as number[]).length / 2 : (value as number[]).length;
}

/** One TIFF block: header, IFD0, an optional Exif and GPS directory, and data. */
function buildTiff(photo: Photo): Uint8Array {
  const little = !photo.bigEndian;
  const ifd0 = [...(photo.ifd0 ?? [])];

  const directories: Array<{ pointerTag: number; entries: Entry[] }> = [];
  if (photo.exif?.length) directories.push({ pointerTag: 0x8769, entries: photo.exif });
  if (photo.gps?.length) directories.push({ pointerTag: 0x8825, entries: photo.gps });

  // Space for each directory, plus the pointer entries IFD0 needs to reach them.
  const sizeOf = (entries: Entry[]): number => 2 + entries.length * 12 + 4;

  let cursor = 8 + sizeOf([...ifd0, ...directories.map(() => [0, 4, [0]] as Entry)]);
  const placed = directories.map((directory) => {
    const at = cursor;
    cursor += sizeOf(directory.entries);
    ifd0.push([directory.pointerTag, 4, [at]]);
    return { ...directory, at };
  });

  // Everything larger than four bytes lands here, addressed from the header.
  const overflow: number[] = [];
  const bytes = new Uint8Array(cursor + 4096);
  const view = new DataView(bytes.buffer);

  view.setUint16(0, little ? 0x4949 : 0x4d4d);
  view.setUint16(2, 42, little);
  view.setUint32(4, 8, little);

  function writeEntries(at: number, entries: Entry[]): void {
    view.setUint16(at, entries.length, little);

    entries.forEach((entry, index) => {
      const [tag, type, value] = entry;
      const count = componentCount(type, value);
      const total = TYPE_SIZE[type]! * count;
      const cell = at + 2 + index * 12;

      view.setUint16(cell, tag, little);
      view.setUint16(cell + 2, type, little);
      view.setUint32(cell + 4, count, little);

      const target = total <= 4 ? cell + 8 : cursor + overflow.length;
      if (total > 4) {
        for (let i = 0; i < total; i += 1) overflow.push(0);
      }

      if (type === 1) {
        (value as number[]).forEach((n, i) => view.setUint8(target + i, n));
      } else if (type === 2) {
        const text = value as string;
        for (let i = 0; i < text.length; i += 1) view.setUint8(target + i, text.charCodeAt(i));
        view.setUint8(target + text.length, 0);
      } else if (type === 3) {
        (value as number[]).forEach((n, i) => view.setUint16(target + i * 2, n, little));
      } else if (type === 4) {
        (value as number[]).forEach((n, i) => view.setUint32(target + i * 4, n, little));
      } else {
        (value as number[]).forEach((n, i) => view.setUint32(target + i * 4, n, little));
      }

      if (total > 4) view.setUint32(cell + 8, target, little);
    });

    view.setUint32(at + 2 + entries.length * 12, 0, little);
  }

  writeEntries(8, ifd0);
  for (const directory of placed) writeEntries(directory.at, directory.entries);

  return bytes.slice(0, cursor + overflow.length);
}

function build(photo: Photo): ArrayBuffer {
  const tiff = buildTiff(photo);
  if (photo.jpeg === false) return tiff.buffer.slice(tiff.byteOffset, tiff.byteOffset + tiff.byteLength) as ArrayBuffer;

  // SOI, then an APP1 segment holding "Exif\0\0" and the TIFF block.
  const out = new Uint8Array(2 + 4 + 6 + tiff.length);
  const view = new DataView(out.buffer);

  view.setUint16(0, 0xffd8);
  view.setUint16(2, 0xffe1);
  view.setUint16(4, 2 + 6 + tiff.length);
  out.set([0x45, 0x78, 0x69, 0x66, 0, 0], 6);
  out.set(tiff, 12);

  return out.buffer;
}

/** A rational is written as numerator then denominator. */
function rational(...pairs: Array<[number, number]>): number[] {
  return pairs.flat();
}

describe('readExif', () => {
  it('reads the camera and the settings a photograph was taken with', () => {
    const photo = build({
      ifd0: [
        [0x010f, 2, 'Canon'],
        [0x0110, 2, 'Canon EOS R6'],
        [0x0112, 3, [6]],
      ],
      exif: [
        [0x9003, 2, '2026:08:22 14:03:11'],
        [0x829a, 5, rational([1, 250])],
        [0x829d, 5, rational([28, 10])],
        [0x8827, 3, [1600]],
        [0x920a, 5, rational([85, 1])],
        [0xa002, 4, [6000]],
        [0xa003, 4, [4000]],
        [0xa434, 2, 'RF85mm F2 MACRO IS STM'],
      ],
    });

    const data = readExif(photo);

    assert.ok(data);
    assert.equal(data.make, 'Canon');
    // The model repeats the manufacturer, and "Canon Canon EOS R6" is what
    // naive concatenation would show.
    assert.equal(data.model, 'EOS R6');
    assert.equal(data.lens, 'RF85mm F2 MACRO IS STM');
    assert.equal(data.takenAt, '2026-08-22 14:03:11');
    assert.equal(data.exposureTime, '1/250s');
    assert.equal(data.fNumber, 2.8);
    assert.equal(data.iso, 1600);
    assert.equal(data.focalLength, 85);
    assert.equal(data.orientation, 6);
    assert.equal(data.widthPx, 6000);
    assert.equal(data.heightPx, 4000);
  });

  it('reads big-endian files, which half the camera makers write', () => {
    const photo = build({ bigEndian: true, ifd0: [[0x010f, 2, 'NIKON CORPORATION']] });
    assert.equal(readExif(photo)?.make, 'NIKON CORPORATION');
  });

  it('turns degrees, minutes and seconds into one number', () => {
    const photo = build({
      ifd0: [[0x010f, 2, 'Apple']],
      gps: [
        [0x0001, 2, 'N'],
        [0x0002, 5, rational([28, 1], [36, 1], [1800, 100])],
        [0x0003, 2, 'E'],
        [0x0004, 5, rational([77, 1], [13, 1], [3000, 100])],
        [0x0005, 1, [0]],
        [0x0006, 5, rational([216, 1])],
      ],
    });

    const gps = readExif(photo)?.gps;

    assert.ok(gps);
    assert.equal(gps.latitude, 28.605);
    assert.equal(gps.longitude, 77.225);
    assert.equal(gps.altitude, 216);
  });

  it('reads south and west as negative', () => {
    // The file stores the sign as a letter, so a reader that ignores the
    // reference puts Sydney in the northern hemisphere.
    const photo = build({
      gps: [
        [0x0001, 2, 'S'],
        [0x0002, 5, rational([33, 1], [51, 1], [3600, 100])],
        [0x0003, 2, 'W'],
        [0x0004, 5, rational([70, 1], [39, 1], [0, 1])],
      ],
    });

    const gps = readExif(photo)?.gps;

    assert.ok(gps);
    assert.ok(gps.latitude < 0, 'south is negative');
    assert.ok(gps.longitude < 0, 'west is negative');
  });

  it('records an altitude below sea level as negative', () => {
    const photo = build({
      gps: [
        [0x0001, 2, 'N'],
        [0x0002, 5, rational([31, 1], [30, 1], [0, 1])],
        [0x0003, 2, 'E'],
        [0x0004, 5, rational([35, 1], [30, 1], [0, 1])],
        // The value itself is positive; the reference is what makes it a depth.
        [0x0005, 1, [1]],
        [0x0006, 5, rational([430, 1])],
      ],
    });

    assert.equal(readExif(photo)?.gps?.altitude, -430);
  });

  it('reads a bare TIFF as well as a JPEG', () => {
    const photo = build({ jpeg: false, ifd0: [[0x010f, 2, 'Hasselblad']] });
    assert.equal(readExif(photo)?.make, 'Hasselblad');
  });

  it('finds the segment even when another one comes first', () => {
    // A JFIF APP0 before the EXIF APP1 is the normal shape of a phone photo,
    // and a reader that only looks at the first segment finds nothing.
    const withExif = new Uint8Array(build({ ifd0: [[0x010f, 2, 'Google']] }));
    const app0 = new Uint8Array([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);

    const out = new Uint8Array(2 + app0.length + (withExif.length - 2));
    out.set([0xff, 0xd8], 0);
    out.set(app0, 2);
    out.set(withExif.slice(2), 2 + app0.length);

    assert.equal(readExif(out.buffer)?.make, 'Google');
  });

  it('says nothing rather than throwing on a file with no EXIF', () => {
    assert.equal(readExif(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 0]).buffer), null);
    assert.equal(readExif(new Uint8Array(0).buffer), null);
    assert.equal(readExif(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]).buffer), null);
  });

  it('survives a header that was cut off mid-way', () => {
    // Only the first stretch of the file is fetched, so a photo with a large
    // thumbnail in its EXIF genuinely arrives truncated.
    const whole = new Uint8Array(build({ ifd0: [[0x010f, 2, 'Fujifilm']], exif: [[0x9003, 2, '2026:01:01 00:00:00']] }));
    const cut = whole.slice(0, whole.length - 12);

    // Either it reads what survived or it reports nothing; what it must not do
    // is throw into the viewer.
    assert.doesNotThrow(() => readExif(cut.buffer));
  });

  it('refuses a directory claiming more entries than could fit', () => {
    // 65535 entries is 786KB of directory in a 200-byte file: a corrupt offset,
    // and a reader that trusts it walks off the end of the buffer.
    const photo = new Uint8Array(build({ ifd0: [[0x010f, 2, 'Sony']] }));
    const view = new DataView(photo.buffer);
    view.setUint16(20, 0xffff, true);

    assert.equal(readExif(photo.buffer), null);
  });

  it('does not read a zero denominator as infinity', () => {
    // Cameras write 0/0 for "not recorded", and 1/0 reaches the page as Infinity.
    const photo = build({ exif: [[0x829d, 5, rational([0, 0])]] });
    assert.equal(readExif(photo)?.fNumber, undefined);
  });
});

describe('formatExposure', () => {
  it('reads a shutter speed the way a photographer says it', () => {
    assert.equal(formatExposure(1 / 250), '1/250s');
    assert.equal(formatExposure(1 / 60), '1/60s');
  });

  it('keeps a long exposure in seconds', () => {
    assert.equal(formatExposure(2.5), '2.5s');
    assert.equal(formatExposure(30), '30s');
  });

  it('says nothing for a value that is not an exposure', () => {
    assert.equal(formatExposure(0), '');
    assert.equal(formatExposure(Number.NaN), '');
  });
});
