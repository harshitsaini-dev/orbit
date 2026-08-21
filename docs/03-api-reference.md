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

### `WS /ws`
Channel pub/sub. Client frames: `{"type":"subscribe","channel":"..."}`, `unsubscribe`, `ping`.
Server frames: `upload:progress`, `upload:complete`, `upload:error`, `sync:status`.

## Planned

| Route | Phase |
|---|---|
| `POST /auth/request-otp`, `POST /auth/verify-otp`, `POST /auth/logout`, `GET /auth/me` | 1 |
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
