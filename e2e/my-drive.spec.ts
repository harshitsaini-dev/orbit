import { expect, test } from '@playwright/test';
import { signIn } from './helpers.js';

/**
 * The E2E stack has no connected account — connecting one needs a real Google
 * consent — so these cover the states the browser reaches without a provider,
 * and the wiring that does not depend on one. The listing, streaming and
 * mutation paths are covered by the route and adapter suites against mocked
 * provider responses.
 */
test.describe('my drive', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('points at Quota when nothing is connected', async ({ page }) => {
    await page.getByRole('link', { name: 'My Drive' }).click();
    await expect(page).toHaveURL(/\/my-drive$/);

    await expect(page.getByRole('heading', { name: 'My Drive' })).toBeVisible();
    await expect(page.getByText(/no accounts connected yet/i)).toBeVisible();

    // Nothing to list, so no list.
    await expect(page.getByTestId('file-list')).toHaveCount(0);
  });

  test('prefers "connect an account" over "that account is gone"', async ({ page }) => {
    // A stale bookmark pointing at an account that no longer exists. When the
    // user has no accounts at all, telling them to connect one is more useful
    // than telling them this particular id is missing — both are true, and only
    // one is actionable.
    await page.goto('/my-drive?account=does-not-exist&path=/');

    await expect(page.getByText(/no accounts connected yet/i)).toBeVisible();
    await expect(page.getByTestId('file-list')).toHaveCount(0);
  });

  test('a file name never links straight out to the provider', async ({ page }) => {
    // The whole point of the proxy is that the provider's URL never reaches the
    // browser, so nothing on this page may be an outbound link to one.
    await page.goto('/my-drive');

    for (const link of await page.locator('a[href]').all()) {
      const href = (await link.getAttribute('href')) ?? '';
      expect(href, `${href} points at a provider`).not.toMatch(
        /googleapis|googleusercontent|dropboxusercontent|sharepoint|blob\.core\.windows\.net/,
      );
    }
  });

  test('keeps the account and path in the URL, so a folder can be linked to', async ({ page }) => {
    await page.goto('/my-drive?account=does-not-exist&path=/Photos/2026');

    // Reloading must land in the same place rather than resetting to the root.
    await page.reload();
    await expect(page).toHaveURL(/path=%2FPhotos%2F2026|path=\/Photos\/2026/);
  });

  test('the search box says it reaches beyond the loaded folder', async ({ page }) => {
    await page.goto('/my-drive');

    // With no account there is nothing to search, but the control must still
    // describe what it does rather than implying it only filters what is loaded.
    const search = page.getByRole('searchbox', { name: 'Search files' });
    await expect(search).toHaveCount(0);
  });

  test('an empty search is refused rather than returning the whole drive', async ({ page }) => {
    const res = await page.request.get('http://localhost:8788/api/search?accountId=x');
    expect(res.status()).toBe(400);
  });
});
