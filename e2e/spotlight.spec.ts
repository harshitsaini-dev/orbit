import { expect, test } from '@playwright/test';
import { signIn } from './helpers.js';

/**
 * With no account connected there is nothing to find, so what is checked here
 * is the shell: that the shortcut opens it, that it closes the way a dialog
 * should, and that it does not claim a file is missing before it has looked.
 */
test.describe('spotlight', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.goto('/my-drive');
    await expect(page.locator('.app-nav')).toBeVisible();
  });

  test('opens on the keyboard shortcut and closes on Escape', async ({ page }) => {
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog', { name: 'Search everything' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Search everything' })).toBeHidden();
  });

  test('opens from the header too, for anyone not reaching for a shortcut', async ({ page }) => {
    await page.getByRole('button', { name: 'Search everything' }).click();
    await expect(page.getByRole('dialog', { name: 'Search everything' })).toBeVisible();
  });

  test('says what it has looked at rather than declaring a file missing', async ({ page }) => {
    // "Nothing matches" from a cache that has only seen a few folders would be
    // telling someone their file is gone when Orbit has not looked yet.
    await page.keyboard.press('Control+k');
    await page.locator('.spotlight input').fill('z');

    await expect(page.locator('.spotlight__empty')).toContainText('on this device yet');
  });

  test('closes when the backdrop is clicked', async ({ page }) => {
    await page.keyboard.press('Control+k');
    await page.locator('.spotlight__scrim').click({ position: { x: 10, y: 10 } });
    await expect(page.getByRole('dialog', { name: 'Search everything' })).toBeHidden();
  });
});
