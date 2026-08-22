import { getAdapter } from '@orbit/adapters';
import { accounts } from '@orbit/db';
import type { FileCategory, SearchQuery } from '@orbit/shared-types';
import { categorise } from '@orbit/shared-types';
import { inArray } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { useAccount } from './accounts.js';
import { readableAccountIds } from './sharing.js';
import type { ViewResult, WorkspaceFile } from './views.js';

export interface SearchRequest extends SearchQuery {
  /** Restrict to one account; absent means every connected account. */
  accountId?: string;
}

export interface SearchResult extends ViewResult {
  /** Opaque; pass it back to continue. Absent when every account is exhausted. */
  nextCursor?: string;
}

/**
 * Where each account had got to. Accounts finish at different points — one may
 * have thousands of matches and another none — so a single page token would
 * either cut the deep account short or re-read the shallow one.
 */
type Cursor = Record<string, string>;

function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Cursor;
  } catch {
    // A malformed cursor restarts the search rather than failing it.
    return null;
  }
}

function encodeCursor(cursor: Cursor): string | undefined {
  const entries = Object.entries(cursor).filter(([, token]) => Boolean(token));
  if (entries.length === 0) return undefined;
  return Buffer.from(JSON.stringify(Object.fromEntries(entries)), 'utf8').toString('base64url');
}

/**
 * Search across accounts.
 *
 * The matching itself happens at the provider, over every file in the account —
 * a hundred thousand of them if that is what is there — not over whatever the
 * browser has loaded. What is paginated is the *results*, so a broad query stays
 * answerable without pulling every match at once.
 *
 * Category is applied here rather than pushed into each provider's query
 * language: the classification reads the file extension when the mime type is
 * useless, which no provider query can express, so applying it centrally is the
 * only way the same filter means the same thing everywhere.
 */
export async function searchWorkspace(
  userId: string,
  request: SearchRequest,
  options: { cursor?: string } = {},
): Promise<SearchResult> {
  // Every drive they may read, not only the ones they connected: a drive
  // shared with somebody is a drive they should be able to find things in.
  const readable = await readableAccountIds(userId);
  const rows = readable.length
    ? await db().select().from(accounts).where(inArray(accounts.id, readable))
    : [];
  const all = request.accountId ? rows.filter((row) => row.id === request.accountId) : rows;

  const cursor = decodeCursor(options.cursor);
  // Continuing: only the accounts that still had pages left are asked again.
  const scoped = cursor ? all.filter((row) => cursor[row.id]) : all;

  const result: SearchResult = { files: [], problems: [], unsupported: [] };
  const categories = new Set((request.categories ?? []) as FileCategory[]);
  const nextCursor: Cursor = {};

  const settled = await Promise.allSettled(
    scoped.map(async (row) => {
      if (!getAdapter(row.provider).capabilities.search) {
        return { unsupported: true as const };
      }

      const active = await useAccount(userId, row.id, 'read');
      if (!active) return { unsupported: false as const, files: [], nextPageToken: undefined };

      const page = await active.adapter.search(active.tokens, request, cursor?.[row.id]);
      return { unsupported: false as const, files: page.files, nextPageToken: page.nextPageToken };
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
      // Only worth mentioning on the first page; a continuation is about the
      // accounts that had more, not the ones that never took part.
      if (!cursor) result.unsupported.push({ accountId: row.id, nickname: row.nickname });
      continue;
    }

    if (outcome.value.nextPageToken) nextCursor[row.id] = outcome.value.nextPageToken;

    for (const file of outcome.value.files ?? []) {
      // Folders match by name like anything else, but a category filter is
      // about content, so it excludes them.
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
  result.nextCursor = encodeCursor(nextCursor);

  return result;
}
