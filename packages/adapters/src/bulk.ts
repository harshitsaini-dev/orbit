import type { BulkResult } from '@orbit/shared-types';

/**
 * Running a bulk operation against a provider without doing it one at a time.
 *
 * Every adapter deleted in a `for` loop, which is one round trip after another
 * for as many files as were selected. At roughly a third of a second each that
 * is a minute for a hundred and seventy files - and the API sits behind a
 * proxy that closes a request after a hundred seconds. So a large delete did
 * not fail slowly, it *hung*: the browser waited on a request that had already
 * been cut, the progress counter never moved off zero, and nothing was
 * reported either way.
 *
 * Concurrency is the fix and also the risk. Too much of it is the fastest way
 * to be rate-limited on exactly the selection sizes where that hurts most, so
 * the limit is deliberately modest and `providerFetch` backs off when a
 * provider says to slow down.
 */

/**
 * Providers are shared infrastructure and every request is authenticated as
 * one user. Six is enough to turn minutes into seconds and small enough that a
 * bulk delete does not read as an attack on somebody's Drive.
 */
export const BULK_CONCURRENCY = 6;

/**
 * Applies `work` to every id, a few at a time, and reports each outcome.
 *
 * Never rejects. A bulk selection is not all-or-nothing: one file the provider
 * refuses must not abandon the rest, and the caller needs to know exactly
 * which ones did not make it rather than being handed a single error.
 */
export async function bulkMap(
  remoteIds: string[],
  work: (remoteId: string) => Promise<void>,
  limit = BULK_CONCURRENCY,
): Promise<BulkResult> {
  const result: BulkResult = { succeeded: [], failed: [] };
  if (remoteIds.length === 0) return result;

  /*
   * A shared cursor rather than fixed slices. Files differ wildly in how long
   * they take - a folder is a subtree, a file is one call - so splitting the
   * list into equal chunks would leave most workers idle behind whichever one
   * drew the heavy end.
   */
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= remoteIds.length) return;

      const remoteId = remoteIds[index]!;
      try {
        await work(remoteId);
        result.succeeded.push(remoteId);
      } catch (err) {
        result.failed.push({
          remoteId,
          reason: err instanceof Error ? err.message : 'Failed',
        });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, remoteIds.length) }, () => worker()),
  );

  return result;
}
