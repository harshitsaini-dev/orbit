import { spawn } from 'node:child_process';

/**
 * Optional external renderers, used when the machine happens to have them.
 *
 * Drive makes thumbnails for video and PDFs as well as images. Orbit can too,
 * but only with tools that are not a free tier's to spend: a video frame needs
 * ffmpeg and a PDF page needs poppler, and both are sustained CPU competing
 * with request serving on a single node.
 *
 * So neither is a dependency. Both are looked for once at start-up, and the
 * feature exists exactly when the tool does. On the free instance nothing is
 * found and those files show an icon, as they did before. On a machine with
 * ffmpeg installed — a bigger instance, a container that adds it, somebody's
 * own server — video thumbnails simply start appearing, with no flag to set
 * and no code path that was written and then never used.
 *
 * The cost of that shape is one probe per tool at boot. The alternative is a
 * setting somebody has to know to turn on, which is worse: the honest answer to
 * "can this machine do it" is to ask the machine.
 */

/** Long enough for a cold binary on a slow disk, short enough not to stall boot. */
const PROBE_TIMEOUT_MS = 3_000;

/**
 * A frame this far in, rather than the first.
 *
 * Video routinely opens on black, a fade, or a title card. One second in is
 * usually the first frame that says anything about the file.
 */
const FRAME_AT_SECONDS = 1;

/** Past this, decoding costs more than the tile is worth. */
const RENDER_TIMEOUT_MS = 15_000;

/** What a renderer is allowed to write back, so a hostile file cannot fill memory. */
const MAX_OUTPUT_BYTES = 24 * 1024 * 1024;

/**
 * Where to find each tool.
 *
 * A bare name is looked up on PATH, which is the usual case. The overrides are
 * for the two situations where that is not enough: a build that installs ffmpeg
 * somewhere deliberate rather than on PATH, and Windows, where Node's spawn
 * resolves `.exe` but not `.cmd` or `.bat` unless given the full name.
 *
 * Read at call time, not at module load, so a test can point them somewhere and
 * so a container can set them after the image is built.
 */
function binary(tool: 'ffmpeg' | 'pdftoppm'): string {
  const override = process.env[tool === 'ffmpeg' ? 'ORBIT_FFMPEG' : 'ORBIT_PDFTOPPM'];
  return override && override.trim() ? override : tool;
}

/**
 * How to actually launch it.
 *
 * Since CVE-2024-27980, Node refuses outright to spawn a `.cmd` or `.bat` on
 * Windows without a shell - it throws EINVAL rather than returning an error.
 * That is not a corner case here: scoop installs ffmpeg as a `.cmd` shim, so a
 * Windows machine that plainly has ffmpeg would report that it does not.
 *
 * So those two go through cmd.exe, with the arguments still passed as a list
 * and quoted by hand for it. Nothing user-supplied reaches this: every argument
 * is a literal in this file, and the file itself goes in on stdin.
 */
function launch(command: string, args: string[]): { file: string; args: string[]; verbatim: boolean } {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    return {
      file: process.env['COMSPEC'] ?? 'cmd.exe',
      /*
       * /d skips AutoRun scripts. /s makes the quoting rule predictable, at the
       * price of a quirk: cmd strips the first and last character of the whole
       * command when both are quotes, so the line needs an outer pair of its
       * own or the path and the first argument arrive fused together.
       */
      args: ['/d', '/s', '/c', `""${command}" ${args.map((a) => `"${a}"`).join(' ')}"`],
      verbatim: true,
    };
  }

  return { file: command, args, verbatim: false };
}

export interface Renderers {
  /** ffmpeg, for a frame out of a video. */
  video: boolean;
  /** pdftoppm from poppler-utils, for the first page of a PDF. */
  pdf: boolean;
}

let detected: Renderers | null = null;

function probe(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (found: boolean) => {
      if (settled) return;
      settled = true;
      resolve(found);
    };

    try {
      const how = launch(command, args);
      const child = spawn(how.file, how.args, {
        stdio: 'ignore',
        windowsVerbatimArguments: how.verbatim,
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        done(false);
      }, PROBE_TIMEOUT_MS);

      // ENOENT is the ordinary answer here, not a fault: it means the machine
      // does not have the tool, which is most machines.
      child.on('error', () => {
        clearTimeout(timer);
        done(false);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        done(code === 0);
      });
    } catch {
      done(false);
    }
  });
}

