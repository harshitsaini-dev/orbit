import { listAdapters } from '@orbit/adapters';
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
