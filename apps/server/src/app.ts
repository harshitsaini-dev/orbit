import { ProviderError } from '@orbit/adapters';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { env } from './lib/env.js';
import { attachUser } from './middleware/auth.js';
import { accountsRouter } from './routes/accounts.js';
import { authRouter } from './routes/auth.js';
import { filesRouter } from './routes/files.js';
import { profileRouter } from './routes/profile.js';
import { sharesRouter } from './routes/shares.js';
import { uploadsRouter } from './routes/uploads.js';
import { healthRouter } from './routes/health.js';

/**
 * Turns a provider's HTTP status into something the user can act on.
 *
 * The provider's own message is deliberately not passed through: it names
 * internal file ids ("File not found: 1w1s7dydd..."), which mean nothing to the
 * person reading them and are not ours to publish. The status is what carries
 * the meaning, and the full message is already in the server log.
 *
 * Google in particular answers 404 rather than 403 for a file the caller may
 * not see, so "not found" and "no permission" cannot be told apart from here -
 * and the wording has to cover both without guessing which it was.
 */
function describeProviderFailure(status: number): [number, string, string] {
  if (status === 401 || status === 403) {
    return [403, 'provider_denied', 'That account does not have permission to do this.'];
  }
  if (status === 404) {
    return [
      404,
      'provider_not_found',
      'The provider could not find that. It may have been moved or deleted, or this account may no longer have access to it.',
    ];
  }
  if (status === 429) {
    return [429, 'provider_busy', 'The provider is rate limiting Orbit. Try again in a moment.'];
  }
  if (status === 507) {
    return [507, 'provider_full', 'That account is out of space.'];
  }
  return [502, 'provider_unavailable', 'The provider did not respond. Nothing was changed.'];
}

export function createApp(): Express {
  const app = express();

  app.set('trust proxy', 1);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: env.APP_URL, credentials: true }));
  // Skips the upload chunk route: that body is raw file bytes, and a JSON
  // parser would both fail on it and buffer it twice.
  app.use((req, res, next) =>
    /^\/api\/uploads\/[^/]+\/chunk$/.test(req.path)
      ? next()
      : express.json({ limit: '1mb' })(req, res, next),
  );
  // The share page's password form posts urlencoded, since it runs no scripts.
  app.use('/s', express.urlencoded({ extended: false, limit: '4kb' }));
  app.use(cookieParser());

  /**
   * Only the two endpoints that actually are a brute-force surface. Applied to
   * all of `/auth` it also counted `GET /auth/me`, which the app calls on every
   * page load: a few tabs and a couple of reloads used the whole budget, and
   * the punishment for that was being unable to sign in for the rest of the
   * window. Reading a session is not guessing a code.
   */
  const isOtp = (req: Request): boolean =>
    req.path === '/auth/request-otp' || req.path === '/auth/verify-otp';

  app.use(
    rateLimit({
      windowMs: env.AUTH_RATE_WINDOW_MS,
      limit: env.AUTH_RATE_LIMIT,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      skip: (req) => !isOtp(req),
    }),
  );
  // Streaming a file or fetching a thumbnail is not a metadata call, and
  // counting them together means one scroll through a grid of photos exhausts
  // the budget for listing anything.
  const isTransfer = (req: Request): boolean =>
    /^\/api\/files\/[^/]+\/(content|thumbnail)$/.test(req.path);

  app.use(
    rateLimit({
      windowMs: env.API_RATE_WINDOW_MS,
      limit: env.API_RATE_LIMIT,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      // The rest of /auth belongs here rather than nowhere: still limited, but
      // against the budget sized for ordinary use.
      skip: (req) =>
        !(req.path.startsWith('/api') || req.path.startsWith('/auth')) ||
        isTransfer(req) ||
        isOtp(req),
    }),
  );

  app.use(
    rateLimit({
      windowMs: env.TRANSFER_RATE_WINDOW_MS,
      limit: env.TRANSFER_RATE_LIMIT,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      skip: (req) => !isTransfer(req),
    }),
  );

  /**
   * Share links are public, so they are the one surface a stranger can reach
   * without a session - and the one that must not let a stranger walk the id
   * space looking for links that work. The budget is generous enough for a page
   * plus its bytes and its QR, and far too small to search 60 bits.
   */
  app.use(
    rateLimit({
      windowMs: env.API_RATE_WINDOW_MS,
      limit: env.SHARE_RATE_LIMIT,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      skip: (req) => !req.path.startsWith('/s/'),
    }),
  );

  app.use(healthRouter);

  app.use(attachUser);
  app.use(authRouter);
  app.use(accountsRouter);
  app.use(filesRouter);
  app.use(profileRouter);
  app.use(sharesRouter);
  app.use(uploadsRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } });
  });

  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    // Log the cause chain: a wrapped driver error otherwise reports only
    // "Failed query", which says nothing about why it failed.
    console.error(`${req.method} ${req.path} ->`, err.name, err.message);
    let cause = (err as { cause?: unknown }).cause;
    while (cause instanceof Error) {
      console.error('  caused by:', cause.name, cause.message);
      cause = (cause as { cause?: unknown }).cause;
    }
    // A provider that told us exactly what was wrong should not be reported as
    // "something went wrong": a refused upload is usually a permission or a
    // missing folder, and the user can act on that but not on a 500. The
    // provider's own wording is not passed through - it names internal file ids
    // - so the status is translated into a sentence and the detail stays in the
    // log above.
    if (err instanceof ProviderError) {
      const [status, code, message] = describeProviderFailure(err.status);
      // An adapter that understood the failure explains it better than a status
      // ever could, so its own wording wins where it wrote one.
      res.status(status).json({ error: { code, message: err.userMessage ?? message } });
      return;
    }

    res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong' } });
  });

  return app;
}
