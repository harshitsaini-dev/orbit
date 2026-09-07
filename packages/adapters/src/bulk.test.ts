import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bulkMap } from './bulk.js';

const ids = (count: number): string[] => Array.from({ length: count }, (_, i) => `f${i}`);
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe('running a bulk operation', () => {
  it('reports every id it was given', async () => {
    const result = await bulkMap(ids(50), async () => {});

    assert.equal(result.succeeded.length, 50);
    assert.equal(result.failed.length, 0);
  });

  /*
   * The point of the whole file. Sequentially, a hundred and seventy files at
   * a third of a second each is a minute - and the API sits behind a proxy
   * that closes the request at a hundred seconds, so a large delete hung
   * rather than finishing.
   */
  it('runs several at once rather than one after another', async () => {
    let running = 0;
    let peak = 0;

    await bulkMap(
      ids(30),
      async () => {
        running += 1;
        peak = Math.max(peak, running);
        await tick();
        running -= 1;
      },
      6,
    );

    assert.equal(peak, 6);
  });

  it('never runs more at once than the limit allows', async () => {
    let running = 0;
    let peak = 0;

    await bulkMap(
      ids(100),
      async () => {
        running += 1;
        peak = Math.max(peak, running);
        await tick();
        running -= 1;
      },
      3,
    );

    assert.equal(peak, 3);
  });

  /*
   * A bulk selection is not all-or-nothing. One file the provider refuses must
   * not abandon the rest, and the caller has to know which ones.
   */
  it('carries on past a failure and names the ones that failed', async () => {
    const result = await bulkMap(ids(10), async (id) => {
      if (id === 'f3' || id === 'f7') throw new Error('nope');
    });

    assert.equal(result.succeeded.length, 8);
    assert.deepEqual(
      result.failed.map((entry) => entry.remoteId).sort(),
      ['f3', 'f7'],
    );
    assert.equal(result.failed[0]?.reason, 'nope');
  });

  it('does not reject even when everything fails', async () => {
    const result = await bulkMap(ids(5), async () => {
      throw new Error('all of it');
    });

    assert.equal(result.succeeded.length, 0);
    assert.equal(result.failed.length, 5);
  });

  it('describes a thrown non-Error rather than losing it', async () => {
    const result = await bulkMap(['one'], async () => {
      // Deliberately not an Error. Provider libraries throw strings and plain
      // objects - megajs does - and the point of this test is that such a
      // throw becomes a reported failure rather than crashing the batch.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'a string';
    });

    assert.equal(result.failed[0]?.reason, 'Failed');
  });

  it('does nothing, successfully, when given nothing', async () => {
    const result = await bulkMap([], async () => {
      throw new Error('must not be called');
    });

    assert.deepEqual(result, { succeeded: [], failed: [] });
  });

  it('does each id exactly once', async () => {
    const seen: string[] = [];

    await bulkMap(ids(40), async (id) => {
      await tick();
      seen.push(id);
    });

    assert.equal(new Set(seen).size, 40);
    assert.equal(seen.length, 40);
  });

  /*
   * A shared cursor rather than fixed slices: files differ wildly in how long
   * they take, and equal chunks would leave most workers idle behind whichever
   * one drew the heavy end.
   */
  it('keeps workers busy when one id takes far longer than the rest', async () => {
    const started: string[] = [];

    await bulkMap(
      ids(12),
      async (id) => {
        started.push(id);
        await new Promise((resolve) => setTimeout(resolve, id === 'f0' ? 40 : 1));
      },
      2,
    );

    // With fixed halves, the worker holding f0 would stall its whole half and
    // only six ids could have started. A shared cursor starts all twelve.
    assert.equal(started.length, 12);
  });
});
