import { expect, test, type Page } from '@playwright/test';
import { signIn } from './helpers.js';

/**
 * The two questions the date filter could not ask.
 *
 * It only ever ran one way — "changed in the last N days" — so "everything
 * older than a year", which is what somebody asks before clearing space, had
 * no answer but sorting by date and scrolling. And there was no created-date
 * filter at all, because `OrbitFile` had no created date to filter on.
 */

const ACCOUNT = {
  id: 'acc-0',
  provider: 'google_drive',
  catalogueKey: 'google_drive',
  nickname: 'me@example.com',
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
  flatEnumeration: true, recentView: true, thumbnails: false, search: true,
  fullTextSearch: false, reportsCreated: true,
};

async function stub(page: Page): Promise<URL[]> {
  const asked: URL[] = [];

  await page.route('**/api/accounts', (route) => route.fulfill({ json: { accounts: [ACCOUNT] } }));
  await page.route('**/api/files?**', (route) =>
    route.fulfill({
      json: {
        accountId: ACCOUNT.id,
        provider: 'google_drive',
        path: '/',
        files: [],
        capabilities: CAPABILITIES,
      },
    }),
  );
  await page.route('**/api/search?**', (route) => {
    asked.push(new URL(route.request().url()));
    return route.fulfill({ json: { files: [] } });
  });

  return asked;
}

async function openFilters(page: Page): Promise<void> {
  await page.goto('/my-drive');
  await page.getByRole('button', { name: /Filters/ }).click();
}

test.describe('filtering by date', () => {
  test('asks the provider for a lower bound when the band looks back', async ({ page }) => {
    await signIn(page);
    const asked = await stub(page);
    await openFilters(page);

    await page.getByRole('button', { name: 'Modified', exact: true }).click();
    await page.getByRole('option', { name: 'Past week' }).click();

    await expect.poll(() => asked.length).toBeGreaterThan(0);

    const last = asked[asked.length - 1]!;
    expect(last.searchParams.get('since')).toBeTruthy();
    // One bound or the other, never both - "past week" has no upper end.
    expect(last.searchParams.get('before')).toBeNull();
  });

  test('asks for an upper bound when the band looks back past a point', async ({ page }) => {
    await signIn(page);
    const asked = await stub(page);
    await openFilters(page);

    await page.getByRole('button', { name: 'Modified', exact: true }).click();
    await page.getByRole('option', { name: 'Older than a year' }).click();

    await expect.poll(() => asked.length).toBeGreaterThan(0);

    const last = asked[asked.length - 1]!;
    // The question that had no answer before: everything untouched for a year.
    expect(last.searchParams.get('before')).toBeTruthy();
    expect(last.searchParams.get('since')).toBeNull();

    const before = new Date(last.searchParams.get('before')!);
    const daysAgo = (Date.now() - before.getTime()) / 86_400_000;
    expect(daysAgo).toBeGreaterThan(360);
    expect(daysAgo).toBeLessThan(370);
  });

  test('filters on the created date, separately from the modified one', async ({ page }) => {
    await signIn(page);
    const asked = await stub(page);
    await openFilters(page);

    await page.getByRole('button', { name: 'Created', exact: true }).click();
    await page.getByRole('option', { name: 'Older than 3 months' }).click();

    await expect.poll(() => asked.length).toBeGreaterThan(0);

    const last = asked[asked.length - 1]!;
    expect(last.searchParams.get('createdBefore')).toBeTruthy();
    // The two are independent: a created filter must not move the modified one.
    expect(last.searchParams.get('before')).toBeNull();
  });

  test('offers both directions, not only "within"', async ({ page }) => {
    await signIn(page);
    await stub(page);
    await openFilters(page);

    await page.getByRole('button', { name: 'Modified', exact: true }).click();

    const options = page.getByRole('option');
    await expect(options.filter({ hasText: 'Past week' })).toHaveCount(1);
    await expect(options.filter({ hasText: 'Older than a year' })).toHaveCount(1);
    await expect(options.filter({ hasText: 'Older than 3 months' })).toHaveCount(1);
  });

  test('hides the created filter on a drive that has no created date', async ({ page }) => {
    await signIn(page);

    await page.route('**/api/accounts', (route) =>
      route.fulfill({ json: { accounts: [{ ...ACCOUNT, provider: 'dropbox', catalogueKey: 'dropbox' }] } }),
    );
    await page.route('**/api/files?**', (route) =>
      route.fulfill({
        json: {
          accountId: ACCOUNT.id,
          provider: 'dropbox',
          path: '/',
          files: [],
          // Dropbox records when a client last wrote the file, which is not a
          // creation time.
          capabilities: { ...CAPABILITIES, reportsCreated: false },
        },
      }),
    );

    await openFilters(page);

    // Still asks about modified - that one every provider can answer.
    await expect(page.getByRole('button', { name: 'Modified', exact: true })).toBeVisible();

    /*
     * And says nothing about created. A filter that is present and returns
     * nothing reads as an answer about the files rather than about the drive.
     */
    await expect(page.getByRole('button', { name: 'Created', exact: true })).toHaveCount(0);
  });
});
