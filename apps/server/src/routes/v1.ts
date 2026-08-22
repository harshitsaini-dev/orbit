import { Readable } from 'node:stream';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../lib/env.js';
import { attachApiCaller, requireApiAuth, requireScope } from '../middleware/api-auth.js';
import { sendProviderError } from '../lib/provider-error.js';
import { listAccounts, useAccount } from '../services/accounts.js';
import { createShare, listShares, revokeShare } from '../services/shares.js';
import { parseRange } from './files.js';

/**
 * The public API.
 *
 * Everything here already exists behind `/api`; the difference is who is
 * calling and what they are allowed to do. `/api` is the app talking to itself
 * over a session cookie and may do anything the person may do. `/v1` is a
 * program, holding a token that names exactly which of those things it may do,
 * against a surface that is promised not to change under it.
 *
 * That promise is the reason this is a separate file rather than a scope check
 * bolted onto the existing routes. `/api` is free to change shape whenever the
 * app needs it to - it ships with its only client. `/v1` is not: a breaking
 * change means `/v2`, and the two would fight inside one handler.
 *
 * What is deliberately not here: anything that would hand over a provider's own
 * credentials. Orbit proxies every byte, so a token reaches files without ever
 * exposing the Google or Dropbox token behind them.
 */
export const v1Router: Router = Router();

/*
 * Order matters here.
 *
 * The token is resolved first, because the rate limit is keyed on it: a script
 * legitimately makes more requests than a person clicking, and counting per IP
 * would let one busy token exhaust the budget for everyone behind the same
 * address - including, on a home connection, that person's own browser.
 *
 * An unauthenticated caller falls back to the address, so omitting a credential
 * is not a way to spend somebody else's budget.
 */
v1Router.use(
  '/v1',
  attachApiCaller,
  rateLimit({
    windowMs: env.API_RATE_WINDOW_MS,
    limit: env.V1_RATE_LIMIT,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => req.apiTokenId ?? req.ip ?? 'unknown',
  }),
  requireApiAuth,
);

function fail(res: Parameters<typeof sendProviderError>[1], status: number, code: string, message: string): void {
  res.status(status).json({
    error: { code, message, requestId: String(res.locals['requestId'] ?? '') },
  });
}

// --- who -------------------------------------------------------------------

v1Router.get('/v1/me', (req, res) => {
  res.json({
    user: { id: req.user!.id, email: req.user!.email, displayName: req.user!.displayName },
    // A program should be able to find out what it may do without discovering
    // it one 403 at a time.
    scopes: req.apiScopes ?? 'session',
  });
});

// --- accounts ---------------------------------------------------------------

v1Router.get('/v1/accounts', requireScope('accounts:read'), async (req, res, next) => {
  try {
    res.json({ accounts: await listAccounts(req.user!.id) });
  } catch (err) {
    next(err);
  }
});

// --- files ------------------------------------------------------------------

const listQuery = z.object({
  accountId: z.string().min(1),
  path: z.string().default('/'),
  cursor: z.string().optional(),
});

v1Router.get('/v1/files', requireScope('files:read'), async (req, res, next) => {
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) {
    fail(res, 400, 'invalid_request', 'accountId is required');
    return;
  }

  try {
    const active = await useAccount(req.user!.id, parsed.data.accountId, 'read');
    if (!active) {
      fail(res, 404, 'not_found', 'No such account');
      return;
    }

    const page = await active.adapter.listFolder(active.tokens, parsed.data.path, parsed.data.cursor);

    res.json({
      accountId: active.row.id,
      path: parsed.data.path,
      files: page.files,
      // Cursor rather than an offset, everywhere: the underlying drive changes
      // under a reader, and page 3 of a list that shifted is not page 3.
      nextCursor: page.nextPageToken ?? null,
    });
  } catch (err) {
    if (!sendProviderError(err, res)) next(err);
  }
});

v1Router.get('/v1/files/:id', requireScope('files:read'), async (req, res, next) => {
  const accountId = typeof req.query['accountId'] === 'string' ? req.query['accountId'] : '';
  if (!accountId) {
    fail(res, 400, 'invalid_request', 'accountId is required');
    return;
  }

  try {
    const active = await useAccount(req.user!.id, accountId, 'read');
    if (!active) {
      fail(res, 404, 'not_found', 'No such account');
      return;
    }

    res.json({ file: await active.adapter.getFileMeta(active.tokens, req.params.id!) });
  } catch (err) {
    if (!sendProviderError(err, res)) next(err);
  }
});

/**
 * The bytes, proxied.
 *
 * Range is honoured, so a client can seek a video rather than downloading it -
 * which is also what makes this usable for anything that resumes.
 */
