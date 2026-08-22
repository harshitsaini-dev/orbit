import { API_SCOPES, isApiScope } from '@orbit/shared-types';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { record } from '../services/audit.js';
import { createToken, listTokens, revokeToken } from '../services/api-tokens.js';

/**
 * Managing personal access tokens.
 *
 * Session-only, deliberately: a token must not be able to mint another token.
 * Otherwise a leaked read-only token could issue itself a delete-everything
 * one, and every scope on it would be decoration.
 */
export const developerRouter: Router = Router();

developerRouter.get('/api/tokens', requireAuth, async (req, res, next) => {
  try {
    res.json({ tokens: await listTokens(req.user!.id), scopes: API_SCOPES });
  } catch (err) {
    next(err);
  }
});

const createBody = z.object({
  name: z.string().min(1).max(80),
  scopes: z.array(z.string()).min(1),
  /** Optional, and worth setting: a token with no expiry outlives its purpose. */
  expiresInDays: z.number().int().positive().max(365).optional(),
});

developerRouter.post('/api/tokens', requireAuth, async (req, res, next) => {
  const parsed = createBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: { code: 'invalid_request', message: 'A name and at least one scope' } });
    return;
  }

  const scopes = parsed.data.scopes.filter(isApiScope);
  if (scopes.length !== parsed.data.scopes.length) {
    // Refused rather than filtered: a token that silently grants less than was
    // asked for fails later, somewhere unrelated, as a 403 nobody expected.
    res
      .status(400)
      .json({ error: { code: 'unknown_scope', message: 'That is not a scope Orbit issues' } });
    return;
  }

  try {
    const expiresAt = parsed.data.expiresInDays
      ? new Date(Date.now() + parsed.data.expiresInDays * 86_400_000)
      : undefined;

    const created = await createToken({
      userId: req.user!.id,
      name: parsed.data.name,
      scopes,
      expiresAt,
    });

    await record({
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: 'token.create',
      targetType: 'token',
      targetId: created.record.id,
      // The scopes, never the token. This row is read by whoever is working out
      // what happened, and a log holding a live credential is a second copy of
      // the credential.
      summary: `Created API token "${created.record.name}" (${scopes.join(', ')})`,
      ip: req.ip,
    });

    // The one and only time the value exists outside the caller's hands.
    res.status(201).json({ token: created.token, record: created.record });
  } catch (err) {
    next(err);
  }
});

developerRouter.delete('/api/tokens/:id', requireAuth, async (req, res, next) => {
  try {
    const revoked = await revokeToken(req.user!.id, req.params.id!);
    if (!revoked) {
      res.status(404).json({ error: { code: 'not_found', message: 'No such token' } });
      return;
    }

    await record({
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: 'token.revoke',
      targetType: 'token',
      targetId: req.params.id!,
      summary: 'Revoked an API token',
      ip: req.ip,
    });

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
