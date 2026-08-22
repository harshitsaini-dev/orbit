import { getAdapter, listAdapters } from '@orbit/adapters';
import { PROVIDER_CATALOGUE } from '@orbit/shared-types';
import { Router } from 'express';
import { sql } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { env } from '../lib/env.js';
import { log } from '../lib/log.js';
import { hub } from '../lib/ws.js';

export const healthRouter: Router = Router();

const startedAt = Date.now();

/** Kept cheap and unauthenticated - the uptime pinger hits this to keep Render warm. */
healthRouter.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    mode: env.AUTH_MODE,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    wsConnections: hub.connectionCount,
  });
});

/**
 * Whether this instance can actually serve, as opposed to being up.
 *
 * `/health` answers from memory and would keep saying "ok" with the database
 * unreachable - which is exactly the state a load balancer must not send
 * traffic into. This one asks the database a question and reports 503 if it
 * cannot answer, so a deploy that cannot reach Turso never takes over from the
 * instance that can.
 *
 * Separate from /health because they are for different callers: the uptime
 * pinger wants something free, an orchestrator wants the truth.
 */
healthRouter.get('/health/ready', async (_req, res) => {
  try {
    await db().run(sql`select 1`);
    res.json({ ready: true });
  } catch (err) {
    log.error('readiness check failed', { error: err });
    res.status(503).json({ ready: false, reason: 'database_unreachable' });
  }
});

/** The adapters themselves - one per distinct provider API. */
healthRouter.get('/health/providers', (_req, res) => {
  res.json({
    providers: listAdapters().map((adapter) => ({
      id: adapter.id,
      displayName: adapter.displayName,
      authType: adapter.authType,
      capabilities: adapter.capabilities,
    })),
  });
});

/**
 * What "Connect an account" offers. Several entries share the s3 adapter and
 * differ only in endpoint, so this is a longer list than /health/providers.
 * Also reports the services Orbit cannot support, with the reason, so the UI
 * can say so instead of just omitting them.
 */
healthRouter.get('/api/catalogue', (_req, res) => {
  res.json({
    entries: PROVIDER_CATALOGUE.map((entry) => ({
      ...entry,
      capabilities: getAdapter(entry.provider).capabilities,
      authType: getAdapter(entry.provider).authType,
    })),
  });
});
