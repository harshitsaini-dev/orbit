import { Readable } from 'node:stream';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import express, { Router } from 'express';
import QRCode from 'qrcode';
import { z } from 'zod';
import { env } from '../lib/env.js';
import { shareBundle, SHARE_ASSET_DIR, SHARE_ASSET_PATH } from '../lib/share-bundle.js';
import { record } from '../services/audit.js';
import { requireAuth } from '../middleware/auth.js';
import { useAccount } from '../services/accounts.js';
import {
  createShare,
  findShare,
  listShares,
  lookupShare,
  recordAccess,
  resolveShareTarget,
  revokeShare,
  type PublicShare,
} from '../services/shares.js';
import { parseRange } from './files.js';
import { sharePage } from './share-page.js';

export const sharesRouter: Router = Router();

// --- the owner's side -----------------------------------------------------

const createSchema = z.object({
  accountId: z.string().min(1),
  remoteId: z.string().min(1),
  permission: z.enum(['view', 'download']).optional(),
  password: z.string().min(1).max(200).optional(),
  expiresInDays: z.number().int().positive().max(365).optional(),
});

function shareUrl(shortId: string): string {
  // The API's own origin, not the app's: the page is served here, so that the
  // bytes and the page come from one place and no provider URL is involved.
  return `${env.API_URL}/s/${shortId}`;
}

function withUrl(share: PublicShare): PublicShare & { url: string } {
  return { ...share, url: shareUrl(share.shortId) };
}

sharesRouter.post('/api/shares', requireAuth, async (req, res, next) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'Malformed share' } });
    return;
  }

  try {
    const share = await createShare({ userId: req.user!.id, ...parsed.data });
    if (!share) {
      res.status(404).json({ error: { code: 'not_found', message: 'No such account' } });
      return;
    }

    /*
     * The short id, never the password.
     *
     * A link put on the open internet is the least undoable thing this app
     * does, so it is worth a row - but the row must not become the place a
     * password was written down.
     */
    await record({
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: 'share.create',
      accountId: parsed.data.accountId,
      targetType: 'share',
      targetId: share.shortId,
      summary: `Published a ${share.permission === 'download' ? 'downloadable' : 'view-only'} link`,
      ip: req.ip,
    });

    res.status(201).json({ share: withUrl(share) });
  } catch (err) {
    next(err);
  }
});

sharesRouter.get('/api/shares', requireAuth, async (req, res, next) => {
  try {
    const all = await listShares(req.user!.id);

    // Optional narrowing to one file. The share dialog needs "is this file
    // already shared", and matching on the name instead would show the wrong
    // link for two files that happen to share a name in different folders.
    const accountId = typeof req.query.accountId === 'string' ? req.query.accountId : null;
    const remoteId = typeof req.query.remoteId === 'string' ? req.query.remoteId : null;

    // Narrowed here rather than by returning the provider's id and letting the
    // caller match: that id is exactly what the proxy exists to keep off the
    // client.
    const narrowed = accountId && remoteId ? await findShare(req.user!.id, accountId, remoteId) : null;
    const shares = accountId && remoteId ? (narrowed ? [narrowed] : []) : all;

    res.json({ shares: shares.map(withUrl) });
  } catch (err) {
    next(err);
  }
});

