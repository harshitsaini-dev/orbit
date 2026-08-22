import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import sharp from 'sharp';
import {
  detectRenderers,
  pdfFirstPage,
  renderers,
  setRenderers,
  videoFrame,
} from './renderers.js';
import { clearThumbnailCache, sourceKind } from './thumbnails.js';

/**
 * The external renderers.
 *
 * ffmpeg and poppler are not dependencies and are not installed on most
 * machines this runs on, so the spawn-and-pipe path is exercised against shims
 * on PATH instead. A shim proves the plumbing — arguments reach a process,
 * bytes go in on stdin, bytes come back on stdout, a failure is a null rather
 * than a throw — which is the part that is ours. Whether ffmpeg can decode a
 * given video is ffmpeg's business.
 */

const original = process.env['PATH'];
let binDir: string;

/** A real PNG, so what comes back can actually be decoded. */
let png: Buffer;

const windows = process.platform === 'win32';

/** Writes an executable on PATH under the name a renderer is looked up by. */
function shim(name: string, body: { stdout?: Buffer; exit?: number }): void {
  const payload = join(binDir, `${name}.payload`);
  if (body.stdout) writeFileSync(payload, body.stdout);

  const script = [
    'const fs = require("fs");',
    // Drain stdin first: a renderer that exits without reading it leaves the
    // caller writing into a closed pipe, which is a different failure.
    'const chunks = [];',
    'process.stdin.on("data", (c) => chunks.push(c));',
    'process.stdin.on("end", () => {',
    body.stdout
      ? `  process.stdout.write(fs.readFileSync(${JSON.stringify(payload)}));`
      : '  void 0;',
    `  process.exit(${body.exit ?? 0});`,
    '});',
  ].join('\n');

  const js = join(binDir, `${name}.js`);
  writeFileSync(js, script);

  // Pointed at by the override rather than left to PATH: on Windows, Node's
  // spawn resolves .exe but not .cmd, so a shim found only by name would never
  // run and these tests would pass for the wrong reason.
  let path: string;
  if (windows) {
    path = join(binDir, `${name}.cmd`);
    writeFileSync(path, `@echo off
node "${js}" %*
`);
  } else {
    path = join(binDir, name);
    writeFileSync(path, `#!/bin/sh
exec node "${js}" "$@"
`);
    chmodSync(path, 0o755);
  }

  process.env[name === 'ffmpeg' ? 'ORBIT_FFMPEG' : 'ORBIT_PDFTOPPM'] = path;
}

before(async () => {
  png = await sharp({
    create: { width: 640, height: 360, channels: 3, background: { r: 10, g: 90, b: 200 } },
  })
    .png()
    .toBuffer();
});

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), 'orbit-renderers-'));
  process.env['PATH'] = `${binDir}${windows ? ';' : ':'}${original ?? ''}`;
  delete process.env['ORBIT_FFMPEG'];
  delete process.env['ORBIT_PDFTOPPM'];
  setRenderers(null);
  clearThumbnailCache();
});

after(() => {
  process.env['PATH'] = original;
  delete process.env['ORBIT_FFMPEG'];
  delete process.env['ORBIT_PDFTOPPM'];
  setRenderers(null);
  try {
    rmSync(binDir, { recursive: true, force: true });
  } catch {
    // A shim still held open by a dying child is not worth failing a run over.
  }
});

describe('finding out what the machine has', () => {
  it('reports neither when neither is installed', async () => {
    // The ordinary case, and the one the free tier is in.
    const found = await detectRenderers();
    assert.deepEqual(found, { video: false, pdf: false });
  });

  it('finds a tool that is on PATH', async () => {
    shim('ffmpeg', {});
    shim('pdftoppm', {});

    assert.deepEqual(await detectRenderers(), { video: true, pdf: true });
  });

  it('treats a tool that exits non-zero as absent', async () => {
    // Present but broken is not usable, and pretending otherwise means every
    // video costs a fetch and a spawn to produce nothing.
    shim('ffmpeg', { exit: 1 });

    assert.equal((await detectRenderers()).video, false);
  });

  it('asks the machine once', async () => {
    const first = await detectRenderers();
    shim('ffmpeg', {});

    // Still the remembered answer: a probe per request would be a process per
    // request, which is the cost this is trying to avoid.
    assert.equal((await detectRenderers()).video, first.video);
  });
});

describe('what a file can become a tile from', () => {
  it('always allows an image, whatever is installed', async () => {
    setRenderers({ video: false, pdf: false });
    assert.equal(sourceKind('photo.jpg', 'image/jpeg'), 'image');
    assert.equal(sourceKind('photo.HEIC', 'application/octet-stream'), 'image');
  });

  it('declines video and pdf when the tools are missing', async () => {
    // The point of asking here rather than at the point of use: a machine
    // without ffmpeg never fetches a byte of a video it cannot decode.
    setRenderers({ video: false, pdf: false });
    assert.equal(sourceKind('clip.mp4', 'video/mp4'), null);
    assert.equal(sourceKind('report.pdf', 'application/pdf'), null);
  });

  it('allows them as soon as the tools are there', () => {
    setRenderers({ video: true, pdf: true });
    assert.equal(sourceKind('clip.mp4', 'video/mp4'), 'video');
    assert.equal(sourceKind('clip.mkv', 'application/octet-stream'), 'video');
    assert.equal(sourceKind('report.pdf', 'application/pdf'), 'pdf');
    assert.equal(sourceKind('report.pdf', 'application/octet-stream'), 'pdf');
  });

  it('still refuses SVG with everything installed', () => {
    setRenderers({ video: true, pdf: true });
    assert.equal(sourceKind('logo.svg', 'image/svg+xml'), null);
  });
});

describe('running one', () => {
  it('pipes the file in and gets an image back', async () => {
    shim('ffmpeg', { stdout: png });
    setRenderers({ video: true, pdf: false });

    const frame = await videoFrame(Buffer.from('pretend this is an mp4'));
    assert.ok(frame);
    assert.equal((await sharp(frame).metadata()).width, 640);
  });

  it('returns null rather than throwing when the tool fails', async () => {
    // A video whose index is at the end, an encrypted PDF: the caller shows an
    // icon, which is what it would have shown anyway.
    shim('ffmpeg', { exit: 1 });
    setRenderers({ video: true, pdf: false });

    assert.equal(await videoFrame(Buffer.from('nonsense')), null);
  });

  it('does not spawn anything when the tool was never found', async () => {
    // Even with a shim sitting on PATH: detection is the authority, so a
    // machine that reported nothing stays cheap.
    shim('ffmpeg', { stdout: png });
    setRenderers({ video: false, pdf: false });

    assert.equal(await videoFrame(Buffer.from('x')), null);
  });

  it('renders a pdf page the same way', async () => {
    shim('pdftoppm', { stdout: png });
    setRenderers({ video: false, pdf: true });

    const page = await pdfFirstPage(Buffer.from('%PDF-1.7'));
    assert.ok(page);
    assert.equal((await sharp(page).metadata()).height, 360);
  });

  it('survives a tool that exits without reading its input', async () => {
    // Writing into a closed pipe is an EPIPE, not a crash.
    shim('pdftoppm', { exit: 3 });
    setRenderers({ video: false, pdf: true });

    assert.equal(await pdfFirstPage(Buffer.alloc(2 * 1024 * 1024)), null);
  });

  it('leaves renderers() reporting nothing before detection has run', () => {
    setRenderers(null);
    assert.deepEqual(renderers(), { video: false, pdf: false });
  });
});
