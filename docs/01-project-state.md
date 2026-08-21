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
| 2 | First adapter — Google Drive | 🟢 Done |
| 3 | Remaining adapters (OneDrive, Dropbox, MEGA, pCloud, S3) | ⚪ Not started |
| 4 | Unified workspace views | ⚪ Not started |
| 5 | Upload system + WebSocket progress + allocation | ⚪ Not started |
| 6 | Sync engine | ⚪ Not started |
| 7 | Sharing + QR | ⚪ Not started |
| 8 | RBAC + superadmin | ⚪ Not started |
| 9 | Design pass (Claymorphism, three.js, PWA) | ⚪ Not started |
| 10 | Hardening + deploy | ⚪ Not started |
| 11 | Developer platform (public API, tokens, OAuth apps, API docs tab) | ⚪ Designed, not started |

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

### Provider coverage
- Nine adapters, one per distinct provider API: Google Drive, OneDrive, Dropbox, MEGA, pCloud,
  Google Cloud Storage, Azure Blob Storage, Bunny Storage, and a generic S3 adapter.
- A **provider catalogue** of fourteen entries — what the user actually picks from — mapping onto
  those adapters. Amazon S3, Cloudflare R2, Supabase Storage, DigitalOcean Spaces and Backblaze
  B2 all route to the `s3` adapter with their own endpoint template and field list, so adding an
  S3-compatible service is a data change rather than new code (ADR 0007).
- iCloud Drive and Proton Drive are listed as **not supported**, with the reason, because neither
  publishes an API for third-party access. See ADR 0007.

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
| `npm test --workspaces` | 216 pass, 0 fail |

Verified against the live account: 842 files, 11.9 GB scanned, categories summing exactly to the
provider's own usage figure once the trash allowance is included.
| `npm run build --workspaces` | clean |
| `npx playwright test` (headed) | 78 pass, 0 fail across desktop, tablet and mobile |

## Designed but not built

- **Phase 11 — developer platform.** Full design in `docs/06-developer-platform.md`: a versioned
  public `/v1` API, personal access tokens, OAuth 2.0 with PKCE and per-account consent, scoped
  permissions, webhooks, a Developer tab for token and application management, and an API docs
  tab generated from the same Zod schemas the routes validate with.

### Phase 2 — Google Drive (in progress)
- Full `GoogleDriveAdapter`: OAuth exchange and refresh, folder listing with path resolution,
  shared-with-me, metadata, range-aware streaming, folder creation, rename, star, bulk remove,
  resumable upload, quota, and delta changes. 26 tests against mocked Drive responses.
- Drive is a graph, not a tree, so virtual paths are resolved by walking from the root a segment
  at a time. Google-native documents hold no bytes and are exported rather than downloaded.
  Deletion trashes rather than destroying — a delete through an aggregator is too easy to trigger
  by accident.
- OAuth connect flow with PKCE and a state cookie; `state` is validated before any token is
  exchanged, and a forged callback creates nothing.
- `useAccount()` is the single path to a provider: it refreshes an expiring token, persists it,
  and marks the account `needs_reauth` if the grant is gone.
- Accounts UI on `/quota`: connect, list with quota bars, refresh, disconnect.
- A shared `providerFetch` helper with retry-and-backoff on the retryable statuses, and error
  messages that quote the provider but never the request headers that held the token.

### Verified against a real Drive
- Connected a live Google account end to end. Listing, quota and the storage breakdown all work
  against real data.
- Two defects only a real account revealed: `.env` was never being read (see ADR 0008), and
  **shortcuts** — nine in the root alone — appeared as unopenable zero-byte files.
- The breakdown of that account: 842 files, 11.9 GB, scanned in about three seconds.

### Storage breakdown and provider marks
- Google One style category breakdown: photos, video, audio, documents, archives, code, other.
  Classified by mime type first and extension second, because object stores label nearly
  everything `application/octet-stream`.
