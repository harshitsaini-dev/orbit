import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pageNumbersFor } from './Pagination.js';

describe('pageNumbersFor', () => {
  it('lists every page when there are few enough to show', () => {
    assert.deepEqual(pageNumbersFor(1, 5), [1, 2, 3, 4, 5]);
    assert.deepEqual(pageNumbersFor(4, 7), [1, 2, 3, 4, 5, 6, 7]);
  });

  it('windows around the current page, keeping the ends reachable', () => {
    // A folder of forty thousand files is forty pages, and a row of forty
    // buttons is not navigation.
    assert.deepEqual(pageNumbersFor(20, 40), [1, 'gap', 18, 19, 20, 21, 22, 'gap', 40]);
  });

  it('does not hide a single page behind an ellipsis', () => {
    // A gap of exactly one is worse than the number it would hide.
    const pages = pageNumbersFor(4, 10);
    assert.deepEqual(pages, [1, 2, 3, 4, 5, 6, 'gap', 10]);
  });

  it('keeps the first and last page in every window', () => {
    for (const current of [1, 5, 25, 50]) {
      const pages = pageNumbersFor(current, 50);
      assert.equal(pages[0], 1);
      assert.equal(pages.at(-1), 50);
      assert.ok(pages.includes(current));
    }
  });

  it('handles a single page', () => {
    assert.deepEqual(pageNumbersFor(1, 1), [1]);
  });
});
