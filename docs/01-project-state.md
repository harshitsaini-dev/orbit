# Project state

_Last updated: 2026-08-22_

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
| 3 | Remaining adapters | 🟢 Drive, OneDrive, Dropbox, every S3 store, GCS, Azure, Bunny and pCloud done · MEGA removed |
| 4 | Unified workspace views | 🟢 Done |
| 5 | Upload system + WebSocket progress + allocation | 🟢 Done |
| 6 | Sync engine | 🟢 Done |
| 7 | Sharing + QR | 🟢 Done |
| 8 | RBAC + superadmin | 🟢 Done |
| 9 | Design pass (Claymorphism, three.js, PWA) | 🟢 Done — chrome, theme depth, headings, grid, selection, toolbar and motion |
| 10 | Hardening + deploy | 🟡 Hardening done · deploy waits on the owner's sign-ups |
| 11 | Developer platform (public API, tokens, OAuth apps, API docs tab) | 🟡 Tokens, `/v1`, Developer tab and API docs done · OAuth apps and webhooks pending |
| 12 | Instant directory cache + offline browsing | 🟢 Done |
| 13 | Spotlight (Ctrl/Cmd + K) | 🟢 Done |
| 14 | Unified storage dashboard | 🟢 Done |
| 15 | Collections (virtual folders) | 🟢 Done |
| 16 | Metadata viewers + remaining previewers | 🟢 Done — code, CSV, PDF, Office, archives, fonts, markdown, EXIF, hex and 3D |
| 17 | Cross-cloud transfer engine | 🟢 Done |
| 18 | Cross-cloud duplicate finder | 🟢 Done |
| 19 | Scheduled jobs | 🟢 Done |
| 20 | Automatic tagging by OCR | ⚪ Designed, not started |
| 21 | Peer-to-peer direct transfer | ⚪ Designed, not started |
| 22 | Share analytics | 🟢 Done |

Phases 12 onward are specified in `18-planned-capabilities.md`, which records
for each one what it costs, what the free tier will and will not carry, and —
for HLS transcoding — why it is declined in favour of the Range streaming that
already works.

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
- Seven adapters, one per distinct provider API: Google Drive, OneDrive, Dropbox, pCloud,
  Azure Blob Storage, Bunny Storage, and a generic S3 adapter that every S3-compatible service
  routes through, Google Cloud Storage included.
- A **provider catalogue** of thirteen entries — what the user actually picks from — mapping onto
  those adapters. Amazon S3, Cloudflare R2, Supabase Storage, DigitalOcean Spaces and Backblaze
  B2 all route to the `s3` adapter with their own endpoint template and field list, so adding an
  S3-compatible service is a data change rather than new code (ADR 0007).
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

## Reconnecting an account

An account is identified by `(user_id, provider, remote_account_id)`, where
`remote_account_id` is the provider's own id for it - the address, for the OAuth
providers. Authorising an account Orbit already holds updates that connection in
place: new tokens, `status` back to `ok`, and its priority, weight and counters
untouched. This is the ordinary path rather than an edge case, because a grant
expiring is ordinary; without it every expiry would leave a dead entry behind and
add a twin beside it.

Several accounts of the same provider are fully supported - they differ by
`remote_account_id` and are labelled by address in the UI. Connections for which
the provider offers no stable identity store `NULL` there, and SQLite counts
NULLs as distinct, so those never deduplicate: merging two connections that only
*might* be the same is worse than keeping a duplicate.

## Verification (last run, 2026-08-22)

| Check | Result |
|---|---|
| `npm run typecheck --workspaces` | clean |
| `npm test --workspaces` | 863 pass, 0 fail |
| `npm run lint` | 0 errors |
| `npm run build --workspaces` | clean |
| `npx playwright test` (headed) | 222 pass, 0 fail across desktop, tablet and mobile |

Verified against the live account: 842 files, 11.9 GB scanned, categories summing exactly to the
provider's own usage figure once the trash allowance is included. The EXIF reader was checked
against a real photo out of that Drive over the live content route, and the share page's viewer
against a model and a binary in a real browser.

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

