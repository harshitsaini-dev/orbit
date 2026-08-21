# 0001 — Orbit aggregates, it never stores bytes

- **Status:** accepted
- **Date:** 2026-08-21

## Context

Orbit presents many cloud drives through one workspace. The obvious implementation caches or
re-hosts file content so previews and downloads are fast and uniform. That would require bulk
object storage, which is the single largest recurring cost in a project like this and the one
free tier that reliably demands a payment card.

## Decision

Orbit stores only metadata, encrypted credentials, and its own app data. File bytes are fetched
from the connected provider on demand and streamed straight through to the client, never landing
on Orbit's disk or database.

## Consequences

- No S3/R2/B2 dependency; the whole stack fits in card-free free tiers.
- Download and preview latency is bounded by the provider, not by Orbit.
- Public share links must proxy through the backend (see ADR 0004) rather than redirecting, so
  the provider URL stays hidden.
- Any future feature that wants a cache (thumbnails, transcodes) needs its own ADR and a
  storage-cost answer.
