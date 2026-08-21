# Deployment runbook

Target: `orbit.harshitsaini.in` (frontend) and `api.orbit.harshitsaini.in` (backend).
Every service below is on a free tier that does not require a payment card.

## 1. Database — Turso

```bash
turso db create orbit-prod
turso db show orbit-prod --url
turso db tokens create orbit-prod
```

Keep the URL and token; they become `DATABASE_URL` and `DATABASE_AUTH_TOKEN` on Render.

Apply migrations against it once:

```bash
DATABASE_URL=libsql://... DATABASE_AUTH_TOKEN=... npm run db:migrate
```

## 2. Email — Resend

Verify `signal.harshitsaini.in` for sending, then create an API key. Set `RESEND_API_KEY` and
`RESEND_FROM="Orbit <no-reply@signal.harshitsaini.in>"` on Render.

## 3. Backend — Render

- New → Web Service → connect the GitHub repo.
- Root directory: repository root. Build: `npm ci`. Start: `npm start -w @orbit/server`.
- Environment variables:

  | Key | Value |
  |---|---|
  | `NODE_ENV` | `production` |
  | `AUTH_MODE` | `hosted` |
  | `APP_URL` | `https://orbit.harshitsaini.in` |
  | `API_URL` | `https://api.orbit.harshitsaini.in` |
  | `DATABASE_URL` / `DATABASE_AUTH_TOKEN` | from step 1 |
  | `TOKEN_ENCRYPTION_KEY` / `SESSION_SECRET` | 32 random bytes, base64 |
  | `RESEND_API_KEY` / `RESEND_FROM` | from step 2 |
  | `SYNC_CRON` | `*/15 * * * *` |
  | provider OAuth client id/secret pairs | per provider, as adapters land |

- Add the custom domain `api.orbit.harshitsaini.in`.

## 4. Frontend — Vercel

- Import the repo. Root directory `apps/web`, framework preset Vite.
- Build command `npm run build`, output `dist`.
- Environment: `VITE_API_URL=https://api.orbit.harshitsaini.in`.
- Add the custom domain `orbit.harshitsaini.in`.

## 5. DNS — Cloudflare (free plan, DNS only)

| Type | Name | Target |
|---|---|---|
| CNAME | `orbit` | Vercel's target for the project |
| CNAME | `api.orbit` | Render's `onrender.com` hostname |

## 6. Provider OAuth apps

Register each provider's OAuth app with redirect URI
`https://api.orbit.harshitsaini.in/auth/callback/:provider`. All registrations are free and none
require billing. Keep every client secret in Render's environment — never in the repo.

## 7. Keep-alive

Render's free instance sleeps after 15 minutes idle. Add a free UptimeRobot (or cron-job.org)
monitor hitting `https://api.orbit.harshitsaini.in/health` every 10 minutes.

## 8. CI

`ci.yml` and `e2e.yml` run on every push and pull request. Actions minutes are unmetered on a
public repository.
