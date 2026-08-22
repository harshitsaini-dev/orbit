import { shareLinks, shareViews } from '@orbit/db';
import { and, eq, gte, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../lib/db.js';

/**
 * How a published link is actually being used.
 *
 * The owner's question is a simple one - is anybody opening this, and are they
 * reading it or saving it - and answering it does not require knowing who they
 * are. Whoever opens a share link is not an Orbit user; they followed something
 * a friend sent them and agreed to nothing. So nothing here identifies them:
 * no address, no user agent, no referrer, no cookie.
 *
 * What that costs is honest to state: **unique visitors cannot be counted.**
 * Ten opens might be ten people or one person refreshing, and the UI says
 * "opens" rather than pretending to know. Counting uniques would mean a cookie
 * or a fingerprint, which is a much larger thing to do to a stranger than the
 * question is worth.
 */

export type ViewKind = 'view' | 'download';
export type Device = 'desktop' | 'mobile' | 'bot';

/** How long a record is kept. Long enough to see a pattern, not a history. */
export const RETENTION_DAYS = 90;

/**
 * Three words out of a user agent, and then the user agent is discarded.
 *
 * Enough to tell "my colleagues opened it on their phones" from "something is
 * crawling it", and useless for anything else - which is the point.
 */
export function classifyDevice(userAgent: string | undefined): Device {
  const ua = (userAgent ?? '').toLowerCase();
  if (!ua) return 'bot';

  // Checked first: plenty of crawlers also say "Mobile" somewhere.
  if (/bot|crawler|spider|preview|scrape|curl|wget|python-requests|headless|facebookexternalhit|slackbot|whatsapp|telegram/.test(ua)) {
    return 'bot';
  }

  if (/android|iphone|ipad|ipod|mobile|windows phone/.test(ua)) return 'mobile';
  return 'desktop';
}

/** Never throws: an analytics failure must not fail the thing being measured. */
export async function recordView(
  shortId: string,
  kind: ViewKind,
  userAgent?: string,
): Promise<void> {
  try {
    await db().insert(shareViews).values({
      id: nanoid(),
      shortId,
      kind,
      device: classifyDevice(userAgent),
      viewedAt: new Date().toISOString(),
    });
  } catch {
    // A link that works and is not counted is better than a link that fails
    // because counting it did.
  }
}

export interface ShareStats {
  /** One entry per day, oldest first, including the days with nothing. */
  daily: Array<{ date: string; views: number; downloads: number }>;
  views: number;
  downloads: number;
  /** How many of the opens came from something that is not a person. */
  bots: number;
  byDevice: Record<Device, number>;
  lastViewedAt: string | null;
}

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * The last `days` days for one link, owned by `userId`.
 *
 * Returns null when the link is not theirs, so a caller cannot learn whether
 * somebody else's link exists by asking about its statistics.
 */
export async function statsFor(
  userId: string,
  shortId: string,
  days = 30,
  now = new Date(),
): Promise<ShareStats | null> {
  const [link] = await db()
    .select({ shortId: shareLinks.shortId })
    .from(shareLinks)
    .where(and(eq(shareLinks.shortId, shortId), eq(shareLinks.ownerId, userId)))
    .limit(1);

  if (!link) return null;

  const since = new Date(now.getTime() - (days - 1) * 86_400_000);
  since.setUTCHours(0, 0, 0, 0);

  const rows = await db()
    .select({ kind: shareViews.kind, device: shareViews.device, viewedAt: shareViews.viewedAt })
    .from(shareViews)
    .where(and(eq(shareViews.shortId, shortId), gte(shareViews.viewedAt, since.toISOString())));

  /*
   * Every day in the window is present, including the empty ones.
   *
   * A chart built only from the days that have data draws a straight line
   * through a fortnight of silence and calls it steady traffic.
   */
  const buckets = new Map<string, { views: number; downloads: number }>();
  for (let i = 0; i < days; i += 1) {
    const date = new Date(since.getTime() + i * 86_400_000).toISOString().slice(0, 10);
    buckets.set(date, { views: 0, downloads: 0 });
  }

  const byDevice: Record<Device, number> = { desktop: 0, mobile: 0, bot: 0 };
  let views = 0;
  let downloads = 0;
  let lastViewedAt: string | null = null;

  for (const row of rows) {
    const bucket = buckets.get(dayOf(row.viewedAt));
    if (bucket) {
      if (row.kind === 'download') bucket.downloads += 1;
      else bucket.views += 1;
    }

    if (row.kind === 'download') downloads += 1;
    else views += 1;

    byDevice[row.device] += 1;
    if (!lastViewedAt || row.viewedAt > lastViewedAt) lastViewedAt = row.viewedAt;
  }

  return {
    daily: [...buckets.entries()].map(([date, counts]) => ({ date, ...counts })),
    views,
    downloads,
    bots: byDevice.bot,
    byDevice,
    lastViewedAt,
  };
}

/**
 * Drops records past the retention window.
 *
 * Kept short deliberately. This is a log of strangers' behaviour, and the
 * useful question - is this link being used - is answered by the last few
 * weeks. Anything older is a record nobody reads and somebody could lose.
 */
export async function pruneOldViews(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000).toISOString();

  const result = await db()
    .delete(shareViews)
    .where(sql`${shareViews.viewedAt} < ${cutoff}`);

  return result.rowsAffected ?? 0;
}
