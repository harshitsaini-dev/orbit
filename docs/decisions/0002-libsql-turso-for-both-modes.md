# 0002 — libSQL/Turso as the single database driver

- **Status:** accepted
- **Date:** 2026-08-21

## Context

Local mode is a personal, self-hosted deployment that should work from a plain file. Hosted mode
runs on Render, whose filesystem is ephemeral — a local SQLite file would be wiped on every
redeploy.

## Decision

Use Drizzle ORM over `@libsql/client`. `DATABASE_URL=file:./orbit.db` for local mode,
`DATABASE_URL=libsql://…turso.io` plus an auth token for hosted mode.

## Consequences

- One schema, one query layer, one migration history for both modes.
- Turso's free tier (5 GB, card-free) is far beyond what metadata-only storage needs.
- SQLite semantics apply everywhere, so no Postgres-only features may be used.
