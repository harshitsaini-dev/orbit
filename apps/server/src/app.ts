import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { env } from './lib/env.js';
import { attachUser } from './middleware/auth.js';
import { accountsRouter } from './routes/accounts.js';
import { authRouter } from './routes/auth.js';
import { healthRouter } from './routes/health.js';

export function createApp(): Express {
  const app = express();

  app.set('trust proxy', 1);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: env.APP_URL, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // Auth routes are the enumeration/brute-force surface; limit them harder than the rest.
  app.use(
    '/auth',
    rateLimit({
      windowMs: env.AUTH_RATE_WINDOW_MS,
      limit: env.AUTH_RATE_LIMIT,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
    }),
  );
  app.use(
    '/api',
    rateLimit({
      windowMs: env.API_RATE_WINDOW_MS,
      limit: env.API_RATE_LIMIT,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
    }),
  );

  app.use(healthRouter);

  app.use(attachUser);
  app.use(authRouter);
  app.use(accountsRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err.name, err.message);
    res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong' } });
  });

  return app;
}
