import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { webhookDeliveries, webhooks } from '@orbit/db';
import { WEBHOOK_EVENT_NAMES, type WebhookEvent } from '@orbit/shared-types';
import { and, desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../lib/db.js';
import { env } from '../lib/env.js';
import { log } from '../lib/log.js';

/**
 * Telling somebody else's program that something happened.
 *
 * The other half of the developer platform. A token lets a program ask Orbit
 * questions; this lets Orbit answer one before it is asked - the difference
 * between a script polling every minute and one that runs when there is work.
 *
 * Two things make this harder than "POST some JSON".
 *
 * The first is that a webhook URL is an address chosen by a user and fetched by
 * the server, which is the definition of a server-side request forgery. Orbit
 * runs somewhere with a metadata service, a database on a private address and
 * a loopback interface that answers to itself, and a URL pointing at any of
 * them would make Orbit fetch it on the user's behalf. `checkTarget` below is
 * the only thing standing between that and a URL field.
 *
 * The second is that the receiver has to be able to tell a real delivery from
 * anyone who guessed the address. Every delivery is signed, and the signature
 * covers a timestamp, so a captured one cannot be replayed a week later.
 */

export interface PublicWebhook {
  id: string;
  name: string;
  url: string;
  events: string[];
  active: boolean;
  failureCount: number;
  lastStatus: number | null;
  lastError: string | null;
  lastDeliveredAt: string | null;
  createdAt: string;
}

/**
 * Consecutive failures before a webhook switches itself off.
 *
 * An endpoint that has refused ten deliveries in a row is not going to accept
 * the eleventh, and continuing to try is a slow denial of service aimed at
 * whoever now owns that address. Any success resets it.
 */
const MAX_FAILURES = 10;

/** Long enough for a cold serverless receiver, short of holding a pass open. */
const TIMEOUT_MS = 10_000;

const ATTEMPTS = 3;
const BACKOFF_MS = [0, 1_000, 4_000];

function toPublic(row: typeof webhooks.$inferSelect): PublicWebhook {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    events: JSON.parse(row.events) as string[],
    active: row.active,
    failureCount: row.failureCount,
    lastStatus: row.lastStatus,
    lastError: row.lastError,
    lastDeliveredAt: row.lastDeliveredAt,
    createdAt: row.createdAt,
  };
}

/**
 * Whether an address is one Orbit is allowed to be pointed at.
 *
 * Everything private is refused: loopback, the link-local range that carries
 * cloud metadata services, and every RFC 1918 network. Checked after resolving
 * the name, because `http://internal.example.com` and `http://127.0.0.1` are
 * the same request once DNS has had its say - and checked against *every*
 * address the name resolves to, because a name that answers with one public
 * and one private address would otherwise pass.
 *
 * This does not close the door completely. A name whose DNS record changes
 * between this check and the request itself would slip through, and closing
 * that means resolving once and connecting to the address rather than the name.
 * That is a fetch this codebase cannot express without a custom agent, and the
 * gap is narrow enough to name rather than to pretend is not there.
 */
function isPrivateAddress(address: string): boolean {
  if (address.includes(':')) {
    const ip = address.toLowerCase();
    // Loopback, unspecified, unique-local and link-local.
    return ip === '::1' || ip === '::' || /^f[cd]/.test(ip) || ip.startsWith('fe80');
  }

  const parts = address.split('.').map(Number);
  const [a = 0, b = 0] = parts;

  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // Carrier-grade NAT, link-local (which is where cloud metadata lives), and
  // the ranges nothing should be routing anyway.
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a >= 224) return true;

  return false;
}

export async function checkTarget(raw: string): Promise<{ ok: true } | { ok: false; why: string }> {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    return { ok: false, why: 'That is not a URL' };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, why: 'Only http and https addresses can be called' };
  }

  /*
   * Plain http allowed on a development machine and refused on a deployed one.
   * A signed payload sent unencrypted is a payload anyone on the path can read,
   * and the signature proves it came from Orbit rather than keeping it private.
   */
  if (url.protocol === 'http:' && env.AUTH_MODE !== 'local') {
    return { ok: false, why: 'The address has to be https' };
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');

  if (isIP(host)) {
    return isPrivateAddress(host)
      ? { ok: false, why: 'That address is on a private network' }
      : { ok: true };
  }

  let addresses: Array<{ address: string }>;

  try {
    addresses = await lookup(host, { all: true });
  } catch {
    return { ok: false, why: 'That host does not resolve' };
  }

  if (addresses.length === 0) return { ok: false, why: 'That host does not resolve' };

  // Every address, not the first: a name answering with one public and one
  // private address would otherwise pass on the strength of the public one.
  if (addresses.some((entry) => isPrivateAddress(entry.address))) {
    return { ok: false, why: 'That host resolves to a private network' };
  }

  return { ok: true };
}

