# API reference

Base URL: `http://localhost:8787` (dev) · `https://api.orbit.harshitsaini.in` (prod)

All error responses share one shape:

```json
{ "error": { "code": "not_found", "message": "Route not found" } }
```

## Implemented

### `GET /health`
Unauthenticated liveness probe. Also what the uptime pinger hits to keep the free Render
instance warm.

```json
{ "status": "ok", "mode": "local", "uptimeSeconds": 42, "wsConnections": 0 }
```

### `GET /health/providers`
Lists every registered adapter and its capability flags. The frontend uses this to hide actions
a provider cannot perform rather than letting them fail.

```json
{ "providers": [{ "id": "google_drive", "displayName": "Google Drive", "authType": "oauth",
  "capabilities": { "star": true, "sharedWithMe": true, "delta": true,
  "resumableUpload": true, "rangeRequests": true } }] }
```

### `POST /auth/request-otp`
Body `{ "email": "you@example.com" }`. Emails a 6-digit code valid for 5 minutes.
Always answers `200 { "message": "If that address can sign in, a code is on its way." }`
whether or not the address exists, and whether or not a code was actually sent (a resend inside
the 60-second cooldown is silently skipped). Returns `400` in local mode.

### `POST /auth/verify-otp`
Body `{ "email": "...", "code": "123456" }`. On success sets an `httpOnly`, `sameSite=strict`
session cookie valid for 30 days and returns `{ user }`. Every failure - wrong code, expired
code, no code ever issued, attempt limit reached - returns the same
`401 { "error": { "code": "invalid_code" } }`.

### `POST /auth/logout`
Deletes the session row and clears the cookie. `204`. Replaying the old cookie afterwards fails.

### `GET /auth/me`
`{ user, mode }` for the current session, or `401`.

### `GET /auth/mode`
`{ "mode": "local" | "hosted" }`. Lets the frontend decide whether to show a sign-in screen.

### `GET /auth/dev/last-code`
Development only. Reads back the last code the console transport recorded, so tests can drive
the real flow without a mailbox. Routable only when `ENABLE_DEV_AUTH_ENDPOINTS=true` **and**
`NODE_ENV !== 'production'`; otherwise `404`.

### `GET /api/catalogue`
Everything "Connect an account" offers, plus what it cannot. Longer than
`/health/providers`, because several entries share the `s3` adapter and differ only in endpoint.

```json
{
  "entries": [{
    "key": "cloudflare_r2", "label": "Cloudflare R2", "provider": "s3",
    "blurb": "R2 bucket. Uses an S3 API token from the R2 dashboard.",
    "endpointTemplate": "https://{accountId}.r2.cloudflarestorage.com",
    "forcePathStyle": true,
    "fields": [{ "name": "accountId", "label": "Cloudflare account ID" }],
    "capabilities": { "nativeFolders": false, "reportsQuota": false }
  }],
}
```

`fields` describes what to ask the user for. It never carries values.

### `GET /auth/connect/:provider`
Starts the OAuth flow. Sets a short-lived `httpOnly` state cookie holding the PKCE verifier and
a random state, then `302`s to the provider. Google is sent `access_type=offline` and
`prompt=consent` — without both it issues no refresh token and the connection dies in an hour.

### `GET /auth/callback/:provider`
Where the provider returns the browser. Validates `state` against the cookie before exchanging
anything, then stores the account with its tokens AES-256-GCM encrypted, labels it with the
account's email address, and redirects to `{APP_URL}/quota?connect=connected`. Any failure —
cancelled consent, missing or mismatched state — redirects with `?connect=failed&reason=…` and
creates nothing.

### `POST /api/accounts/connect`
Connects a store that authenticates with keys rather than a redirect, so the answer is JSON
rather than a redirect back into the app.

```json
{ "catalogueKey": "cloudflare_r2", "values": { "accountId": "…", "accessKeyId": "…", "secretAccessKey": "…", "bucket": "photos" } }
```

`values` supplies whatever that catalogue entry's `fields` ask for. The endpoint is assembled
server-side from the entry's `endpointTemplate`, so a caller sends an account id or a region and
never a URL. `201 { account: PublicAccount }` on success.

