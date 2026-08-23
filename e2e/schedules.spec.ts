import { expect, test } from '@playwright/test';
import { signIn } from './helpers.js';

const API = 'http://localhost:8788';

/**
 * Scheduled jobs.
 *
 * The E2E stack has no connected drive, and a schedule has to name one — so
 * what is reachable here is the page, its empty state, and the fact that it
 * refuses to offer a job it could not create. Creating and running one is
 * covered against a stubbed provider in the route suite.
 */
test.describe('schedules', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('reachable from the sidebar, and says what it is for', async ({ page }) => {
    await page
      .getByRole('navigation', { name: 'Workspace' })
      .getByRole('link', { name: 'Schedules' })
      .click();

    await expect(page).toHaveURL(/\/schedules$/);
    await expect(page.getByRole('heading', { name: 'Schedules', level: 1 })).toBeVisible();

    // The one thing that will otherwise be discovered by a job firing at the
    // wrong time.
    await expect(page.getByText(/late rather than not at all/i)).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('offers nothing to create while there is no drive to point at', async ({ page }) => {
    await page.goto('/schedules');

    await expect(page.getByText(/Nothing scheduled/i)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'New schedule' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create' })).toBeDisabled();
  });

  test('the form asks for a preset and a time, never a cron expression', async ({ page }) => {
    await page.goto('/schedules');

    /*
     * The app's own control rather than a native <select>, which a browser
     * draws from the operating system's palette and which therefore ignores
     * the theme entirely.
     */
    const often = page.getByRole('button', { name: 'How often' });
    await expect(often).toBeVisible();

    await often.click();
    await expect(page.getByRole('listbox', { name: 'How often' })).toBeVisible();
    await expect(page.getByRole('option')).toHaveText([
      'Every hour',
      'Every day',
      'Every week',
      'Every month',
    ]);

    // Weekly reveals a day; hourly hides the hour, which would mean nothing.
    await page.getByRole('option', { name: 'Every week' }).click();
    await expect(page.getByRole('button', { name: 'Day', exact: true })).toBeVisible();

    /*
     * Reopened from the keyboard, which is where focus already is - choosing
     * an option returns it to the trigger. It also covers the path a keyboard
     * user takes, which a second mouse click would not.
     */
    await often.press('Enter');
    await expect(page.getByRole('listbox', { name: 'How often' })).toBeVisible();
    await page.getByRole('option', { name: 'Every hour' }).click();
    await expect(page.getByRole('spinbutton', { name: 'Hour' })).toHaveCount(0);
    await expect(page.getByRole('spinbutton', { name: 'Minute' })).toBeVisible();
  });

  test('the API refuses a time that is not on the clock', async ({ page }) => {
    const res = await page.request.post(`${API}/api/schedules`, {
      data: { name: 'Bad', action: 'sync', accountId: 'anything', every: 'daily', hour: 25 },
    });
    expect(res.status()).toBe(400);
  });

  test('a schedule on somebody else\'s drive does not exist', async ({ page }) => {
    const res = await page.request.post(`${API}/api/schedules`, {
      data: { name: 'Sneaky', action: 'sync', accountId: 'not-mine', every: 'daily' },
    });
    expect(res.status()).toBe(404);
  });

  test('signed out, there are no schedules to read', async ({ page }) => {
    await page.context().clearCookies();
    const res = await page.request.get(`${API}/api/schedules`);
    expect(res.status()).toBe(401);
  });
});
