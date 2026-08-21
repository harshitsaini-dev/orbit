import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { archiveFormat } from './archive.js';
import { readRar } from './rar.js';
import { gunzip, readTar, readTarEntry, tarKind } from './tar.js';
import { listArchiveFolder } from './zip.js';

/**
 * Against archives written by tar and by WinRAR themselves. A reader checked
 * only against archives it could also have written proves nothing about the
 * ones it will actually meet.
 *
 * Regenerate with `scripts/make-archive-fixtures.py`.
 */
async function fixture(name: string): Promise<Uint8Array> {
  const path = fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));
  return new Uint8Array(await readFile(path));
}

describe('readTar', () => {
  it('lists files with their sizes', async () => {
    const entries = readTar(await fixture('sample.tar'));
    const readme = entries.find((entry) => entry.name.endsWith('readme.txt'));

    assert.ok(readme, 'readme.txt should be listed');
    assert.equal(readme.sizeBytes, 23);
    assert.equal(readme.isDirectory, false);
  });

  it('keeps nested paths', async () => {
    const entries = readTar(await fixture('sample.tar'));
    assert.ok(entries.some((entry) => entry.name.endsWith('src/lib/util.ts')));
  });

  it('reads a name too long for the header', async () => {
    // tar stores an over-long name in an entry of its own; ignoring that gives
    // a truncated name and a phantom file beside it.
    const entries = readTar(await fixture('sample.tar'));
    const deep = entries.find((entry) => entry.name.endsWith('deep.txt'));

    assert.ok(deep, 'the deeply nested file should be listed');
    assert.ok(deep.name.split('/').length > 4, `expected a long path, got ${deep.name}`);
  });

  it('returns an entry\'s contents', async () => {
    const bytes = await fixture('sample.tar');
    const entries = readTar(bytes);
    const readme = entries.find((entry) => entry.name.endsWith('readme.txt'))!;

    assert.equal(new TextDecoder().decode(readTarEntry(bytes, readme)), 'hello from the archive\n');
  });

  it('stops at the end rather than reading padding as files', async () => {
    // A tar ends with zero blocks; taken as headers they would be endless
    // files of size zero.
    const entries = readTar(await fixture('sample.tar'));
    assert.ok(entries.length < 20, `expected a handful of entries, got ${entries.length}`);
    assert.ok(entries.every((entry) => entry.name !== ''));
  });
});

describe('tar.gz', () => {
  it('reads a compressed tar through the browser\'s own gzip', async () => {
    const bytes = await gunzip(await fixture('sample.tar.gz'));
    const entries = readTar(bytes);

    assert.ok(entries.some((entry) => entry.name.endsWith('readme.txt')));
    const readme = entries.find((entry) => entry.name.endsWith('readme.txt'))!;
    assert.equal(new TextDecoder().decode(readTarEntry(bytes, readme)), 'hello from the archive\n');
  });
});

describe('tarKind', () => {
  it('tells a compressed tar from a plain one', () => {
    assert.equal(tarKind('backup.tar'), 'tar');
    assert.equal(tarKind('backup.tar.gz'), 'tar.gz');
    assert.equal(tarKind('backup.tgz'), 'tar.gz');
    assert.equal(tarKind('backup.zip'), null);
  });
});

describe('readRar', () => {
  it('lists what is inside without extracting anything', async () => {
    const entries = readRar(await fixture('sample.rar'));
    const names = entries.map((entry) => entry.name.replace(/\\/g, '/'));

    assert.ok(names.some((name) => name.endsWith('readme.txt')), names.join(', '));
    assert.ok(names.some((name) => name.endsWith('src/main.ts')), names.join(', '));
  });

  it('reads the uncompressed size, which is what a listing shows', async () => {
    const entries = readRar(await fixture('sample.rar'));
    const readme = entries.find((entry) => entry.name.endsWith('readme.txt'))!;

    // The packed size would be smaller and meaningless to anyone reading a
    // file list.
    assert.equal(readme.sizeBytes, 23);
  });

  it('marks directories as directories', async () => {
    const entries = readRar(await fixture('sample.rar'));
    const directories = entries.filter((entry) => entry.isDirectory);

    assert.ok(directories.length > 0, 'the archive has folders in it');
    assert.ok(directories.every((entry) => entry.sizeBytes === 0));
  });

  it('refuses something that is not a RAR', async () => {
    await assert.rejects(async () => readRar(await fixture('sample.tar')), /does not look like a RAR/);
  });
});

describe('archiveFormat', () => {
  it('recognises each archive by name', () => {
    assert.equal(archiveFormat('a.zip', ''), 'zip');
    assert.equal(archiveFormat('a.tar', ''), 'tar');
    assert.equal(archiveFormat('a.tar.gz', ''), 'tar');
    assert.equal(archiveFormat('a.tgz', ''), 'tar');
    assert.equal(archiveFormat('a.rar', ''), 'rar');
  });

  it('falls back to the mime type when the name says nothing', () => {
    assert.equal(archiveFormat('download', 'application/zip'), 'zip');
    assert.equal(archiveFormat('download', 'application/vnd.rar'), 'rar');
  });

  it('declines formats whose compression no browser implements', () => {
    // 7z keeps its own index compressed, so even listing one needs LZMA.
    assert.equal(archiveFormat('a.7z', ''), null);
    assert.equal(archiveFormat('a.bz2', ''), null);
  });
});

describe('listing an archive of any format', () => {
  it('builds the same folder tree from tar entries as from ZIP ones', async () => {
    const entries = readTar(await fixture('sample.tar')).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory,
      uncompressedSize: entry.sizeBytes,
      modifiedAt: entry.modifiedAt,
    }));

    const root = listArchiveFolder(entries, '');
    assert.ok(root.some((node) => node.name === 'src' && node.isDirectory));
    assert.ok(root.some((node) => node.name === 'readme.txt' && !node.isDirectory));

    const src = listArchiveFolder(entries, 'src/');
    assert.ok(src.some((node) => node.name === 'lib' && node.isDirectory));
    assert.ok(src.some((node) => node.name === 'main.ts'));
  });
});
