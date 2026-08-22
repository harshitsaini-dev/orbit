import { createServer } from 'node:http';
import { createApp } from './app.js';
import { assertHostedSecrets, assertProductionSafety, env } from './lib/env.js';
import { log } from './lib/log.js';
import { recoverInterrupted } from './services/transfers.js';
import { hub } from './lib/ws.js';
import { detectRenderers } from './services/renderers.js';
import { startSyncScheduler } from './services/sync-scheduler.js';

assertProductionSafety();
assertHostedSecrets();

const server = createServer(createApp());
hub.attach(server);

const scheduler = startSyncScheduler();

server.listen(env.PORT, () => {
  log.info('orbit api listening', { port: env.PORT, mode: env.AUTH_MODE, env: env.NODE_ENV });

  // A row saying "running" with nothing running is what an interrupted
  // transfer looks like after a restart, and this instance restarts on every
  // deploy. Left alone it would sit there claiming progress it is not making.
  void recoverInterrupted().then((count) => {
    if (count > 0) log.warn('transfers interrupted by a restart, marked paused', { count });
  });

  // Said out loud rather than left to be inferred from thumbnails that do or do
  // not appear. Neither tool is a dependency: with them, video and PDF get
  // tiles; without them, those files show an icon and nothing else changes.
  void detectRenderers().then((found) => {
    log.info('thumbnail renderers', { images: true, video: found.video, pdf: found.pdf });
  });
});

/**
 * How long a shutdown is allowed to take before the process stops asking.
 *
 * Something is always mid-flight here - a file being streamed from a provider,
 * a chunk being pushed to one. Those deserve a moment to finish. What they do
 * not get is forever: a platform that asked for a shutdown will kill the
 * process anyway, and being killed is a worse ending than exiting on purpose.
 */
const GRACE_MS = 10_000;

let stopping = false;

function shutdown(signal: string): void {
  // A second Ctrl-C means "now", not "start again".
  if (stopping) {
    log.warn('second signal, exiting immediately', { signal });
    process.exit(1);
  }

  stopping = true;
  log.info('shutting down', { signal });

  scheduler.stop();
  // Before the server: a WebSocket never ends on its own, so closing the
  // server first would wait on connections that are designed not to close.
  hub.close();

  const timer = setTimeout(() => {
    log.warn('shutdown timed out, exiting anyway', { afterMs: GRACE_MS });
    process.exit(1);
  }, GRACE_MS);

  // Nothing should keep the process alive purely to wait for this timer.
  timer.unref();

  server.close(() => {
    clearTimeout(timer);
    log.info('closed cleanly');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

/*
 * A crash with nothing written is the worst way to lose a deployment: the
 * platform restarts the process, the loop repeats, and the log says nothing
 * about why. These two say why, then exit - a process that has already thrown
 * from somewhere unknown is not in a state worth continuing from.
 */
process.on('uncaughtException', (error) => {
  log.error('uncaught exception', { error });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection', { error: reason });
  process.exit(1);
});
