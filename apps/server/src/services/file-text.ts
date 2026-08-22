import { accounts, fileText } from '@orbit/db';
import { and, desc, eq, inArray, like, or, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../lib/db.js';
import { readableAccountIds } from './sharing.js';

/**
 * What was read out of a file, and finding files by it.
 *
 * The reading is done in the browser and posted here; this side only stores it
 * and searches it. Nothing in here talks to a provider.
 *
 * Why it exists: a phone names a photo `1759653621497799480627.jpg`, and every
 * provider's own search looks at names. So a drive full of photographed
 * receipts is a drive where nothing can be found - the one thing on the page
 * that would identify it, the text in the image, is the one thing nobody is
 * indexing.
 */

export interface StoredText {
  accountId: string;
  remoteId: string;
  name: string;
  virtualPath: string;
  text: string;
  confidence: number;
  scannedAt: string;
}

/**
 * Enough to be worth keeping.
 *
 * Below this a reading is either a blank page or noise the engine invented
 * from grain, and storing it means a search that returns a file for a word
 * that was never in it. The cost of being wrong here is asymmetric: a missing
 * result is a search that fails visibly, a wrong result is one that lies.
 */
const MIN_CONFIDENCE = 45;
const MIN_CHARACTERS = 8;

/** Long enough for any receipt, short of storing a book in the database. */
const MAX_CHARACTERS = 20_000;

export function isWorthKeeping(text: string, confidence: number): boolean {
  return text.trim().length >= MIN_CHARACTERS && confidence >= MIN_CONFIDENCE;
}

/**
 * Records a reading, replacing whatever was there for that file.
 *
 * Returns false when the reading was not worth keeping, which the caller shows
 * as "no text found" rather than as a failure - an unreadable photo is an
 * ordinary outcome, not an error.
 */
export async function storeText(input: {
  userId: string;
  accountId: string;
  remoteId: string;
  name: string;
  virtualPath: string;
  text: string;
  confidence: number;
}): Promise<boolean> {
  const readable = await readableAccountIds(input.userId);
  if (!readable.includes(input.accountId)) return false;

  const text = input.text.trim().slice(0, MAX_CHARACTERS);
  if (!isWorthKeeping(text, input.confidence)) {
    // A file that used to read well and now does not should stop claiming the
    // old text: the file changed, and the reading is about the file.
    await forgetOne(input.accountId, input.remoteId);
    return false;
  }

  await db()
    .insert(fileText)
    .values({
      id: nanoid(),
      accountId: input.accountId,
      remoteId: input.remoteId,
      name: input.name,
      virtualPath: input.virtualPath,
      text,
      confidence: input.confidence,
      scannedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: [fileText.accountId, fileText.remoteId],
      set: {
        name: input.name,
        virtualPath: input.virtualPath,
        text,
        confidence: input.confidence,
        scannedAt: new Date().toISOString(),
      },
    });

  return true;
}

export async function forgetOne(accountId: string, remoteId: string): Promise<void> {
  await db()
    .delete(fileText)
    .where(and(eq(fileText.accountId, accountId), eq(fileText.remoteId, remoteId)));
}

/** Which of these files have already been read, so a scan can skip them. */
export async function alreadyScanned(
  userId: string,
  accountId: string,
  remoteIds: string[],
): Promise<string[]> {
  if (remoteIds.length === 0) return [];

  const readable = await readableAccountIds(userId);
  if (!readable.includes(accountId)) return [];

  const rows = await db()
    .select({ remoteId: fileText.remoteId })
    .from(fileText)
    .where(and(eq(fileText.accountId, accountId), inArray(fileText.remoteId, remoteIds)));

  return rows.map((row) => row.remoteId);
}

export interface TextMatch extends StoredText {
  accountNickname: string;
  /** So a result can be drawn with the right badge without a second lookup. */
  provider: string;
  catalogueKey: string | null;
  /** The words around the hit, so a result can show why it matched. */
  excerpt: string;
}

/**
 * Fifteen characters of run-up.
 *
 * A hit shown from its first character reads as a fragment starting mid-word;
 * a hit shown with a whole paragraph around it is not an excerpt. This is the
 * amount that lets somebody recognise a line.
 */
const LEAD = 15;
const EXCERPT = 120;

function excerptAround(text: string, query: string): string {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return text.slice(0, EXCERPT);

  const from = Math.max(0, at - LEAD);
  const cut = text.slice(from, from + EXCERPT).replace(/\s+/g, ' ').trim();

  return `${from > 0 ? '…' : ''}${cut}${from + EXCERPT < text.length ? '…' : ''}`;
}

/**
 * Files whose text contains the query, across every drive the caller may read.
 *
 * `LIKE` rather than a full-text index. The scale this runs at is one person's
 * scanned receipts - hundreds of rows, not millions - and FTS5 would mean a
 * virtual table, triggers to keep it in step, and a migration that cannot be
 * rolled back. If this ever holds enough rows for the difference to be felt,
 * that is the moment to pay for it, and not before.
 */
export async function searchText(
  userId: string,
  query: string,
  limit = 40,
): Promise<TextMatch[]> {
  const term = query.trim();
  if (term.length < 2) return [];

  const readable = await readableAccountIds(userId);
  if (readable.length === 0) return [];

  const pattern = `%${term.replace(/[%_]/g, (char) => `\\${char}`)}%`;

  const rows = await db()
    .select({
      accountId: fileText.accountId,
      remoteId: fileText.remoteId,
      name: fileText.name,
      virtualPath: fileText.virtualPath,
      text: fileText.text,
      confidence: fileText.confidence,
      scannedAt: fileText.scannedAt,
      accountNickname: accounts.nickname,
      provider: accounts.provider,
      catalogueKey: accounts.catalogueKey,
    })
    .from(fileText)
    .innerJoin(accounts, eq(accounts.id, fileText.accountId))
    .where(
      and(
        inArray(fileText.accountId, readable),
        // The name too: somebody who scanned a folder expects to search it as
        // one thing, and being told "that file has no text" about a file
        // called what they searched for is a strange answer.
        or(
          sql`${fileText.text} LIKE ${pattern} ESCAPE '\\'`,
          like(fileText.name, pattern),
        ),
      ),
    )
    .orderBy(desc(fileText.scannedAt))
    .limit(limit);

  return rows.map((row) => ({ ...row, excerpt: excerptAround(row.text, term) }));
}

/** How much has been read, for a page that wants to say so. */
export async function textCoverage(userId: string): Promise<{ files: number; accounts: number }> {
  const readable = await readableAccountIds(userId);
  if (readable.length === 0) return { files: 0, accounts: 0 };

  const rows = await db()
    .select({ accountId: fileText.accountId })
    .from(fileText)
    .where(inArray(fileText.accountId, readable));

  return { files: rows.length, accounts: new Set(rows.map((row) => row.accountId)).size };
}
