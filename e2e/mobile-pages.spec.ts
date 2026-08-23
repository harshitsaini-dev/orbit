import { expect, test, type Page } from '@playwright/test';
import { signIn } from './helpers.js';

/**
 * The pages nobody had looked at on a phone.
 *
 * Two things this locks down. Nothing may overflow the width — a page that
 * scrolls sideways hides whatever is past the edge with nothing to say so. And
 * no dropdown may be a native `<select>`: a browser draws its own from the
 * operating system's palette and ignores the theme entirely, so on a dark page
 * one opens as a white list with a blue highlight, which reads as a piece of
 * another application sitting on top.
 */

const PAGES = [
  ['/collections', 'Collections'],
  ['/links', 'Links'],
  ['/schedules', 'Schedules'],
  ['/uploads', 'Uploads'],
  ['/quota', 'Connect an account'],
  ['/duplicates', 'Duplicates'],
] as const;

async function stub(page: Page): Promise<void> {
  await page.route('**/api/transfers', (route) =>
    route.fulfill({
      json: {
        transfers: [
          {
            id: 't1',
            name: 'holiday-video-final-cut.mp4',
            sizeBytes: 2_100_000_000,
            transferredBytes: 840_000_000,
            state: 'running',
            error: null,
            deleteSource: false,
          },
        ],
      },
    }),
  );
}

test.describe('every page on a phone', () => {
  test.use({ viewport: { width: 393, height: 850 } });

  for (const [path, heading] of PAGES) {
    test(`${heading} fits the screen`, async ({ page }) => {
      await signIn(page);
      await stub(page);
      await page.goto(path);

      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();

      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1,
      );
      expect(overflows).toBe(false);
    });
  }

  test('no page draws a native dropdown', async ({ page }) => {
    await signIn(page);
    await stub(page);

    for (const [path] of PAGES) {
      await page.goto(path);
      await expect(page.locator('select')).toHaveCount(0);
    }
  });

  test('Uploads draws no empty panel beside a running transfer', async ({ page }) => {
    await signIn(page);
    await stub(page);
    await page.goto('/uploads');

    // A transfer between clouds has its own section. The uploads list below it
    // was sharing a condition with it, so a session with a transfer and no
    // uploads drew an empty card - which reads as something that failed to
    // load rather than as a section with nothing in it.
    await expect(page.getByText('Between clouds')).toBeVisible();

    /*
     * One list, not two.
     *
     * Both sections draw a `.upload-list` - the transfers above, this
     * session's uploads below. They were sharing a condition, so a session
     * with a transfer running and nothing uploaded rendered the second one
     * empty: a card with nothing in it, which reads as something that failed
     * to load rather than as a section with nothing to show.
     */
    await expect(page.locator('.upload-list')).toHaveCount(1);
    await expect(page.locator('.upload-list li')).toHaveCount(1);
  });
});
