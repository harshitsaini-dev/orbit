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

### `WS /ws`
Channel pub/sub. Client frames: `{"type":"subscribe","channel":"..."}`, `unsubscribe`, `ping`.
Server frames: `upload:progress`, `upload:complete`, `upload:error`, `sync:status`.

## Planned

| Route | Phase |
|---|---|
| `GET /auth/connect/:provider`, `GET /auth/callback/:provider` | 2 |
| `GET /api/accounts`, `POST /api/accounts`, `DELETE /api/accounts/:id` | 2 |
| `GET /api/files`, `POST /api/files/folder`, `PATCH /api/files/:id`, `DELETE /api/files` | 2 |
| `GET /api/files/:id/content` (range-aware stream) | 2 |
| `GET /api/views/{recent,starred,shared-with-me}` | 4 |
| `POST /api/uploads/init`, `PUT /api/uploads/:id/chunk` | 5 |
| `GET /api/allocation`, `PUT /api/allocation` | 5 |
| `POST /api/sync/trigger`, `GET /api/health/sync` | 6 |
| `POST /api/shares`, `DELETE /api/shares/:shortId`, `GET /s/:shortId`, `GET /s/:shortId/qr` | 7 |
| `GET /api/admin/*` | 8 |
