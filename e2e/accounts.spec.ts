import { expect, test } from '@playwright/test';
import { signIn } from './helpers.js';

const API = 'http://localhost:8788';

test.describe('connecting an account', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('shows an empty state and offers Google Drive', async ({ page }) => {
    await page.getByRole('link', { name: 'Quota' }).click();
    await expect(page).toHaveURL(/\/quota$/);

    await expect(page.getByRole('heading', { name: 'Connected accounts' })).toBeVisible();
    await expect(page.getByText('No accounts yet')).toBeVisible();

    const connect = page.getByRole('link', { name: /Google Drive/ });
    await expect(connect).toBeVisible();
    // Relative in development, so it goes through the dev proxy; VITE_API_URL
    // makes it absolute in production. Either way it must reach this path.
    await expect(connect).toHaveAttribute('href', /\/auth\/connect\/google_drive$/);
  });

  test('the connect link hands off to Google with the right parameters', async ({ page }) => {
    // Followed with the API client rather than the page, so the test never
    // actually leaves for accounts.google.com.
    const res = await page.request.get(`${API}/auth/connect/google_drive`, { maxRedirects: 0 });
    expect(res.status()).toBe(302);

    const target = new URL(res.headers().location!);
    expect(target.host).toBe('accounts.google.com');
    expect(target.searchParams.get('access_type')).toBe('offline');
    expect(target.searchParams.get('code_challenge_method')).toBe('S256');
    expect(target.searchParams.get('redirect_uri')).toBe(`${API}/auth/callback/google_drive`);
  });

  test('a forged callback connects nothing and says so', async ({ page }) => {
    await page.goto(`${API}/auth/callback/google_drive?code=forged&state=forged`);

    // The API redirects back to the app with the failure in the query string.
    await expect(page).toHaveURL(/\/quota\?connect=failed/);
    await expect(page.getByRole('status')).toContainText(/could not connect/i);
    await expect(page.getByText('No accounts yet')).toBeVisible();
  });

  test('a cancelled consent is reported, not swallowed', async ({ page }) => {
    await page.goto(`${API}/auth/callback/google_drive?error=access_denied`);
    await expect(page.getByRole('status')).toContainText(/access denied/i);
  });
});
