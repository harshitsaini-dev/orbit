import 'dotenv/config';
import { z } from 'zod';

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
  API_RATE_LIMIT: z.coerce.number().int().positive().default(120),
  API_RATE_WINDOW_MS: z.coerce.number().int().positive().default(60 * 1000),

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

