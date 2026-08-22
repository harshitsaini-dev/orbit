import { getAdapter } from '@orbit/adapters';
import { accounts } from '@orbit/db';
import type { OrbitFile, WorkspaceView } from '@orbit/shared-types';
import { inArray } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { useAccount } from './accounts.js';
import { readableAccountIds } from './sharing.js';

/** A file with the account it came from, which is what makes a merged view readable. */
export interface WorkspaceFile extends OrbitFile {
  accountId: string;
  provider: string;
  accountNickname: string;
}

export interface ViewResult {
  files: WorkspaceFile[];
  /** Accounts that could not answer, so a partial result never looks complete. */
  problems: Array<{ accountId: string; nickname: string; reason: string }>;
  /** Accounts whose provider cannot offer this view at all. */
  unsupported: Array<{ accountId: string; nickname: string }>;
}

/** Which capability gates each view. */
function supports(view: WorkspaceView, capabilities: { star: boolean; sharedWithMe: boolean; recentView: boolean }): boolean {
  if (view === 'starred') return capabilities.star;
  if (view === 'shared') return capabilities.sharedWithMe;
  return capabilities.recentView;
}

/**
 * One view across every connected account.
 *
 * This is the aggregation the whole product is for: "recent" should mean recent
 * everywhere, not recent in whichever drive happens to be selected. Accounts are
 * queried in parallel because the slowest one would otherwise set the pace for
 * all of them.
 */
export async function listWorkspaceView(
  userId: string,
  view: WorkspaceView,
  limit = 100,
): Promise<ViewResult> {
  // Every drive they may read, not only the ones they connected: a drive
  // shared with somebody is a drive they should be able to find things in.
  const readable = await readableAccountIds(userId);
  const rows = readable.length
    ? await db().select().from(accounts).where(inArray(accounts.id, readable))
    : [];

  const result: ViewResult = { files: [], problems: [], unsupported: [] };

  const settled = await Promise.allSettled(
    rows.map(async (row) => {
      const capabilities = getAdapter(row.provider).capabilities;
      if (!supports(view, capabilities)) {
        return { row, unsupported: true as const };
      }

      const active = await useAccount(userId, row.id, 'read');
      if (!active) return { row, unsupported: false as const, files: [] };

      const page = await active.adapter.listView(active.tokens, view);
      return { row, unsupported: false as const, files: page.files };
    }),
  );

  for (const [index, outcome] of settled.entries()) {
    const row = rows[index]!;

    if (outcome.status === 'rejected') {
      // One unreachable account must not empty the whole view.
      result.problems.push({
        accountId: row.id,
        nickname: row.nickname,
        reason:
          outcome.reason instanceof Error && outcome.reason.message === 'needs_reauth'
            ? 'needs reconnecting'
            : 'could not be reached',
      });
      continue;
    }

    if (outcome.value.unsupported) {
      result.unsupported.push({ accountId: row.id, nickname: row.nickname });
      continue;
    }

    for (const file of outcome.value.files ?? []) {
      result.files.push({
        ...file,
        accountId: row.id,
        provider: row.provider,
        accountNickname: row.nickname,
      });
    }
  }

  // Merged results need one order, not each provider's. Recent and shared are
  // chronological; starred reads better by name.
  result.files.sort((a, b) =>
    view === 'starred'
      ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      : Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt),
  );

  result.files = result.files.slice(0, limit);
  return result;
}
