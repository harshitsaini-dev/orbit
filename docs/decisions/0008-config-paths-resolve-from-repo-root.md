# 0008 — Paths in configuration resolve from the repo root

- **Status:** accepted
- **Date:** 2026-08-21

## Context

Two bugs with the same shape surfaced while connecting the first Google account, and neither
announced itself:

1. `dotenv` resolves a bare `.env` against the **process working directory**. The server starts
   from `apps/server`, so the repo-root `.env` was never read at all. Nothing failed loudly —
   every variable simply fell back to its default, and the only symptom, much later, was an OAuth
   client id that appeared unset.
2. `DATABASE_URL=file:./orbit.db` is likewise relative to the working directory. The server
   (`apps/server`), drizzle-kit (`packages/db`) and the migration step each opened a *different*
   file. Migrations were applied to one database while the server read an empty one, and the
   error surfaced as `no such table: users` — a message that points nowhere near the cause.

Both bugs cost far more to find than to fix, because a wrong-but-plausible default is much harder
to diagnose than a hard failure.

## Decision

A path written in configuration means "relative to the project", never "relative to however this
process was launched".

- `loadEnvFile()` resolves `.env` from the server module's own location, not the working
  directory. Real environment variables still take precedence, so Render, CI and the Playwright
  config are unaffected.
- `resolveDatabaseUrl()` resolves a relative `file:` URL against the repo root. Remote URLs and
  absolute file URLs pass through untouched.
- A blank value in `.env` is treated as unset. `DATABASE_URL=` parses to an empty string, which
  is not `undefined`, so every `?? default` in the codebase would otherwise keep the empty value
  and fail somewhere unrelated.

## Consequences

- Any command can be run from any directory and reaches the same database and the same config.
- `resolveDatabaseUrl` has its own test suite covering exactly the case that broke: a relative
  `file:` URL must resolve to the repo root regardless of the working directory.
- The Express error handler now logs the whole `cause` chain. The original 500 reported only
  "Failed query", which said nothing; the driver's actual `no such table: users` was two levels
  down and invisible.
