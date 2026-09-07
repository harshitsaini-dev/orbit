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
        try {
          const res = await page.request.get(url);
          if (res.status() !== 200) return res.status();
          code = ((await res.json()) as { code: string }).code;
          return 200;
        } catch {
          // A connection reset under parallel load is worth another try, not a
          // failed test - the poll below is what decides when to give up.
          return 0;
        }
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

/** Appearance controls live behind the avatar now, so a test has to open it. */
export async function openAccountMenu(page: Page) {
  await page.getByRole('button', { name: /account menu|Your account/i }).first().click();
  return page.getByRole('menu', { name: 'Account' });
}

/**
 * Goes to a workspace page, whichever navigation this viewport has.
 *
 * A desk gets a sidebar of links; a phone gets the `NavPicker` dropdown, and
 * there is no sidebar behind it. Specs that clicked the link directly passed on
 * desktop and, on the mobile project, waited sixty seconds for an element that
 * was never going to exist - then did it twice more, because CI retries.
 * Twenty-five specs behaved that way, which is over an hour of the E2E job
 * spent proving that a phone has no sidebar.
 *
 * Navigating is a means in almost all of those tests, not the thing under
 * test. This makes it work in both layouts so the coverage is real on both,
 * rather than scoping the specs to desktop and pretending the phone is tested.
 */
export async function goToPage(page: Page, label: string): Promise<void> {
  const link = page.getByRole('link', { name: label, exact: true });

  // The sidebar, when this viewport has one.
  if (await link.isVisible().catch(() => false)) {
    await link.click();
    return;
  }

  await page.getByRole('button', { name: /^Go to another page/ }).click();
  await page.getByRole('menu', { name: 'Pages' }).getByRole('menuitem', { name: label, exact: true }).click();
}
