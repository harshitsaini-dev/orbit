# Developer platform — design

**Status: designed, not implemented.** This is the plan for Phase 11. Nothing described here
exists yet; the roadmap in `docs/01-project-state.md` tracks when it lands.

The goal: someone other than the account owner can build against Orbit. A script, a mobile app,
a backup job, or another product should be able to list and move a user's files across every
connected provider through one API — which is the whole point of an aggregator, and is worth
more to a developer than the UI is.

---

## 1. What ships

1. A versioned public REST API at `https://api.orbit.harshitsaini.in/v1/…`.
2. Two ways to authenticate: **personal access tokens** for a developer acting on their own
   account, and **OAuth 2.0** for an application acting on behalf of someone else.
3. A **Developer** tab in the app: create and revoke tokens, register OAuth applications, see
   request logs and rate-limit headroom.
4. An **API docs** tab rendering the OpenAPI spec, with a live "try it" console that uses the
   reader's own session.
5. A machine-readable `openapi.json`, generated from the same Zod schemas the routes validate
   with — so the documentation cannot drift from the implementation.

---

## 2. Authentication

### Personal access tokens

For a developer acting as themselves. Created in the Developer tab, shown once, stored as a
SHA-256 fingerprint exactly as session tokens already are.

```
Authorization: Bearer orbit_pat_<41 random base62 chars>
```

The `orbit_pat_` prefix is deliberate: it makes a leaked token findable by secret scanners, and
it lets the API reject a malformed credential before touching the database.

### OAuth 2.0 for third-party applications

Authorisation-code flow with PKCE, so public clients (SPAs, mobile, CLI) need no client secret.

```
GET  /v1/oauth/authorize?client_id&redirect_uri&scope&state&code_challenge&code_challenge_method
POST /v1/oauth/token            # code -> access + refresh token
POST /v1/oauth/revoke
```

- Access tokens live one hour; refresh tokens rotate on every use, and reusing a consumed
  refresh token revokes the whole chain — the standard defence against a stolen refresh token.
- The consent screen names the application, the scopes, and **which connected accounts** it will
  reach. A user must be able to grant access to one Drive without handing over all of them.
- Every grant is listed under Settings → Connected applications, revocable individually.

### Scopes

Narrow and readable; an application asks for the least it needs.

| Scope | Grants |
|---|---|
| `files:read` | List and read file metadata |
| `files:download` | Stream file content |
| `files:write` | Create folders, rename, upload |
| `files:delete` | Delete files and folders |
| `accounts:read` | List connected accounts and quota |
| `accounts:write` | Connect and disconnect accounts |
| `shares:read` / `shares:write` | Read and create share links |

Deliberately absent: any scope granting the raw provider credentials. Orbit proxies; it never
hands a third party the user's Google token. That is the security property that makes the whole
platform safe to open up, and no scope may ever break it.

---

## 3. Surface

`/v1` mirrors what the app already uses, minus the session-only routes.

| Method | Path | Scope |
|---|---|---|
| `GET` | `/v1/accounts` | `accounts:read` |
| `POST` | `/v1/accounts` | `accounts:write` |
| `DELETE` | `/v1/accounts/{id}` | `accounts:write` |
| `GET` | `/v1/files?path=&accountId=&cursor=` | `files:read` |
| `GET` | `/v1/files/{id}` | `files:read` |
| `GET` | `/v1/files/{id}/content` | `files:download` |
| `POST` | `/v1/files/folder` | `files:write` |
| `PATCH` | `/v1/files/{id}` | `files:write` |
| `DELETE` | `/v1/files` | `files:delete` |
| `POST` | `/v1/uploads` | `files:write` |
| `PUT` | `/v1/uploads/{id}/chunk` | `files:write` |
| `GET` | `/v1/shares` · `POST` `/v1/shares` · `DELETE` `/v1/shares/{shortId}` | `shares:*` |
| `POST` | `/v1/sync` | `accounts:write` |
| `GET` | `/v1/me` | any |

Conventions:

- Cursor pagination everywhere (`cursor` in, `nextCursor` out). No offsets — the mirror changes
  under the reader.
- `GET /v1/files/{id}/content` honours `Range`, so a client can seek video without downloading
  the file.
