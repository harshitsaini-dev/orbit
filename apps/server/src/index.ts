import { createServer } from 'node:http';
import { createApp } from './app.js';
import { assertHostedSecrets, env } from './lib/env.js';
import { hub } from './lib/ws.js';
import { startSyncScheduler } from './services/sync-scheduler.js';

assertHostedSecrets();

const server = createServer(createApp());
hub.attach(server);

const scheduler = startSyncScheduler();

server.listen(env.PORT, () => {
  console.log(`orbit api listening on :${env.PORT} (mode=${env.AUTH_MODE})`);
});

function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);
  scheduler.stop();
  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
