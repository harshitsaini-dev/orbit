import { expect, test } from '@playwright/test';
import { signIn } from './helpers.js';
import { E2E_API_URL } from './paths.js';

/**
 * Every provider with a working adapter is offered, and named.
 *
 * These lists are three separate things — the landing page's own grouping, the
 * connect screen fed by `/api/connectable`, and the icon table — and adding an
 * adapter without touching all three leaves a provider that exists in the code
 * and nowhere a person can see. That is exactly what happened when MEGA
 * landed: connectable from the first commit, absent from the landing page, and
 * drawn as the grey fallback beside eight real marks.
 */

const DRIVES = ['Google Drive', 'OneDrive', 'Dropbox', 'pCloud', 'MEGA'];

test.describe('the providers on offer', () => {
  test('the landing page lists every drive', async ({ page }) => {
    await page.goto('/');

    // By card rather than by exact text: a provider this instance has no keys
    // for carries a "Coming soon" badge inside the same heading, so its text
    // is no longer the name on its own.
    const cards = page.locator('.landing__provider-grid > li');

    for (const name of DRIVES) {
      await expect(cards.filter({ hasText: name })).toHaveCount(1);
    }
  });

  test('the connect screen offers every drive, with its own mark', async ({ page }) => {
    await signIn(page);
    await page.goto('/quota');

    // Every one is on the page - the ones with keys as controls, the rest
    // under "Not set up yet".
    for (const name of DRIVES) {
      await expect(page.getByText(name, { exact: false }).first()).toBeVisible();
    }

    /*
     * The mark specifically. A provider missing from the icon table still
     * appears, drawn as a grey cloud that says nothing - which is worse than
     * an obvious gap, because it looks deliberate.
     */
    const mega = page.getByRole('button', { name: /MEGA/ });
    await expect(mega).toBeVisible();

    const fill = await mega.locator('svg circle, svg path').first().getAttribute('fill');
    expect(fill).toBe('#d9272e');
  });

  test('MEGA asks for an email and a password, not OAuth', async ({ page }) => {
    await signIn(page);
    await page.goto('/quota');

    // A store with fields stays in the app; an OAuth provider has to leave it.
    // MEGA issues no tokens, so it is the first kind.
    await page.getByRole('button', { name: /MEGA/ }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('MEGA email')).toBeVisible();
    await expect(dialog.getByText('MEGA password')).toBeVisible();

    // And it says what happens to the password, because "type your password
    // into this other website" deserves an answer.
    await expect(dialog.getByText(/discarded/i)).toBeVisible();

    /*
     * The two-factor field is not there yet, and that is the point. Asking for
     * a code up front is asking a question nobody can answer: most accounts do
     * not have it turned on, and the ones that do have a code that expires in
     * seconds - it cannot be typed before the password has even been tried.
     */
    await expect(dialog.getByText('Two-factor code')).toHaveCount(0);
  });

  test('asks for a two-factor code only once MEGA says it needs one', async ({ page }) => {
    await signIn(page);
    await page.goto('/quota');
    await page.getByRole('button', { name: /MEGA/ }).click();

    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('MEGA email').fill('me@example.com');
    await dialog.getByLabel('MEGA password').fill('hunter2');

    // What MEGA answers for an account with a second factor: not a refusal,
    // a next step.
    await page.route('**/api/accounts/connect', (route) =>
      route.fulfill({
        status: 400,
        json: {
          error: {
            code: 'mfa_required',
            message: 'This account has two-factor authentication on. Enter the current code from your authenticator app.',
          },
        },
      }),
    );

    await dialog.getByRole('button', { name: 'Connect' }).click();

    // The field appears, and what was typed is still there - a form that
    // cleared itself would be asking for the password a second time.
    const code = dialog.getByLabel('Two-factor code');
    await expect(code).toBeVisible();
    await expect(code).toBeFocused();
    await expect(dialog.getByLabel('MEGA email')).toHaveValue('me@example.com');

    await expect(dialog.getByText(/two-factor authentication on/i)).toBeVisible();
  });
});

/**
 * A provider that is built and not set up here.
 *
 * An OAuth client belongs to whoever runs Orbit, not to Orbit - so a provider
 * can be finished, tested and completely unconnectable on an instance whose
 * owner has not registered one. It used to be listed as an ordinary card, and
 * the button sent the browser to an authorise URL with no client id, which
 * ends at the provider's own error page rather than anywhere Orbit could
 * explain.
 *
 * The e2e server has keys for Google only, so OneDrive, Dropbox and pCloud are
 * the unset ones here.
 */
test.describe('a provider without its keys', () => {
  test('is marked on the landing page rather than promised or hidden', async ({ page }) => {
    await page.goto('/');

    const soon = page.locator('.landing__provider-grid > li[data-soon]');
    await expect(soon.filter({ hasText: 'OneDrive' })).toHaveCount(1);
    await expect(soon.filter({ hasText: 'pCloud' })).toHaveCount(1);

    // Still named, because "does Orbit support X" is a question the page
    // exists to answer.
    await expect(soon.filter({ hasText: 'OneDrive' }).getByText('Coming soon')).toBeVisible();

    // And the ones that do work are not marked.
    await expect(
      page.locator('.landing__provider-grid > li[data-soon]').filter({ hasText: 'Google Drive' }),
    ).toHaveCount(0);
  });

  test('is not offered as something to click on the connect screen', async ({ page }) => {
    await signIn(page);
    await page.goto('/quota');

    await expect(page.getByText('Not set up yet')).toBeVisible();

    const unset = page.locator('.provider-soon-list > li');
    await expect(unset.filter({ hasText: 'OneDrive' })).toHaveCount(1);

    // Not a button and not a link: there is nothing behind it yet.
    await expect(page.getByRole('button', { name: /OneDrive/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /OneDrive/ })).toHaveCount(0);

    // Google has keys on this instance, so it is a real control.
    await expect(page.getByRole('link', { name: /Google Drive/ })).toHaveCount(1);
  });

  test('the catalogue says which is which', async ({ request }) => {
    const res = await request.get(`${E2E_API_URL}/api/catalogue`);
    const { entries } = (await res.json()) as Array<never> extends never
      ? { entries: Array<{ key: string; configured: boolean }> }
      : never;

    const byKey = new Map(entries.map((entry) => [entry.key, entry.configured]));

    expect(byKey.get('google_drive')).toBe(true);
    expect(byKey.get('onedrive')).toBe(false);
    // Credentials providers have nothing for an operator to set up: the user
    // types the keys in.
    expect(byKey.get('aws_s3')).toBe(true);
    expect(byKey.get('mega')).toBe(true);
  });
});
