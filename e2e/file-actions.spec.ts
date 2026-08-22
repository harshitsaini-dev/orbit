import { expect, test } from '@playwright/test';
import { signIn } from './helpers.js';

const API = 'http://localhost:8788';

/**
 * The actions on one file, and the boundaries behind them.
 *
 * The E2E stack has no connected drive, so what a browser can reach here is the
 * page and the refusals. Moving and copying against a real provider is covered
 * in the adapter suites, which is where the four different shapes of the
 * operation actually live.
 */
test.describe('moving and copying', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('relocating needs a destination, and a drive that is yours', async ({ page }) => {
    // The two ways to get it wrong, answered differently: one is a malformed
    // request, the other is a drive that - as far as this caller is concerned -
    // does not exist.
    const noDestination = await page.request.post(`${API}/api/files/whatever/relocate`, {
      data: { accountId: 'anything' },
    });
    expect(noDestination.status()).toBe(400);

    const notMine = await page.request.post(`${API}/api/files/whatever/relocate`, {
      data: { accountId: 'not-mine', targetPath: '/somewhere' },
    });
    expect(notMine.status()).toBe(404);
  });

  test('defaults to copying, the option that leaves the original alone', async ({ page }) => {
    // Omitting `copy` must never be read as "move". The account is refused
    // either way here; what is being checked is that the body parses at all
    // without it, so the default is a real default rather than a required field
    // in disguise.
    const res = await page.request.post(`${API}/api/files/whatever/relocate`, {
      data: { accountId: 'not-mine', targetPath: '/somewhere' },
    });

    expect(res.status()).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
  });

  test('signed out, nothing can be relocated', async ({ page }) => {
    await page.context().clearCookies();

    const res = await page.request.post(`${API}/api/files/whatever/relocate`, {
      data: { accountId: 'anything', targetPath: '/' },
    });
    expect(res.status()).toBe(401);
  });
});

test.describe('where uploads go', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('offers asking as well as the rules', async ({ page }) => {
    await page.goto('/account');

    const ask = page.getByRole('radio', { name: 'Ask me every time' });
    await expect(ask).toBeVisible();
    await expect(page.getByText(/cannot put a file in the wrong cloud/i)).toBeVisible();
  });

  test('asking makes the server decline to pick, rather than reporting no room', async ({
    page,
  }) => {
    // A question to put and a problem to report must not arrive looking the
    // same: the client shows a picker for one and an error for the other.
    await page.request.put(`${API}/api/allocation`, { data: { strategy: 'ask' } });

    const res = await page.request.post(`${API}/api/uploads`, {
      data: { name: 'photo.jpg', sizeBytes: 1024, mimeType: 'image/jpeg' },
    });

    expect(res.status()).toBe(409);
    expect((await res.json()).error.code).toBe('choose_account');
  });

  test('any other strategy still reports having nowhere to put it', async ({ page }) => {
    // No drive is connected in this stack, so there genuinely is no room - and
    // that is a different answer from being asked to choose.
    await page.request.put(`${API}/api/allocation`, { data: { strategy: 'round_robin' } });

    const res = await page.request.post(`${API}/api/uploads`, {
      data: { name: 'photo.jpg', sizeBytes: 1024, mimeType: 'image/jpeg' },
    });

    expect(res.status()).toBe(507);
    expect((await res.json()).error.code).toBe('no_room');
  });
});

test.describe('shared drives', () => {
  test('has a page of its own, and explains what it is not', async ({ page }) => {
    await signIn(page);

    await page
      .getByRole('navigation', { name: 'Workspace' })
      .getByRole('link', { name: 'Shared drives' })
      .click();

    await expect(page).toHaveURL(/\/shared-drives$/);
    await expect(page.getByRole('heading', { name: 'Shared drives' })).toBeVisible();

    // The thing people actually trip over.
    await expect(page.getByText(/not part of your own storage/i)).toBeVisible();
    await expect(page.getByText(/does not make you a member/i)).toBeVisible();
  });
});