### Landing, dashboard, and the account menu
- The root is now the one address that differs by who is asking: a visitor gets the pitch, a
  signed-in user gets their own storage.
- Appearance moved out of the header, where eight loose controls made the top of every page
  about settings, and into a menu behind the avatar.
- Signing out lands on the landing page rather than the sign-in form.

### What previews, and what does not

| Format | Shown as | Note |
|---|---|---|
| Images, video, audio | Orbit's own viewers | SVG included: an `<img>` cannot run its scripts |
| PDF | pdf.js, with a password prompt | |
| Text, source, CSV | Line numbers and highlighting; CSV as a table | |
| Markdown | Rendered or source | |
| .xlsx .docx .pptx | Values and text | Read here; they are ZIPs of XML |
| .ods .odt .odp .epub | The same viewers | Also ZIPs of XML |
| Google Docs, Sheets, Slides | The same viewers | Drive exports them to the Office formats above |
| .zip .jar .cbz | Browsed from its index | Nothing downloaded, whatever the size |
| .tar .tar.gz .tgz | Browsed | No index, so the whole file is read - capped at 100MB |
| .rar | Contents listed | Its compression is proprietary; nothing can be extracted |
| .7z, .bz2, .zst | Declined | The index is itself compressed, so even listing needs the algorithm |
| Fonts | Sample text set in the font | |
| .doc .xls .ppt | Declined | The old binary formats share nothing with the modern ones |

Every viewer says what it is not showing. Someone looking at a spreadsheet
whose charts are the point should not conclude the file is broken when Orbit
simply is not drawing them.

## The mirror

`files_mirror` holds metadata for every file in every account - names, paths,
sizes, checksums, never bytes. It is what makes finding duplicates across
clouds, counting what is stored, and searching without waiting for the slowest
provider possible at all.

A delta feed reports what changed since a point in time, and a fresh cursor
means "from now on" - so the first pass returns nothing. The mirror is therefore
**seeded** by a full enumeration and only then followed by deltas; without that
it would only ever learn about files that changed after Orbit connected, which
for an untouched account is never. Measured against the connected Drive: 863
files on the first pass.

The cursor is written every page rather than at the end, so a pass cut short by
a restart resumes instead of enumerating everything again. A pass that stops at
its page cap reports `partial` rather than pretending to be complete. A dead
grant marks the account for reconnection instead of retrying every hour forever;
a 5xx does not, because that is the provider having a bad afternoon.

## Finding duplicates

Reads the mirror rather than the providers: comparing every file against every
other over the network would be thousands of requests, and the mirror already
holds the three things a comparison needs.

Two tiers, kept visibly apart. **Identical** means both sides published a
checksum and they agree. **Possibly the same** means a matching size and name
and nothing more - which is a guess, and presenting a guess as proof is how
somebody deletes their only copy. Only the certain groups can be bulk-selected.

A multipart S3 ETag is never treated as a checksum. It is built from the hashes
of the parts with the count appended, so two identical files uploaded with
different part sizes get different ETags. Files under 64KB are excluded
entirely: a hundred identical small configs would bury the ones worth acting on.

Against the connected Drive: 757 files, 35 identical sets, 82MB reclaimable.

## The directory cache

Folder listings - names, paths, sizes, timestamps, never contents - are mirrored
into IndexedDB. A folder paints from the cache immediately and refreshes from
the provider behind a quiet line in the footer. Measured against the connected
Drive: **3,584ms cold, 153ms warm.**

Everything in it is stale by definition, so it decides what to *draw* and never
what to *do*. A download, a rename or a delete goes to the provider and reports
what the provider says; anything that changes a folder drops its cached copy
first, or the refresh would paint the stale version back over the change.

Offline, a signed-in workspace stays up: the tree still browses and only the
bytes are missing, so there is a bar rather than a screen. Signed out there is
nothing cached to browse, and the screen is the honest answer. A failed session
read no longer signs anyone out - only a refusal does, since a request that
never reached the server means we could not tell.

