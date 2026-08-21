import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  bufferSource,
  listArchiveFolder,
  readZipDirectory,
  readZipEntry,
  readZipText,
  type ZipEntry,
} from './zip.js';

/**
 * The archives are built here rather than committed as fixtures, so what each
 * test exercises is visible in the test: a stored entry, a deflated one, a
 * nested path, a comment after the end record.
 */

const encoder = new TextEncoder();

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as unknown as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface Source {
  name: string;
  content: string;
  deflated?: boolean;
}

/** Writes a minimal but real ZIP: local headers, then the central directory. */
async function makeZip(sources: Source[], comment = ''): Promise<Uint8Array> {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const source of sources) {
    const name = encoder.encode(source.name);
    const raw = encoder.encode(source.content);
    const method = source.deflated ? 8 : 0;
    const data = source.deflated ? await deflate(raw) : raw;

    const local = new Uint8Array(30 + name.byteLength + data.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(8, method, true);
    // 2026-08-22 12:00:00 in the DOS packing.
    localView.setUint16(10, (12 << 11) | (0 << 5) | 0, true);
    localView.setUint16(12, ((2026 - 1980) << 9) | (8 << 5) | 22, true);
    localView.setUint32(18, data.byteLength, true);
    localView.setUint32(22, raw.byteLength, true);
    localView.setUint16(26, name.byteLength, true);
    localView.setUint16(28, 0, true);
    local.set(name, 30);
    local.set(data, 30 + name.byteLength);
    locals.push(local);

    const central = new Uint8Array(46 + name.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(10, method, true);
    centralView.setUint16(12, (12 << 11) | (0 << 5) | 0, true);
    centralView.setUint16(14, ((2026 - 1980) << 9) | (8 << 5) | 22, true);
    centralView.setUint32(20, data.byteLength, true);
    centralView.setUint32(24, raw.byteLength, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);

    offset += local.byteLength;
  }

  const directorySize = centrals.reduce((sum, part) => sum + part.byteLength, 0);
  const commentBytes = encoder.encode(comment);
  const eocd = new Uint8Array(22 + commentBytes.byteLength);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, sources.length, true);
  eocdView.setUint16(10, sources.length, true);
  eocdView.setUint32(12, directorySize, true);
  eocdView.setUint32(16, offset, true);
  eocdView.setUint16(20, commentBytes.byteLength, true);
  eocd.set(commentBytes, 22);

  const total = offset + directorySize + eocd.byteLength;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, cursor);
    cursor += part.byteLength;
  }
  return out;
}

describe('readZipDirectory', () => {
  it('lists entries with their sizes and names', async () => {
    const zip = await makeZip([
      { name: 'readme.txt', content: 'hello' },
      { name: 'src/main.ts', content: 'export const a = 1;', deflated: true },
    ]);

    const entries = await readZipDirectory(bufferSource(zip));

    assert.deepEqual(entries.map((e) => e.name), ['readme.txt', 'src/main.ts']);
    assert.equal(entries[0]!.uncompressedSize, 5);
    assert.equal(entries[0]!.method, 0);
    assert.equal(entries[1]!.method, 8);
  });

  it('reads the date out of the DOS packing', async () => {
    const zip = await makeZip([{ name: 'a.txt', content: 'x' }]);
    const [entry] = await readZipDirectory(bufferSource(zip));

    assert.equal(entry!.modifiedAt?.getFullYear(), 2026);
    assert.equal(entry!.modifiedAt?.getMonth(), 7);
    assert.equal(entry!.modifiedAt?.getDate(), 22);
  });

  it('finds the end record behind a comment', async () => {
    // The record is not at a fixed offset: a comment of up to 64KB may follow
    // it, which is why the search runs backwards from the end.
    const zip = await makeZip([{ name: 'a.txt', content: 'x' }], 'x'.repeat(500));
    const entries = await readZipDirectory(bufferSource(zip));
    assert.equal(entries.length, 1);
  });

  it('refuses something that is not an archive', async () => {
    await assert.rejects(
      () => readZipDirectory(bufferSource(encoder.encode('just some text, no index here'))),
      /does not look like a ZIP/,
    );
  });

  it('only reads the tail, not the whole file', async () => {
    // The entire point: listing a 2GB archive must not fetch 2GB. Stored, not
    // deflated, so the archive really is as large as its contents.
    const zip = await makeZip([{ name: 'a.txt', content: 'x'.repeat(400_000) }]);
    const reads: Array<[number, number]> = [];
    const source = {
      size: zip.byteLength,
      read: async (start: number, end: number) => {
        reads.push([start, end]);
        return zip.subarray(start, end);
      },
    };

    await readZipDirectory(source);

    const bytesRead = reads.reduce((sum, [start, end]) => sum + (end - start), 0);
    assert.ok(
      bytesRead < zip.byteLength / 4,
      `read ${bytesRead} of ${zip.byteLength}, which is not a tail`,
    );
  });
});