v1Router.get('/v1/files/:id/content', requireScope('files:download'), async (req, res, next) => {
  const accountId = typeof req.query['accountId'] === 'string' ? req.query['accountId'] : '';
  if (!accountId) {
    fail(res, 400, 'invalid_request', 'accountId is required');
    return;
  }

  try {
    const active = await useAccount(req.user!.id, accountId, 'read');
    if (!active) {
      fail(res, 404, 'not_found', 'No such account');
      return;
    }

    const range = parseRange(req.get('range'));
    const result = await active.adapter.getFileStream(active.tokens, req.params.id!, range ?? undefined);

    res.status(result.contentRange ? 206 : 200);
    res.setHeader('content-type', result.contentType);
    res.setHeader('accept-ranges', 'bytes');
    if (result.contentLength !== undefined) res.setHeader('content-length', String(result.contentLength));
    if (result.contentRange) res.setHeader('content-range', result.contentRange);
    res.setHeader('cache-control', 'private, max-age=0, no-store');

    const stream = Readable.fromWeb(result.stream as Parameters<typeof Readable.fromWeb>[0]);

    // A client that hangs up mid-download should stop costing the provider.
    res.on('close', () => stream.destroy());
    stream.on('error', (err) => {
      if (!res.headersSent) next(err);
      else res.destroy();
    });

    stream.pipe(res);
  } catch (err) {
    if (!sendProviderError(err, res)) next(err);
  }
});

const folderBody = z.object({
  accountId: z.string().min(1),
  path: z.string().default('/'),
  name: z.string().min(1).max(255),
});

v1Router.post('/v1/files/folder', requireScope('files:write'), async (req, res, next) => {
  const parsed = folderBody.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'invalid_request', 'accountId and name are required');
    return;
  }

  try {
    const active = await useAccount(req.user!.id, parsed.data.accountId, 'write');
    if (!active) {
      fail(res, 404, 'not_found', 'No such account');
      return;
    }

    const folder = await active.adapter.createFolder(active.tokens, parsed.data.path, parsed.data.name);
    res.status(201).json({ file: folder });
  } catch (err) {
    if (!sendProviderError(err, res)) next(err);
  }
});

const renameBody = z.object({ accountId: z.string().min(1), name: z.string().min(1).max(255) });

v1Router.patch('/v1/files/:id', requireScope('files:write'), async (req, res, next) => {
  const parsed = renameBody.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'invalid_request', 'accountId and name are required');
    return;
  }

  try {
    const active = await useAccount(req.user!.id, parsed.data.accountId, 'write');
    if (!active) {
      fail(res, 404, 'not_found', 'No such account');
      return;
    }

    await active.adapter.rename(active.tokens, req.params.id!, parsed.data.name);
    res.json({ file: await active.adapter.getFileMeta(active.tokens, req.params.id!) });
  } catch (err) {
    if (!sendProviderError(err, res)) next(err);
  }
});

const deleteBody = z.object({
  accountId: z.string().min(1),
  remoteIds: z.array(z.string().min(1)).min(1).max(200),
});

v1Router.delete('/v1/files', requireScope('files:delete'), async (req, res, next) => {
  const parsed = deleteBody.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'invalid_request', 'accountId and remoteIds are required');
    return;
  }

  try {
    const active = await useAccount(req.user!.id, parsed.data.accountId, 'delete');
    if (!active) {
      fail(res, 404, 'not_found', 'No such account');
      return;
    }

    /*
     * Partial success is reported rather than flattened.
     *
     * A bulk delete where one file is already gone is not a failed request,
     * and a program deserves to know which of the two hundred it asked about
     * actually went.
     */
    const result = await active.adapter.remove(active.tokens, parsed.data.remoteIds);
    res.json(result);
  } catch (err) {
    if (!sendProviderError(err, res)) next(err);
  }
});

// --- shares -----------------------------------------------------------------

v1Router.get('/v1/shares', requireScope('shares:read'), async (req, res, next) => {
  try {
    res.json({ shares: await listShares(req.user!.id) });
  } catch (err) {
    next(err);
  }
});

const shareBody = z.object({
  accountId: z.string().min(1),
  remoteId: z.string().min(1),
  permission: z.enum(['view', 'download']).optional(),
  password: z.string().min(1).max(200).optional(),
  expiresInDays: z.number().int().positive().max(365).optional(),
});

v1Router.post('/v1/shares', requireScope('shares:write'), async (req, res, next) => {
  const parsed = shareBody.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'invalid_request', 'accountId and remoteId are required');
    return;
  }

  try {
    const share = await createShare({ userId: req.user!.id, ...parsed.data });
    if (!share) {
      fail(res, 404, 'not_found', 'No such file');
      return;
    }

    res.status(201).json({ share });
  } catch (err) {
    if (!sendProviderError(err, res)) next(err);
  }
});

v1Router.delete('/v1/shares/:shortId', requireScope('shares:write'), async (req, res, next) => {
  try {
    const revoked = await revokeShare(req.user!.id, req.params.shortId!);
    if (!revoked) {
      fail(res, 404, 'not_found', 'No such link');
      return;
    }

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Anything else under /v1 is a route that does not exist, answered in the same
// shape as every other error rather than falling through to the app's 404.
v1Router.use('/v1', (_req, res) => {
  fail(res, 404, 'not_found', 'No such endpoint. See /developer/docs for what exists.');
});
