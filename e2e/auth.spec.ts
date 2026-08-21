import { expect, test } from '@playwright/test';
import { lastCode, openAccountMenu, uniqueEmail } from './helpers.js';

test.describe('email OTP sign-in', () => {
  test('signs in with a valid code and stays signed in across a reload', async ({ page }) => {
    const email = uniqueEmail('pilot');

    await page.goto('/my-drive');
    await expect(page).toHaveURL(/\/login$/);

    await page.getByLabel('Email address').fill(email);
    await page.getByRole('button', { name: 'Send code' }).click();

    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    await expect(page.getByText(email)).toBeVisible();

    await page.getByLabel('6-digit code').fill(await lastCode(page, email));
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId('current-user')).toHaveText(email);

    await page.reload();
    await expect(page.getByTestId('current-user')).toHaveText(email);
  });

  test('rejects a wrong code and keeps the user on the code step', async ({ page }) => {
    const email = uniqueEmail('wrong');

    await page.goto('/login');
    await page.getByLabel('Email address').fill(email);
    await page.getByRole('button', { name: 'Send code' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

    const real = await lastCode(page, email);
    const wrong = real === '000000' ? '111111' : '000000';

    await page.getByLabel('6-digit code').fill(wrong);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByRole('alert')).toContainText(/not valid/i);
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByTestId('current-user')).toHaveCount(0);
  });

  test('signing out ends the session', async ({ page }) => {
    const email = uniqueEmail('bye');

    await page.goto('/login');
    await page.getByLabel('Email address').fill(email);
    await page.getByRole('button', { name: 'Send code' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

    await page.getByLabel('6-digit code').fill(await lastCode(page, email));
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByTestId('current-user')).toHaveText(email);

    const menu = await openAccountMenu(page);
    await menu.getByRole('menuitem', { name: 'Sign out' }).click();

    // Signing out lands on the public landing page, not the sign-in form.
    await expect(page.getByRole('heading', { name: /one workspace for every cloud/i })).toBeVisible();
    await expect(page.getByTestId('current-user')).toHaveCount(0);

    // And the protected routes are closed again.
    await page.goto('/my-drive');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('offers a resend only after the cooldown', async ({ page }) => {
    const email = uniqueEmail('cooldown');

    await page.goto('/login');
    await page.getByLabel('Email address').fill(email);
    await page.getByRole('button', { name: 'Send code' }).click();

    const resend = page.getByRole('button', { name: /Resend/ });
    await expect(resend).toBeDisabled();
    await expect(resend).toContainText(/Resend in \d+s/);
  });
});
