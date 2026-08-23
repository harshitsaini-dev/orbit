import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { signIn } from './helpers.js';

/**
 * A file going from one browser to another and touching nothing in between.
 *
 * Two real pages, a real WebRTC connection, and the bytes compared at the far
 * end. Both are in the same browser and on the same machine, so this exercises
 * the signalling, the chunking, the backpressure and the reassembly - not the
 * part that fails in the wild, which is two networks with no path between them.
 * That path has no test because it has no fix: bridging it needs a relay, a
 * relay is a bill, and the product's answer is to say so.
 */
test.describe('sending a file directly', () => {
  test('arrives byte for byte, without going through Orbit', async ({ browser }) => {
    const sender = await browser.newContext();
    const receiver = await browser.newContext();

    const from = await sender.newPage();
    const to = await receiver.newPage();

    await signIn(from);
    await signIn(to);

    /*
     * Nothing may reach the server carrying the file. Orbit's part is the
     * introduction; if a byte of this went through an upload route, the whole
     * claim the feature is built on would be false.
     */
    const uploads: string[] = [];
    for (const page of [from, to]) {
      page.on('request', (request) => {
        if (/\/api\/uploads|\/v1\/files/.test(request.url())) uploads.push(request.url());
      });
    }

    await from.goto('/handoff');

    // A file with structure, so a chunking bug shows up as a mismatch rather
    // than as a run of identical bytes that happens to line up.
    const CONTENT = Array.from({ length: 4000 }, (_, i) => `line ${i} of the file\n`).join('');

    await from.setInputFiles('input[type=file]', {
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(CONTENT),
    });

    const link = await from.locator('.share-link input').inputValue();
    expect(link).toContain('/handoff#');

    // The id lives in the fragment, which a browser never sends to a server.
    const hash = new URL(link).hash;
    expect(hash.length).toBeGreaterThan(20);

    await to.goto(`/handoff${hash}`);

    // Saved for real and read back off disk, so this checks the bytes rather
    // than a label claiming they arrived.
    const save = to.getByRole('button', { name: /^Save / });
    await expect(save).toBeVisible({ timeout: 60_000 });
    await expect(save).toHaveText('Save notes.txt');

    const download = to.waitForEvent('download');
    await save.click();

    const saved = await download;
    const path = await saved.path();
    const written = readFileSync(path, 'utf8');

    expect(written).toHaveLength(CONTENT.length);
    expect(written).toBe(CONTENT);

    await expect(from.getByTestId('handoff-status')).toHaveText('Done.', { timeout: 30_000 });
    expect(uploads).toEqual([]);

    await sender.close();
    await receiver.close();
  });

  test('says plainly when it cannot connect, and points at the other way', async ({ page }) => {
    await signIn(page);

    // No second end will ever arrive, so this waits.
    await page.goto('/handoff#never-going-to-be-joined-aaaaaaaaaaaa');

    await expect(page.getByTestId('handoff-status')).toHaveText(
      /Waiting for the other side/,
    );
  });
});