- One error shape, matching the existing API: `{ "error": { "code", "message" } }`.
- Breaking changes mean `/v2`. `/v1` keeps working.

---

## 4. Rate limits

Per token, not per IP — an IP limit punishes everyone behind one NAT and does nothing against a
distributed client.

| Tier | Requests/min | Concurrent transfers |
|---|---|---|
| Personal access token | 300 | 4 |
| OAuth application, per user | 180 | 3 |

Every response carries `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset`, and a 429
carries `Retry-After`. A client should never have to guess.

Transfer routes are counted separately from metadata routes: a large download must not consume a
listing budget.

---

## 5. Webhooks

Polling an aggregator is wasteful when the sync engine already knows what changed.

- Register an endpoint per application; Orbit `POST`s `file.created`, `file.updated`,
  `file.deleted`, `account.connected`, `account.needs_reauth`.
- Every delivery is signed: `Orbit-Signature: t=<unix>,v1=<hmac-sha256 of "t.body">`, verified
  against the endpoint's secret. Receivers must reject a timestamp older than five minutes, which
  is what stops a captured delivery being replayed.
- Retries with exponential backoff for 24 hours; deliveries and their responses are visible in
  the Developer tab, because a webhook you cannot inspect is a webhook you cannot debug.

---

## 6. The Developer tab

Route `/developer`, available to any signed-in user.

- **Tokens** — create (name, scopes, optional expiry), see last-used time, revoke. The value is
  shown exactly once, on creation.
- **Applications** — register an OAuth client: name, logo, redirect URIs, scopes. Public clients
  get no secret and must use PKCE.
- **Webhooks** — endpoint URL, signing secret, recent deliveries with status and response body.
- **Usage** — requests over time, error rate, current rate-limit headroom.

## 7. The API docs tab

Route `/developer/docs`, and also published unauthenticated so it can be linked from the README.

- Rendered from `openapi.json`, which is **generated from the Zod schemas the routes already
  validate with**. Hand-written API docs drift from the code within a release; generated ones
  cannot.
- Every endpoint shows request and response schemas, required scopes, error codes, and a
  copy-paste example in `curl`, JavaScript, and Python.
- A "try it" console that signs requests with the reader's own session when they are signed in,
  so the examples are runnable rather than illustrative.
- A getting-started page covering the token flow end to end, and a page on the aggregation model
  — virtual paths, `accountId`, and allocation strategies — since none of that is guessable from
  the endpoint list alone.

---

## 8. Data model additions

```
api_tokens        id, user_id, name, token_hash, scopes, last_used_at, expires_at, revoked_at
oauth_clients     id, owner_id, name, logo_url, redirect_uris, is_public, secret_hash
oauth_grants      id, client_id, user_id, scopes, account_ids, refresh_token_hash,
                  rotated_from, revoked_at
webhook_endpoints id, client_id, url, secret_hash, events, disabled_at
webhook_deliveries id, endpoint_id, event, payload, status_code, attempts, next_retry_at
api_request_log   id, token_id, method, path, status, duration_ms, created_at
```

`oauth_grants.account_ids` is what implements per-account consent: the grant names exactly which
connected accounts the application may reach, and the API filters every query by it.

---

## 9. Order of work

1. `api_tokens` + bearer middleware + scope enforcement.
2. `/v1` routes reusing the existing services, with scope checks and per-token rate limits.
3. OpenAPI generation from the Zod schemas, and the docs tab that renders it.
4. The Developer tab: token management, then usage.
5. OAuth clients, consent screen, and grant management.
6. Webhooks.

Steps 1–4 are useful on their own: they give the owner a scriptable API and public documentation
without any of the third-party surface. Steps 5–6 are only worth building once something outside
Orbit actually wants to integrate.

---

## 10. Open questions

- Should an OAuth application be able to *connect* a provider account on the user's behalf
  (`accounts:write`), or only use accounts the user connected themselves? Connecting on behalf
  means the application chooses the OAuth scopes requested from Google, which is a meaningfully
  larger trust grant. Leaning towards: read-only account access for third parties in v1.
- Rate limits above are guesses. They should be set from observed usage, not before it.
- Whether to expose the allocation engine over the API, or make an upload's target account
  explicit. Implicit allocation is convenient but surprising for a program.
