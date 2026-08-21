# 0003 — One Node process for API, WebSocket, and cron

- **Status:** accepted
- **Date:** 2026-08-21

## Context

Render's free tier allows one always-on web service worth of instance hours. Splitting the API,
the WebSocket server, and the sync scheduler into separate services would exceed it.

## Decision

`apps/server` runs all three in one process: Express handles REST, the `ws` server attaches to
the same HTTP server on `/ws`, and node-cron schedules the sync pass in-process.

## Consequences

- Fits one free service; keeps deployment to a single unit.
- Horizontal scaling would break the in-memory WebSocket channel map and duplicate cron runs.
  If Orbit ever needs more than one instance, the hub moves to an external pub/sub and the
  scheduler gains a database lock — that will need its own ADR.
- The instance sleeps after 15 minutes idle; an external uptime pinger on `/health` keeps it warm.
