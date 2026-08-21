/**
 * Rasterises the brand assets: the PWA icon set and the social link-preview card.
 *
 * Uses the Chromium that Playwright already installs rather than adding a
 * native image dependency. Run after editing favicon.svg or the OG template:
 *
 *   node scripts/generate-brand-assets.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(repoRoot, 'apps', 'web', 'public');
const mark = readFileSync(join(publicDir, 'favicon.svg'), 'utf8');

/**
 * A maskable icon may be cropped to a circle, so its artwork has to sit inside
 * the middle 80%. The plain icons keep their own rounded corners instead.
 */
const ICONS = [
  { file: 'icon-192.png', size: 192, inset: 0 },
  { file: 'icon-512.png', size: 512, inset: 0 },
  { file: 'icon-maskable-512.png', size: 512, inset: 0.12 },
  // iOS ignores transparency and squares the corners itself, so this one is
  // rendered on an opaque background.
  { file: 'apple-touch-icon.png', size: 180, inset: 0.06 },
];

/** The size every major platform crops a link preview to. */
const OG_WIDTH = 1200;
const OG_HEIGHT = 630;

const browser = await chromium.launch();

try {
  for (const { file, size, inset } of ICONS) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    const pad = Math.round(size * inset);

    await page.setContent(
      `<!doctype html><meta charset="utf-8">
       <style>
         html,body{margin:0;padding:0;width:${size}px;height:${size}px}
         body{background:${inset > 0 ? '#151824' : 'transparent'};display:grid;place-items:center}
         svg{width:${size - pad * 2}px;height:${size - pad * 2}px;display:block}
       </style>
       ${mark}`,
      { waitUntil: 'load' },
    );

    const buffer = await page.screenshot({ omitBackground: inset === 0, type: 'png' });
    writeFileSync(join(publicDir, file), buffer);
    console.log(`${file.padEnd(24)} ${size}x${size}  ${(buffer.length / 1024).toFixed(1)} kB`);
    await page.close();
  }

  // --- link preview ------------------------------------------------------
  // The mark is inlined twice: once small beside the wordmark, once large as
  // the hero. Both copies come from favicon.svg, so the card can never drift
  // from the icon. Their gradient ids are namespaced to avoid colliding.
  const namespace = (svg, suffix) =>
    svg
      .replace(/id="([^"]+)"/g, `id="$1-${suffix}"`)
      .replace(/url\(#([^)]+)\)/g, `url(#$1-${suffix})`);

  // The hero copy drops the icon's rounded background so it sits inside the
  // card's own bloom instead of reading as a floating app tile.
  const heroMark = namespace(mark, 'lg').replace(/\s*<rect width="64"[^>]*\/>/, '');

  const template = readFileSync(join(repoRoot, 'scripts', 'templates', 'og.html'), 'utf8')
    .replace('<!--MARK_SMALL-->', namespace(mark, 'sm'))
    .replace('<!--MARK_LARGE-->', heroMark);

  const page = await browser.newPage({
    viewport: { width: OG_WIDTH, height: OG_HEIGHT },
    deviceScaleFactor: 1,
  });
  await page.setContent(template, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);

  const og = await page.screenshot({ type: 'png' });
  writeFileSync(join(publicDir, 'og-image.png'), og);
  console.log(`${'og-image.png'.padEnd(24)} ${OG_WIDTH}x${OG_HEIGHT}  ${(og.length / 1024).toFixed(1)} kB`);
  await page.close();
} finally {
  await browser.close();
}
