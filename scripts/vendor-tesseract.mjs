/**
 * Puts the OCR engine's own files where the app can serve them itself.
 *
 * Tesseract.js loads three things at runtime that are not part of the bundle:
 * a worker script, a WebAssembly core, and the trained data for a language.
 * Left alone it fetches all three from a public CDN.
 *
 * Two reasons that will not do here. Orbit's Content-Security-Policy allows
 * scripts and workers from its own origin only, so a CDN worker is blocked
 * outright - and relaxing the policy for it would be the wrong trade for a
 * feature whose whole point is that nothing leaves the machine. The other is
 * plainer: fetching a script from a third party tells that third party who is
 * scanning, and the privacy policy says no such thing happens.
 *
 * So they are copied out of node_modules and downloaded once at build time.
 * The result is gitignored - it is 3 MB of somebody else's build output, and
 * the lockfile already pins which build.
 *
 *   node scripts/vendor-tesseract.mjs
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(repoRoot, 'apps', 'web', 'public', 'tesseract');
const modules = join(repoRoot, 'node_modules');

/**
 * The "fast" trained data rather than the standard set.
 *
 * A quarter of the size - two megabytes against ten - and the difference shows
 * on book scans and old print, not on a photographed receipt in a phone
 * camera's own lighting, which is what this is for. Ten megabytes to read a
 * shop bill slightly better is not a trade worth making somebody wait for.
 */
const LANG_URL = 'https://tessdata.projectnaptha.com/4.0.0_fast/eng.traineddata.gz';

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function copyInto(from, into, names) {
  await mkdir(into, { recursive: true });

  for (const name of names) {
    await copyFile(join(from, name), join(into, name));
  }
}

async function main() {
  await mkdir(out, { recursive: true });

  // The worker, which tesseract.js spawns and which does the actual work.
  await copyInto(join(modules, 'tesseract.js', 'dist'), out, ['worker.min.js']);

  /*
   * Three core builds, not the nineteen in the package.
   *
   * The engine picks between plain, SIMD and relaxed-SIMD by asking the
   * browser what it supports, so which one is needed is a property of the
   * visitor rather than of the build - all three have to be here. But only the
   * LSTM ones: the legacy engine is a different recogniser Orbit never asks
   * for, and it is switched off explicitly where the worker is created, so a
   * request for those files cannot arise.
   *
   * `.wasm.js` rather than `.wasm`, because that is the name the worker
   * actually fetches - the WebAssembly is embedded in it. Copying the bare
   * `.wasm` files as well would be 8 MB nothing ever asks for.
   */
  const coreDir = join(modules, 'tesseract.js-core');
  const cores = (await readdir(coreDir)).filter(
    (name) => name.endsWith('-lstm.wasm.js') || name === 'tesseract-core-lstm.wasm.js',
  );

  if (cores.length === 0) throw new Error('No LSTM core builds found - has the package changed?');

  await copyInto(coreDir, join(out, 'core'), cores);

  // The language data, which is the only piece not in node_modules.
  const lang = join(out, 'lang', 'eng.traineddata.gz');

  if (await exists(lang)) {
    console.log('tesseract: language data already here');
  } else {
    await mkdir(dirname(lang), { recursive: true });

    const response = await fetch(LANG_URL);
    if (!response.ok) throw new Error(`Could not fetch trained data: ${response.status}`);

    const bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(lang, bytes);

    const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
    console.log(`tesseract: eng.traineddata.gz  ${(bytes.length / 1e6).toFixed(1)} MB  ${digest}`);
  }

  console.log(`tesseract: ${cores.length} core files, worker, and language data in public/tesseract`);
}

await main();