export function sign(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/** For a receiver's own tests, and for the docs to point at something real. */
export function verify(secret: string, timestamp: string, body: string, given: string): boolean {
  const expected = Buffer.from(sign(secret, timestamp, body));
  const offered = Buffer.from(given);

  if (expected.length !== offered.length) return false;
  return timingSafeEqual(expected, offered);
}

export async function listWebhooks(userId: string): Promise<PublicWebhook[]> {
  const rows = await db()
    .select()
    .from(webhooks)
    .where(eq(webhooks.userId, userId))
    .orderBy(desc(webhooks.createdAt));

  return rows.map(toPublic);
}

/**
 * Creates one, and hands back the secret exactly once.
 *
 * Shown on creation and never again - not because it cannot be read back, but
 * because a secret that any page can display is a secret that leaks through a
 * screen share. Somebody who loses it rotates it.
 */
export async function createWebhook(input: {
  userId: string;
  name: string;
  url: string;
  events: string[];
}): Promise<{ webhook: PublicWebhook; secret: string }> {
  const wanted = input.events.filter((event) => WEBHOOK_EVENT_NAMES.includes(event));
  if (wanted.length === 0) throw new Error('no_events');

  const secret = `whsec_${randomBytes(24).toString('base64url')}`;

  const [row] = await db()
    .insert(webhooks)
    .values({
      id: nanoid(),
      userId: input.userId,
      name: input.name,
      url: input.url,
      secret,
      events: JSON.stringify(wanted),
      active: true,
      createdAt: new Date().toISOString(),
    })
    .returning();

  if (!row) throw new Error('Failed to create webhook');
  return { webhook: toPublic(row), secret };
}

export async function rotateSecret(userId: string, id: string): Promise<string | null> {
  const secret = `whsec_${randomBytes(24).toString('base64url')}`;

  const [row] = await db()
    .update(webhooks)
    .set({ secret })
    .where(and(eq(webhooks.id, id), eq(webhooks.userId, userId)))
    .returning();

  return row ? secret : null;
}

export async function setActive(
  userId: string,
  id: string,
  active: boolean,
): Promise<PublicWebhook | null> {
  const [row] = await db()
    .update(webhooks)
    // Turning one back on clears the failures that turned it off, otherwise it
    // would switch itself off again on the first hiccup.
    .set(active ? { active, failureCount: 0, lastError: null } : { active })
    .where(and(eq(webhooks.id, id), eq(webhooks.userId, userId)))
    .returning();

  return row ? toPublic(row) : null;
}

export async function deleteWebhook(userId: string, id: string): Promise<boolean> {
  const rows = await db()
    .delete(webhooks)
    .where(and(eq(webhooks.id, id), eq(webhooks.userId, userId)))
    .returning();

  return rows.length > 0;
}

export interface DeliveryRecord {
  id: string;
  event: string;
  status: number | null;
  error: string | null;
  attempts: number;
  durationMs: number;
  sentAt: string;
}

export async function recentDeliveries(
  userId: string,
  id: string,
  limit = 20,
): Promise<DeliveryRecord[] | null> {
  const [own] = await db()
    .select({ id: webhooks.id })
    .from(webhooks)
    .where(and(eq(webhooks.id, id), eq(webhooks.userId, userId)))
    .limit(1);

  if (!own) return null;

  const rows = await db()
    .select({
      id: webhookDeliveries.id,
      event: webhookDeliveries.event,
      status: webhookDeliveries.status,
      error: webhookDeliveries.error,
      attempts: webhookDeliveries.attempts,
      durationMs: webhookDeliveries.durationMs,
      sentAt: webhookDeliveries.sentAt,
    })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.webhookId, id))
    .orderBy(desc(webhookDeliveries.sentAt))
    .limit(limit);

  return rows;
}

/** How many delivery records to keep per webhook. */
const KEEP_DELIVERIES = 50;

