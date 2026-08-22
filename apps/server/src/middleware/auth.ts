import type { PublicUser, SystemRole } from '@orbit/shared-types';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../lib/env.js';
import { resolveSession, SESSION_COOKIE } from '../services/session.js';
import { getLocalUser } from '../services/users.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: PublicUser;
      sessionId?: string;
      /**
       * True when this user came from the local-mode bypass rather than from a
       * session anybody actually signed into. The public API refuses it.
       */
      implicitUser?: boolean;
    }
  }
}

/** Populates req.user when a valid session exists. Never rejects. */
export async function attachUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    if (env.AUTH_MODE === 'local') {
      req.user = await getLocalUser();
      req.implicitUser = true;
      next();
      return;
    }

    const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
    if (token) {
      const context = await resolveSession(token);
      if (context) {
        req.user = context.user;
        req.sessionId = context.sessionId;
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: { code: 'unauthenticated', message: 'Sign in to continue' } });
    return;
  }
  next();
}

/**
 * Role gate. Returns 404 rather than 403 for admin routes so the existence of
 * the admin surface is not confirmed to a non-admin.
 */
export function requireRole(role: SystemRole) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: { code: 'unauthenticated', message: 'Sign in to continue' } });
      return;
    }
    if (req.user.role !== role) {
      res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } });
      return;
    }
    next();
  };
}
