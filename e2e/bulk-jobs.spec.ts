import { expect, test, type Page } from '@playwright/test';
import { signIn } from './helpers.js';

/**
 * A bulk delete is a background job.
 *
 * It used to run inside My Drive, so navigating to another page mid-delete
 * unmounted the loop doing the deleting: the progress bar disappeared and the
 * work stopped with it. That is the regression these cover — the queue lives
 * above the router now, and reports from the header.
 *
 * The drive is stubbed at the network, as everywhere else in this suite: what
 * is under test is where the job lives, not any provider's behaviour.
 */

const ACCOUNT = {
  id: 'acc-stub',
  provider: 'google_drive',
  catalogueKey: 'google_drive',
  nickname: 'stub@example.com',
  usedBytes: 1_000,
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
  star: true,
  sharedWithMe: true,
  delta: true,
  resumableUpload: true,
  rangeRequests: true,
  nativeFolders: true,
  trash: true,
  purgeTrash: false,
  relocate: true,
  reportsQuota: true,
  flatEnumeration: true,
  recentView: true,
  thumbnails: true,
  search: true,
  fullTextSearch: false,
};

/** Enough to need more than one batch, so progress has somewhere to move. */
const FILES = Array.from({ length: 120 }, (_, index) => ({
  remoteId: `id-${index}`,
  name: `file-${String(index).padStart(3, '0')}.txt`,
  virtualPath: `/file-${String(index).padStart(3, '0')}.txt`,
  mimeType: 'text/plain',
  sizeBytes: 1_024,
  isFolder: false,
  starred: false,
  modifiedAt: new Date(Date.UTC(2026, 7, 20)).toISOString(),
}));

async function stubDrive(page: Page, holdDelete: () => Promise<void>): Promise<void> {
  await page.route('**/api/accounts', (route) => route.fulfill({ json: { accounts: [ACCOUNT] } }));

  await page.route('**/api/files?**', (route) =>
    route.fulfill({
      json: {
        accountId: ACCOUNT.id,
        provider: 'google_drive',
        path: '/',
        files: FILES,
        capabilities: CAPABILITIES,
        source: 'provider',
        syncedAt: null,
      },
    }),
  );

  /*
   * Held open on purpose. A stubbed delete answers instantly, and a job that
   * finishes before the next line runs cannot show whether it survived
   * anything - the test would pass with the bug still in place.
   */
  await page.route('**/api/files', async (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    await holdDelete();
    const body = route.request().postDataJSON() as { remoteIds: string[] };
    return route.fulfill({ json: { succeeded: body.remoteIds, failed: [] } });
  });
}

async function selectAllAndDelete(page: Page): Promise<void> {
  // Forced: the input is visually hidden behind the drawn box, which is how
  // every checkbox in this app is built.
  await page.getByRole('checkbox', { name: /select/i }).first().check({ force: true });
  await page.getByRole('button', { name: /^(Bin|Delete) \d+/ }).click();
  await page.getByRole('button', { name: /Move to bin|Delete for ever/ }).click();
}

test.describe('a bulk delete outlives the page that started it', () => {
  /*
   * Desktop only, and the exclusion lives in playwright.config.ts because that
   * is where the project matrix is. See the note beside it: this covers where
   * a job lives, which is not viewport behaviour, and reaching another page
   * differs between the sidebar and the phone's nav dropdown.
   */
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('keeps running, and keeps reporting, after navigating away', async ({ page }) => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    await stubDrive(page, () => held);
    await page.goto('/my-drive');
    await expect(page.getByText('file-000.txt')).toBeVisible();

    await selectAllAndDelete(page);

    /*
     * The header's chip specifically, not the bar on the file list. Both are
     * live regions saying the same thing, and it is the header one that has to
     * survive the navigation - the other belongs to the page being left.
     */
    const chip = page.locator('.bulk-chip');
    await expect(chip).toContainText(/Deleting/);

    // The move that used to kill it.
    await page.getByRole('link', { name: 'Quota' }).click();
    await expect(page).toHaveURL(/\/quota/);

    // Still there, still counting, on a page that knows nothing about it.
    await expect(chip).toBeVisible();
    await expect(chip).toContainText(/Deleting/);

    release();

    // And it finishes here rather than never.
    await expect(page.getByText(/Deleted \d+ files\./)).toBeVisible({ timeout: 15_000 });
  });

  test('reports what the provider refused rather than claiming it all worked', async ({ page }) => {
    await stubDrive(page, async () => {});
    await page.unroute('**/api/files');
    await page.route('**/api/files', async (route) => {
      if (route.request().method() !== 'DELETE') return route.fallback();
      const body = route.request().postDataJSON() as { remoteIds: string[] };
      return route.fulfill({
        json: {
          succeeded: body.remoteIds.slice(1),
          failed: [{ remoteId: body.remoteIds[0], reason: 'insufficient permissions' }],
        },
      });
    });

    await page.goto('/my-drive');
    await expect(page.getByText('file-000.txt')).toBeVisible();

    await selectAllAndDelete(page);

    // The count and the reason, because "some failed" sends somebody looking
    // and the reason is usually the whole answer.
    await expect(page.getByText(/could not be: insufficient permissions/)).toBeVisible({
      timeout: 15_000,
    });
  });
});