The keys are proved against the bucket before anything is stored — a key that cannot list is a
connection that would fail on first use. A refusal from the store is `400 connect_failed`, not a
500: a mistyped key is the caller's to fix and nothing broke here. `400 invalid_request` names the
required fields left empty, or says the provider uses OAuth. `404 not_found` for a catalogue entry
with no adapter behind it yet.

Re-sending the same bucket at the same endpoint refreshes the existing connection rather than
adding a second one.

### `GET /api/accounts`
`{ accounts: PublicAccount[] }`. Never includes token material of any kind.

Each account carries `catalogueKey` alongside `provider`. Five catalogue entries run on the `s3`
adapter, so the adapter id alone cannot tell an R2 bucket from a Backblaze one.

The caller's own drives come first in the order they chose, then any granted to them, oldest
grant first. `isOwner` and `accessLevel` describe the caller's relationship to each drive rather
than the drive itself — the same connection is `admin` to its owner and `read` to a guest — so the
client can decline to offer an upload button that would only ever 403.

### `POST /api/accounts/:id/refresh-quota`
Re-reads usage from the provider and caches it. `409 needs_reauth` when the grant has expired.

### `DELETE /api/accounts/:id`
Disconnects. `204`. Files in the provider account are untouched. **Owner only** — a guest with
`admin` on the drive may hand it to other people but not sever the connection itself.

## Who may use a drive

Access is granted per drive, not per Orbit account — see ADR 0011. Levels are ordered and each
contains the ones before it:

| Level | Adds |
| --- | --- |
| `read` | list, open, download, search |
| `write` | upload, rename, move, create folders |
| `full` | delete, and publish share links |
| `admin` | grant this drive to other people |

Every route below needs `admin`, and answers `404` to anybody without it — telling a reader
"you may not manage this" would confirm there is a member list to see.

### `GET /api/accounts/:id/members`
`{ members: DriveMember[], owner: boolean }`. `joinedAt` is null for somebody who has been named
but has never signed in.

### `POST /api/accounts/:id/members`
`{ email, level }` → `201 { member }`. Creates the user row if that address is new to Orbit;
there is no accept step, because signing in with a code sent to that address is what proves the
invitation reached the right inbox. Naming somebody already on the drive changes their level
rather than failing. `409` if the address owns the drive already.

### `PATCH /api/accounts/:id/members/:userId`
`{ level }` → `204`. `403` when the caller is the member being changed: an admin guest must not be
able to promote themselves past whoever invited them.

### `DELETE /api/accounts/:id/members/:userId`
`204`. The grant goes; nothing of theirs is touched. Removing yourself is allowed — leaving a
drive is not the same as promoting yourself.

### `GET /api/files?accountId=&path=&pageToken=`
Note the asymmetry: the request takes `pageToken`, the response returns the next one as
`nextCursor`. Passing it back as `cursor` is silently ignored and re-fetches the first page.

Lists one folder from one account. Needs `read` on it.
`{ accountId, provider, path, files, nextCursor, capabilities }`. The capabilities travel with
the listing so the UI can hide actions the provider cannot perform.

### `POST /api/files/:id/relocate`
`{ accountId, targetPath, copy }` → `{ file }`. Moves or copies **within one account**, with the
provider doing the work — nothing is downloaded and re-uploaded.

Deliberately not the transfer engine: that exists for crossing between two accounts, where the
bytes genuinely have to travel through Orbit. Inside one account every provider does this itself in
a call or two.

`copy` defaults to `true`, the option that leaves the original alone. A copy needs `write`; a move
needs `delete`, because it takes the file away from where it was. `400 unsupported` on a provider
whose `relocate` capability is false.

### `GET /api/views/:view`
`recent`, `starred`, or `shared`, **merged across every readable account** — the caller's own and
any granted to them — which is the point
of the product: "recent" should mean recent everywhere, not recent in whichever account happens
to be selected. Accounts are queried in parallel.

```json
{
  "files": [{ "remoteId": "…", "name": "notes.txt", "modifiedAt": "…",
              "accountId": "…", "provider": "google_drive", "accountNickname": "me@example.com" }],
  "problems": [{ "accountId": "…", "nickname": "…", "reason": "needs reconnecting" }],
  "unsupported": [{ "accountId": "…", "nickname": "…" }]
}
```

