import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { signIn } from './helpers.js';

/**
 * A format that says `image/` and that no browser will draw.
 *
 * HEIC is what an iPhone writes by default, so most of a modern camera roll is
 * made of it — and outside Safari an `<img>` pointed at one shows a broken
 * picture and the filename, which reads as Orbit failing rather than as the
 * format being unsupported.
 */

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
  flatEnumeration: true, recentView: true, thumbnails: true, search: true, fullTextSearch: false,
};

const HEIC = {
  remoteId: 'r-heic',
  name: 'IMG20260822213320.heic',
  virtualPath: '/IMG20260822213320.heic',
  mimeType: 'image/heic',
  sizeBytes: 6_300_000,
  isFolder: false,
  starred: false,
  modifiedAt: new Date(Date.UTC(2026, 7, 22)).toISOString(),
};

/** What a provider hands back when asked to render one: an ordinary JPEG-ish
 *  picture at a sensible size, not a placeholder pixel. */
const RENDERED = readFileSync('e2e/fixtures/rendered.png');

async function stub(page: Page): Promise<void> {
  await page.route('**/api/accounts', (route) => route.fulfill({ json: { accounts: [ACCOUNT] } }));

  await page.route('**/api/files?**', (route) =>
    route.fulfill({
      json: {
        accountId: ACCOUNT.id,
        provider: 'google_drive',
        path: '/',
        files: [HEIC],
        capabilities: CAPABILITIES,
      },
    }),
  );

  await page.route('**/thumbnail?**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: RENDERED }),
  );

  // The file itself, which the browser could not decode if it tried.
  await page.route('**/content?**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/heic', body: Buffer.from([0, 1, 2]) }),
  );
}

test.describe('previewing a HEIC', () => {
  test('shows the provider’s rendering, and says that is what it is', async ({ page }) => {
    await signIn(page);
    await stub(page);
    await page.goto('/my-drive');

    await page.getByText(HEIC.name).first().click();

    const dialog = page.getByTestId('file-preview');
    await expect(dialog).toBeVisible();

    // The picture on screen is the thumbnail, not the file: an <img> pointed
    // at the HEIC itself is a broken-picture icon everywhere but Safari.
    const image = dialog.locator('img').first();
    await expect(image).toBeVisible();
    expect(await image.getAttribute('src')).toContain('/thumbnail?');

    // And it says so, rather than passing a downscaled render off as the file.
    await expect(dialog.getByText(/browsers cannot display/i)).toBeVisible();
    await expect(dialog.getByText(/Download it for the original/i)).toBeVisible();
  });
});
