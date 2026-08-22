import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import {
  addToCollection,
  createCollection,
  deleteCollection,
  listCollections,
  readCollection,
  removeFromCollection,
  renameCollection,
} from '../services/collections.js';

export const collectionsRouter: Router = Router();

const nameSchema = z.object({
  name: z.string().trim().min(1).max(120),
  colour: z.string().max(32).optional(),
});

collectionsRouter.get('/api/collections', requireAuth, async (req, res, next) => {
  try {
    res.json({ collections: await listCollections(req.user!.id) });
  } catch (err) {
    next(err);
  }
});

collectionsRouter.post('/api/collections', requireAuth, async (req, res, next) => {
  const parsed = nameSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'A name is required' } });
    return;
  }

  try {
    const collection = await createCollection(req.user!.id, parsed.data.name, parsed.data.colour);
    res.status(201).json({ collection });
  } catch (err) {
    next(err);
  }
});

collectionsRouter.get('/api/collections/:id', requireAuth, async (req, res, next) => {
  try {
    const found = await readCollection(req.user!.id, req.params.id ?? '');
    if (!found) {
      res.status(404).json({ error: { code: 'not_found', message: 'No such collection' } });
      return;
    }
    res.json(found);
  } catch (err) {
    next(err);
  }
});

collectionsRouter.patch('/api/collections/:id', requireAuth, async (req, res, next) => {
  const parsed = nameSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'A name is required' } });
    return;
  }

  try {
    const renamed = await renameCollection(req.user!.id, req.params.id ?? '', parsed.data.name);
    if (!renamed) {
      res.status(404).json({ error: { code: 'not_found', message: 'No such collection' } });
      return;
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

collectionsRouter.delete('/api/collections/:id', requireAuth, async (req, res, next) => {
  try {
    const removed = await deleteCollection(req.user!.id, req.params.id ?? '');
    if (!removed) {
      res.status(404).json({ error: { code: 'not_found', message: 'No such collection' } });
      return;
    }
    // The files are untouched: a collection holds references, so deleting it
    // deletes a grouping and nothing else.
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

const addSchema = z.object({
  accountId: z.string().min(1),
  remoteId: z.string().min(1),
  /** Where the caller was standing; see addToCollection for why. */
  virtualPath: z.string().max(4096).optional(),
});

collectionsRouter.post('/api/collections/:id/items', requireAuth, async (req, res, next) => {
  const parsed = addSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'Malformed item' } });
    return;
  }

  try {
    const item = await addToCollection(
      req.user!.id,
      req.params.id ?? '',
      parsed.data.accountId,
      parsed.data.remoteId,
      parsed.data.virtualPath,
    );

    if (!item) {
      res.status(404).json({ error: { code: 'not_found', message: 'No such collection or account' } });
      return;
    }

    res.status(201).json({ item });
  } catch (err) {
    next(err);
  }
});

collectionsRouter.delete(
  '/api/collections/:id/items/:itemId',
  requireAuth,
  async (req, res, next) => {
    try {
      const removed = await removeFromCollection(
        req.user!.id,
        req.params.id ?? '',
        req.params.itemId ?? '',
      );

      if (!removed) {
        res.status(404).json({ error: { code: 'not_found', message: 'No such item' } });
        return;
      }

      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);