async function record(
  webhookId: string,
  event: string,
  payload: string,
  result: { status: number | null; error: string | null; attempts: number; durationMs: number },
): Promise<void> {
  await db().insert(webhookDeliveries).values({
    id: nanoid(),
    webhookId,
    event,
    payload,
    status: result.status,
    error: result.error,
    attempts: result.attempts,
    durationMs: result.durationMs,
    sentAt: new Date().toISOString(),
  });

  // Trimmed here rather than on a schedule: the list only grows when something
  // is added to it, so that is the moment it is worth checking.
  const rows = await db()
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.webhookId, webhookId))
    .orderBy(desc(webhookDeliveries.sentAt))
    .offset(KEEP_DELIVERIES)
    .limit(200);

  for (const row of rows) {
    await db().delete(webhookDeliveries).where(eq(webhookDeliveries.id, row.id));
  }
}

export interface DeliveryOutcome {
  status: number | null;
  error: string | null;
  attempts: number;
  durationMs: number;
}

/**
 * Sends one delivery, retrying a few times, and writes down what happened.
 *
 * Retries only what a retry could fix. A refused connection or a 500 is worth
 * trying again; a 400 or a 404 is the receiver saying it does not want this,
 * and repeating it three times is noise.
 */
async function deliver(
  row: typeof webhooks.$inferSelect,
  event: string,
  body: string,
): Promise<DeliveryOutcome> {
  const started = Date.now();
  let status: number | null = null;
  let error: string | null = null;
  let attempts = 0;

  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    attempts = attempt + 1;

    if (BACKOFF_MS[attempt]) {
      await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS[attempt]));
    }

    const timestamp = String(Date.now());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(row.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Orbit-Webhook/1',
          'x-orbit-event': event,
          'x-orbit-delivery': nanoid(),
          'x-orbit-timestamp': timestamp,
          'x-orbit-signature': `sha256=${sign(row.secret, timestamp, body)}`,
        },
        body,
        signal: controller.signal,
        // A redirect is an address the SSRF check never saw, so it is refused
        // rather than followed.
        redirect: 'manual',
      });

      status = response.status;
      error = null;

      if (response.ok) break;
      if (response.status < 500 && response.status !== 429) {
        error = `Refused with ${response.status}`;
        break;
      }

      error = `Answered ${response.status}`;
    } catch (err) {
      status = null;
      error = err instanceof Error && err.name === 'AbortError' ? 'Timed out' : 'Could not connect';
    } finally {
      clearTimeout(timer);
    }
  }

  const outcome = { status, error, attempts, durationMs: Date.now() - started };
  await record(row.id, event, body, outcome);

  const delivered = status !== null && status >= 200 && status < 300;

  if (delivered) {
    await db()
      .update(webhooks)
      .set({
        failureCount: 0,
        lastStatus: status,
        lastError: null,
        lastDeliveredAt: new Date().toISOString(),
      })
      .where(eq(webhooks.id, row.id));
  } else {
    const failures = row.failureCount + 1;

    await db()
      .update(webhooks)
      .set({
        failureCount: failures,
        lastStatus: status,
        lastError: error,
        lastDeliveredAt: new Date().toISOString(),
        // Switched off rather than retried for ever. An endpoint dead for a
        // week is not coming back this minute.
        ...(failures >= MAX_FAILURES ? { active: false } : {}),
      })
      .where(eq(webhooks.id, row.id));
  }

  return outcome;
}

/** Sends a made-up event, so somebody can see their receiver work. */
export async function sendTest(userId: string, id: string): Promise<DeliveryOutcome | null> {
  const [row] = await db()
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.id, id), eq(webhooks.userId, userId)))
    .limit(1);

  if (!row) return null;

  const body = JSON.stringify({
    event: 'ping',
    sentAt: new Date().toISOString(),
    data: { message: 'This is a test delivery from Orbit.' },
  });

  return deliver(row, 'ping', body);
}

/**
 * Tells every webhook of this user that wants this event.
 *
 * Never awaited by the thing that caused it, and never able to fail it. An
 * upload that succeeded and then reported an error because somebody's server
 * was down would be Orbit lying about its own work.
 */
export function emit(userId: string, event: WebhookEvent, data: unknown): void {
  void (async () => {
    try {
      const rows = await db()
        .select()
        .from(webhooks)
        .where(and(eq(webhooks.userId, userId), eq(webhooks.active, true)));

      const wanted = rows.filter((row) => (JSON.parse(row.events) as string[]).includes(event));
      if (wanted.length === 0) return;

      const body = JSON.stringify({ event, sentAt: new Date().toISOString(), data });

      for (const row of wanted) {
        await deliver(row, event, body);
      }
    } catch (err) {
      log.error('webhook delivery failed', { event, error: err });
    }
  })();
}
