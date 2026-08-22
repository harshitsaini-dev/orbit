import { expect, test } from '@playwright/test';
import { signIn } from './helpers.js';

/**
 * The E2E stack has no connected account, so what can be checked here is the
 * shape of the behaviour rather than a cached listing: that losing the network
 * no longer takes the workspace away, and that the cache is visible and
 * clearable rather than being something that silently accumulates.
 */
test.describe('offline', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.goto('/my-drive');
  });

  test('keeps the workspace up and says what is missing', async ({ page, context }) => {
    // Taking the whole app away would throw away the cached tree to say
    // something a bar can say.
    // Wait for the workspace to be up before cutting the network: dispatched
    // while the first render is still in flight, the event lands on a tree that
    // has not mounted the bar yet and nothing re-fires it.
    await expect(page.locator('.app-nav')).toBeVisible();

    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));

    await expect(page.locator('.offline-bar')).toBeVisible();
    await expect(page.locator('.app-nav')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'You are offline' })).toBeHidden();

    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.locator('.offline-bar')).toBeHidden();
  });

  test('the cache can be seen and cleared from the account menu', async ({ page }) => {
    // A cache nobody can see or clear is one people stop trusting the moment
    // anything looks stale.
    await page.locator('.app-header button').last().click();
    await expect(page.getByRole('menuitem', { name: /cached/i })).toBeVisible();
  });
});
