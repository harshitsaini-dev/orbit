import { expect, test } from '@playwright/test';
import { signIn } from './helpers.js';

/**
 * The E2E stack has no connected account, so these cover the behaviour that
 * does not need one: that the browser's own menu is replaced, that the
 * replacement is positioned and dismissed correctly, and that the window is the
 * drop target rather than one panel.
 */
test.describe('right-click menu', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.goto('/my-drive');
  });

  test('leaves the browser menu alone where Orbit has nothing to offer', async ({ page }) => {
    // Suppressing it everywhere would take away copy and paste on ordinary text
    // for no gain; only rows carry a replacement.
    let prevented = false;
    await page.exposeFunction('reportDefaultPrevented', (value: boolean) => {
      prevented = value;
    });
    await page.evaluate(() => {
      document.addEventListener('contextmenu', (event) => {
        (window as unknown as { reportDefaultPrevented: (v: boolean) => void }).reportDefaultPrevented(
          event.defaultPrevented,
        );
      });
    });

    await page.locator('h1').first().click({ button: 'right' });
    expect(prevented).toBe(false);
  });
});

test.describe('dropping files', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.goto('/my-drive');
  });

  test('a dragged file never navigates the page away', async ({ page }) => {
    // Unhandled, the browser opens the dropped file and abandons the app -
    // losing an upload in progress with it.
    const before = page.url();

    await page.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['x'], 'note.txt', { type: 'text/plain' }));
      window.dispatchEvent(
        Object.assign(new DragEvent('dragover', { bubbles: true, cancelable: true }), {}),
      );
      document.body.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
    });

    await page.waitForTimeout(400);
    expect(page.url()).toBe(before);
  });

  test('shows where the files would land while one is over the window', async ({ page }) => {
    await page.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['x'], 'note.txt', { type: 'text/plain' }));
      window.dispatchEvent(
        new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
    });

    // With no account connected there is nowhere to put them, so the overlay
    // stays away rather than promising an upload it cannot perform.
    await expect(page.locator('.dropzone')).toBeHidden();
  });
});