- **One bar per account**, not a usage bar plus a breakdown bar. The track is the allowance, the
  filled part is what is used, and the colours inside it are what is using it. Categories are
  proportioned against the *used block* rather than the allowance: 12 GB against a 5 TB
  allowance is 0.24% of the track, so a per-category minimum width on the track would have
  rendered eight slivers and overstated usage by more than an order of magnitude.
- The scan runs on its own when the page loads; the bar is drawn immediately from the cached
  quota figures and refines in place.
- The provider's usage figure covers what a file scan cannot see - the trash, and on Google,
  Gmail and Photos. The difference is shown as "Trash and other services" rather than letting
  the categories quietly fail to add up.
- Added `listAllFiles` to the adapter contract, gated by a `flatEnumeration` capability. The
  sync engine needs the same flat pass in Phase 6 for providers without a delta feed.
- The scan is bounded and reports `partial` rather than presenting an undercount as the total.
- Provider marks are **original glyphs**, not vendor logos — see `docs/07-provider-icons.md`.

### Mobile
- The app shell moved from inline styles to CSS classes, since inline styles cannot carry media
  queries. Below 768px the sidebar becomes a horizontal strip that scrolls on its own; below
  480px the header stacks.
- A dedicated mobile suite asserts what only breaks on a phone: no horizontal page scroll on any
  view, every nav item reachable, tap targets at least 36px, and long email addresses staying
  inside their card.

### File browser and operations
- `/my-drive`: breadcrumb navigation, account switcher, folder open, multi-select, new folder,
  rename, star, bulk delete, download and open-in-tab.
- Account and path live in the URL, so a folder can be bookmarked or linked to.
- `GET /api/files/:id/content` streams bytes straight through from the provider — never onto
  Orbit's disk, and the provider's URL never reaches the client. Range requests are honoured, so
  a client can seek video without pulling the whole file.
- Deleting answers **207** for a mixed batch, so a caller cannot read a 200 as "all done".
- Action glyphs are SVG rather than text characters: several platforms substitute a solid star
  for `☆`, which makes an unstarred file look starred.

### Verified against the real account
- Navigated real folders, including ones reached through shortcuts.
- Downloaded a 3,222,799-byte JPEG: byte count exact, magic bytes intact, correct content type,
  `private, no-store`, and the right filename.
- `Range: bytes=0-99` answered `206` with `content-range: bytes 0-99/3222799` and exactly 100
  bytes.
- No response header mentions the provider's domain.

### Keeping connections alive
- A failed refresh used to mark an account `needs_reauth` whatever the cause, so a timeout or a
  provider 5xx cost the user their connection. Only an explicit refusal — `invalid_grant`, or a
  400/401 from the token endpoint — now counts as a dead grant; anything else is recorded as a
  transient error and recovers on its own.
- The scheduled pass sweeps every account and renews any token within an hour of expiry, so a
  connection stays warm whether or not the app was opened, and a genuinely dead grant surfaces
  before the user runs into it. One pass runs at boot as well.
- **Remaining cause of repeated reconnects, which no code here can fix:** Google expires refresh
  tokens after seven days while an app's publishing status is *Testing*. See
  `docs/05-owner-setup.md` §1.

### Profile
- Display name, picture, theme and accent, managed from `/account` and stored on the account, so
  they follow the user to another device.
- The picture is resized and cropped to a 192px square in the browser before upload, so any
  phone photo works instead of being rejected by the size cap.
- A provider's name and picture seed an empty profile at connect time, but never overwrite
  something the user set. The picture is fetched server-side and stored as a data URL rather than
  linked: a remote URL would report every page load back to the provider and would break the
  moment the account was disconnected.
- Scrollbars follow the theme tokens in both engines, rather than being drawn by the OS.

## Next up — Phase 3 (remaining adapters)

1. OneDrive and Dropbox, which are the closest in shape to Drive.
2. The generic S3 adapter, which unlocks five catalogue entries at once.
3. GCS, Azure Blob, Bunny, MEGA.

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
