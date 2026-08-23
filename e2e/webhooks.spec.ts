import { expect, test } from '@playwright/test';
import { signIn } from './helpers.js';

/**
 * The webhook screen.
 *
 * The API is covered by unit tests, including the part that matters most - what
 * a webhook is allowed to point at. This covers what somebody sees: that the
 * refusal of a private address arrives as an explanation rather than a stack
 * trace, and that the secret is shown once and then not again.
 */
test.describe('webhooks', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.goto('/developer');
  });

  test('explains why a private address is refused', async ({ page }) => {
    await page.getByRole('button', { name: 'Add a webhook' }).click();

    await page.getByPlaceholder('What is at the other end').fill('My laptop');
    // https, so the check gets past the scheme and on to the address itself -
    // plain http is refused first, and separately, on a deployed instance.
    await page.getByPlaceholder('https://example.com/orbit').fill('https://169.254.169.254/meta');
    await page.getByRole('checkbox', { name: /file\.uploaded/ }).check({ force: true });

    await page.getByRole('button', { name: 'Add it' }).click();

    // The cloud metadata service. Fetched on a user's say-so it hands out the
    // instance's own credentials, which is why this is refused rather than
    // stored and discovered later.
    await expect(page.getByRole('alert')).toContainText(/private/i);
  });

  test('refuses plain http on its own terms', async ({ page }) => {
    await page.getByRole('button', { name: 'Add a webhook' }).click();
    await page.getByPlaceholder('What is at the other end').fill('Insecure');
    await page.getByPlaceholder('https://example.com/orbit').fill('http://203.0.113.10/hook');
    await page.getByRole('checkbox', { name: /file\.uploaded/ }).check({ force: true });
    await page.getByRole('button', { name: 'Add it' }).click();

    // A signed payload sent unencrypted is a payload anyone on the path can
    // read; the signature proves who sent it, not that it stayed private.
    await expect(page.getByRole('alert')).toContainText(/https/i);
  });

  test('shows the secret once, and never in the list', async ({ page }) => {
    await page.getByRole('button', { name: 'Add a webhook' }).click();

    await page.getByPlaceholder('What is at the other end').fill('Public receiver');
    // An address rather than a name, so the check needs no DNS.
    await page.getByPlaceholder('https://example.com/orbit').fill('https://203.0.113.10/hook');
    await page.getByRole('checkbox', { name: /share\.created/ }).check({ force: true });

    await page.getByRole('button', { name: 'Add it' }).click();

    await expect(page.getByText('Copy it now')).toBeVisible();
    const secret = await page.locator('.token-issued').textContent();
    expect(secret).toMatch(/^whsec_/);

    await page.getByRole('button', { name: 'Done' }).click();

    // Listed, but the secret is not: one that any page can display is one that
    // leaks through a screen share.
    await expect(page.getByText('Public receiver')).toBeVisible();
    await expect(page.getByText('share.created')).toBeVisible();
    await expect(page.getByText(secret!)).toHaveCount(0);
  });

  test('says a webhook has never fired rather than leaving it blank', async ({ page }) => {
    await page.getByRole('button', { name: 'Add a webhook' }).click();
    await page.getByPlaceholder('What is at the other end').fill('Quiet one');
    await page.getByPlaceholder('https://example.com/orbit').fill('https://203.0.113.11/hook');
    await page.getByRole('checkbox', { name: /file\.deleted/ }).check({ force: true });
    await page.getByRole('button', { name: 'Add it' }).click();
    await page.getByRole('button', { name: 'Done' }).click();

    await expect(page.getByText('Last delivery never')).toBeVisible();
  });
});