The cache is visible and clearable from the account menu. One that nobody can
see or clear is one people stop trusting the moment anything looks stale.

## Spotlight

Ctrl/Cmd + K from anywhere, or the button in the header. Every result carries
the service it came from, because the question it exists to answer is which
cloud a file is in.

Two searches run. The cache answers immediately and without debouncing, since
reading an object store is not a request; the provider's search follows after a
pause and replaces the local answer rather than joining it, or most files would
be listed twice. The local half is labelled while it stands alone: it covers
only folders that have been opened, so presenting it as the result would be
telling someone a file is missing when Orbit has not looked.

## Uploads
- Upload files, upload a folder, or drag either onto the page. A dropped folder is walked
  through the FileSystem entry API — `dataTransfer.files` alone yields nothing for a directory,
  so without it dropping a folder silently uploaded nothing.
- Files go up one at a time. A browser will open six connections happily, but providers
  rate-limit per account, and six uploads each crawling is worse than one finishing.
- Chunks are sent as raw bytes: the JSON body parser is skipped for that one route, which would
  otherwise both fail on the body and buffer it twice.
- Missing folders in a dropped tree are created shortest-path-first, so a parent always exists
  before its children.
- **Verified against the live account:** a 12,900-byte file uploaded, read back through Orbit
  byte-identical, then moved to Drive's trash.

### Search
- Real search, run by the provider rather than as a filter over the loaded page, so it reaches
  into subfolders the way a file manager does. Debounced on every keystroke.
- Filters compose: text, file type, modified-within, size band, starred-only, and optional
  full-text where the provider indexes contents.
- Drive has no "everything under folder X" query — `in parents` matches only direct children —
  so scoping to a subtree resolves each result's real path and keeps the ones beneath it. That
  resolution is wanted anyway, because a result is far less useful without saying where the file
  lives; ancestors are cached per call.
- Category is applied by Orbit rather than pushed into each provider's query language: the
  classification reads the extension when the mime type is useless, which no provider query can
  express, so applying it centrally is the only way the filter means the same thing everywhere.
- A search with no criterion at all is refused — it would return the entire drive.
- **Verified against the live account:** a file three levels down was found by name with its full
  path resolved, scoping to its ancestor folder found it, and scoping to an unrelated folder
  returned nothing.

### Whole folders, not first pages
- A folder loads completely rather than stopping at its first page. The first page renders
  immediately and the rest is fetched behind it, so a large folder is usable straight away
  instead of being either truncated or blank until everything lands.
- Capped at 5,000 items, and the count says plainly when that cap was reached rather than
  presenting a truncated folder as the whole thing.
- **Verified against the live account:** the root folder now shows all 510 items across three
  provider pages, where it previously stopped at 200.

### Grid view, thumbnails and skeletons
- A list/grid toggle, with real previews in grid: Drive renders its own, including a frame from
  a video and a first page for a document. They are fetched server-side and proxied, so the
  provider URL still never reaches the browser.
- Tiles fetch a preview only once they are near the viewport. A folder of two hundred photos
  would otherwise fire two hundred requests the moment the page opened.
- Skeletons shaped like what replaces them, so nothing jumps when the data lands. They hold
  still under `prefers-reduced-motion` — a shimmer with no content is exactly the motion that
  hurts.
- Select all, scoped to what is on screen: selecting all during a search means the results, not
  the folder behind them.

### Controls
- The dropdown is a real listbox. A native `select` cannot be restyled past its closed state —
  `appearance: none` reaches the control but never the popup, which the OS draws, so on a dark
  theme the menu still opened white.
- The checkbox keeps its native input and only moves it out of sight, so keyboard, focus, form
  semantics and screen readers keep working.

### Dialogs
- `window.prompt` and `window.confirm` are gone. Both are drawn by the browser, ignore the theme
  entirely, and on some platforms are suppressed outright — a feature built on them can silently
  stop working.

