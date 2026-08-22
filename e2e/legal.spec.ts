import { expect, test } from '@playwright/test';

/**
 * Reachable without signing in, which is the whole point of them: a consent
 * screen links to the privacy policy for somebody who has not signed in and
 * may be deciding not to.
 */
test.describe('privacy and terms', () => {
  test('both open without a session', async ({ page }) => {
    await page.goto('/privacy');
    await expect(page.getByRole('heading', { name: 'Privacy', level: 1 })).toBeVisible();

    // The claim Google's review looks for, and the one that is actually true
    // of the code: nothing of the file itself is kept.
    await expect(page.getByText('The contents of your files.')).toBeVisible();
    await expect(page.getByText('Google API Services User Data Policy')).toBeVisible();

    await page.goto('/terms');
    await expect(page.getByRole('heading', { name: 'Terms of use', level: 1 })).toBeVisible();
  });

  test('the landing page links to both', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Privacy' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Terms of use' })).toBeVisible();
  });
});
