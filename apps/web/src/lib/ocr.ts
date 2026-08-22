import type { Worker } from 'tesseract.js';

/**
 * Reading the text out of a picture, on the machine looking at it.
 *
 * The engine is Tesseract compiled to WebAssembly, running in a Web Worker, so
 * a scan does not freeze the page it was started from. Nothing is uploaded: the
 * bytes the browser already fetched to draw a thumbnail are the bytes it reads,
 * and only the resulting string is sent to Orbit.
 *
 * That is not a nice-to-have, it is the reason this exists at all. Server-side
 * OCR is a bill per page, and a product whose first rule is that it stores none
 * of your files has no business sending them to a paid vision API instead.
 *
 * Everything here is loaded on demand. The engine is about six megabytes the
 * first time and nothing afterwards - too much to put in the bundle that loads
 * when somebody opens their drive to look at one photo.
 */

export interface Reading {
  text: string;
  /** Mean confidence over the page, 0-100, as the engine reports it. */
  confidence: number;
}

/**
 * Served by Orbit itself rather than from a CDN.
 *
 * The Content-Security-Policy allows scripts and workers from this origin
 * only, so a CDN worker is blocked outright - and loading one would tell a
 * third party who is scanning what, which the privacy policy says does not
 * happen. `scripts/vendor-tesseract.mjs` puts them here at build time.
 */
const PATHS = {
  workerPath: '/tesseract/worker.min.js',
  corePath: '/tesseract/core',
  langPath: '/tesseract/lang',
};

/**
 * One worker, kept alive between scans.
 *
 * Starting one costs several seconds - the WebAssembly has to be fetched,
 * compiled and handed the language data - and a folder of forty photos would
 * pay that forty times. It is terminated when the page has finished with it.
 */
let worker: Worker | null = null;
let starting: Promise<Worker> | null = null;

async function engine(onProgress?: (ratio: number) => void): Promise<Worker> {
  if (worker) return worker;
  if (starting) return starting;

  starting = (async () => {
    // Imported here rather than at the top of the file so the six megabytes
    // arrive when somebody scans something, not when they open the app.
    const { createWorker } = await import('tesseract.js');

    const made = await createWorker('eng', 1, {
      ...PATHS,
      /*
       * The neural recogniser only. The legacy engine is a separate, older
       * recogniser with its own core build and its own trained data, and
       * saying so here is what lets the build ship three files instead of
       * nineteen.
       */
      legacyCore: false,
      legacyLang: false,
      logger: onProgress
        ? (message: { status: string; progress: number }) => {
            // Only the part that is actually the reading. The setup steps
            // report their own 0-to-1 as well, and a bar that fills three
            // times reads as broken.
            if (message.status === 'recognizing text') onProgress(message.progress);
          }
        : undefined,
    });

    worker = made;
    return made;
  })();

  try {
    return await starting;
  } finally {
    starting = null;
  }
}

/** Lets go of the engine and its six megabytes of compiled WebAssembly. */
export async function stopOcr(): Promise<void> {
  const current = worker;
  worker = null;
  if (current) await current.terminate();
}

/**
 * Reads one image.
 *
 * Takes a blob rather than a URL: the caller has already fetched the file to
 * show it, and handing the bytes over directly saves a second download of
 * something that can be several megabytes.
 */
export async function readImage(
  blob: Blob,
  onProgress?: (ratio: number) => void,
): Promise<Reading> {
  const tesseract = await engine(onProgress);
  const { data } = await tesseract.recognize(blob);

  return {
    // Tesseract preserves the layout with runs of spaces and newlines, which
    // matters for reading a page and not at all for finding one.
    text: data.text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim(),
    confidence: data.confidence,
  };
}

/** Whether there is any point offering to read this file. */
export function isReadable(mimeType: string, name: string): boolean {
  if (mimeType.startsWith('image/')) {
    // Vector and animated formats are not photographs of anything.
    return !/svg|gif/i.test(mimeType);
  }

  return /\.(jpe?g|png|bmp|tiff?|webp)$/i.test(name);
}
