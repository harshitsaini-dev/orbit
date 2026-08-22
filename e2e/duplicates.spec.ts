import { expect, test, type Page } from '@playwright/test';
import { signIn } from './helpers.js';

/**
 * The duplicates page on a narrow screen.
 *
 * Stubbed at the network: a real report needs two connected drives with the
 * same file in both, and what is being checked here is the layout, not the
 * comparison that produced it.
 */

function copyOn(nickname: string, index: number) {
  return {
    accountId: `acc-${index}`,
    accountNickname: nickname,
    provider: 'google_drive',
    catalogueKey: 'google_drive',
    remoteId: `r-${index}`,
    name: '1759653621497799480627.jpg',
    virtualPath: '/BCA 2nd sem study stuff/Module Assessment/1759653621497799480627.jpg',
    sizeBytes: 2_100_000,
  };
}

const REPORT = {
  scanned: 4213,
  withoutChecksum: 12,
  ignored: 0,
  drives: [
    { accountId: 'acc-0', nickname: 'me@example.com', files: 3200 },
    { accountId: 'acc-1', nickname: 'work.account.long@example.com', files: 1013 },
  ],
  groups: [
    {
      key: 'g1',
      kind: 'identical',
      checksum: 'abc',
      sizeBytes: 2_100_000,
      files: [copyOn('me@example.com', 0), copyOn('work.account.long@example.com', 1)],
      reclaimableBytes: 2_100_000,
    },
  ],
};

async function openReport(page: Page): Promise<void> {
  await signIn(page);
  await page.route('**/api/duplicates**', (route) => route.fulfill({ json: REPORT }));
  await page.goto('/duplicates');
  await expect(page.getByText('IDENTICAL')).toBeVisible();
}

test.describe('duplicates on a phone', () => {
  test.use({ viewport: { width: 393, height: 850 } });

  test('shows the path and the drive, which are what tell copies apart', async ({ page }) => {
    await openReport(page);

    /*
     * Every copy in a set has the same name - that is what makes it a set - so
     * the name identifies nothing and the path is the only thing that does.
     * The path used to be the one that got truncated.
     */
    await expect(page.getByText('…/Module Assessment/1759653621497799480627.jpg').first()).toBeVisible();

    // And which drive each copy is on, which is the whole question when the
    // copies are on two different clouds. This was hidden below 700px.
    await expect(page.getByText('work.account.long@example.com', { exact: false }).last()).toBeVisible();
  });

  test('keeps the set actions on the screen', async ({ page }) => {
    await openReport(page);

    const spares = page.getByRole('button', { name: 'Select spares' });
    const dismiss = page.getByRole('button', { name: 'Not duplicates' });

    await expect(spares).toBeInViewport();
    await expect(dismiss).toBeInViewport();

    // Side by side across the width rather than pushed off the right edge by
    // the margin-left: auto that positions them on a desk.
    const a = (await spares.boundingBox())!;
    const b = (await dismiss.boundingBox())!;
    expect(a.x + a.width).toBeLessThanOrEqual(393);
    expect(b.x + b.width).toBeLessThanOrEqual(393);
    expect(Math.abs(a.y - b.y)).toBeLessThan(4);
  });

  test('does not render a path that does not exist', async ({ page }) => {
    await openReport(page);

    // direction: rtl put the leading slash at the right-hand end, so
    // /a/b/photo.jpg was drawn as "…b/photo.jpg/".
    await expect(page.getByText(/\.jpg\/$/)).toHaveCount(0);
  });
});
