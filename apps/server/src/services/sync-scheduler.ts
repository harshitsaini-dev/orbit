import cron, { type ScheduledTask } from 'node-cron';
import { env } from '../lib/env.js';
import { refreshExpiringAccounts } from './accounts.js';
import { syncAll } from './sync.js';

export interface Scheduler {
  stop(): void;
  runNow(): Promise<void>;
}

/**
 * The scheduled pass: keep tokens alive, then bring the mirror up to date.
 *
 * The wiring lives here so the process shape - one Node service doing API, WS
 * and cron - is fixed rather than assumed.
 */
async function runSyncPass(): Promise<void> {
  // Keeping tokens alive is the part of a sync pass that matters even before
  // there is a mirror to sync: an account that quietly expires forces the user
  // to reconnect it, which is the single most annoying thing an aggregator can
  // do. A dead grant is also discovered here rather than the moment they need it.
  const result = await refreshExpiringAccounts();
  if (result.refreshed || result.revoked || result.failed) {
    console.log(
      `token sweep: ${result.refreshed} refreshed, ${result.revoked} need reconnecting, ${result.failed} deferred`,
    );
  }

  const synced = await syncAll();
  const failed = synced.filter((account) => account.status === 'error');
  const changed = synced.reduce((sum, account) => sum + account.changed + account.deleted, 0);

  if (synced.length > 0) {
    console.log(
      `sync: ${synced.length} account(s), ${changed} change(s)` +
        (failed.length > 0 ? `, ${failed.length} failed` : ''),
    );
  }
}

export function startSyncScheduler(): Scheduler {
  if (!cron.validate(env.SYNC_CRON)) {
    throw new Error(`SYNC_CRON is not a valid cron expression: ${env.SYNC_CRON}`);
  }

  const task: ScheduledTask = cron.schedule(env.SYNC_CRON, () => {
    void runSyncPass().catch((err: unknown) => {
      console.error('sync pass failed', err instanceof Error ? err.message : err);
    });
  });

  // One pass at boot, so a restart after a long idle period renews immediately
  // rather than waiting for the next tick.
  void runSyncPass().catch((err: unknown) => {
    console.error('initial sync pass failed', err instanceof Error ? err.message : err);
  });

  return {
    stop: () => task.stop(),
    runNow: runSyncPass,
  };
}
