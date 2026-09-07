import { expect, test } from '@playwright/test';
import { goToPage, signIn, uniqueEmail } from './helpers.js';

/**
 * Layout checks that only mean something on a small screen. They run on every
 * project, so a change that breaks the phone view fails even if it was made
 * while looking at a desktop.
 */

/** The page itself must never scroll sideways; wide content scrolls in its own box. */
async function horizontalOverflow(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    return Math.max(0, doc.scrollWidth - doc.clientWidth);
  });
}

test.describe('small-screen layout', () => {
  test('the sign-in screen fits the viewport', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Sign in to Orbit' })).toBeVisible();

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);

    // The one input on the page must be reachable and comfortably tappable.
    const email = page.getByLabel('Email address');
    await expect(email).toBeVisible();
    const box = await email.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(40);
  });

  test('the workspace does not scroll sideways on any view', async ({ page }) => {
    await signIn(page);

    for (const path of ['/', '/my-drive', '/quota', '/starred', '/developer', '/my-drive?account=x&path=/a/b']) {
      await page.goto(path);
      await expect(page.locator('.app-main')).toBeVisible();
      expect(await horizontalOverflow(page), `${path} pushes the page sideways`).toBeLessThanOrEqual(1);
    }
  });

  test('the page does not spend the screen on its own chrome', async ({ page }, testInfo) => {
    /*
     * Everything above the content is paid for on every page, and on a phone
     * there is not much screen to pay with. The header used to stack the brand
     * above the search and the avatar, which cost about fifty pixels of every
     * single view.
     *
     * A ceiling rather than an exact height: this is about the header staying
     * one row, not about a particular font metric.
     */
    await signIn(page);

    const header = await page.locator('.app-header').boundingBox();
    const limit = testInfo.project.name === 'mobile' ? 76 : 96;

    expect(header!.height, `${testInfo.project.name}: the header has stacked`).toBeLessThanOrEqual(
      limit,
    );
  });

  test('every navigation item is reachable', async ({ page }, testInfo) => {
    await signIn(page);

    /*
     * On a phone the navigation is a dropdown, not a strip of links.
     *
     * This test described the strip long after it was replaced, so it failed
     * on the one project it exists for. What matters is unchanged: the last
     * entry has to be reachable, which for a list of sixteen pages in a capped
     * menu means the menu scrolls.
     */
    await goToPage(page, 'Account');
    await expect(page).toHaveURL(/\/account$/);

    // And the navigation must not have widened the page.
    expect(await horizontalOverflow(page), `${testInfo.project.name} nav overflows`).toBeLessThanOrEqual(1);
  });

  test('nav entries are large enough to tap', async ({ page }) => {
    await signIn(page);

    // Whichever navigation this viewport has: sidebar links on a desk, menu
    // items behind the picker on a phone.
    const sidebar = page.getByRole('navigation', { name: 'Workspace' }).getByRole('link');
    let targets = sidebar;

    if ((await sidebar.count()) === 0) {
      await page.getByRole('button', { name: /^Go to another page/ }).click();
      targets = page.getByRole('menu', { name: 'Pages' }).getByRole('menuitem');
    }

    expect(await targets.count()).toBeGreaterThan(0);

    for (const target of await targets.all()) {
      const box = await target.boundingBox();
      // A menu item below the fold of a scrolling list has no box; it is
      // reachable, which is what the test above covers.
      if (!box) continue;
      expect(box.height, `"${await target.innerText()}" is too short to tap`).toBeGreaterThanOrEqual(32);
    }
  });

  test('the account row stays inside its card with a long address', async ({ page }) => {
    // A long email is the realistic way this layout breaks on a phone.
    await signIn(page, uniqueEmail('a-really-quite-long-address-for-layout'));
    await page.goto('/quota');

    await expect(page.getByRole('heading', { name: 'Connected accounts' })).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  });

  test('the hero canvas never exceeds the viewport width', async ({ page }) => {
    // The hero moved to the public pages when the root became a dashboard for
    // signed-in users, so this checks it where it actually renders.
    await page.goto('/login');

    const canvas = page.locator('canvas').first();
    await expect(canvas).toBeVisible();

    const viewport = page.viewportSize()!;
    const box = await canvas.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(viewport.width);
  });
});
