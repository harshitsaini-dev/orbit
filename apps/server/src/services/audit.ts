import { auditLog, users } from '@orbit/db';
import { and, desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../lib/db.js';

/**
 * Who did what, on which drive.
 *
 * Written now that a drive can have more than one person on it. Before that the
 * answer to "who deleted this" was always "you", and a log saying so would have
 * been noise; with guests it is a real question and there is nowhere else to
 * ask it.
 *
 * Only actions that cannot be undone by looking at the result are recorded: a
 * deletion, a move, a link published to the open internet, somebody's access
 * changed. Reading a file is not - it would be most of the rows and none of the
 * answers, and it would turn a short useful list into a surveillance log of
 * everything a colleague opened.
 */

export type AuditAction =
  | 'file.delete'
  | 'file.relocate'
  | 'file.rename'
  | 'file.upload'
  | 'share.create'
  | 'share.revoke'
  | 'member.invite'
  | 'member.level'
  | 'member.revoke'
  | 'account.connect'
  | 'account.disconnect';

export interface RecordInput {
  actorId: string;
  actorEmail?: string | undefined;
  action: AuditAction;
  accountId?: string | undefined;
  targetType?: string | undefined;
  targetId?: string | undefined;
  /** A short sentence a person can read. Never a token, a code, or a password. */
  summary?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  ip?: string | undefined;
}

/**
 * Records one entry. Never throws.
 *
 * A failure to write the log must not fail the thing being logged: somebody
 * deleting a file should not be told the delete failed because a row could not
 * be inserted, and the delete has already happened by then anyway.
 */
export async function record(input: RecordInput): Promise<void> {
  try {
    await db()
      .insert(auditLog)
      .values({
        id: nanoid(),
        actorId: input.actorId,
        actorEmail: input.actorEmail ?? null,
        action: input.action,
        accountId: input.accountId ?? null,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        // Truncated rather than refused: a hundred file names in one delete is
        // a long sentence, not a reason to lose the entry.
        summary: input.summary?.slice(0, 500) ?? null,
        metadata: input.metadata ? JSON.stringify(input.metadata).slice(0, 2000) : null,
        ip: input.ip ?? null,
      });
  } catch {
    // Deliberately silent. There is nothing useful to do about it here, and
    // the alternative is a failed action with a confusing reason.
  }
}

export interface AuditEntry {
  id: string;
  action: AuditAction;
  actorEmail: string | null;
  /** Null once the person has been removed; the entry still says what happened. */
  actorId: string | null;
  targetType: string | null;
  summary: string | null;
  createdAt: string;
}

/** Enough to answer "what has been done to this drive lately". */
const PAGE = 100;

export async function listForAccount(accountId: string, limit = PAGE): Promise<AuditEntry[]> {
  const rows = await db()
    .select({
      id: auditLog.id,
      action: auditLog.action,
      actorId: auditLog.actorId,
      actorEmail: auditLog.actorEmail,
      currentEmail: users.email,
      targetType: auditLog.targetType,
      summary: auditLog.summary,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    // Left, not inner: an entry whose actor has been deleted is exactly the one
    // worth keeping, and an inner join would drop it.
    .leftJoin(users, eq(users.id, auditLog.actorId))
    .where(eq(auditLog.accountId, accountId))
    .orderBy(desc(auditLog.createdAt))
    .limit(Math.min(limit, PAGE));

  return rows.map((row) => ({
    id: row.id,
    action: row.action as AuditAction,
    actorId: row.actorId,
    // The current address wins: somebody who changed theirs should read as one
    // person throughout, not as two.
    actorEmail: row.currentEmail ?? row.actorEmail,
    targetType: row.targetType,
    summary: row.summary,
    createdAt: row.createdAt,
  }));
}

/** Everything one person did, across every drive. For their own account page. */
export async function listForActor(actorId: string, limit = PAGE): Promise<AuditEntry[]> {
  const rows = await db()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.actorId, actorId)))
    .orderBy(desc(auditLog.createdAt))
    .limit(Math.min(limit, PAGE));

  return rows.map((row) => ({
    id: row.id,
    action: row.action as AuditAction,
    actorId: row.actorId,
    actorEmail: row.actorEmail,
    targetType: row.targetType,
    summary: row.summary,
    createdAt: row.createdAt,
  }));
}
