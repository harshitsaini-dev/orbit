import { getAdapter, listAdapters } from '@orbit/adapters';
import { PROVIDER_CATALOGUE, UNAVAILABLE_PROVIDERS } from '@orbit/shared-types';
import { Router } from 'express';
import { env } from '../lib/env.js';
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
    unavailable: UNAVAILABLE_PROVIDERS,
  });
});