`problems` names accounts that could not answer and `unsupported` those whose provider has no
such view, so a partial result never looks complete. `recent` and `shared` come back newest
first; `starred` by name.

### `GET /api/search`
Searches whole accounts, the way a file manager searches a folder: it reaches into subfolders,
and every result carries the path it was found at.

| Parameter | Meaning |
|---|---|
| `q` | Matched against the file name |
| `fullText=1` | Also match text inside documents, where the provider indexes it |
| `categories` | Comma-separated, e.g. `video,image` |
| `under` | Only results at or beneath this path |
| `since` | ISO timestamp; only files changed since |
| `minSize` / `maxSize` | Bytes |
| `starred=1`, `mine=1` | Starred only; owned by me only |
| `accountId` | One account; absent means every connected account |

At least one criterion is required — a search with none would return the whole drive, which is
never what was meant. Same response shape as `/api/views/:view`, so `problems` and `unsupported`
still say which accounts could not answer.

Google Drive has no "everything under folder X" query — `in parents` matches only direct
children — so `under` is applied by resolving each result's real path and keeping the ones
beneath it. That resolution is wanted anyway: a result is far less useful without saying where
the file lives. Ancestors are cached per call.

### `GET /api/files/:id/content?accountId=&download=&name=`
Streams the file straight through from the provider. The bytes never touch Orbit's disk and the
provider's own URL never reaches the client.

- Honours `Range`, answering `206` with `Content-Range`. A suffix range (`bytes=-500`) is
  declined rather than guessed at, since this layer does not know the length.
- Always `Cache-Control: private, no-store` — one user's file behind their session.
- `download=1` adds a `Content-Disposition` attachment header with `name`.

### `GET /api/files/:id/thumbnail?accountId=&size=`
A small preview image, proxied like everything else so the provider's own URL never reaches the
browser. `size` is clamped to 64–1024. Missing is a normal answer rather than an error: a file
with no preview gets `404 no_thumbnail`, which the grid quietly falls back from.

Cached `private, max-age=900` — a grid re-requests these on every scroll back, and the image is
derived rather than the file itself.

Thumbnails and file streams are rate-limited **separately** from metadata calls
(`TRANSFER_RATE_LIMIT`). A grid fetches one preview per tile, so a single scroll through a photo
folder would otherwise exhaust the budget for listing anything.

### `POST /api/files/folder`
`{ accountId, path, name }` → `201 { file }`.

### `PATCH /api/files/:id`
`{ accountId, name?, starred? }` → `204`. At least one of `name` or `starred` is required.
`501 unsupported` when starring a provider that cannot star.

### `DELETE /api/files`
`{ accountId, remoteIds: [] }` → `200 { succeeded, failed }`, or **`207`** when the batch was
mixed, so a caller cannot read a 200 as "all done". On Google Drive this trashes rather than
destroys.

### `GET /api/accounts/:id/breakdown`
What is using the space, by category — the Google One style panel. There is no aggregate
endpoint on any provider, so this enumerates the account flat via `listAllFiles`. The scan is
bounded at 60 pages and its result cached for 30 minutes; `?refresh=1` forces a new one.

```json
{ "breakdown": { "accountId": "…", "fileCount": 842, "sizeBytes": 12750000000,
  "partial": false, "scannedAt": "2026-08-21T10:12:00.000Z",
  "totals": [{ "category": "archive", "fileCount": 21, "sizeBytes": 9600000000 }] } }
```

`partial: true` means the scan stopped at its page limit, so the figures are a lower bound.
`501 breakdown_unsupported` for a provider that cannot enumerate flat.

### `GET /api/connectable`
Only the catalogue entries with a working adapter behind them, so the connect UI never offers a
dead end. The full intended list is `GET /api/catalogue`.

### `POST /api/shares`
`{ accountId, remoteId, permission?, password?, expiresInDays? }` → `201 { share }`, where the
share carries a `url` on the API's own origin. Sharing a file that already has a live link returns
that link rather than minting a second one — two live links for one file cannot both be managed
from a UI that shows one per file.

