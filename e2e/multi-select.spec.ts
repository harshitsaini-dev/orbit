import { expect, test, type Page } from '@playwright/test';
import { signIn } from './helpers.js';

/**
 * Right-clicking a selection.
 *
 * The E2E stack connects nothing, so the drive is stubbed at the network: a
 * real account would mean real provider credentials, and what is being checked
 * here is the menu's arithmetic, not any provider's behaviour.
 *
 * The rule under test is the one every file manager follows and the one that
 * loses people's work when it is missing - a menu opened on something that is
 * part of a selection acts on the whole selection, not on the one row the
 * pointer happened to be over.
 */

const ACCOUNT = {
  id: 'acc-stub',
  provider: 'google_drive',
  catalogueKey: 'google_drive',
  nickname: 'stub@example.com',
  usedBytes: 1_000,
  quotaBytes: 1_000_000,
  priorityOrder: 0,
  weight: 1,
  status: 'ok',
  lastSyncedAt: null,
  lastRefreshedAt: null,
  connectedAt: new Date().toISOString(),
  isOwner: true,
  accessLevel: 'admin',
};

const CAPABILITIES = {
  star: true,
  sharedWithMe: true,
  delta: true,
  resumableUpload: true,
  rangeRequests: true,
  nativeFolders: true,
  trash: true,
  purgeTrash: false,
  relocate: true,
  reportsQuota: true,
  flatEnumeration: true,
  recentView: true,
  thumbnails: true,
  search: true,
  fullTextSearch: false,
};

function file(name: string, index: number) {
  return {
    remoteId: `id-${index}`,
    name,
    virtualPath: `/${name}`,
    mimeType: 'text/plain',
    sizeBytes: 1_024 * (index + 1),
    isFolder: false,
    starred: false,
    modifiedAt: new Date(Date.UTC(2026, 7, 20 - index)).toISOString(),
  };
}

const FILES = [file('alpha.txt', 0), file('beta.txt', 1), file('gamma.txt', 2)];

async function stubDrive(page: Page): Promise<void> {
  await page.route('**/api/accounts', (route) =>
    route.fulfill({ json: { accounts: [ACCOUNT] } }),
  );

  await page.route('**/api/files?**', (route) =>
    route.fulfill({
      json: {
        accountId: ACCOUNT.id,
        provider: 'google_drive',
        path: '/',
        files: FILES,
        capabilities: CAPABILITIES,
      },
    }),
  );
}

test.describe('right-clicking a selection', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await stubDrive(page);
    await page.goto('/my-drive');
    await expect(page.getByText('alpha.txt')).toBeVisible();
  });

  test('offers every action for the whole selection, not just the row clicked', async ({
    page,
  }) => {
    const alpha = page.getByText('alpha.txt').first();
    const beta = page.getByText('beta.txt').first();

    // Ctrl and shift, not a plain click: a plain click opens the file, which
    // is the behaviour the selection modifiers exist to get out of the way of.
    await alpha.click({ modifiers: ['Control'] });
    await beta.click({ modifiers: ['Shift'] });

    await beta.click({ button: 'right' });

    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();

    // Counted, so a menu that quietly forgot the other file would fail here
    // rather than looking right.
    await expect(menu.getByText('Download 2 files')).toBeVisible();
    await expect(menu.getByText('Share 2 links')).toBeVisible();
    await expect(menu.getByText('Copy 2 to another cloud')).toBeVisible();
    await expect(menu.getByText('Move 2 to another cloud')).toBeVisible();
    await expect(menu.getByText('Copy to folder… (2)')).toBeVisible();
    await expect(menu.getByText('Move to folder… (2)')).toBeVisible();
    await expect(menu.getByText('Add to collection (2)')).toBeVisible();
    await expect(menu.getByText('Add star (2)')).toBeVisible();
    await expect(menu.getByText('Move to bin (2)')).toBeVisible();
  });

  test('acts on one file when the click lands outside the selection', async ({ page }) => {
    await page.getByText('alpha.txt').first().click({ modifiers: ['Control'] });
    await page.getByText('gamma.txt').first().click({ button: 'right' });

    const menu = page.getByRole('menu');
    await expect(menu.getByText('Download', { exact: true })).toBeVisible();
    await expect(menu.getByText('Download 2 files')).toBeHidden();
  });

  test('keeps the singular actions singular', async ({ page }) => {
    const alpha = page.getByText('alpha.txt').first();

    await alpha.click({ modifiers: ['Control'] });
    await page.getByText('beta.txt').first().click({ modifiers: ['Shift'] });
    await alpha.click({ button: 'right' });

    // One new name cannot be twenty new names, so these are shown greyed
    // rather than hidden: an action that vanishes reads as a bug.
    await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeDisabled();
    await expect(page.getByRole('menuitem', { name: 'Details' })).toBeDisabled();
  });
});