sharesRouter.delete('/api/shares/:shortId', requireAuth, async (req, res, next) => {
  try {
    const revoked = await revokeShare(req.user!.id, req.params.shortId ?? '');
    if (!revoked) {
      res.status(404).json({ error: { code: 'not_found', message: 'No such link' } });
      return;
    }

    await record({
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: 'share.revoke',
      accountId: revoked.accountId,
      targetType: 'share',
      targetId: req.params.shortId ?? '',
      summary: 'Revoked a public link',
      ip: req.ip,
    });

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// --- the visitor's side ---------------------------------------------------

/**
 * Proof that a password was entered, so the page and the bytes it references do
 * not each demand it.
 *
 * An HMAC of the id rather than the password itself: the cookie travels with
 * every request to the share and would otherwise put the password in the
 * browser's store.
 */
function unlockToken(shortId: string): string {
  return createHmac('sha256', env.SESSION_SECRET ?? 'orbit-dev-secret')
    .update(`share:${shortId}`)
    .digest('base64url');
}

function hasUnlocked(req: { cookies?: Record<string, unknown> }, shortId: string): boolean {
  const supplied = req.cookies?.[`orbit_share_${shortId}`];
  if (typeof supplied !== 'string') return false;

  const expected = unlockToken(shortId);
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  // Length-checked first: timingSafeEqual throws on a mismatch rather than
  // returning false, which would turn a wrong-length cookie into a 500.
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Nothing shared should end up in a search index, and nothing on the page
 * should be able to reach anywhere else.
 *
 * `nonce` allows exactly one inline script - the viewer's zoom and pan - and
 * nothing more. A nonce rather than `'unsafe-inline'`: this is the one page an
 * attacker gets to point a stranger at, so the policy should permit the script
 * that is there rather than the class of scripts it belongs to.
 */
function publicHeaders(
  res: { setHeader: (name: string, value: string) => void },
  nonce?: string,
): void {
  res.setHeader('x-robots-tag', 'noindex, nofollow, noarchive');
  res.setHeader('referrer-policy', 'no-referrer');

  /*
   * `origins` is empty in production - the viewer is served from here. In
   * development it is the Vite server, which is the only way to work on the
   * viewer without rebuilding it between edits.
   */
  const extra = nonce ? (shareBundle()?.origins ?? []).join(' ') : '';
  const from = extra ? ` ${extra}` : '';

  res.setHeader(
    'content-security-policy',
    [
      "default-src 'none'",
      // blob: for the viewers that decode a file themselves - an archive entry,
      // a font, a PDF page - and hand the result back to the page.
      `img-src 'self' data: blob:${from}`,
      `media-src 'self' blob:${from}`,
      `font-src 'self' data: blob:${from}`,
      `style-src 'self' 'unsafe-inline'${from}`,
      `connect-src 'self'${from}`,
      "worker-src 'self' blob:",
      nonce ? `script-src 'self' 'nonce-${nonce}'${from}` : "script-src 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
    ].join('; '),
  );
}

/*
 * The viewer bundle, from the same origin as the bytes it renders.
 *
 * Mounted before /s/:shortId, or the path would be read as a link id and
 * answered with the "this link does not work" page. The names are content
 * hashed, so a year is safe and a changed build is a different URL.
 */
sharesRouter.use(
  SHARE_ASSET_PATH,
  express.static(SHARE_ASSET_DIR, {
    index: false,
    fallthrough: true,
    maxAge: '365d',
    immutable: true,
  }),
);

sharesRouter.get('/s/:shortId', async (req, res, next) => {
  const shortId = req.params.shortId ?? '';

  try {
    const found = await lookupShare(shortId);

    // One per response, so a nonce lifted from a cached page is worthless.
    const nonce = randomBytes(16).toString('base64');
    publicHeaders(res, nonce);

    if (found.state === 'missing') {
      res.status(404).type('html').send(sharePage({ kind: 'missing' }));
      return;
    }
    if (found.state === 'expired') {
      res.status(410).type('html').send(sharePage({ kind: 'expired' }));
      return;
    }
    if (found.state === 'locked' && !hasUnlocked(req, shortId)) {
      res.status(401).type('html').send(sharePage({ kind: 'locked', shortId }));
      return;
    }

    res
      .type('html')
      .send(sharePage({ kind: 'file', shortId, share: found.share, nonce }));
  } catch (err) {
    next(err);
  }
});

const unlockSchema = z.object({ password: z.string().min(1).max(200) });

sharesRouter.post('/s/:shortId/unlock', async (req, res, next) => {
  const shortId = req.params.shortId ?? '';

  try {
    const parsed = unlockSchema.safeParse(req.body);
    const found = await lookupShare(shortId, parsed.success ? parsed.data.password : undefined);
    publicHeaders(res);

    if (found.state === 'missing') {
      res.status(404).type('html').send(sharePage({ kind: 'missing' }));
      return;
    }
    if (found.state === 'expired') {
      res.status(410).type('html').send(sharePage({ kind: 'expired' }));
      return;
    }
    if (found.state === 'locked') {
      res.status(401).type('html').send(sharePage({ kind: 'locked', shortId, wrong: true }));
      return;
    }

    res.cookie(`orbit_share_${shortId}`, unlockToken(shortId), {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: `/s/${shortId}`,
      maxAge: 6 * 60 * 60 * 1000,
    });

    // Redirect rather than render, so a refresh does not resubmit the password.
    res.redirect(303, `/s/${shortId}`);
  } catch (err) {
    next(err);
  }
});

sharesRouter.get('/s/:shortId/content', async (req, res, next) => {
  const shortId = req.params.shortId ?? '';

  try {
    const target = await resolveShareTarget(shortId, hasUnlocked(req, shortId));

    if ('blocked' in target) {
      // A visitor without the password gets the same answer as one following a
      // link that never existed: the bytes say nothing the page has not said.
      res.status(target.blocked === 'expired' ? 410 : 404).end();
      return;
    }

    const active = await useAccount(target.ownerId, target.accountId, 'read');
    if (!active) {
      res.status(404).end();
      return;
    }

    const range = parseRange(req.headers.range);
    const stream = await active.adapter.getFileStream(
      active.tokens,
      target.remoteId,
      range ?? undefined,
    );

    publicHeaders(res);
    res.setHeader('content-type', stream.contentType);
    res.setHeader('accept-ranges', 'bytes');
    // Never held by a shared cache: the link can be revoked at any moment, and
    // a cached copy would outlive the revocation.
    res.setHeader('cache-control', 'private, no-store');

    if (req.query.download !== undefined && target.permission === 'download') {
      res.setHeader(
        'content-disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(target.name)}`,
      );
    }

    if (stream.contentRange) {
      res.status(206).setHeader('content-range', stream.contentRange);
    }
    if (stream.contentLength !== undefined) {
      res.setHeader('content-length', String(stream.contentLength));
    }

    Readable.fromWeb(stream.stream as never).pipe(res);
    void recordAccess(shortId);
  } catch (err) {
    next(err);
  }
});

sharesRouter.get('/s/:shortId/qr', async (req, res, next) => {
  const shortId = req.params.shortId ?? '';

  try {
    const found = await lookupShare(shortId);
    if (found.state === 'missing') {
      res.status(404).end();
      return;
    }

    // SVG rather than PNG: it scales to whatever it is printed or shown at,
    // and it is a fraction of the bytes.
    const svg = await QRCode.toString(shareUrl(shortId), {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'M',
    });

    publicHeaders(res);
    res.type('image/svg+xml').setHeader('cache-control', 'private, max-age=3600');
    res.send(svg);
  } catch (err) {
    next(err);
  }
});
