import { getAdapter } from '@orbit/adapters';
import { accounts } from '@orbit/db';
import type { FileCategory, SearchQuery } from '@orbit/shared-types';
import { categorise } from '@orbit/shared-types';
import { eq } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { useAccount } from './accounts.js';
import type { ViewResult, WorkspaceFile } from './views.js';

export interface SearchRequest extends SearchQuery {
  /** Restrict to one account; absent means every connected account. */
  accountId?: string;
}

/**
 * Search across accounts.
 *
 * Category is applied here rather than pushed into each provider's query
 * language: the classification is Orbit's own — it reads the extension when the
 * mime type is useless, which no provider's query can do — so applying it
 * centrally is the only way the same filter means the same thing everywhere.
 */
export async function searchWorkspace(
  userId: string,
  request: SearchRequest,
  limit = 200,
): Promise<ViewResult> {
  const rows = await db().select().from(accounts).where(eq(accounts.userId, userId));
  const scoped = request.accountId ? rows.filter((row) => row.id === request.accountId) : rows;

  const result: ViewResult = { files: [], problems: [], unsupported: [] };
  const categories = new Set((request.categories ?? []) as FileCategory[]);

  const settled = await Promise.allSettled(
    scoped.map(async (row) => {
      if (!getAdapter(row.provider).capabilities.search) {
        return { unsupported: true as const };
      }

      const active = await useAccount(userId, row.id);
      if (!active) return { unsupported: false as const, files: [] };

      const page = await active.adapter.search(active.tokens, request);
      return { unsupported: false as const, files: page.files };
    }),
  );

  for (const [index, outcome] of settled.entries()) {
    const row = scoped[index]!;

    if (outcome.status === 'rejected') {
      result.problems.push({
        accountId: row.id,
        nickname: row.nickname,
        reason:
          outcome.reason instanceof Error && outcome.reason.message === 'needs_reauth'
            ? 'needs reconnecting'
            : 'could not be searched',
      });
      continue;
    }

    if (outcome.value.unsupported) {
      result.unsupported.push({ accountId: row.id, nickname: row.nickname });
      continue;
    }

    for (const file of outcome.value.files ?? []) {
      // Folders are matched by name like anything else, but a category filter
      // is about content, so it excludes them.
      if (categories.size > 0) {
        if (file.isFolder) continue;
        if (!categories.has(categorise(file.mimeType, file.name))) continue;
      }

      result.files.push({
        ...file,
        accountId: row.id,
        provider: row.provider,
        accountNickname: row.nickname,
      } satisfies WorkspaceFile);
    }
  }

  result.files.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
  result.files = result.files.slice(0, limit);

  return result;
}
