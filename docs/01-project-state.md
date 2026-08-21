# Project state

_Last updated: 2026-08-21_

## Current phase

**Phase 1 — Auth. Complete.** Phase 0 is complete apart from the infrastructure accounts,
which need the owner's hands (see "Blocked on the owner" below).

Repository: <https://github.com/harshitsaini-dev/orbit> (public).

## Phase board

| Phase | Title | Status |
|---|---|---|
| 0 | Foundation (monorepo, CI, docs, infra accounts) | 🟢 Code done · infra accounts pending |
| 1 | Auth (email OTP, sessions, local-mode bypass) | 🟢 Done |
| 2 | First adapter — Google Drive | ⚪ Next |
| 3 | Remaining adapters (OneDrive, Dropbox, MEGA, pCloud, S3) | ⚪ Not started |
| 4 | Unified workspace views | ⚪ Not started |
| 5 | Upload system + WebSocket progress + allocation | ⚪ Not started |
| 6 | Sync engine | ⚪ Not started |
| 7 | Sharing + QR | ⚪ Not started |
| 8 | RBAC + superadmin | ⚪ Not started |
| 9 | Design pass (Claymorphism, three.js, PWA) | ⚪ Not started |
| 10 | Hardening + deploy | ⚪ Not started |

## Done

### Phase 0 — Foundation
- npm-workspaces monorepo: `apps/web`, `apps/server`, `packages/{shared-types,db,adapters}`.
- `ProviderAdapter` contract, normalised `OrbitFile`, and per-provider capability flags so the
  UI hides unsupported actions rather than failing them.
- Drizzle schema for all ten tables against libSQL — one code path for a local SQLite file and
  for Turso.
- `BaseAdapter` + 6 provider stubs + registry, and the shared contract suite every adapter must
  pass before being wired into the allocation engine.
- Express app (helmet, CORS, cookie-parser, env-driven rate limits), WebSocket hub, and the
  node-cron scheduler — one process, one free Render service.
- Vite + React + PWA frontend, Claymorphism tokens, three-way theming with an accent picker,
  three.js orbiting-spheres hero.
- Playwright (headed locally, headless in CI) and GitHub Actions `ci.yml` / `e2e.yml`.

### Phase 1 — Auth
- Passwordless 6-digit email OTP: scrypt-hashed at rest, 5-minute expiry, 5-attempt cap,
  60-second resend cooldown.
- Both auth endpoints answer identically for known and unknown addresses, and every verify
  failure returns one indistinguishable error — no account enumeration. Asserted by tests.
- Sessions: 32 random bytes, stored as a SHA-256 fingerprint, in an `httpOnly` +
  `sameSite=strict` cookie. Logout deletes the row, so a replayed cookie fails.
- Sign-in is registration; the first account created becomes `superadmin`.
- `AUTH_MODE=local` bypasses OTP entirely and runs as one implicit user.
- Resend mailer with a console transport (and a gated dev outbox) when no API key is set.
- `attachUser` / `requireAuth` / `requireRole` middleware. Admin routes 404 rather than 403 so
  the admin surface is not confirmed to a non-admin; the frontend mirrors this.
- Frontend: two-step login screen with resend cooldown, `AuthProvider`, protected routes, and
  a sign-out control.

## Verification (last run, 2026-08-21)

| Check | Result |
|---|---|
| `npm run typecheck --workspaces` | clean |
| `npm test --workspaces` | 55 pass, 0 fail (28 server, 27 adapters) |
| `npm run build --workspaces` | clean |
| `npx playwright test` | 21 pass, 0 fail — four consecutive clean runs |

## Next up — Phase 2 (Google Drive adapter)

1. Register the Google OAuth app; redirect URI `/auth/callback/google_drive`.
2. Implement `connect` / `refreshToken` and the account-connection routes, storing tokens
   AES-256-GCM encrypted.
3. Implement `listFolder`, `getFileMeta`, `getFileStream` (range-aware), `createFolder`,
   `rename`, `remove`, `star`, `getQuota`.
4. Adapter-level tests against mocked Drive responses, plus an E2E pass over the connect flow.

## Blocked on the owner

Step-by-step instructions for all of these are in **`docs/05-owner-setup.md`**.

- **Google OAuth client** — this is the one blocking Phase 2. Nothing else is urgent.
- Turso, Render, Vercel, Resend, and Cloudflare DNS sign-ups (all card-free).
- Generating production values for `TOKEN_ENCRYPTION_KEY` and `SESSION_SECRET`.

## Known issues / open questions

- `.claude/settings.json` is gitignored per the global no-agent-files rule, so the attribution
  suppression does not travel with the repo. `scripts/install-hooks.sh` installs a `commit-msg`
  hook that strips any stray trailer — **run it once after every fresh clone.**
- PWA icons `public/icon-192.png` and `public/icon-512.png` are referenced by the manifest but
  not created yet; they land in Phase 9.
- The three.js hero rebuilds its whole scene when the accent or theme changes. That is fine at
  human click rates but would need per-material updates if it ever animated.
- The landing copy currently sits behind the auth gate. Phase 9 should split a public marketing
  page from the authenticated workspace.
- MEGA has no official Node SDK with delta support, so its adapter declares `delta: false` and
  Phase 3 will fall back to full re-listing.
- Local mode trusts the machine it runs on: it has no sign-in at all. Do not expose an
  `AUTH_MODE=local` instance to a network.
