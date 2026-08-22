import { Readable } from 'node:stream';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { useAccount } from '../services/accounts.js';
import { renderThumbnail } from '../services/thumbnails.js';
import { forgetBreakdown } from '../services/breakdown.js';
import { searchWorkspace } from '../services/search.js';
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
    const active = await useAccount(req.user!.id, parsed.data.accountId, 'read');
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

const searchQuery = z.object({
  q: z.string().trim().max(200).optional(),
  accountId: z.string().optional(),
  // Comma-separated, because this is a query string a person may well type.
  categories: z.string().optional(),
  under: z.string().optional(),
  since: z.string().datetime().optional(),
  minSize: z.coerce.number().int().nonnegative().optional(),
  maxSize: z.coerce.number().int().nonnegative().optional(),
  starred: z.enum(['1', '0']).optional(),
  mine: z.enum(['1', '0']).optional(),
  fullText: z.enum(['1', '0']).optional(),
  cursor: z.string().optional(),
});

/**
 * Search across accounts, the way a file manager searches a folder: it reaches
 * into subfolders, and every result says where it lives.
 */
filesRouter.get('/api/search', requireAuth, async (req, res, next) => {
  const parsed = searchQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'Invalid search' } });
    return;
  }

  const { q, categories, under, since, minSize, maxSize, starred, mine, fullText, accountId, cursor } =
    parsed.data;

  // A search with no criterion at all would return the entire drive, which is
  // never what anyone meant.
  const hasCriterion =
    Boolean(q) || Boolean(categories) || Boolean(since) || minSize !== undefined || maxSize !== undefined || starred === '1';

  if (!hasCriterion) {
    res.status(400).json({
      error: { code: 'invalid_request', message: 'Give something to search for' },
    });
    return;
  }

  try {
    res.json(
      await searchWorkspace(
        req.user!.id,
        {
          accountId,
          text: q,
          fullText: fullText === '1',
          categories: categories ? categories.split(',').filter(Boolean) : undefined,
          underPath: under,
          modifiedAfter: since,
          minSizeBytes: minSize,
          maxSizeBytes: maxSize,
          starredOnly: starred === '1',
          ownedByMeOnly: mine === '1',
        },
        { cursor },
      ),
    );
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
    const active = await useAccount(req.user!.id, accountId, 'read');
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

/**
 * A small preview image, proxied like everything else so the provider's own URL
 * never reaches the browser. Missing is a normal answer, not an error, so a
 * file with no preview gets a 404 the grid quietly falls back from.
 */
filesRouter.get('/api/files/:id/thumbnail', requireAuth, async (req, res, next) => {
  const accountId = typeof req.query.accountId === 'string' ? req.query.accountId : '';
  if (!accountId) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'accountId is required' } });
    return;
  }

  const size = Math.min(Math.max(Number(req.query.size) || 400, 64), 1024);

  try {
    const active = await useAccount(req.user!.id, accountId, 'read');
    if (!active) {
      res.status(404).json({ error: { code: 'not_found', message: 'No such account' } });
      return;
    }

    // A provider that renders its own is always preferred: it costs Orbit one
    // proxied request instead of fetching, decoding and re-encoding the file.
    if (active.adapter.capabilities.thumbnails) {
      const result = await active.adapter.getThumbnail(active.tokens, req.params.id!, size);

      if (!result) {
        res.status(404).json({ error: { code: 'no_thumbnail', message: 'No preview available' } });
        return;
      }

      res.setHeader('content-type', result.contentType);
      if (result.contentLength !== undefined) {
        res.setHeader('content-length', String(result.contentLength));
      }
      // Private, but worth holding briefly: a grid re-requests these on every
      // scroll back, and the image is derived rather than the file itself.
      res.setHeader('cache-control', 'private, max-age=900');

      const stream = Readable.fromWeb(result.stream as Parameters<typeof Readable.fromWeb>[0]);
      res.on('close', () => stream.destroy());
      stream.on('error', () => res.destroy());
      stream.pipe(res);
      return;
    }

    // An object store makes none, so Orbit does - otherwise a bucket of photos
    // is a grid of file icons.
    const file = await active.adapter.getFileMeta(active.tokens, req.params.id!);
    const rendered = await renderThumbnail({
      adapter: active.adapter,
      tokens: active.tokens,
      remoteId: req.params.id!,
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      size,
    });

    if (!rendered) {
      res.status(404).json({ error: { code: 'no_thumbnail', message: 'No preview available' } });
      return;
    }

    res.setHeader('content-type', rendered.contentType);
    res.setHeader('content-length', String(rendered.bytes.byteLength));
    // Longer than a proxied one: this cost real work to produce, and the file
    // it came from is addressed by an id that changes when the file does.
    res.setHeader('cache-control', 'private, max-age=86400');
    res.end(rendered.bytes);
  } catch (err) {
    // A thumbnail that cannot be fetched is not worth a 500 - the grid shows an
    // icon instead, which is what it would do anyway.
    if (!res.headersSent) {
      res.status(404).json({ error: { code: 'no_thumbnail', message: 'No preview available' } });
      return;
    }
    next(err);
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
    const active = await useAccount(req.user!.id, parsed.data.accountId, 'write');
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

const relocateBody = z.object({
  accountId: z.string().min(1),
  targetPath: z.string().min(1),
  /** False moves it. The default is the safe one. */
  copy: z.boolean().default(true),
});

/**
 * Moves or copies within one account, without the bytes leaving the provider.
 *
 * Deliberately not the transfer engine: that exists for crossing between two
 * accounts, where the bytes genuinely have to travel through Orbit. Inside one
 * account every provider does this itself in a call or two, and routing it
 * through a transfer would mean downloading and re-uploading a file that never
 * needed to move.
 */
filesRouter.post('/api/files/:id/relocate', requireAuth, async (req, res, next) => {
  const parsed = relocateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: 'invalid_request', message: 'A destination folder is required' },
    });
    return;
  }

  try {
    // A move removes the file from where it was, so it needs what deleting
    // needs. A copy only adds.
    const need = parsed.data.copy ? 'write' : 'delete';
    const active = await useAccount(req.user!.id, parsed.data.accountId, need);
    if (!active) {
      res.status(404).json({ error: { code: 'not_found', message: 'No such account' } });
      return;
    }

    if (!active.adapter.capabilities.relocate) {
      res.status(400).json({
        error: {
          code: 'unsupported',
          message: `${active.adapter.displayName} cannot move files between folders`,
        },
      });
      return;
    }

    const file = await active.adapter.relocate(
      active.tokens,
      req.params.id!,
      parsed.data.targetPath,
      { copy: parsed.data.copy },
    );

    res.json({ file });
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
    const active = await useAccount(req.user!.id, parsed.data.accountId, 'write');
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
    const active = await useAccount(req.user!.id, parsed.data.accountId, 'delete');
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
