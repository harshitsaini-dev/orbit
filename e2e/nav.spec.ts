import { expect, test, type Page } from '@playwright/test';
import { signIn } from './helpers.js';

/**
 * The two pickers.
 *
 * Both replaced strips that hid most of their contents. The drive switcher
 * scrolled sideways, so every account past the third looked like it did not
 * exist; the navigation on a phone did the same to two thirds of the pages.
 * Wrapping them fixed the hiding and cost several lines of a screen that has
 * none to spare, so both are menus now — one line each, however many are behind
 * them.
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
  provider: i === 1 ? 'dropbox' : 'google_drive',
  catalogueKey: i === 1 ? 'dropbox' : 'google_drive',
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

test.describe('the drive picker', () => {
  test('names the current drive and offers the rest behind one control', async ({ page }) => {
    await signIn(page);
    await stub(page);
    await page.goto('/my-drive');

    const trigger = page.locator('.drive-picker');
    await expect(trigger).toBeVisible();

    // Which one you are on, said rather than shown by colour at the far end of
    // a scroll.
    await expect(trigger).toContainText('first@example.com');
    // And how many others there are, so the menu is worth opening.
    await expect(trigger).toContainText(String(NAMES.length));

    // One line, whatever the number of accounts.
    const height = (await trigger.boundingBox())!.height;
    expect(height).toBeLessThan(56);

    await trigger.click();

    const menu = page.getByRole('menu');
    for (const name of NAMES) {
      await expect(menu.getByText(name, { exact: true })).toBeVisible();
    }
  });

  test('switching drives changes the drive', async ({ page }) => {
    await signIn(page);
    await stub(page);
    await page.goto('/my-drive');

    await page.locator('.drive-picker').click();
    await page.getByRole('menuitem', { name: 'third.long.address@example.com' }).click();

    await expect(page.locator('.drive-picker')).toContainText('third.long.address@example.com');
    // The drive is in the address, so the page survives a reload and a shared
    // link opens the same place.
    expect(page.url()).toContain('account=acc-2');
  });
});

test.describe('the navigation on a phone', () => {
  test.use({ viewport: { width: 393, height: 850 } });

  test('is one control that says which page you are on', async ({ page }) => {
    await signIn(page);
    await stub(page);
    await page.goto('/my-drive');

    const trigger = page.locator('.nav-picker');
    await expect(trigger).toContainText('My Drive');

    // The whole navigation, in one line rather than six.
    const height = (await trigger.boundingBox())!.height;
    expect(height).toBeLessThan(56);

    await trigger.click();

    const menu = page.getByRole('menu');
    // Including the entries that used to be four swipes away.
    await expect(menu.getByRole('menuitem', { name: 'Account' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Developer' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Dashboard' })).toBeVisible();
  });

  test('goes where it is told', async ({ page }) => {
    await signIn(page);
    await stub(page);
    await page.goto('/my-drive');

    await page.locator('.nav-picker').click();
    await page.getByRole('menuitem', { name: 'Duplicates' }).click();

    await expect(page).toHaveURL(/\/duplicates/);
    await expect(page.locator('.nav-picker')).toContainText('Duplicates');
  });

  test('the sidebar is still a sidebar on a desk', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    await stub(page);
    await page.goto('/my-drive');

    // A column that would otherwise be empty costs nothing, so nothing is
    // hidden there.
    await expect(page.locator('.nav-picker')).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  });
});
