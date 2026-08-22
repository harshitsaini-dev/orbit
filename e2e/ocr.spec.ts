import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { signIn } from './helpers.js';

/**
 * Reading the text out of a picture, end to end and for real.
 *
 * The drive is stubbed - a real one needs a provider - but the OCR is not.
 * Tesseract, its WebAssembly core and the English data all load from Orbit's
 * own origin exactly as they would in production, and the words asserted below
 * are words the engine actually read off a rendered receipt. A mocked engine
 * would prove that a button calls a function; this proves somebody can find a
 * photograph by what is written on it.
 */

const RECEIPT = readFileSync('e2e/fixtures/receipt.png');

const FILE = {
  remoteId: 'r-1',
  name: '1759653621497799480627.png',
  virtualPath: '/1759653621497799480627.png',
  mimeType: 'image/png',
  sizeBytes: RECEIPT.length,
  isFolder: false,
  starred: false,
  modifiedAt: new Date(Date.UTC(2026, 7, 20)).toISOString(),
};

const ACCOUNT = {
  id: 'acc-stub',
  provider: 'google_drive',
  catalogueKey: 'google_drive',
  nickname: 'stub@example.com',
  usedBytes: 1000,
  quotaBytes: 1_000_000,
  priorityOrder: 0,
  weight: 1,
  status: 'ok',
  lastSyncedAt: null,
  lastRefreshedAt: null,
  connectedAt: new Date().toISOString(),
  isOwner: true,
  accessLevel: 'admin',
};

const CAPABILITIES = {
  star: true, sharedWithMe: true, delta: true, resumableUpload: true, rangeRequests: true,
  nativeFolders: true, trash: true, purgeTrash: false, relocate: true, reportsQuota: true,
  flatEnumeration: true, recentView: true, thumbnails: false, search: true, fullTextSearch: false,
};

async function stub(page: Page): Promise<void> {
  await page.route('**/api/accounts', (route) => route.fulfill({ json: { accounts: [ACCOUNT] } }));

  await page.route('**/api/files?**', (route) =>
    route.fulfill({
      json: {
        accountId: ACCOUNT.id,
        provider: 'google_drive',
        path: '/',
        files: [FILE],
        capabilities: CAPABILITIES,
      },
    }),
  );

  // The bytes the engine actually reads.
  await page.route('**/api/files/*/content**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: RECEIPT }),
  );

  // The provider's own search finds nothing, which is the situation this
  // feature exists for: the file is named by a camera.
  await page.route('**/api/search?**', (route) => route.fulfill({ json: { files: [] } }));
}

test.describe('reading the text in a picture', () => {
  // Fetching and compiling six megabytes of WebAssembly, then recognising.
  test.setTimeout(180_000);

  test('finds a photo by what is written on it', async ({ page }) => {
    await signIn(page);
    await stub(page);
    await page.goto('/my-drive');
    await expect(page.getByText(FILE.name).first()).toBeVisible();

    const stored: Array<{ text: string; confidence: number }> = [];

    await page.route('**/api/text', async (route) => {
      const body = route.request().postDataJSON() as { text: string; confidence: number };
      stored.push(body);
      await route.fulfill({ json: { stored: true } });
    });
    await page.route('**/api/text/known', (route) => route.fulfill({ json: { scanned: [] } }));

    await page.getByText(FILE.name).first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Read the text' }).click();

    await expect(page.getByRole('dialog')).toContainText('Runs on this device');
    await page.getByRole('button', { name: 'Read it' }).click();

    await expect(page.getByText('1 with text found')).toBeVisible({ timeout: 170_000 });

    // What the engine actually read, not what a mock returned.
    expect(stored).toHaveLength(1);
    expect(stored[0]!.text).toMatch(/NATIONAL MARKET/i);
    expect(stored[0]!.text).toMatch(/17842/);
    expect(stored[0]!.confidence).toBeGreaterThan(60);
  });

  test('shows the line a result matched on', async ({ page }) => {
    await signIn(page);
    await stub(page);

    await page.route('**/api/text/search**', (route) =>
      route.fulfill({
        json: {
          matches: [
            {
              accountId: ACCOUNT.id,
              accountNickname: ACCOUNT.nickname,
              provider: 'google_drive',
              catalogueKey: 'google_drive',
              remoteId: FILE.remoteId,
              name: FILE.name,
              virtualPath: FILE.virtualPath,
              text: 'NATIONAL MARKET PVT LTD Invoice 17842 Rose-e-Sharbat',
              confidence: 84,
              scannedAt: new Date().toISOString(),
              excerpt: '…MARKET PVT LTD Invoice 17842 Rose-e-Sharbat…',
            },
          ],
        },
      }),
    );

    await page.goto('/my-drive');
    await page.getByPlaceholder(/Search/i).first().fill('sharbat');

    // The provider returned nothing; this result came from the reading, and
    // says so - otherwise a camera-named file appearing under "sharbat" reads
    // as a bug.
    await expect(page.getByText('…MARKET PVT LTD Invoice 17842 Rose-e-Sharbat…')).toBeVisible({
      timeout: 15_000,
    });
  });
});
