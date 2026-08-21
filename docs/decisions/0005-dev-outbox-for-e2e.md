# 0005 — A gated dev outbox instead of a mailbox in tests

- **Status:** accepted
- **Date:** 2026-08-21

## Context

The E2E suite must exercise the real OTP flow, which means reading a code that was "emailed".
Polling a real mailbox in CI is slow and flaky, and weakening the flow for tests would mean the
suite no longer covers what ships.

## Decision

When no `RESEND_API_KEY` is configured, the mailer logs to the console *and* records the code in
a small in-memory outbox. `GET /auth/dev/last-code` reads it back, and is routable only when
**both** `ENABLE_DEV_AUTH_ENDPOINTS=true` and `NODE_ENV !== 'production'`.

## Consequences

- Tests drive the genuine flow: real code, real expiry, real attempt limits.
- The endpoint cannot exist on a production deployment: it needs an explicit opt-in that
  defaults to off, and is refused outright under `NODE_ENV=production`. A test asserts it 404s
  when not enabled.
- Because the outbox stands in for a mail provider, hosted mode does not demand
  `RESEND_API_KEY` when the dev endpoints are enabled — the only configuration where nobody
  expects real email.
