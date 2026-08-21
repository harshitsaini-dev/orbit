import { expect, test } from '@playwright/test';
import { signIn } from './helpers.js';

test.describe('grid view and thumbnails', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('offers no layout controls when there is nothing to lay out', async ({ page }) => {
    // The E2E stack has no connected account, so the browser sits on its empty
    // state. The toolbar - and the toggle with it - belongs to a drive that
    // exists; offering a view switch over nothing would be noise.
    await page.goto('/my-drive');

    await expect(page.getByText(/no accounts connected yet/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Grid view' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'List view' })).toHaveCount(0);
    await expect(page.getByTestId('file-grid')).toHaveCount(0);
  });

  test('a thumbnail is refused for an account that is not there', async ({ page }) => {
    const res = await page.request.get('http://localhost:8788/api/files/whatever/thumbnail?accountId=nope');
    expect(res.status()).toBe(404);
  });

  test('a thumbnail request needs an account', async ({ page }) => {
    const res = await page.request.get('http://localhost:8788/api/files/whatever/thumbnail');
    expect(res.status()).toBe(400);
  });
});