The name, type and size are copied in when the link is made. A share page is public and can be
opened any number of times; reading metadata per view would turn a link into a way to make Orbit
hammer someone's Drive.

### `GET /api/shares`
`{ shares: [] }` for the caller. Never includes the password hash. `hasPassword` says whether
there is one.

### `DELETE /api/shares/:shortId`
Revokes. `204`. The row is kept with `revokedAt` set, so the short id can never be handed out
again, and the link then answers exactly as one that never existed.

### `GET /s/:shortId`
The public page, server-rendered here rather than by the web app so that the page and the bytes
come from one origin — anything else needs a redirect that leaks where the file really is. It
runs **no JavaScript**, so its policy is `default-src 'none'`, and it carries
`X-Robots-Tag: noindex`.

`404` for a link that is revoked or never existed — the same answer for both, so the id space
cannot be probed. `410` for one that has expired, which tells a holder of the link nothing they
did not know. `401` and a password form for a protected one.

### `POST /s/:shortId/unlock`
Urlencoded `password`. On success sets an httpOnly cookie scoped to `/s/:shortId` containing an
HMAC of the id — not the password, which would otherwise sit in the browser's cookie store — and
redirects, so a refresh does not resubmit.

### `GET /s/:shortId/content`
The bytes, Range-aware so a shared video seeks. `private, no-store`: a revoked link must not
outlive its revocation in a cache. `?download` sets a filename, and only when the link permits
downloading.

### `GET /s/:shortId/qr`
An SVG QR code of the link. SVG rather than PNG so it scales to whatever it is printed at.

### `GET /api/collections`
`{ collections: [] }` with an item count on each. Counted in one query rather than one per
collection, so a dozen collections is not a dozen round trips.

### `POST /api/collections`
`{ name, colour? }` → `201 { collection }`.

### `GET /api/collections/:id`
`{ collection, items }`. Each item carries the account it lives in and the path it lives at, which
is what makes a collection different from a folder.

### `PATCH /api/collections/:id`
`{ name }` → `204`.

### `DELETE /api/collections/:id`
`204`. The files are untouched: a collection holds references, so deleting one deletes a grouping.

### `POST /api/collections/:id/items`
`{ accountId, remoteId, virtualPath? }` → `201 { item }`. The name, type and size are snapshotted
from the provider so a collection spanning five accounts is not five round trips to draw a list.

`virtualPath` is the path the caller was standing in. A provider's metadata call returns the file
and not the walk to it — Drive would need a request per ancestor — so without it a row says
`/invoice.pdf` for a file three folders deep. Adding the same file twice refreshes the snapshot
rather than erroring or duplicating.

### `DELETE /api/collections/:id/items/:itemId`
`204`. Removes the reference. The file is not touched.

### `PUT /api/allocation`
`{ strategy }` → `204`. One of `round_robin`, `weighted_round_robin`, `least_used`, `most_free`,
`manual`.

### `PUT /api/accounts/:id/weight`
`{ weight }` (0-100) → `204`. Read only by `weighted_round_robin`. Zero means never, which parks an
account without disconnecting it.

### `PUT /api/allocation/order`
`{ order: [accountId] }` → `204`. The list `manual` walks.

### `POST /api/uploads`
`accountId` is now **optional**. Omitted, Orbit picks using the strategy above and returns the
account it chose. `507 no_room` when nothing has space — said before a byte moves rather than
partway through the transfer.

### `POST /api/transfers`
`{ sourceAccountId, sourceRemoteId, targetAccountId, targetPath?, deleteSource? }` →
`201 { transfer }`, and it starts. The bytes stream through the server and are never written to
Orbit's disk.

`400` when both ends are the same account — within one account the provider moves it natively,
without moving any bytes. `400 unsupported` for a folder. Transfers run one at a time across the
whole process: two at once on a 512MB instance is how both of them fail.

### `GET /api/transfers`
`{ transfers: [] }`, newest first.

### `POST /api/transfers/:id/resume`
`202`. Picks up from the recorded position rather than starting again. `409` if it is already
running or done.

