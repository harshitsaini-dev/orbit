import { expect, type Page } from '@playwright/test';

const API = 'http://localhost:8788';

export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}@example.com`;
}

/**
 * Reads the code back from the dev outbox instead of a real mailbox. Polls,
 * because the caller may reach here before the send request has settled.
 */
export async function lastCode(page: Page, email: string): Promise<string> {
  const url = `${API}/auth/dev/last-code?email=${encodeURIComponent(email)}`;
  let code: string | null = null;

  await expect
    .poll(
      async () => {
        const res = await page.request.get(url);
        if (res.status() !== 200) return res.status();
        code = ((await res.json()) as { code: string }).code;
        return 200;
      },
      { message: 'waiting for a code to reach the dev outbox', timeout: 10_000 },
    )
    .toBe(200);

  if (!code) throw new Error(`No code was issued for ${email}`);
  return code;
}

/** Completes the whole OTP flow and lands on the workspace. */
export async function signIn(page: Page, email = uniqueEmail('user')): Promise<string> {
  await page.goto('/login');
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

  await page.getByLabel('6-digit code').fill(await lastCode(page, email));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('current-user')).toHaveText(email);

  return email;
}
