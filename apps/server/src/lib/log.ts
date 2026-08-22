import { env } from './env.js';

/**
 * One place every line of server output goes through.
 *
 * Two reasons it exists rather than `console.log` everywhere.
 *
 * The first is redaction. Orbit holds OAuth tokens, session cookies and
 * one-time codes, and a log is the easiest place for one to escape - not
 * through a deliberate `console.log(token)`, but through logging an object
 * that happens to contain one, or a URL with `?access_token=` in it. Anything
 * that looks like a secret is replaced here, so a careless field is a redacted
 * field rather than a leak.
 *
 * The second is shape. In production these lines are read by whatever collects
 * them, which wants one JSON object per line; locally they are read by a person
 * watching a terminal, who does not. Both come out of the same call.
 */

export type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Below this nothing is written. Debug is noise outside development. */
const THRESHOLD = ORDER[env.NODE_ENV === 'production' ? 'info' : 'debug'];

export type Fields = Record<string, unknown>;

/**
 * Field names whose value never gets written, whatever it holds.
 *
 * Matched loosely and case-insensitively: `accessToken`, `access_token`,
 * `refreshToken` and `x-access-token` are all the same mistake, and a list of
 * exact spellings would miss the next one.
 */
const SECRET_KEY = /(token|secret|password|passphrase|cookie|authorization|otp|credential|signature|apikey|api_key|encryptedtokens|accesskey|privatekey)/i;

/** Query parameters that carry a secret, wherever a URL is written. */
const SECRET_PARAM = /([?&](?:access_token|refresh_token|token|code|key|signature|sig|password|api_key|apikey)=)[^&\s]*/gi;

const REDACTED = '[redacted]';

/** Strings that are themselves a credential, wherever they turn up. */
function scrubText(text: string): string {
  return text
    .replace(SECRET_PARAM, `$1${REDACTED}`)
    // An Authorization header quoted into a message, which is how a token
    // usually reaches a log: inside an error rather than as a field.
    .replace(/\b(bearer|basic)\s+[\w.\-+/=]+/gi, `$1 ${REDACTED}`)
    // AWS-style credentials in a signed URL or an error from an object store.
    .replace(/\b(AKIA|ASIA)[A-Z0-9]{12,}/g, REDACTED);
}

/**
 * A value safe to write down.
 *
 * Depth-limited and cycle-safe, because this runs on whatever a caller passed:
 * an error, a request, a provider response. A logger that throws while logging
 * turns a handled failure into a crash.
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 6) return '[deep]';

  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1, seen));

  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubText(value.message),
      ...(value.cause ? { cause: redact(value.cause, depth + 1, seen) } : {}),
    };
  }

  const out: Fields = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? REDACTED : redact(item, depth + 1, seen);
  }

  return out;
}

function write(level: Level, message: string, fields?: Fields): void {
  if (ORDER[level] < THRESHOLD) return;

  const safeMessage = scrubText(message);
  const safeFields = fields ? (redact(fields) as Fields) : undefined;
  const stream = level === 'error' || level === 'warn' ? console.error : console.log;

  if (env.NODE_ENV === 'production') {
    stream(JSON.stringify({ level, time: new Date().toISOString(), message: safeMessage, ...safeFields }));
    return;
  }

  // Developing: a person is reading this, so the message leads and the fields
  // trail it as key=value rather than as JSON.
  const trailer = safeFields
    ? Object.entries(safeFields)
        .filter(([, item]) => item !== undefined)
        // JSON for anything structured: `String(object)` is "[object Object]",
        // which is the least useful thing a log line can say.
        .map(([key, item]) => `${key}=${typeof item === 'object' ? JSON.stringify(item) : String(item as string | number | boolean)}`)
        .join(' ')
    : '';

  stream(`${level.padEnd(5)} ${safeMessage}${trailer ? ` ${trailer}` : ''}`);
}

export const log = {
  debug: (message: string, fields?: Fields) => write('debug', message, fields),
  info: (message: string, fields?: Fields) => write('info', message, fields),
  warn: (message: string, fields?: Fields) => write('warn', message, fields),
  error: (message: string, fields?: Fields) => write('error', message, fields),
};
