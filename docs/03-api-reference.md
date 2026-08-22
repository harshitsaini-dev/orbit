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
  "unavailable": [{ "key": "icloud_drive", "label": "iCloud Drive",
    "reason": "Apple publishes no API for third-party access to a user's Drive.",
    "unblockedBy": "Apple shipping a public iCloud Drive API with third-party OAuth." }]
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

### `POST /api/accounts/:id/refresh-quota`
Re-reads usage from the provider and caches it. `409 needs_reauth` when the grant has expired.

### `DELETE /api/accounts/:id`
Disconnects. `204`. Files in the provider account are untouched.

### `GET /api/files?accountId=&path=&pageToken=`
Note the asymmetry: the request takes `pageToken`, the response returns the next one as
`nextCursor`. Passing it back as `cursor` is silently ignored and re-fetches the first page.

Lists one folder from one account.
`{ accountId, provider, path, files, nextCursor, capabilities }`. The capabilities travel with
the listing so the UI can hide actions the provider cannot perform.

### `GET /api/views/:view`
`recent`, `starred`, or `shared`, **merged across every connected account** — which is the point
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

### `WS /ws`
Channel pub/sub. Client frames: `{"type":"subscribe","channel":"..."}`, `unsubscribe`, `ping`.
Server frames: `upload:progress`, `upload:complete`, `upload:error`, `sync:status`.

## Planned

| Route | Phase |
|---|---|
| `POST /api/uploads/init`, `PUT /api/uploads/:id/chunk` | 5 |
| `GET /api/allocation`, `PUT /api/allocation` | 5 |
| `POST /api/sync/trigger`, `GET /api/health/sync` | 6 |
| `POST /api/shares`, `DELETE /api/shares/:shortId`, `GET /s/:shortId`, `GET /s/:shortId/qr` | 7 |
| `GET /api/admin/*` | 8 |
