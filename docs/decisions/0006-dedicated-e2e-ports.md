# 0006 — The E2E stack runs on its own ports and never reuses a server

- **Status:** accepted
- **Date:** 2026-08-21

## Context

Playwright's `reuseExistingServer` silently adopts anything already listening on the target
port. Locally that meant the suite could attach to a hand-started dev server that lacked the
environment the config sets — hosted mode, the dev outbox, a raised rate limit. The result was
nondeterministic: some runs passed, some failed with a rate-limited request surfacing as a
generic "Request failed" in the UI.

## Decision

The E2E stack runs on dedicated ports (API `8788`, web `5174`) with `reuseExistingServer: false`
and `strictPort`. Both ports are driven by environment variables the Playwright config sets, so
the servers under test always have exactly the configuration the suite expects.

The database is likewise addressed by an **absolute** `file://` URL, since a relative
`file:./x.db` resolves against each process's own working directory — the migration step and the
server had been reading two different files.

## Consequences

- A run either starts its own correctly-configured stack or fails loudly; it can never quietly
  test the wrong thing.
- A dev server left running on 5173/8787 no longer interferes with a test run.
- Timeouts were raised (60 s per test, 15 s per expectation) because a cold Vite dev server
  transforms the module graph, three.js included, on the first parallel request.
