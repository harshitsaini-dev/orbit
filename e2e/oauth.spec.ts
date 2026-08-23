import { createHash, randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { signIn } from './helpers.js';
import { E2E_API_URL } from './paths.js';

/**
 * Registering an application, and the screen where somebody allows one.
 *
 * The protocol itself is covered by unit tests, including every check that has
 * been the subject of a real attack. This is about what a person sees: that the
 * consent screen says what is being asked for and where the answer goes, that
 * cancelling sends them back rather than stranding them, and that access can be
 * taken away again from the account page.
 */

const REDIRECT = 'https://app.example.com/callback';

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function registerApp(page: Page, confidential = true): Promise<string> {
  await page.goto('/developer');
  await page.getByRole('button', { name: 'Register an application' }).click();

  await page.getByPlaceholder('Shown on the consent screen').fill('Receipt Filer');
  await page
    .getByPlaceholder('One line, also on the consent screen')
    .fill('Files your receipts into folders by month.');
  // Exact: the webhook form on the same page has a placeholder this is a
  // prefix of, and getByPlaceholder matches on substring by default.
  await page.getByPlaceholder('https://example.com', { exact: true }).fill('https://filer.example.com');
  await page.locator('textarea').fill(REDIRECT);

  await page.getByRole('checkbox', { name: /files:read/ }).check({ force: true });
  await page.getByRole('checkbox', { name: /files:write/ }).check({ force: true });

  if (!confidential) {
    // The label, not the input: the input is visually hidden by the checkbox
    // component, and clicking a label is what a person does anyway.
    await page.getByText('It runs on a server and can keep a secret').click();
  }

  // Exact: "Register an application" is behind the dialog and would match too.
  await page.getByRole('button', { name: 'Register', exact: true }).click();

  // A public client is issued no secret, so there is nothing to copy and no
  // dialog to dismiss.
  if (confidential) await page.getByRole('button', { name: 'Done' }).click();

  const clientId = await page.locator('.webhook__events code').first().textContent();
  return clientId!.trim();
}

test.describe('applications', () => {
  test('registers one and shows its client id', async ({ page }) => {
    await signIn(page);
    const clientId = await registerApp(page);

    expect(clientId).toMatch(/^orbit_app_/);
    await expect(page.getByText('Receipt Filer')).toBeVisible();

    // A secret is shown once and never listed. It is the credential.
    await expect(page.getByText(/^orbit_secret_/)).toHaveCount(0);
  });

  test('the consent screen says what is asked for and where it goes', async ({ page }) => {
    await signIn(page);
    const clientId = await registerApp(page);
    const { challenge } = pkce();

    const query = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      scope: 'files:read files:write',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
    });

    // The API's own origin: /oauth/authorize is the one endpoint a browser is
    // sent to directly, before it is handed on to Orbit's consent screen.
    await page.goto(`${E2E_API_URL}/oauth/authorize?${query}`);

    await expect(page.getByRole('heading', { name: /Allow Receipt Filer/ })).toBeVisible();
    await expect(page.getByText('Files your receipts into folders by month.')).toBeVisible();

    // The permissions in the words the rest of the app uses, not raw scopes
    // alone, and the address the answer will be sent to.
    await expect(page.getByText('List folders and read file details')).toBeVisible();
    await expect(page.getByText('Upload, rename, move, and create folders')).toBeVisible();
    await expect(page.getByText(REDIRECT)).toBeVisible();
  });

  test('cancelling sends the app a refusal rather than nothing', async ({ page }) => {
    await signIn(page);
    const clientId = await registerApp(page);
    const { challenge } = pkce();

    const query = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      scope: 'files:read',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
    });

    // The callback is somebody else's server, so it is intercepted here.
    let landed = '';
    await page.route('https://app.example.com/**', (route) => {
      landed = route.request().url();
      return route.fulfill({ status: 200, contentType: 'text/html', body: 'ok' });
    });

    await page.goto(`${E2E_API_URL}/oauth/authorize?${query}`);
    await page.getByRole('button', { name: 'Cancel' }).click();

    await expect.poll(() => landed).toContain('error=access_denied');
    expect(landed).toContain('state=xyz');
  });

  test('allowing one puts it on the account page, where it can be taken back', async ({
    page,
    request,
  }) => {
    await signIn(page);
    // Public, so the exchange below needs no secret - this test is about what
    // the person sees on their account page, not about client authentication.
    const clientId = await registerApp(page, false);
    const { verifier, challenge } = pkce();

    const query = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      scope: 'files:read',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });

    let landed = '';
    await page.route('https://app.example.com/**', (route) => {
      landed = route.request().url();
      return route.fulfill({ status: 200, contentType: 'text/html', body: 'ok' });
    });

    await page.goto(`${E2E_API_URL}/oauth/authorize?${query}`);
    await page.getByRole('button', { name: /Allow Receipt Filer/ }).click();

    await expect.poll(() => landed).toContain('code=');

    /*
     * Allowing is not the end of it. The grant - and so the entry on the
     * account page - exists once the application has redeemed its code, which
     * is the point at which it actually holds a token. Listing it before then
     * would name access nobody has yet.
     */
    const code = new URL(landed).searchParams.get('code')!;

    const exchanged = await request.post(`${E2E_API_URL}/oauth/token`, {
      form: {
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      },
    });

    expect(exchanged.status()).toBe(200);

    await page.goto('/account');
    await expect(page.getByText('Applications you have allowed')).toBeVisible();
    await expect(page.getByText('Receipt Filer')).toBeVisible();

    await page.getByRole('button', { name: 'Withdraw access' }).click();
    // Exact: "Withdraw access" behind the dialog matches otherwise.
    await page.getByRole('button', { name: 'Withdraw', exact: true }).click();

    await expect(page.getByText('Applications you have allowed')).toBeHidden();
  });
});