/**
 * Looks for the tools once and remembers the answer.
 *
 * Called at start-up so the first request does not pay for it, and so the log
 * says plainly what this instance can and cannot do.
 */
export async function detectRenderers(): Promise<Renderers> {
  if (detected) return detected;

  const [video, pdf] = await Promise.all([
    probe(binary('ffmpeg'), ['-version']),
    probe(binary('pdftoppm'), ['-v']),
  ]);

  detected = { video, pdf };
  return detected;
}

/** What this instance can render beyond images. Empty until detection has run. */
export function renderers(): Renderers {
  return detected ?? { video: false, pdf: false };
}

/** For tests, and for a machine that gains a tool without a restart. */
export function setRenderers(value: Renderers | null): void {
  detected = value;
}

interface RunResult {
  ok: boolean;
  stdout: Buffer;
}

/**
 * Feeds bytes to a command's stdin and collects its stdout.
 *
 * Nothing touches disk. A temp file would be simpler and would let ffmpeg seek
 * freely, but writing a user's file to Orbit's disk is the one thing this
 * product does not do, and it is not worth breaking for a thumbnail.
 */
function run(command: string, args: string[], input: Buffer): Promise<RunResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;

    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve({ ok, stdout: ok ? Buffer.concat(chunks) : Buffer.alloc(0) });
    };

    let child;
    try {
      const how = launch(command, args);
      child = spawn(how.file, how.args, {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsVerbatimArguments: how.verbatim,
      });
    } catch {
      finish(false);
      return;
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(false);
    }, RENDER_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(false);
        return;
      }
      chunks.push(chunk);
    });

    child.on('error', () => {
      clearTimeout(timer);
      finish(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code === 0 && chunks.length > 0);
    });

    // A renderer that has seen enough closes stdin early, and writing on is
    // then an EPIPE rather than a problem.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/**
 * One frame from a video, as PNG bytes, or null.
 *
 * The input is a prefix of the file rather than all of it — a two-gigabyte
 * video should not be pulled through the server to draw a tile. That prefix has
 * to contain the index: MP4s written with `faststart` put it at the front and
 * decode fine, and ones that put it at the end do not. Those return null and
 * show an icon, which is the honest outcome rather than a partial download of
 * the whole file to be sure.
 */
export async function videoFrame(prefix: Buffer): Promise<Buffer | null> {
  if (!renderers().video) return null;

  const result = await run(
    binary('ffmpeg'),
    [
      '-hide_banner',
      '-loglevel', 'error',
      // Before -i: a fast seek, done by the demuxer rather than by decoding
      // every frame up to that point.
      '-ss', String(FRAME_AT_SECONDS),
      '-i', 'pipe:0',
      '-frames:v', '1',
      // The prefix is truncated mid-frame by definition, so the tail is
      // garbage and ffmpeg should not treat it as a failure.
      '-err_detect', 'ignore_err',
      '-f', 'image2',
      '-vcodec', 'png',
      'pipe:1',
    ],
    prefix,
  );

  if (result.ok) return result.stdout;

  // A short clip has no frame one second in. Try the very first.
  const first = await run(
    binary('ffmpeg'),
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-frames:v', '1',
      '-err_detect', 'ignore_err',
      '-f', 'image2',
      '-vcodec', 'png',
      'pipe:1',
    ],
    prefix,
  );

  return first.ok ? first.stdout : null;
}

/**
 * The first page of a PDF, as PNG bytes, or null.
 *
 * Rendered at a low DPI: this becomes a tile a few hundred pixels wide, and
 * rasterising an A4 page at print resolution to then throw most of it away is
 * the expensive way to get the same picture.
 */
export async function pdfFirstPage(bytes: Buffer): Promise<Buffer | null> {
  if (!renderers().pdf) return null;

  const result = await run(
    binary('pdftoppm'),
    ['-png', '-f', '1', '-l', '1', '-r', '72', '-cropbox', '-', '-'],
    bytes,
  );

  return result.ok ? result.stdout : null;
}
