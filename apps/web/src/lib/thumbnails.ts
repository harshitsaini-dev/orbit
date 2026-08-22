import type { OrbitFile } from '@orbit/shared-types';
import { previewKindFor } from './preview.js';

/**
 * A queue for thumbnail fetches.
 *
 * Without one, every tile that scrolls past fires its own request at once.
 * Scrolling a folder of five hundred photos queued nearly four hundred requests,
 * saturated the browser's six connections to the origin, and left anything else
 * — opening a file, listing a folder — waiting behind them indefinitely. Each
 * thumbnail also costs the server two calls to the provider, so the flood was
 * pointless as well as harmful.
 *
 * At most a handful run at a time, and a tile scrolled out of view cancels its
 * request instead of holding a slot for an image nobody is looking at.
 */

const MAX_IN_FLIGHT = 4;

interface Job {
  url: string;
  signal: AbortSignal;
  resolve: (blobUrl: string) => void;
  reject: (error: Error) => void;
}

const queue: Job[] = [];
let inFlight = 0;

function pump(): void {
  while (inFlight < MAX_IN_FLIGHT && queue.length > 0) {
    const job = queue.shift()!;

    if (job.signal.aborted) {
      job.reject(new DOMException('Aborted', 'AbortError'));
      continue;
    }

    inFlight += 1;

    fetch(job.url, { credentials: 'include', signal: job.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.blob();
      })
      .then((blob) => job.resolve(URL.createObjectURL(blob)))
      .catch((error: Error) => job.reject(error))
      .finally(() => {
        inFlight -= 1;
        pump();
      });
  }
}

export function fetchThumbnail(url: string, signal: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const job: Job = { url, signal, resolve, reject };

    // A tile that leaves the viewport before its turn should give up its place
    // rather than keep a slot for an image nobody is looking at.
    signal.addEventListener(
      'abort',
      () => {
        const index = queue.indexOf(job);
        if (index >= 0) {
          queue.splice(index, 1);
          reject(new DOMException('Aborted', 'AbortError'));
        }
      },
      { once: true },
    );

    queue.push(job);
    pump();
  });
}

/** Test seam and a way to see the queue is behaving. */
export function thumbnailQueueState(): { inFlight: number; queued: number } {
  return { inFlight, queued: queue.length };
}

/**
 * Whether asking for a thumbnail is worth a request at all.
 *
 * Providers differ in what they render — Drive makes tiles for video, PDFs and
 * documents; an object store gets images only, because Orbit renders those
 * itself and nothing more. The grid cannot know which, so it asks for anything
 * that some provider might have and shows an icon when the answer is no.
 *
 * What it does not ask about is the rest: a folder of five hundred text files
 * or archives would otherwise spend five hundred requests learning that none of
 * them has a picture.
 */
export function mightHaveThumbnail(
  file: Pick<OrbitFile, 'mimeType' | 'name' | 'sizeBytes' | 'isFolder'>,
): boolean {
  if (file.isFolder) return false;

  const kind = previewKindFor(file);
  return (
    kind === 'image' ||
    kind === 'video' ||
    kind === 'pdf' ||
    kind === 'document' ||
    kind === 'presentation'
  );
}
