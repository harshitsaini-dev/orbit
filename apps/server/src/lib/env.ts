import { z } from 'zod';
import { loadEnvFile } from './load-env.js';

loadEnvFile();

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(8787),
  APP_URL: z.string().url().default('http://localhost:5173'),
  API_URL: z.string().url().default('http://localhost:8787'),
  AUTH_MODE: z.enum(['local', 'hosted']).default('local'),
  /** Set to the shared parent domain in production, e.g. .harshitsaini.in */
  COOKIE_DOMAIN: z.string().optional(),

  DATABASE_URL: z.string().optional(),
  DATABASE_AUTH_TOKEN: z.string().optional(),

  TOKEN_ENCRYPTION_KEY: z.string().optional(),
  SESSION_SECRET: z.string().optional(),

  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM: z.string().default('Orbit <no-reply@localhost>'),

  SYNC_CRON: z.string().default('*/15 * * * *'),

  /** Requests per window, per IP. Auth is the brute-force surface, so it is tighter. */
  AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(20),
  AUTH_RATE_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  SHARE_RATE_LIMIT: z.coerce.number().int().positive().default(240),
  API_RATE_LIMIT: z.coerce.number().int().positive().default(120),
  API_RATE_WINDOW_MS: z.coerce.number().int().positive().default(60 * 1000),
  /**
   * The public API, counted per token rather than per IP.
   *
   * An IP limit punishes everyone behind one NAT and does nothing against a
   * client spread over several addresses; a token is the thing actually making
   * the requests.
   */
  V1_RATE_LIMIT: z.coerce.number().int().positive().default(300),

  /**
   * Streaming a file and fetching a thumbnail are counted separately from
   * metadata calls. A grid of tiles fetches one preview each, so a photo folder
   * would otherwise exhaust the metadata budget in a single scroll.
   */
  TRANSFER_RATE_LIMIT: z.coerce.number().int().positive().default(1200),
  TRANSFER_RATE_WINDOW_MS: z.coerce.number().int().positive().default(60 * 1000),

  /**
   * Exposes /auth/dev/* so tests and local development can read back an OTP
   * without a mailbox. Explicit opt-in, and refused outright in production.
   */
  ENABLE_DEV_AUTH_ENDPOINTS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // console rather than the logger: the logger reads this module for its level
  // and its format, so there is nothing to log with until this has parsed.
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;

/** True only when the dev outbox has been explicitly opted into, outside production. */
export function devAuthEndpointsEnabled(): boolean {
  return env.ENABLE_DEV_AUTH_ENDPOINTS && env.NODE_ENV !== 'production';
}

export function assertHostedSecrets(): void {
  if (env.AUTH_MODE !== 'hosted') return;

  const required: Array<'TOKEN_ENCRYPTION_KEY' | 'SESSION_SECRET' | 'RESEND_API_KEY'> = [
    'TOKEN_ENCRYPTION_KEY',
    'SESSION_SECRET',
  ];

  // Without a mail provider nobody can receive a code - unless the dev outbox is
  // deliberately standing in for one, which only happens outside production.
  if (!devAuthEndpointsEnabled()) required.push('RESEND_API_KEY');

  const missing = required.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`AUTH_MODE=hosted requires: ${missing.join(', ')}`);
  }
}


/** Only the parts of the configuration these checks are about. */
export interface ProductionConfig {
  AUTH_MODE: string;
  ENABLE_DEV_AUTH_ENDPOINTS: boolean;
  DATABASE_URL?: string | undefined;
  TOKEN_ENCRYPTION_KEY?: string | undefined;
  SESSION_SECRET?: string | undefined;
  APP_URL: string;
  API_URL: string;
}

/**
 * Everything wrong with a configuration that would still start.
 *
 * Each of these runs perfectly well and is wrong in a way nothing would
 * surface: a workspace with the sign-in turned off, a database that disappears
 * on the next deploy, cookies sent over plain HTTP.
 *
 * Returned as a list rather than thrown one at a time, because somebody fixing
 * a deployment wants all of it, not one round trip per line.
 */
export function productionProblems(config: ProductionConfig): string[] {
  const problems: string[] = [];

  // The big one. Local mode runs every request as one implicit user with no
  // sign-in at all, which on a public host is an open workspace.
  if (config.AUTH_MODE !== 'hosted') {
    problems.push('AUTH_MODE must be "hosted" in production - local mode has no sign-in');
  }

  if (config.ENABLE_DEV_AUTH_ENDPOINTS) {
    problems.push('ENABLE_DEV_AUTH_ENDPOINTS must be off in production - it reads back OTP codes');
  }

  // Without it, libSQL writes a file inside the container, and a container is
  // not somewhere anything survives.
  if (!config.DATABASE_URL) {
    problems.push('DATABASE_URL must be set in production - a local file is lost on every deploy');
  }

  // AES-256 wants exactly 32 bytes. A shorter key is either padded or rejected
  // depending on where it is used, and neither is something to discover later.
  if (config.TOKEN_ENCRYPTION_KEY) {
    const bytes = Buffer.from(config.TOKEN_ENCRYPTION_KEY, 'base64').length;
    if (bytes !== 32) {
      problems.push(`TOKEN_ENCRYPTION_KEY must be 32 bytes of base64, not ${bytes}`);
    }
  }

  if (config.SESSION_SECRET && config.SESSION_SECRET.length < 32) {
    problems.push('SESSION_SECRET must be at least 32 characters');
  }

  // Session cookies are marked secure in production, so a browser on an http
  // origin silently drops them and nobody can stay signed in.
  for (const key of ['APP_URL', 'API_URL'] as const) {
    if (!config[key].startsWith('https://')) problems.push(`${key} must be https in production`);
  }

  return problems;
}

/**
 * The same checks, applied at boot, before anything is served - because the
 * alternative is finding out from a user.
 */
export function assertProductionSafety(): void {
  if (env.NODE_ENV !== 'production') return;

  const problems = productionProblems(env);
  if (problems.length > 0) {
    throw new Error(['Refusing to start in production:', ...problems].join('\n  - '));
  }
}
