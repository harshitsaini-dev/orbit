import { Readable } from 'node:stream';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { useAccount } from '../services/accounts.js';
import { forgetBreakdown } from '../services/breakdown.js';
import { listWorkspaceView } from '../services/views.js';

export const filesRouter: Router = Router();

/** Maps the errors that mean something specific onto a status the UI can act on. */
function sendProviderError(err: unknown, res: import('express').Response): boolean {
  if (err instanceof Error && err.message === 'needs_reauth') {
    res.status(409).json({
      error: { code: 'needs_reauth', message: 'This account needs to be reconnected' },
    });
    return true;
  }
  if (err instanceof Error && err.name === 'NotImplementedError') {
    res.status(501).json({
      error: { code: 'unsupported', message: 'This provider does not support that action' },
    });
    return true;
  }
  return false;
}

const listQuery = z.object({
  accountId: z.string().min(1),
  path: z.string().default('/'),
  pageToken: z.string().optional(),
});

filesRouter.get('/api/files', requireAuth, async (req, res, next) => {
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'accountId is required' } });
    return;
  }

  try {
    const active = await useAccount(req.user!.id, parsed.data.accountId);
    if (!active) {
      res.status(404).json({ error: { code: 'not_found', message: 'No such account' } });
      return;
    }

    const page = await active.adapter.listFolder(active.tokens, parsed.data.path, parsed.data.pageToken);

    res.json({
      accountId: active.row.id,
      provider: active.row.provider,
      path: parsed.data.path,
      files: page.files,
      nextCursor: page.nextPageToken,
      capabilities: active.adapter.capabilities,
    });
  } catch (err) {
    if (!sendProviderError(err, res)) next(err);
  }
});

/**
 * Recent, starred and shared-with-me, merged across every connected account.
 * That merge is the point of the product: "recent" should mean recent
 * everywhere, not recent in whichever drive happens to be selected.
 */
filesRouter.get('/api/views/:view', requireAuth, async (req, res, next) => {
  const view = req.params.view;
  if (view !== 'recent' && view !== 'starred' && view !== 'shared') {
    res.status(404).json({ error: { code: 'not_found', message: 'No such view' } });
    return;
  }

  try {
    res.json(await listWorkspaceView(req.user!.id, view));
  } catch (err) {
    if (!sendProviderError(err, res)) next(err);
  }
});

// --- content --------------------------------------------------------------

/** `bytes=start-end`, with either end optional. Anything else is ignored. */
export function parseRange(header: string | undefined): { start: number; end?: number } | null {
  if (!header) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;

  // A suffix range ("last N bytes") needs a length we do not have here, so it
  // is declined rather than answered wrongly.
  if (!rawStart) return null;

  const start = Number(rawStart);
  const end = rawEnd ? Number(rawEnd) : undefined;
  if (end !== undefined && end < start) return null;

  return { start, end };
}

/**
 * Streams file content straight through from the provider.
 *
 * The bytes are never written to Orbit's disk, and the provider's own URL never
 * reaches the client — which is the point of the aggregator, and what makes a
 * share link safe to hand out later.
 */
filesRouter.get('/api/files/:id/content', requireAuth, async (req, res, next) => {
  const accountId = typeof req.query.accountId === 'string' ? req.query.accountId : '';
  if (!accountId) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'accountId is required' } });
    return;
  }

  try {
    const active = await useAccount(req.user!.id, accountId);
    if (!active) {
      res.status(404).json({ error: { code: 'not_found', message: 'No such account' } });
      return;
    }

    const range = parseRange(req.get('range'));
    const result = await active.adapter.getFileStream(active.tokens, req.params.id!, range ?? undefined);

    res.status(result.contentRange ? 206 : 200);
    res.setHeader('content-type', result.contentType);
    res.setHeader('accept-ranges', 'bytes');
    if (result.contentLength !== undefined) res.setHeader('content-length', String(result.contentLength));
    if (result.contentRange) res.setHeader('content-range', result.contentRange);

    // Private: this is one user's file behind their session, so no shared cache
    // may keep a copy.
    res.setHeader('cache-control', 'private, max-age=0, no-store');

    if (req.query.download === '1') {
      const name = typeof req.query.name === 'string' ? req.query.name : 'download';
      res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    }

    const stream = Readable.fromWeb(result.stream as Parameters<typeof Readable.fromWeb>[0]);

    // If the client goes away mid-download, stop pulling from the provider.
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

// --- mutations ------------------------------------------------------------

const createFolderBody = z.object({
  accountId: z.string().min(1),
  path: z.string().default('/'),
  name: z.string().trim().min(1).max(255),
});

filesRouter.post('/api/files/folder', requireAuth, async (req, res, next) => {
  const parsed = createFolderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'A folder name is required' } });
    return;
  }

  try {
    const active = await useAccount(req.user!.id, parsed.data.accountId);
    if (!active) {
      res.status(404).json({ error: { code: 'not_found', message: 'No such account' } });
      return;
    }

    const folder = await active.adapter.createFolder(active.tokens, parsed.data.path, parsed.data.name);
    res.status(201).json({ file: folder });
  } catch (err) {
    if (!sendProviderError(err, res)) next(err);
  }
});

const patchBody = z
  .object({
    accountId: z.string().min(1),
    name: z.string().trim().min(1).max(255).optional(),
    starred: z.boolean().optional(),
  })
  .refine((value) => value.name !== undefined || value.starred !== undefined, {
    message: 'Nothing to change',
  });

filesRouter.patch('/api/files/:id', requireAuth, async (req, res, next) => {
  const parsed = patchBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'Nothing to change' } });
    return;
  }

  try {
    const active = await useAccount(req.user!.id, parsed.data.accountId);
    if (!active) {
      res.status(404).json({ error: { code: 'not_found', message: 'No such account' } });
      return;
    }

    const remoteId = req.params.id!;

    if (parsed.data.name !== undefined) {
      await active.adapter.rename(active.tokens, remoteId, parsed.data.name);
    }
    if (parsed.data.starred !== undefined) {
      if (!active.adapter.capabilities.star) {
        res.status(501).json({
          error: { code: 'unsupported', message: 'This provider cannot star files' },
        });
        return;
      }
      await active.adapter.star(active.tokens, remoteId, parsed.data.starred);
    }

    res.status(204).end();
  } catch (err) {
    if (!sendProviderError(err, res)) next(err);
  }
});

const deleteBody = z.object({
  accountId: z.string().min(1),
  remoteIds: z.array(z.string().min(1)).min(1).max(500),
});

filesRouter.delete('/api/files', requireAuth, async (req, res, next) => {
  const parsed = deleteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'remoteIds is required' } });
    return;
  }

  try {
    const active = await useAccount(req.user!.id, parsed.data.accountId);
    if (!active) {
      res.status(404).json({ error: { code: 'not_found', message: 'No such account' } });
      return;
    }

    const result = await active.adapter.remove(active.tokens, parsed.data.remoteIds);

    // The cached breakdown is now wrong; drop it rather than serve stale sizes.
    forgetBreakdown(req.user!.id, parsed.data.accountId);

    // 207 when the batch was mixed, so a caller cannot read a 200 as "all done".
    res.status(result.failed.length > 0 ? 207 : 200).json(result);
  } catch (err) {
    if (!sendProviderError(err, res)) next(err);
  }
});
