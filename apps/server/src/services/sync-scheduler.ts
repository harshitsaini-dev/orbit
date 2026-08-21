import cron, { type ScheduledTask } from 'node-cron';
import { env } from '../lib/env.js';

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

  return {
    stop: () => task.stop(),
    runNow: runSyncPass,
  };
}
