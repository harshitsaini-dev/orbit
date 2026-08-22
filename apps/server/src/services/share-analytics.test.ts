import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

process.env.AUTH_MODE = 'local';
process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
process.env.SESSION_SECRET ??= 'test-session-secret';

const { useTestDatabase } = await import('../test-utils.js');
const { createAccount } = await import('./accounts.js');
const { getLocalUser } = await import('./users.js');
const { classifyDevice, pruneOldViews, recordView, statsFor, RETENTION_DAYS } = await import(
  './share-analytics.js'
);
const { db } = await import('../lib/db.js');
const { shareLinks, shareViews } = await import('@orbit/db');

beforeEach(async () => {
  await useTestDatabase();
});

/** A link to attach views to. Written directly; the route is tested elsewhere. */
async function seedLink(shortId = 'abcdefghijkl') {
  const user = await getLocalUser();
  const account = await createAccount({
    userId: user.id,
    provider: 'google_drive',
    catalogueKey: 'google_drive',
    nickname: 'me@example.com',
    tokens: { accessToken: 'a', refreshToken: 'b', expiresAt: Date.now() + 3_600_000 },
  });

  await db().insert(shareLinks).values({
    shortId,
    ownerId: user.id,
    accountId: account.id,
    remoteId: 'file-1',
    name: 'beach.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 2048,
    permission: 'download',
  });

  return { user, shortId };
}

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

describe('what a view record keeps', () => {
  it('keeps nothing that identifies whoever opened it', async () => {
    /*
     * The rule this feature is built around. Somebody following a share link
     * is not an Orbit user and agreed to nothing; the owner's question - is
     * this being used - does not need to know who they are.
     */
    const { shortId } = await seedLink();
    await recordView(shortId, 'view', `${CHROME} 203.0.113.7`);

    const [row] = await db().select().from(shareViews);
    assert.ok(row);

    const written = JSON.stringify(row);
    assert.equal(written.includes('Mozilla'), false, 'the user agent must not be stored');
    assert.equal(written.includes('203.0.113'), false, 'no address may be stored');
    assert.deepEqual(Object.keys(row).sort(), ['device', 'id', 'kind', 'shortId', 'viewedAt']);
  });

  it('never fails the thing it is measuring', async () => {
    // A link that works and is not counted beats a link that fails because
    // counting it did.
    await assert.doesNotReject(recordView('no-such-link', 'view', CHROME));
  });
});

describe('classifyDevice', () => {
  it('tells a phone from a desktop', () => {
    assert.equal(classifyDevice(IPHONE), 'mobile');
    assert.equal(classifyDevice(CHROME), 'desktop');
  });

  it('recognises the things that are not people', () => {
    // Every one of these opens a link the moment it is pasted into a chat, and
    // counting them as opens tells the owner their link is popular.
    for (const ua of [
      'facebookexternalhit/1.1',
      'WhatsApp/2.24',
      'Slackbot-LinkExpanding 1.0',
      'Mozilla/5.0 (compatible; Googlebot/2.1)',
      'curl/8.4.0',
      'python-requests/2.31',
    ]) {
      assert.equal(classifyDevice(ua), 'bot', `${ua} should be a bot`);
    }
  });

  it('calls a mobile crawler a crawler, not a phone', () => {
    // Plenty of them say "Mobile" as well, so the order of the checks matters.
    assert.equal(
      classifyDevice('Mozilla/5.0 (Linux; Android 13; Mobile) Googlebot/2.1'),
      'bot',
    );
  });

  it('treats a missing user agent as not a person', () => {
    assert.equal(classifyDevice(undefined), 'bot');
    assert.equal(classifyDevice(''), 'bot');
  });
});

describe('statsFor', () => {
  it('separates opening a link from saving the file', async () => {
    const { user, shortId } = await seedLink();

    await recordView(shortId, 'view', CHROME);
    await recordView(shortId, 'view', IPHONE);
    await recordView(shortId, 'download', CHROME);

    const stats = await statsFor(user.id, shortId);

    assert.ok(stats);
    assert.equal(stats.views, 2);
    assert.equal(stats.downloads, 1);
    assert.deepEqual(stats.byDevice, { desktop: 2, mobile: 1, bot: 0 });
  });

  it('counts crawlers separately rather than as readers', async () => {
    const { user, shortId } = await seedLink();

    await recordView(shortId, 'view', CHROME);
    await recordView(shortId, 'view', 'WhatsApp/2.24');

    const stats = await statsFor(user.id, shortId);
    assert.equal(stats!.bots, 1);
  });

  it('includes the days nothing happened', async () => {
    /*
     * A chart built only from the days with data draws a straight line through
     * a fortnight of silence and calls it steady traffic.
     */
    const { user, shortId } = await seedLink();
    await recordView(shortId, 'view', CHROME);

    const stats = await statsFor(user.id, shortId, 30);

    assert.equal(stats!.daily.length, 30);
    assert.equal(
      stats!.daily.filter((day) => day.views === 0 && day.downloads === 0).length,
      29,
    );
    // And the last bucket is today, so the chart reads left to right.
    assert.equal(stats!.daily.at(-1)!.date, new Date().toISOString().slice(0, 10));
  });

  it('reports the last time anybody opened it', async () => {
    const { user, shortId } = await seedLink();
    await recordView(shortId, 'view', CHROME);

    const stats = await statsFor(user.id, shortId);
    assert.ok(stats!.lastViewedAt);
  });

  it('says nothing at all about somebody else\'s link', async () => {
    // Not an empty answer: a different one. An empty chart would confirm that
    // the short id exists.
    const { shortId } = await seedLink();
    assert.equal(await statsFor('someone-else', shortId), null);
  });

  it('leaves out anything older than the window asked for', async () => {
    const { user, shortId } = await seedLink();

    await db().insert(shareViews).values({
      id: 'old',
      shortId,
      kind: 'view',
      device: 'desktop',
      viewedAt: new Date(Date.now() - 40 * 86_400_000).toISOString(),
    });

    const stats = await statsFor(user.id, shortId, 30);
    assert.equal(stats!.views, 0);
  });
});

describe('pruneOldViews', () => {
  it('drops what is past the retention window and keeps the rest', async () => {
    const { shortId } = await seedLink();

    await db()
      .insert(shareViews)
      .values([
        {
          id: 'ancient',
          shortId,
          kind: 'view',
          device: 'desktop',
          viewedAt: new Date(Date.now() - (RETENTION_DAYS + 5) * 86_400_000).toISOString(),
        },
        {
          id: 'recent',
          shortId,
          kind: 'view',
          device: 'desktop',
          viewedAt: new Date().toISOString(),
        },
      ]);

    const dropped = await pruneOldViews();
    const left = await db().select().from(shareViews);

    assert.equal(dropped, 1);
    assert.deepEqual(
      left.map((row) => row.id),
      ['recent'],
    );
  });
});