describe('readZipEntry', () => {
  it('returns a stored entry unchanged', async () => {
    const zip = await makeZip([{ name: 'a.txt', content: 'stored content' }]);
    const source = bufferSource(zip);
    const [entry] = await readZipDirectory(source);

    assert.equal(new TextDecoder().decode(await readZipEntry(source, entry!)), 'stored content');
  });

  it('inflates a deflated entry', async () => {
    const content = 'repeat '.repeat(200);
    const zip = await makeZip([{ name: 'a.txt', content, deflated: true }]);
    const source = bufferSource(zip);
    const [entry] = await readZipDirectory(source);

    assert.equal(new TextDecoder().decode(await readZipEntry(source, entry!)), content);
  });

  it('reads the local header rather than assuming its length', async () => {
    // The local extra field need not match the central one, so the data does
    // not start at a predictable offset from the header.
    const zip = await makeZip([
      { name: 'first.txt', content: 'one' },
      { name: 'a-much-longer-name.txt', content: 'two' },
    ]);
    const source = bufferSource(zip);
    const entries = await readZipDirectory(source);

    assert.equal(new TextDecoder().decode(await readZipEntry(source, entries[1]!)), 'two');
  });

  it('declines a compression method it cannot read', async () => {
    const zip = await makeZip([{ name: 'a.txt', content: 'x' }]);
    const source = bufferSource(zip);
    const [entry] = await readZipDirectory(source);

    await assert.rejects(
      () => readZipEntry(source, { ...entry!, method: 99 }),
      /compression method/,
    );
  });
});

describe('readZipText', () => {
  it('returns null for a path the archive does not have', async () => {
    // The Office readers ask for parts that are optional, so absence has to be
    // an answer rather than a throw.
    const zip = await makeZip([{ name: 'a.txt', content: 'x' }]);
    const source = bufferSource(zip);
    const entries = await readZipDirectory(source);

    assert.equal(await readZipText(source, entries, 'nope.xml'), null);
  });
});

describe('listArchiveFolder', () => {
  const entries = [
    { name: 'readme.txt', uncompressedSize: 10 },
    { name: 'src/main.ts', uncompressedSize: 20 },
    { name: 'src/lib/util.ts', uncompressedSize: 30 },
    { name: 'docs/', uncompressedSize: 0 },
  ].map(
    (partial) =>
      ({
        isDirectory: partial.name.endsWith('/'),
        compressedSize: partial.uncompressedSize,
        method: 8,
        offset: 0,
        modifiedAt: null,
        ...partial,
      }) as ZipEntry,
  );

  it('infers folders from paths, since a ZIP need not list them', () => {
    const root = listArchiveFolder(entries, '');

    assert.deepEqual(root.map((node) => node.name), ['docs', 'src', 'readme.txt']);
    // Folders first, as a file list shows them.
    assert.equal(root[0]!.isDirectory, true);
    assert.equal(root.at(-1)!.isDirectory, false);
  });

  it('shows one level at a time', () => {
    const src = listArchiveFolder(entries, 'src/');
    assert.deepEqual(src.map((node) => node.name), ['lib', 'main.ts']);
  });

  it('totals a folder from everything beneath it', () => {
    const [srcFolder] = listArchiveFolder(entries, '').filter((node) => node.name === 'src');
    assert.equal(srcFolder!.sizeBytes, 50);
  });

  it('returns nothing for a prefix that matches nothing', () => {
    assert.deepEqual(listArchiveFolder(entries, 'nope/'), []);
  });
});
