# Project state

_Last updated: 2026-08-21_

## Current phase

**Phase 0 — Foundation.** Scaffold is in place; infrastructure accounts are not yet created.

## Phase board

| Phase | Title | Status |
|---|---|---|
| 0 | Foundation (monorepo, CI, docs, infra accounts) | 🟡 In progress |
| 1 | Auth (email OTP, sessions, local-mode bypass) | ⚪ Not started |
| 2 | First adapter — Google Drive | ⚪ Not started |
| 3 | Remaining adapters (OneDrive, Dropbox, MEGA, pCloud, S3) | ⚪ Not started |
| 4 | Unified workspace views | ⚪ Not started |
| 5 | Upload system + WebSocket progress + allocation | ⚪ Not started |
| 6 | Sync engine | ⚪ Not started |
| 7 | Sharing + QR | ⚪ Not started |
| 8 | RBAC + superadmin | ⚪ Not started |
| 9 | Design pass (Claymorphism, three.js, PWA) | ⚪ Not started |
| 10 | Hardening + deploy | ⚪ Not started |

## Done

- npm-workspaces monorepo: `apps/web`, `apps/server`, `packages/{shared-types,db,adapters}`.
- `ProviderAdapter` contract + `OrbitFile` normalised model in `packages/shared-types`.
- Drizzle schema for all 10 tables (users, accounts, files_mirror, share_links, sessions,
  otp_codes, workspaces, workspace_members, sync_log, audit_log) against libSQL, so the same
  code targets a local SQLite file or Turso via one env var.
- `BaseAdapter` + 6 provider stubs + registry, and the shared contract test suite that every
  adapter must pass.
- Express app with helmet/CORS/cookie-parser, `/auth` and `/api` rate limits, `/health` and
  `/health/providers`, plus server tests covering all three.
- Channel-based WebSocket hub attached to the same HTTP server (one Render service).
- node-cron scheduler wired and validated; the sync pass body lands in Phase 6.
- AES-256-GCM token encryption helpers and a log redactor.
- Vite + React + PWA frontend, Claymorphism token system, light/dark/system theming with an
  accent picker, three.js orbiting-spheres hero.
- Playwright config (headed locally, headless in CI) with a smoke suite; GitHub Actions `ci.yml`
  and `e2e.yml`.

## In progress

- Nothing actively in flight.

## Next up (Phase 0 completion)

1. `git init` + first commit, create the public GitHub repo via `gh`.
2. Create the free-tier accounts: Turso, Render, Vercel, Resend, Cloudflare DNS.
3. Fill `.env` from `.env.example` (generate `TOKEN_ENCRYPTION_KEY` and `SESSION_SECRET`).
4. Generate and apply the first Drizzle migration (`npm run db:generate && npm run db:migrate`).
5. Deploy the empty shell to Vercel + Render so every later phase has a live target.

## Known issues / open questions

- `.claude/settings.json` is gitignored per the global no-agent-files rule, so the attribution
  suppression does not travel with the repo. The `commit-msg` hook in `scripts/install-hooks.sh`
  is the portable safety net — run it after every fresh clone.
- Icon assets `public/icon-192.png` and `public/icon-512.png` referenced by the PWA manifest are
  not created yet; they land in Phase 9.
- MEGA has no official public API SDK for Node with delta support — the adapter's `delta`
  capability is declared `false` and Phase 3 will fall back to full re-listing for it.
