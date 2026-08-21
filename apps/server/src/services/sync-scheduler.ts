import cron, { type ScheduledTask } from 'node-cron';
import { env } from '../lib/env.js';
import { refreshExpiringAccounts } from './accounts.js';

export interface Scheduler {
  stop(): void;
  runNow(): Promise<void>;
}

/**
 * Scheduled delta sync. Phase 6 fills runSyncPass() in with the per-account
 * listChangesSince() loop; the schedule wiring lives here so the process shape
 * (one Node service on Render doing API + WS + cron) is fixed from day one.
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

  // TODO(phase-6): for each account -> getAdapter(provider).listChangesSince(cursor),
  // upsert into files_mirror, write a sync_log row, publish a sync:status event.
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
