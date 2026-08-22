import { createServer } from 'node:http';
import { createApp } from './app.js';
import { assertHostedSecrets, env } from './lib/env.js';
import { recoverInterrupted } from './services/transfers.js';
import { hub } from './lib/ws.js';
import { detectRenderers } from './services/renderers.js';
import { startSyncScheduler } from './services/sync-scheduler.js';

assertHostedSecrets();

const server = createServer(createApp());
hub.attach(server);

const scheduler = startSyncScheduler();

server.listen(env.PORT, () => {
  console.log(`orbit api listening on :${env.PORT} (mode=${env.AUTH_MODE})`);

  // A row saying "running" with nothing running is what an interrupted
  // transfer looks like after a restart, and this instance restarts on every
  // deploy. Left alone it would sit there claiming progress it is not making.
  void recoverInterrupted().then((count) => {
    if (count > 0) console.log(`${count} transfer(s) interrupted by a restart, marked paused`);
  });

  // Said out loud rather than left to be inferred from thumbnails that do or do
  // not appear. Neither tool is a dependency: with them, video and PDF get
  // tiles; without them, those files show an icon and nothing else changes.
  void detectRenderers().then((found) => {
    const have = [found.video && 'video (ffmpeg)', found.pdf && 'pdf (poppler)'].filter(Boolean);
    console.log(
      have.length > 0
        ? `thumbnails: images, plus ${have.join(' and ')}`
        : 'thumbnails: images only (install ffmpeg for video, poppler-utils for pdf)',
    );
  });
});

function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);
  scheduler.stop();
  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
