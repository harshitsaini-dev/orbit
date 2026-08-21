import { expect, test } from '@playwright/test';
import { openAccountMenu, signIn } from './helpers.js';

test.describe('shell', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('shows the dashboard at the root once signed in', async ({ page }) => {
    await page.goto('/');

    // The root is the one address that differs by who is asking: a signed-in
    // user gets their own storage, not the pitch.
    await expect(page.getByRole('heading', { name: /^good (morning|afternoon|evening|night)/i })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Browse files' })).toBeVisible();
  });

  test('navigates between workspace views', async ({ page }) => {
    await page.getByRole('link', { name: 'My Drive' }).click();
    await expect(page).toHaveURL(/\/my-drive$/);
    await expect(page.getByRole('heading', { name: 'My Drive' })).toBeVisible();
  });

  test('theme choice persists across a reload', async ({ page }) => {
    const menu = await openAccountMenu(page);
    await menu.getByRole('menuitemradio', { name: 'dark' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});
