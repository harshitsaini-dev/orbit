import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(8787),
  APP_URL: z.string().url().default('http://localhost:5173'),
  API_URL: z.string().url().default('http://localhost:8787'),
  AUTH_MODE: z.enum(['local', 'hosted']).default('local'),

  DATABASE_URL: z.string().optional(),
  DATABASE_AUTH_TOKEN: z.string().optional(),

  TOKEN_ENCRYPTION_KEY: z.string().optional(),
  SESSION_SECRET: z.string().optional(),

  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM: z.string().default('Orbit <no-reply@localhost>'),

  SYNC_CRON: z.string().default('*/15 * * * *'),
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

/** Hosted mode is the only mode that sends OTP email and needs a real secret set. */
export function assertHostedSecrets(): void {
  if (env.AUTH_MODE !== 'hosted') return;
  const missing = (['TOKEN_ENCRYPTION_KEY', 'SESSION_SECRET', 'RESEND_API_KEY'] as const).filter(
    (key) => !env[key],
  );
  if (missing.length > 0) {
    throw new Error(`AUTH_MODE=hosted requires: ${missing.join(', ')}`);
  }
}