### `DELETE /api/transfers/:id`
Cancels. `204`. Refuses one that has already finished, since saying it was cancelled would be a lie
about a file that has moved.

Progress arrives on the WebSocket as `transfer:progress` and `transfer:done`, on the channel
`transfer:{id}` — a transfer outlives the request that started it, so there is nowhere else to
report it.

## The bin

Deleted files that the provider has not yet destroyed, across every drive that keeps one.

Providers disagree about what a bin is, and two capabilities say so rather than one pretending
they agree: `trash` is whether a delete can be undone, `purgeTrash` is whether an ordinary account
may destroy a file early. Drive has both. Dropbox holds deleted files for thirty days and will
restore one, but only a business plan may empty its bin — so `trash` is true and `purgeTrash` is
false. An object store has neither: a delete there is final.

### `GET /api/trash?cursor=`
`{ files, noBin, problems, nextCursor }`. Paged on the same per-account cursor the merged views
use. `noBin` names the drives that keep none, so a delete that cannot be undone is said before
somebody makes one rather than after. Each file carries `canPurge`.

### `POST /api/trash/restore`
`{ accountId, remoteId }` → `204`. Needs **`write`**, not `delete`: restoring adds a file to the
drive rather than taking one away, and somebody trusted to upload is trusted to undo a deletion.
`400 unsupported` where the drive keeps no bin.

### `DELETE /api/trash`
`{ accountId, remoteId }` → `204`. Needs `delete`, and is gated again on `purgeTrash`. This is the
one operation in Orbit with nothing behind it.

## Schedules

Jobs that run again on their own, described by a preset and a time rather than a cron expression.
They tick on the same node-cron pass that refreshes tokens.

The instance sleeps, so **due-ness is a comparison against a stored time, not an event**: a 2am job
whose moment passes with nothing awake runs on the next wake-up. The next run is then computed from
*now*, so ten missed hours do not become ten runs.

### `GET /api/schedules`
`{ schedules: PublicSchedule[] }`, soonest first. Only the caller's own.

### `POST /api/schedules`
`{ name, action, every, hour?, minute?, weekday?, dayOfMonth?, ...action fields }` → `201`.
`action: 'sync'` takes `accountId`; `action: 'backup'` takes `sourceAccountId`, `sourceRemoteId`,
`targetAccountId` and `targetPath`.

The drives are checked **at the level the job will need** — a backup target for `write`, not merely
for existing. A job that turns out on its first firing to have been pointed at a read-only drive has
already cost the user a week of believing it was running. `404` if any check fails.

### `PATCH /api/schedules/:id`
`{ enabled }` → `204`.

### `POST /api/schedules/:id/run`
Runs it now and returns the updated row, **without moving when it next runs on its own** — pressing
this at four in the afternoon must not turn a nightly job into a four-in-the-afternoon job. Mostly
so somebody can find out whether a job works rather than waiting until 2am to discover it does not.

### `DELETE /api/schedules/:id`
`204`. The job stops; nothing it has already done is undone.

### `WS /ws`
Channel pub/sub. Client frames: `{"type":"subscribe","channel":"..."}`, `unsubscribe`, `ping`.
Server frames: `upload:progress`, `upload:complete`, `upload:error`, `sync:status`.

### `GET /api/shares/:shortId/stats`
How one published link has been used: `{ stats: { daily, views, downloads, bots, byDevice,
lastViewedAt } }`. `daily` covers the last 30 days by default (`?days=` up to 90) and includes
the days with nothing, because a chart built only from the days with data draws a straight line
through a fortnight of silence.

Owner-only, and `404` for a link that is not yours — so nobody can learn that a short id exists
by asking about its statistics.

A view record holds the time, whether it was a read or a download, and one of three words for
the device. No address, no user agent, no referrer, no cookie (ADR 0014), which is why there is
no unique-visitor count: telling one person refreshing from ten people looking would mean
identifying somebody who only followed a link.

## The public API — `/v1`

> Rendered in the app at **`/developer/docs`**, from `packages/shared-types/src/api-spec.ts`.
> A server test compares that description against the routes actually registered on the router,
> in both directions, so an endpoint added without an entry fails and an entry describing
> something that no longer exists fails too. This document repeats it for readers who are not
> signed in; the page is the one that cannot drift.

