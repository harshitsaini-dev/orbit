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
import { uploadsRouter } from './routes/uploads.js';
import { healthRouter } from './routes/health.js';

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

  app.use(healthRouter);

  app.use(attachUser);
  app.use(authRouter);
  app.use(accountsRouter);
  app.use(filesRouter);
  app.use(profileRouter);
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
    res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong' } });
  });

  return app;
}
