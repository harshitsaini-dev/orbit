import { expect, test } from '@playwright/test';
import { signIn } from './helpers.js';

/**
 * Recent, starred and shared-with-me. The E2E stack has no connected account,
 * so these cover the empty states and the wiring; the merge itself is covered
 * by the service suite against several stubbed providers.
 */
const VIEWS = [
  { link: 'Recent', path: '/recent', heading: 'Recent', empty: /nothing has changed recently/i },
  { link: 'Starred', path: '/starred', heading: 'Starred', empty: /nothing is starred yet/i },
  { link: 'Shared with me', path: '/shared-with-me', heading: 'Shared with me', empty: /nobody has shared anything/i },
] as const;

test.describe('workspace views', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  for (const view of VIEWS) {
    test(`${view.link} loads and reports its own empty state`, async ({ page }) => {
      await page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: view.link }).click();
      await expect(page).toHaveURL(new RegExp(`${view.path.replace('/', '\/')}$`));

      await expect(page.getByRole('heading', { name: view.heading })).toBeVisible();
      await expect(page.getByText(view.empty)).toBeVisible();

      // No account, so nothing to list - and no error either.
      await expect(page.getByTestId('view-list')).toHaveCount(0);
      await expect(page.getByRole('alert')).toHaveCount(0);
    });
  }

  test('an unknown view is a 404 rather than an empty page', async ({ page }) => {
    const res = await page.request.get('http://localhost:8788/api/views/nonsense');
    expect(res.status()).toBe(404);
  });
});
