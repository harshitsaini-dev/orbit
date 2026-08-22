import { expect, test } from '@playwright/test';
import { signIn, uniqueEmail } from './helpers.js';

const API = 'http://localhost:8788';

/**
 * Giving somebody else access to a drive.
 *
 * The E2E stack has no connected drive, so the panel itself has nothing to
 * attach to — what this covers is the boundary, which is the part that matters
 * and the part a UI test can reach without one: a drive that is not yours is
 * answered exactly as one that does not exist, and a second person signing in
 * gets their own session rather than yours.
 *
 * Levels and what each permits are covered in the sharing and members suites.
 */
test.describe('sharing a drive', () => {
  test('a drive that is not yours is indistinguishable from one that is not there', async ({
    page,
  }) => {
    await signIn(page);

    const real = await page.request.get(`${API}/api/accounts/not-mine/members`);
    const madeUp = await page.request.get(`${API}/api/accounts/also-not-real/members`);

    expect(real.status()).toBe(404);
    expect(madeUp.status()).toBe(404);
    // Identical, so an id cannot be probed for existence.
    expect(await real.json()).toEqual(await madeUp.json());
  });

  test('managing people needs a session', async ({ page }) => {
    await signIn(page);
    await page.context().clearCookies();

    const res = await page.request.get(`${API}/api/accounts/anything/members`);
    expect(res.status()).toBe(401);
  });

  test('an invited address is refused a level Orbit does not have', async ({ page }) => {
    await signIn(page);

    const res = await page.request.post(`${API}/api/accounts/anything/members`, {
      data: { email: uniqueEmail('guest'), level: 'superuser' },
    });
    expect(res.status()).toBe(400);
  });

  test('two people signing in get their own sessions, not a shared one', async ({ browser }) => {
    // The whole premise of the model: a member is a person with their own
    // address and their own code, not a second seat on somebody's login.
    const first = await browser.newContext();
    const second = await browser.newContext();

    try {
      const alice = await signIn(await first.newPage());
      const bob = await signIn(await second.newPage());

      expect(alice).not.toBe(bob);

      const alicePage = first.pages()[0]!;
      const bobPage = second.pages()[0]!;

      await expect(alicePage.getByTestId('current-user')).toHaveText(alice);
      await expect(bobPage.getByTestId('current-user')).toHaveText(bob);

      // And neither sees the other's drives - both lists are empty here, but
      // they are separately empty.
      for (const [page, who] of [
        [alicePage, alice],
        [bobPage, bob],
      ] as const) {
        const res = await page.request.get(`${API}/api/accounts`);
        expect(res.status(), `${who} can list their own accounts`).toBe(200);
        expect((await res.json()).accounts).toEqual([]);
      }
    } finally {
      await first.close();
      await second.close();
    }
  });
});
