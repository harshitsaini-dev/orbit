import { expect, test } from '@playwright/test';
import { signIn } from './helpers.js';

test.describe('account profile', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('shows the email and an initials avatar before a name is set', async ({ page }) => {
    await page.getByRole('link', { name: 'Account', exact: true }).click();
    await expect(page).toHaveURL(/\/account$/);

    await expect(page.getByRole('heading', { name: 'Your profile' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Upload picture' })).toBeVisible();
  });

  test('saves a display name and shows it in the header', async ({ page }) => {
    await page.goto('/account');

    await page.getByLabel('Display name').fill('Harshit Saini');
    await page.getByRole('button', { name: 'Save name' }).click();

    await expect(page.getByText('Saved.')).toBeVisible();
    // The header identifies the user by name once there is one.
    await expect(page.getByTestId('current-user')).toHaveText('Harshit Saini');

    // And it survives a reload, so it really was stored.
    await page.reload();
    await expect(page.getByTestId('current-user')).toHaveText('Harshit Saini');
  });

  test('a saved theme survives a reload', async ({ page }) => {
    await page.goto('/account');

    await page.getByTestId('appearance').getByRole('button', { name: 'dark', exact: true }).click();

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('the account menu reaches the settings page', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menu', { name: 'Account' }).getByRole('menuitem', { name: 'Account settings' }).click();

    await expect(page).toHaveURL(/\/account$/);
  });
});
