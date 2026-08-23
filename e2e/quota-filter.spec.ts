import { expect, test, type Page } from '@playwright/test';
import { signIn } from './helpers.js';

/**
 * Finding one connection among ten.
 *
 * Several of these are the same address on different services, so the filter
 * searches the provider's name too — typing "dropbox" is a reasonable way to
 * ask for the Dropbox one, and a nickname search alone would return five
 * identical rows.
 */

const ACCOUNTS = [
  ['harshitsaini.dev@gmail.com', 'google_drive', 'ok'],
  ['gameid8839@gmail.com', 'google_drive', 'ok'],
  ['rajmandir.harshit@gmail.com', 'google_drive', 'ok'],
  ['harshit.saini.7017@gmail.com', 'google_drive', 'needs_reauth'],
  ['harshitsaini.dev@gmail.com', 'dropbox', 'ok'],
  ['avatars', 'supabase_storage', 'ok'],
  ['portfolio-media', 'cloudflare_r2', 'error'],
].map(([nickname, catalogueKey, status], i) => ({
  id: `acc-${i}`,
  provider: catalogueKey === 'google_drive' || catalogueKey === 'dropbox' ? catalogueKey : 's3',
  catalogueKey,
  nickname,
  usedBytes: 1000,
  quotaBytes: catalogueKey === 'google_drive' ? 1_000_000 : 0,
  priorityOrder: i,
  weight: 1,
  status,
  lastSyncedAt: null,
  lastRefreshedAt: null,
  connectedAt: new Date().toISOString(),
  isOwner: true,
  accessLevel: 'admin',
}));

async function stub(page: Page): Promise<void> {
  await page.route('**/api/accounts', (route) => route.fulfill({ json: { accounts: ACCOUNTS } }));
  await page.route('**/api/storage', (route) =>
    route.fulfill({ json: { groups: [], sharedDrives: [], overall: { usedBytes: 0, quotaBytes: 0, totals: [], fileCount: 0 }, unindexedAccounts: 0 } }),
  );
}

test.describe('the account filter', () => {
  test('narrows by nickname and by service', async ({ page }) => {
    await signIn(page);
    await stub(page);
    await page.goto('/quota');

    const box = page.getByPlaceholder(/Filter \d+ accounts/);
    await expect(box).toBeVisible();

    const cards = page.locator('.clay-sunken', { has: page.locator('strong') });

    await box.fill('gameid');
    await expect(page.getByText('gameid8839@gmail.com')).toBeVisible();
    await expect(page.getByText('rajmandir.harshit@gmail.com')).toHaveCount(0);

    // The service's name, because five of these are the same address.
    await box.fill('dropbox');
    await expect(cards.filter({ hasText: 'Dropbox' })).toHaveCount(1);
    await expect(page.getByText('gameid8839@gmail.com')).toHaveCount(0);

    await box.fill('nothing here');
    await expect(page.getByText('No account matches that.')).toBeVisible();
  });

  test('shows only the ones that need attention when asked', async ({ page }) => {
    await signIn(page);
    await stub(page);
    await page.goto('/quota');

    // Two of the seven are broken. Finding them by reading every card is the
    // thing this replaces.
    const button = page.getByRole('button', { name: /Needs attention \(2\)/ });
    await expect(button).toBeVisible();

    await button.click();

    await expect(page.getByText('harshit.saini.7017@gmail.com')).toBeVisible();
    await expect(page.getByText('portfolio-media')).toBeVisible();
    await expect(page.getByText('gameid8839@gmail.com')).toHaveCount(0);
  });

  test('stays out of the way when there is nothing to search', async ({ page }) => {
    await signIn(page);
    await page.route('**/api/accounts', (route) =>
      route.fulfill({ json: { accounts: ACCOUNTS.slice(0, 2) } }),
    );
    await page.route('**/api/storage', (route) =>
      route.fulfill({ json: { groups: [], sharedDrives: [], overall: { usedBytes: 0, quotaBytes: 0, totals: [], fileCount: 0 }, unindexedAccounts: 0 } }),
    );
    await page.goto('/quota');

    await expect(page.getByText('harshitsaini.dev@gmail.com').first()).toBeVisible();
    // A filter box above two accounts costs a line and answers nothing.
    await expect(page.getByPlaceholder(/Filter \d+ accounts/)).toHaveCount(0);
  });
});
