import { expect, test, type Page } from '@playwright/test';
import { signIn } from './helpers.js';

/**
 * Switching drives when there are a lot of them.
 *
 * With twenty-one connected accounts the menu ran from the top of the viewport
 * past the bottom of it, so the last few could not be reached at all — and
 * every entry was a Gmail address differing from its neighbours by a few
 * characters in the middle, which is not something anyone can scan.
 *
 * Two things fix that and both are checked here: the list is capped and
 * scrolls, and past a certain length the menu grows a filter field.
 */

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
  thumbnails: false,
  search: true,
  fullTextSearch: false,
};

/** Deliberately the shape that caused this: same prefix, same suffix. */
const MANY = [
  'rajmandir.kn2@gmail.com',
  'rajmandir.mb@gmail.com',
  'rajmandir.vp@gmail.com',
  'rajmandir.nr@gmail.com',
  'rajmandir.ns104@gmail.com',
  'rajmandir.palam@gmail.com',
  'rajmandir.rg@gmail.com',
  'rajmandir.tns@gmail.com',
  'rajmandir.crgzb@gmail.com',
  'rajmandir.cr@gmail.com',
  'rajmandir.kp1@gmail.com',
  'rajmandir.me3@gmail.com',
  'rajmandir.asr@gmail.com',
  'rajmandir.bp@gmail.com',
  'rajmandir.dm@gmail.com',
  'rajmandir.kg@gmail.com',
  'rajmandir.rmme@gmail.com',
  'rajmandir.mg@gmail.com',
  'rajmandir.jp@gmail.com',
  'rmhm.a6@gmail.com',
  'other.person@gmail.com',
];

const FEW = ['one@example.com', 'two@example.com', 'three@example.com'];

function accountsFor(names: string[]) {
  return names.map((nickname, i) => ({
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
}

async function stub(page: Page, names: string[]): Promise<void> {
  await page.route('**/api/accounts', (route) =>
    route.fulfill({ json: { accounts: accountsFor(names) } }),
  );
  await page.route('**/api/files?**', (route) =>
    route.fulfill({
      json: {
        accountId: 'acc-0',
        provider: 'google_drive',
        path: '/',
        files: [],
        capabilities: CAPABILITIES,
        source: 'provider',
        syncedAt: null,
      },
    }),
  );
}

test.describe('switching between many drives', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('stays on the screen instead of running off the bottom', async ({ page }) => {
    await stub(page, MANY);
    await page.goto('/my-drive');
    await page.locator('.drive-picker').click();

    const menu = page.getByRole('menu');
    const box = (await menu.boundingBox())!;
    const viewport = page.viewportSize()!;

    // The failure this exists for: a menu taller than the window has entries
    // nothing can reach.
    expect(box.height).toBeLessThanOrEqual(viewport.height);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);

    // And the ones past the fold are reachable by scrolling the list.
    const last = menu.getByRole('menuitem', { name: MANY[MANY.length - 1]! });
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeVisible();
  });

  test('filters down to the drive being looked for', async ({ page }) => {
    await stub(page, MANY);
    await page.goto('/my-drive');
    await page.locator('.drive-picker').click();

    const menu = page.getByRole('menu');
    const filter = menu.getByPlaceholder('Search drives');
    await expect(filter).toBeVisible();

    // Four characters in the middle, which is all that distinguishes them.
    await filter.fill('palam');

    await expect(menu.getByRole('menuitem')).toHaveCount(1);
    await expect(menu.getByRole('menuitem', { name: 'rajmandir.palam@gmail.com' })).toBeVisible();
  });

  test('says so rather than showing an empty box when nothing matches', async ({ page }) => {
    await stub(page, MANY);
    await page.goto('/my-drive');
    await page.locator('.drive-picker').click();

    await page.getByPlaceholder('Search drives').fill('zzzzz');

    await expect(page.getByRole('menu')).toContainText('No matches');
    await expect(page.getByRole('menu').getByRole('menuitem')).toHaveCount(0);
  });

  test('picks the filtered drive with the keyboard alone', async ({ page }) => {
    await stub(page, MANY);
    await page.goto('/my-drive');
    await page.locator('.drive-picker').click();

    // The field takes focus on open, so somebody can simply start typing.
    await page.keyboard.type('palam');
    await page.keyboard.press('Enter');

    await expect(page.locator('.drive-picker')).toContainText('rajmandir.palam@gmail.com');
    expect(page.url()).toContain('account=acc-5');
  });

  /*
   * The other half of the decision. A field over three drives is clutter, and
   * the point of adding one was the case where scanning stops working.
   */
  test('offers no filter when the list is short enough to read', async ({ page }) => {
    await stub(page, FEW);
    await page.goto('/my-drive');
    await page.locator('.drive-picker').click();

    await expect(page.getByRole('menu')).toBeVisible();
    await expect(page.getByPlaceholder('Search drives')).toHaveCount(0);
  });
});
