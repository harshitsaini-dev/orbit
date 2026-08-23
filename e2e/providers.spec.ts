import { expect, test } from '@playwright/test';
import { signIn } from './helpers.js';

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

    for (const name of DRIVES) {
      await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
    }
  });

  test('the connect screen offers every drive, with its own mark', async ({ page }) => {
    await signIn(page);
    await page.goto('/quota');

    for (const name of DRIVES) {
      await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
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