### Phase 4 — unified views
- Recent, Starred and Shared with me are live, **merged across every connected account**. That
  merge is the aggregation the product exists for; a per-account view would have been three more
  file listers.
- `listView` joined the adapter contract, gated per view by `recentView`, `star` and
  `sharedWithMe`. A provider that cannot answer one is never asked.
- Accounts are queried in parallel, and the response names both the accounts that failed and the
  providers that have no such view — a partial result must never look complete.
- Recent excludes folders: a folder's timestamp changes whenever anything inside it does, so
  including them would make "recent" mostly folders.
- **Verified against the live account:** recent and shared both return real files newest-first;
  starring a file made it appear in Starred, and unstarring removed it again.

## Next up — Phase 3 (remaining adapters)

1. GCS and Azure Blob, which are object stores like S3 but with their own
   protocols rather than the S3 API.
2. Bunny Edge Storage, which is a simple HTTP API.
3. pCloud, which is OAuth but names its own API host at sign-in - the account
   lives in either the US or the EU region and only the token response says
   which.

### What each provider can and cannot do

Capabilities are what the provider actually offers, not what would be
convenient, because the UI hides a control rather than offering it and then
failing.

| | Drive | OneDrive | Dropbox | S3-compatible |
|---|---|---|---|---|
| Starred | yes | no | no (no API) | no |
| Shared with me | yes | yes | yes | no |
| Recent | yes | yes | no (no API) | no |
| Delta feed | yes | yes | yes | no |
| Search | yes | yes | names only | prefix + local match |
| Full-text search | yes | yes | no (paid plans) | no |
| Thumbnails | yes | yes | yes | no |
| Reports an allowance | yes | yes | yes | no |

The S3-compatible adapter is done, which makes Amazon S3, Cloudflare R2,
Supabase Storage, DigitalOcean Spaces, Backblaze B2 and any other S3 API
connectable.

### What the S3 adapter does and does not do

An object store has no folders, no rename, no search and nothing starred, so
those are either synthesised or declined rather than faked:

- **Folders** come from the delimiter the list API already offers. A folder is a
  common prefix; creating one writes the zero-byte marker object every S3 client
  uses, and the marker is hidden from listings so it does not appear as an empty
  file beside its own folder.
- **Rename** is a copy followed by a delete, and for a folder that is every key
  beneath it. The deletes only run once every copy has succeeded, so a refusal
  partway through cannot leave a folder half under each name. A copy can fail
  inside a 200 response - S3 sends the status before the copy finishes - so the
  body is checked rather than the status.
- **Search** narrows by key prefix at the store and matches names while paging.
  The `search` capability marks whether a search is possible at all, not whether
  the provider has an endpoint for it; false would leave every bucket silently
  unsearchable.
- **Starred** is declined: a starred-only search over a bucket matches nothing,
  which is the truth, rather than everything.
- **Quota** reports bytes used and no allowance, since a bucket has none. The
  count walks up to 50 pages; past that it is a floor rather than a total.
- **Signing** is SigV4 written against `node:crypto`, verified against Amazon's
  own `get-vanilla` vector. The AWS SDK is tens of megabytes for one algorithm
  and assumes endpoint conventions that R2, Backblaze and Supabase do not share.
- **Addressing** is path-style or virtual-hosted per catalogue entry. The wrong
  one produces a signature error that never mentions addressing.

## Connecting an S3-compatible bucket

`POST /api/accounts/connect` takes a catalogue key and the values its fields
ask for. The endpoint is assembled server-side from the entry's template, so a
user pastes an account id or a region rather than a URL they could mistype. The
keys are checked against the bucket before anything is stored: a key that cannot
list is a connection that would fail on first use, and it is better to say so
while the form is still open.

`catalogueKey` is stored on the account and returned with it. Five entries run
on the s3 adapter, so the adapter id alone cannot tell an R2 bucket from a
Backblaze one, and the UI needs to name and badge them differently.

## Uploads

