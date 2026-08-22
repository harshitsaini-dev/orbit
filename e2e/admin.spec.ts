import { expect, test } from '@playwright/test';
import { signIn, uniqueEmail } from './helpers.js';

const API = 'http://localhost:8788';

/**
 * The door in front of the operator's console.
 *
 * Only the door. The first account ever created on an instance becomes the
 * superadmin, and the E2E database is shared across the whole run - so which
 * spec file happens to run first decides who that is, and a test that assumed
 * it was this one would pass or fail on ordering rather than on behaviour.
 *
 * What the console does once somebody is through the door is covered against a
 * real database in the admin service suite, where an administrator can be made
 * deliberately instead of by accident.
 */
test.describe('admin', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('is not there for an ordinary user, rather than refused', async ({ page }) => {
    /*
     * A second person, deliberately.
     *
     * The `beforeEach` has already signed somebody in, so this one cannot be
     * the first account on the instance however the run is ordered - which is
     * what makes the assertion about behaviour rather than about which spec
     * file happened to go first.
     *
     * 404 rather than 403 throughout: telling somebody "you may not" confirms
     * there is an admin surface to want.
     */
    // The first session has to go first: `signIn` starts at /login, and a page
    // that already has one is sent straight back to the workspace.
    await page.context().clearCookies();
    await signIn(page, uniqueEmail('ordinary'));

    for (const path of ['/api/admin/overview', '/api/admin/users', '/api/admin/activity']) {
      const res = await page.request.get(`${API}${path}`);
      expect(res.status(), path).toBe(404);
    }

    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'That page does not exist' })).toBeVisible();
  });

  test('refuses the changes too, not only the reading', async ({ page }) => {
    // Whether or not this session is the administrator, neither of these may
    // succeed: one names a user that does not exist, and an ordinary user is
    // not there at all.
    const patched = await page.request.patch(`${API}/api/admin/users/nobody-at-all`, {
      data: { role: 'superadmin' },
    });
    expect([404]).toContain(patched.status());

    const deleted = await page.request.delete(`${API}/api/admin/users/nobody-at-all`);
    expect([404]).toContain(deleted.status());
  });

  test('signed out, it is still not there', async ({ page }) => {
    await page.context().clearCookies();

    const res = await page.request.get(`${API}/api/admin/overview`);
    expect([401, 404]).toContain(res.status());
  });
});
