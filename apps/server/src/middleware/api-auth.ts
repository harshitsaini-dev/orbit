import type { ApiScope } from '@orbit/shared-types';
import type { NextFunction, Request, Response } from 'express';
import { resolveToken } from '../services/api-tokens.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set when a personal access token authorised this request. */
      apiTokenId?: string;
      /** What this request may do. Absent means it came from a session. */
      apiScopes?: ApiScope[];
    }
  }
}

/**
 * How a request to /v1 proves who it is.
 *
 * Two ways in, deliberately.
 *
 * A **bearer token** is the real one: a script, a job, another program. It
 * carries scopes, and the request may do exactly what they say.
 *
 * A **session cookie** is the reader of the documentation. The "try it"
 * console runs against this same API, and asking somebody to mint a token
 * before they can see a response is how documentation stops being read. A
 * session is the person themselves, so it carries every scope - it can already
 * do all of this through the app, and pretending otherwise would be theatre.
 */
export async function attachApiCaller(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.get('authorization');

  if (!header) {
    // No bearer: attachUser may already have resolved a session, and if it
    // did not, requireApiAuth below refuses.
    next();
    return;
  }

  const [scheme, value] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !value) {
    res.status(401).json({
      error: {
        code: 'invalid_authorization',
        message: 'Authorization must be: Bearer <token>',
        requestId: String(res.locals['requestId'] ?? ''),
      },
    });
    return;
  }

  try {
    const context = await resolveToken(value);
    if (!context) {
      /*
       * One answer for expired, revoked, mistyped and never-existed.
       *
       * There is nothing a client would do differently for any of them, and
       * distinguishing them tells somebody guessing tokens which guesses were
       * closer.
       */
      res.status(401).json({
        error: {
          code: 'invalid_token',
          message: 'That token is not valid',
          requestId: String(res.locals['requestId'] ?? ''),
        },
      });
      return;
    }

    // The bearer wins over any cookie that happened to be sent with it: a
    // request that names a token is a request made as that token.
    req.user = context.user;
    req.apiTokenId = context.tokenId;
    req.apiScopes = context.scopes;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Refuses anything that has not actually proved who it is.
 *
 * The local-mode bypass is explicitly not enough. It gives every request an
 * implicit user, which is right for developing the app against a laptop and
 * wrong here: a public API that authenticates itself is not one, and a client
 * written against it would work locally and fail the moment it met a real
 * deployment. Developing against /v1 means minting a token, as a real caller
 * would.
 */
export function requireApiAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || (req.implicitUser && !req.apiTokenId)) {
    res.status(401).json({
      error: {
        code: 'unauthenticated',
        message: 'Send a personal access token: Authorization: Bearer orbit_pat_…',
        requestId: String(res.locals['requestId'] ?? ''),
      },
    });
    return;
  }

  next();
}

/**
 * A gate per scope.
 *
 * 403 rather than 401: the credential is real and the answer will not change
 * by sending it again. A client that retries a 401 forever on a missing scope
 * is a client nobody told the difference to.
 */
export function requireScope(scope: ApiScope) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // A session is the person themselves, and they can do all of this in the
    // app already.
    if (!req.apiScopes) {
      next();
      return;
    }

    if (!req.apiScopes.includes(scope)) {
      res.status(403).json({
        error: {
          code: 'insufficient_scope',
          message: `This token needs the ${scope} scope`,
          requestId: String(res.locals['requestId'] ?? ''),
        },
      });
      return;
    }

    next();
  };
}