The queue lives above the router, so an upload survives navigating away from
the folder that started it - it used to be state inside My Drive, and going to
look at Quota mid-upload unmounted the uploader and killed the transfer
silently. Progress shows in the header as a ring, with a popover for the detail
and `/uploads` for the full list.

It does not survive a page reload. The queue holds handles to files on disk and
a handle cannot be restored from storage, so the list says what it covers
rather than claiming a history it does not have.

## Blocked on the owner

Everything here needs an account, a console, or an approval — none of it can be
done from the codebase. Step-by-step instructions are in
**`docs/05-owner-setup.md`**. In rough order of what unblocks the most:

1. **pCloud OAuth app** — requested 2026-08-22, **pending approval**. pCloud
   creates an application by hand rather than on request; it is free and there
   is no Google-style verification, but a person reads the form. Once it is
   approved: add the redirect URI `http://localhost:8787/auth/callback/pcloud`
   and put the id and secret in `.env` as `PCLOUD_CLIENT_ID` /
   `PCLOUD_CLIENT_SECRET`. The adapter is written and unit-tested; without a
   real account it has never run against pCloud itself, which is not the same
   as verified.
2. **Microsoft app registration** — **blocked, 2026-08-22**. A personal
   Microsoft account has no Entra directory, and Microsoft has deprecated
   registering an application outside one, so the portal loops on
   `AADSTS16000` and then refuses. Unblocking it needs a directory: create a
   tenant (free, no card), use a work or school account that already has one,
   or sign up for Azure (free, but asks for card details). `05-onedrive-dropbox.md`
   has the detail. OneDrive is otherwise in the same position pCloud is:
   written, tested against mocked responses, never run for real.
3. **Google verification** — the Google client is live but the consent screen is
   still in *testing*, which caps it at 100 users and expires every refresh
   token after seven days. Verification needs a reachable homepage and privacy
   policy, so it cannot happen before a deploy.
4. **Dropbox production mode** — connected and working, but the app is in
   development mode, which is capped at 50 linked accounts. Fine for now;
   needed before anyone else uses it.
5. **Deployment sign-ups** — Turso, Render, Vercel, Resend, Cloudflare DNS. All
   card-free, all Phase 10, and (3) depends on them.
6. **Production secrets** — fresh `TOKEN_ENCRYPTION_KEY` and `SESSION_SECRET`.
   Generated on the machine that deploys, never committed.

Optional, and only to exercise an adapter against something real: an Azure
storage account, a Bunny storage zone, and a GCS bucket with its
interoperability keys. All three are credentials rather than OAuth, so they cost
nothing but a sign-up.

## Phase 8 — sharing a drive with other people

Access is granted **per drive**, not per Orbit account (ADR 0011). A grant joins a person to one
drive at one of four ordered levels — `read`, `write`, `full`, `admin` — and somebody with no
grants sees nothing.

The reason it is not a workspace role: somebody brought in for the team bucket would then also see
the personal Drive connected beside it, and the only way out would be a second Orbit account per
audience, which defeats the aggregation the product exists for.

Members sign in as themselves — own address, own code, own session. Naming an address creates the
user row; nothing happens until that person signs in and proves the address is theirs. There is no
accept-link, because a link proves only that somebody has the link.

What is enforced, and where:

- `useAccount(userId, accountId, need)` takes the permission as a **required** argument, so every
  one of the twenty-six call sites had to state its intent rather than inherit a default.
- Refusal and non-existence both answer `404`. A reader asking for the member list is told the
  drive does not exist; being told "you may not manage this" would confirm there is a list.
- The owner holds no grant row, so no grant bug can lock them out of their own connection.
- Disconnecting stays owner-only at any level — somebody else's tokens are not a guest's to sever.
- Search and the smart views span every readable drive. **Allocation deliberately does not**:
  automatic upload placement picks among your own drives, so Orbit never quietly puts your files
  into somebody else's storage.

