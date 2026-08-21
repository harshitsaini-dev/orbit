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

  test('keeps the account and path in the URL, so a folder can be linked to', async ({ page }) => {
    await page.goto('/my-drive?account=does-not-exist&path=/Photos/2026');

    // Reloading must land in the same place rather than resetting to the root.
    await page.reload();
    await expect(page).toHaveURL(/path=%2FPhotos%2F2026|path=\/Photos\/2026/);
  });
});
