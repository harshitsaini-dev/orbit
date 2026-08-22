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

    // The whole viewport, not a panel beside a working sidebar. Drawn in the
    // content area it reads as one broken widget and people click past it.
    await expect(page.getByRole('navigation', { name: 'Workspace' })).toHaveCount(0);
  });

  test('an error inside a page still covers the navigation', async ({ page }) => {
    // This one is returned from a page component, which sits inside the shell -
    // so covering the viewport from there only works because it is portalled
    // out of it. Without that the sidebar stays drawn around the failure and it
    // reads as one broken widget.
    await signIn(page);

    await page.route('**/api/duplicates*', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: '{"error":{"code":"internal_error","message":"boom"}}',
      }),
    );

    await page.goto('/duplicates');
    await expect(page.getByRole('heading', { name: 'Something broke on our side' })).toBeVisible();

    /*
     * Geometry, not occlusion: `toBeInViewport` reports an element covered by
     * another as still in the viewport, so the thing to check is that the
     * failure actually fills the screen and is opaque.
     */
    const covered = await page.evaluate(() => {
      const shell = document.querySelector('.status-shell');
      if (!shell) return null;

      const box = shell.getBoundingClientRect();
      const style = getComputedStyle(shell);
      return {
        /*
         * A pixel of slack. Under mobile emulation the device pixel ratio puts
         * a fixed, inset-0 element at 393.6 against an innerWidth of 394, and
         * a strict comparison fails a screen that is visibly full. What is
         * being asserted is that nothing shows around it, not arithmetic.
         */
        fillsViewport: box.width >= window.innerWidth - 1 && box.height >= window.innerHeight - 1,
        background: style.backgroundColor,
        // What is actually painted at the top-left, where the navigation is.
        onTop: document.elementFromPoint(60, 300)?.closest('.status-shell') !== null,
      };
    });

    expect(covered).not.toBeNull();
    expect(covered!.fillsViewport).toBe(true);
    expect(covered!.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(covered!.onTop).toBe(true);
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