A separate surface from `/api`, for a program rather than for the app. `/api` ships with its
only client and is free to change shape whenever the app needs it to; `/v1` is promised not to,
and a breaking change means `/v2`.

**Authentication.** A personal access token, created in the Developer tab:

```
Authorization: Bearer orbit_pat_<43 chars>
```

A session cookie also works, so the documentation's own examples are runnable while signed in.
What does *not* work is local mode's implicit user: a public API that authenticates itself is
not one, and a client written against that would work locally and fail on a real deployment.

**Scopes.** A token carries the ones it was granted; a request outside them is `403
insufficient_scope`, not `401` - the credential is real and retrying will not change it.

| Scope | Grants |
|---|---|
| `files:read` | List folders, read file details |
| `files:download` | Stream file contents |
| `files:write` | Create folders, rename |
| `files:delete` | Delete files and folders |
| `accounts:read` | List connected accounts and storage |
| `accounts:write` | Connect and disconnect accounts |
| `shares:read` / `shares:write` | Read, create and revoke share links |

There is deliberately no scope that hands over a provider's own credentials. Orbit proxies every
byte, so a token reaches files without ever exposing the Google or Dropbox token behind them.

**Rate limit.** Counted per token rather than per IP - an address limit punishes everyone behind
one NAT and does nothing against a client spread across several. `RateLimit-*` headers on every
response.

### `GET /v1/me`
`{ user, scopes }`. `scopes` is the list a token carries, or `"session"` for a signed-in browser.
Lets a program find out what it may do without discovering it one 403 at a time.

### `GET /v1/accounts` · `accounts:read`
Every connected account, with quota and status.

### `GET /v1/files?accountId=&path=&cursor=` · `files:read`
One folder. Answers `{ accountId, path, files, nextCursor }`; `nextCursor` is `null` when the
listing is finished. Cursors, never offsets - the drive changes under a reader, so page 3 of a
shifted list is not page 3 of anything.

### `GET /v1/files/:id?accountId=` · `files:read`
One file's metadata.

### `GET /v1/files/:id/content?accountId=` · `files:download`
The bytes, proxied. Honours `Range`, so a client can seek a video rather than downloading it.

### `POST /v1/files/folder` · `files:write`
Body `{ accountId, path, name }`. `201 { file }`.

### `PATCH /v1/files/:id` · `files:write`
Body `{ accountId, name }`. Renames, and returns the file as it now is.

### `DELETE /v1/files` · `files:delete`
Body `{ accountId, remoteIds: [] }`, up to 200. Answers `{ succeeded, failed }` - a bulk delete
where one file was already gone is not a failed request, and a program deserves to know which of
the two hundred actually went.

### `GET /v1/shares` · `shares:read` · `POST /v1/shares` · `DELETE /v1/shares/:shortId` · `shares:write`
Share links, the same ones the app creates.

## Managing tokens — `/api/tokens`

Session-only, deliberately: a token must not be able to mint another token, or a leaked
read-only token could issue itself a delete-everything one.

### `GET /api/tokens`
`{ tokens, scopes }` - the caller's live tokens and the full list of scopes Orbit issues. Each
token shows its name, its last six characters, its scopes and when it was last used.

### `POST /api/tokens`
Body `{ name, scopes: [], expiresInDays? }`. Answers `201 { token, record }`. **`token` is
shown exactly once and is not recoverable**; only a SHA-256 fingerprint is stored. An unknown
scope is refused rather than filtered out.

### `DELETE /api/tokens/:id`
`204`. The token stops working immediately. The row is kept as revoked rather than deleted, so
a later audit can still explain requests made with it.

## Planned

| Route | Phase |
|---|---|
| `POST /api/uploads/init`, `PUT /api/uploads/:id/chunk` | 5 |
| `GET /api/allocation`, `PUT /api/allocation` | 5 |
| `POST /api/sync/trigger`, `GET /api/health/sync` | 6 |
| `POST /api/shares`, `DELETE /api/shares/:shortId`, `GET /s/:shortId`, `GET /s/:shortId/qr` | 7 |
| `GET /api/admin/*` | 8 |