**The audit trail is written now.** It exists for a reason it did not before: with guests on a
drive, "who deleted this" has an answer other than "you" and nowhere else to ask it. Recorded are
deletions, moves, renames, uploads, links published and revoked, access given and taken away, and
drives connected and disconnected. Reads deliberately are not — they would be most of the rows and
none of the answers, and a log of everything a colleague opened is surveillance rather than an
audit trail.

Three things its shape had to get right: an entry outlives its actor (the id nulls rather than
cascades, and the address recorded at the time survives), recording never throws (a delete must not
fail because a row could not be inserted), and disconnecting is recorded against the person rather
than the drive, since a drive's rows cascade away with it.

Read from the members panel, gated on `manage` like the member list.

**The superadmin console is done.** What it deliberately cannot do is the point: there is no way
to browse somebody's files, open one, or see what is in their drives — only how many they have
connected and what each provider reports is in them. Orbit's promise is that it holds nothing, and
an admin console that walked around that would make the promise false with the operator, the one
person best placed to break it, holding the key.

Two refusals guard the instance against locking itself out: nobody may change their own role, and
the last superadmin may neither be demoted nor removed.

Every route answers 404 rather than 403 to a non-admin — being told "you may not" confirms there is
an admin surface to want.

## Phase 19 — scheduled jobs

Presets and a time, not cron expressions. They tick on the same node-cron pass that refreshes
tokens, kept in a function of their own so a broken schedule cannot stop tokens being renewed.

The instance sleeps, which shapes everything here: due-ness is a comparison against a stored time
rather than an event, so waking at 6am finds the 2am job still waiting. The next run is computed
from *now*, so ten missed hours do not become ten runs. The page says this in as many words rather
than letting people work it out from a job that fires at the wrong time.

"Run now" deliberately does not move `nextRunAt` — it exists so somebody can find out whether a job
works without waiting until 2am to discover it does not.

## Thumbnails on stores that make none

Drive, OneDrive and Dropbox render previews and Orbit proxies them. Object stores render none, so
a bucket of photos was a grid of file icons.

They are generated server-side now (`services/thumbnails.ts`, sharp): fetched once, resized to
fit, re-encoded as WebP at quality 72, kept in a 32 MB in-memory LRU with an in-flight map so
forty tiles of one image decode once. Never written to disk — a derived image is still bytes.
Decoding is capped at two at a time, because this process also serves requests somebody is
waiting on.

Measured on the connected buckets: 994 KB JPEG → 4.9 KB; 151 KB PNG → 11 KB; 25 KB PNG → 4.2 KB.
Cold ~0.3 s, cached ~0.1 s.

**Video and PDF: written, and on exactly when the machine can afford them.** Drive renders those
too. Orbit can as well — a frame needs ffmpeg, a page needs poppler — but neither is CPU a free tier
has to spare, and both would compete with request serving on the single node (ADR 0003).

So neither is a dependency. `services/renderers.ts` looks for both once at start-up and the feature
exists exactly when the tool does. On the free instance nothing is found, those files show an icon,
and not a byte of a video is ever fetched. On a machine that has ffmpeg — a bigger instance, a
container that installs it, somebody's own server — video thumbnails start appearing with no flag to
set. The boot log says which of the two it found, so this is never something to infer from
thumbnails that do or do not turn up.

`ORBIT_FFMPEG` and `ORBIT_PDFTOPPM` name the binaries when they are not on PATH.

Two limits worth knowing. A video is read as a 12 MB prefix rather than in full, so an MP4 whose
index sits at the end returns no thumbnail — better than pulling two gigabytes through the server to
be sure. And nothing is written to disk: the bytes go to the renderer on stdin, because a temp file
would be storing a user's file, which is the one thing this product does not do.

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
- Only Google Drive and Dropbox have a delta feed. Every other adapter declares `delta: false`
  and re-lists instead, which is why a large object store is measured in the background rather
  than on request.
- Local mode trusts the machine it runs on: it has no sign-in at all. Do not expose an
  `AUTH_MODE=local` instance to a network.
