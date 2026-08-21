import { expect, test } from '@playwright/test';

/**
 * The landing page is what a visitor sees at the root. It must work with no
 * session at all — these tests deliberately do not sign in.
 */
test.describe('landing page', () => {
  test('pitches Orbit and offers a way in', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: /one workspace for every cloud/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /sign in/i }).first()).toBeVisible();
  });

  test('lists what Orbit supports, and says what it cannot', async ({ page }) => {
    await page.goto('/');

    // The catalogue comes from GET /api/catalogue - proves web -> api wiring
    // works before anyone has signed in.
    await expect(page.getByRole('listitem').filter({ hasText: 'Google Drive' })).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: 'Cloudflare R2' })).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: 'Azure Blob' })).toBeVisible();

    // Services Orbit cannot support are shown with a reason rather than hidden.
    await expect(page.getByRole('listitem').filter({ hasText: 'iCloud Drive' })).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: 'Proton Drive' })).toBeVisible();
  });

  test('the workspace is still closed to a visitor', async ({ page }) => {
    await page.goto('/quota');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('sign in leads to the code screen', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: /sign in/i }).first().click();

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Sign in to Orbit' })).toBeVisible();
  });
});
