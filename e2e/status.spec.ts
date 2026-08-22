import { expect, test } from '@playwright/test';
import { signIn } from './helpers.js';

/**
 * The four ways a page can fail to be the page.
 *
 * Each screen is checked for the thing that makes it useful rather than just
 * present: that it names the right cause, and that it offers a way out. A dead
 * end that merely looks tidy is the failure mode worth guarding against.
 */
test.describe('status screens', () => {
  test('a URL that matches nothing says so', async ({ page }) => {
    await signIn(page);
    await page.goto('/no-such-page');

    await expect(page.getByRole('heading', { name: 'That page does not exist' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to your workspace' })).toBeVisible();
  });

  test('a server fault blames the server, not the visitor', async ({ page }) => {
    await signIn(page);

    await page.route('**/api/accounts*', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: '{"error":{"code":"internal_error","message":"boom"}}',
      }),
    );

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Something broke on our side' })).toBeVisible();

    // The retry must be a real retry: once the API recovers, the same button
    // has to bring the page back without a reload.
    await page.unroute('**/api/accounts*');
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('heading', { name: 'Something broke on our side' })).toBeHidden();
  });

  test('a refusal offers a way back in', async ({ page }) => {
    await signIn(page);

    await page.route('**/api/views/**', (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: '{"error":{"code":"forbidden","message":"no"}}',
      }),
    );

    await page.goto('/starred');
    await expect(page.getByRole('heading', { name: 'You do not have access to this' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
  });

  test('shows the offline screen to a visitor with nothing cached to browse', async ({
    page,
    context,
  }) => {
    // Signed out there is no directory cache and nothing to look at, so the
    // screen is the honest answer. Signed in it is a bar instead, because the
    // cached tree still browses - that case is covered in cache.spec.ts.
    await page.goto('/login');

    await context.setOffline(true);
    // Chromium does not always emit the event for a programmatic change, and
    // the screen is driven by the event rather than by polling.
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expect(page.getByRole('heading', { name: 'You are offline' })).toBeVisible();

    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.getByRole('heading', { name: 'You are offline' })).toBeHidden();
  });
});
