import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import {
  alreadyScanned,
  forgetOne,
  searchText,
  storeText,
  textCoverage,
} from '../services/file-text.js';

/**
 * Text read out of files, stored and searched.
 *
 * The reading itself is not here and never will be. It happens in the browser,
 * on the machine that already has the bytes on screen, which is what keeps the
 * feature free - and it means Orbit does not have to hold a file to index it,
 * which is the same rule the rest of the product runs on.
 */

export const textRouter: Router = Router();

const storeSchema = z.object({
  accountId: z.string().min(1),
  remoteId: z.string().min(1),
  name: z.string().min(1).max(512),
  virtualPath: z.string().min(1).max(2048),
  text: z.string().max(50_000),
  /** As the engine reports it: a mean over the page, 0-100. */
  confidence: z.number().min(0).max(100),
});

/**
 * Records what a browser read out of one file.
 *
 * `{ stored: false }` is a success, not a failure: an unreadable photo has no
 * text, which is an ordinary answer. A caller that treated it as an error
 * would put a red message on a scan that worked perfectly.
 */
textRouter.post('/api/text', requireAuth, async (req, res, next) => {
  const parsed = storeSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'Bad reading' } });
    return;
  }

  try {
    const stored = await storeText({ userId: req.user!.id, ...parsed.data });
    res.json({ stored });
  } catch (err) {
    next(err);
  }
});

/**
 * Which of these files have been read already.
 *
 * Asked before a folder scan so it can skip them. The alternative - scanning
 * everything every time - is minutes of a laptop's fans for an answer already
 * in the database.
 */
textRouter.post('/api/text/known', requireAuth, async (req, res, next) => {
  const parsed = z
    .object({ accountId: z.string().min(1), remoteIds: z.array(z.string()).max(2000) })
    .safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'Bad request' } });
    return;
  }

  try {
    res.json({
      scanned: await alreadyScanned(req.user!.id, parsed.data.accountId, parsed.data.remoteIds),
    });
  } catch (err) {
    next(err);
  }
});

textRouter.get('/api/text/search', requireAuth, async (req, res, next) => {
  const query = typeof req.query.q === 'string' ? req.query.q : '';

  try {
    res.json({ matches: await searchText(req.user!.id, query) });
  } catch (err) {
    next(err);
  }
});

textRouter.get('/api/text/coverage', requireAuth, async (req, res, next) => {
  try {
    res.json(await textCoverage(req.user!.id));
  } catch (err) {
    next(err);
  }
});

/** Forgetting a reading, for somebody who does not want it kept. */
textRouter.delete('/api/text/:accountId/:remoteId', requireAuth, async (req, res, next) => {
  try {
    const known = await alreadyScanned(req.user!.id, req.params.accountId!, [
      req.params.remoteId!,
    ]);

    if (known.length === 0) {
      res.status(404).json({ error: { code: 'not_found', message: 'Nothing to forget' } });
      return;
    }

    await forgetOne(req.params.accountId!, req.params.remoteId!);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
