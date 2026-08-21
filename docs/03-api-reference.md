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

### `GET /api/accounts`
`{ accounts: PublicAccount[] }`. Never includes token material of any kind.

### `POST /api/accounts/:id/refresh-quota`
Re-reads usage from the provider and caches it. `409 needs_reauth` when the grant has expired.

### `DELETE /api/accounts/:id`
Disconnects. `204`. Files in the provider account are untouched.

### `GET /api/files?accountId=&path=&pageToken=`
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

### `GET /api/files/:id/content?accountId=&download=&name=`
Streams the file straight through from the provider. The bytes never touch Orbit's disk and the
provider's own URL never reaches the client.

- Honours `Range`, answering `206` with `Content-Range`. A suffix range (`bytes=-500`) is
  declined rather than guessed at, since this layer does not know the length.
- Always `Cache-Control: private, no-store` — one user's file behind their session.
- `download=1` adds a `Content-Disposition` attachment header with `name`.

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
The catalogue entries that can actually be connected today, as opposed to the full catalogue.

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
