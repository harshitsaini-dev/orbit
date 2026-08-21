import { expect, test } from '@playwright/test';
import { signIn } from './helpers.js';

test.describe('shell', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('renders the landing page and reaches the API', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: /one workspace for every cloud/i })).toBeVisible();

    // Provider list comes from GET /health/providers - proves web -> api wiring.
    await expect(page.getByRole('listitem').filter({ hasText: 'Google Drive' })).toBeVisible();
    await expect(page.getByRole('listitem')).toHaveCount(6);
  });

  test('navigates between workspace views', async ({ page }) => {
    await page.getByRole('link', { name: 'My Drive' }).click();
    await expect(page).toHaveURL(/\/my-drive$/);
    await expect(page.getByRole('heading', { name: 'My Drive' })).toBeVisible();
  });

  test('theme choice persists across a reload', async ({ page }) => {
    await page.getByRole('button', { name: 'dark', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});
