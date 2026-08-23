import { expect, test, type Page } from '@playwright/test';
import { signIn } from './helpers.js';

/**
 * Nothing important behind a sideways swipe.
 *
 * Both of these were horizontal scrollers, and both hid most of their contents
 * past the right edge with nothing to say so. A strip that scrolls sideways
 * reads as "this is the whole list" — so the pages nobody could see were pages
 * nobody visited, and the drives past the third were drives nobody switched to.
 */

const NAMES = [
  'first@example.com',
  'second@example.com',
  'third.long.address@example.com',
  'fourth@example.com',
  'fifth.even.longer.address@example.com',
  'sixth@example.com',
];

const ACCOUNTS = NAMES.map((nickname, i) => ({
  id: `acc-${i}`,
  provider: 'google_drive',
  catalogueKey: 'google_drive',
  nickname,
  usedBytes: 1000,
  quotaBytes: 1_000_000,
  priorityOrder: i,
  weight: 1,
  status: 'ok',
  lastSyncedAt: null,
  lastRefreshedAt: null,
  connectedAt: new Date().toISOString(),
  isOwner: true,
  accessLevel: 'admin',
}));

const CAPABILITIES = {
  star: true, sharedWithMe: true, delta: true, resumableUpload: true, rangeRequests: true,
  nativeFolders: true, trash: true, purgeTrash: false, relocate: true, reportsQuota: true,
  flatEnumeration: true, recentView: true, thumbnails: false, search: true, fullTextSearch: false,
};

async function stub(page: Page): Promise<void> {
  await page.route('**/api/accounts', (route) => route.fulfill({ json: { accounts: ACCOUNTS } }));
  await page.route('**/api/files?**', (route) =>
    route.fulfill({
      json: {
        accountId: 'acc-0',
        provider: 'google_drive',
        path: '/',
        files: [],
        capabilities: CAPABILITIES,
      },
    }),
  );
}

test.describe('the drive switcher', () => {
  test('wraps onto more lines instead of scrolling sideways', async ({ page }) => {
    await signIn(page);
    await stub(page);
    await page.goto('/my-drive');

    const strip = page.locator('.drive-strip');
    await expect(strip).toBeVisible();

    // Nothing past the right edge.
    const overflows = await strip.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(overflows).toBe(false);

    // Every drive is on the screen, not only the ones that fit on one line.
    const chips = strip.locator('button');
    await expect(chips).toHaveCount(NAMES.length);

    for (const name of NAMES) {
      await expect(strip.getByText(name, { exact: true })).toBeInViewport();
    }

    // And they are genuinely on more than one row.
    const rows = await chips.evaluateAll(
      (els) => new Set(els.map((el) => Math.round(el.getBoundingClientRect().top))).size,
    );
    expect(rows).toBeGreaterThan(1);
  });
});

test.describe('the navigation on a phone', () => {
  test.use({ viewport: { width: 393, height: 850 } });

  test('shows every page without a swipe', async ({ page }) => {
    await signIn(page);
    await stub(page);
    await page.goto('/my-drive');

    const nav = page.locator('.app-nav');
    await expect(nav).toBeVisible();

    const overflows = await nav.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(overflows).toBe(false);

    // The last entry used to be four swipes away.
    await expect(nav.getByRole('link', { name: 'Account' })).toBeInViewport();
    await expect(nav.getByRole('link', { name: 'Developer' })).toBeInViewport();

    const rows = await nav
      .locator('a')
      .evaluateAll((els) => new Set(els.map((el) => Math.round(el.getBoundingClientRect().top))).size);

    expect(rows).toBeGreaterThan(2);
  });
});
