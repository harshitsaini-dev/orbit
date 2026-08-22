# 0007 — A provider catalogue separate from the adapter registry

- **Status:** accepted
- **Date:** 2026-08-21

## Context

Orbit is meant to cover Google Drive, OneDrive, Dropbox, MEGA, pCloud, Amazon S3, Cloudflare R2,
Supabase Storage, DigitalOcean Spaces, Backblaze B2, Google Cloud Storage, Azure Blob Storage and
Bunny Storage.

Six of those speak the plain S3 API and differ only in endpoint. Writing six near-identical
adapters would be duplication; but collapsing them into one "S3-compatible" option in the UI
would push the work onto the user, who would have to know that R2's endpoint is
`https://{accountId}.r2.cloudflarestorage.com` and that Supabase requires path-style addressing.

## Decision

Two separate concepts:

- **Adapters** (`ProviderId`) — one per distinct provider API. Nine of them:
  `google_drive`, `onedrive`, `dropbox`, `mega`, `pcloud`, `gcs`, `azure_blob`, `bunny`, `s3`.
- **Catalogue entries** (`PROVIDER_CATALOGUE`) — one per thing a user recognises and picks.
  Fourteen of them. Each names the adapter it routes to, an endpoint template, whether the
  service needs path-style addressing, and the exact fields the connect form must collect.

`accounts.catalogue_key` records which entry the user chose, so the UI can label an account
"Cloudflare R2" even though the adapter behind it is `s3`.

Services that are not S3-compatible get their own adapter: GCS (native JSON API, for resumable
uploads), Azure Blob, and Bunny Edge Storage.

## Consequences

- Adding an S3-compatible service is a data change — one catalogue entry, no new code.
- The connect form is generated from the catalogue, so a new entry cannot ship without declaring
  what it needs to be asked.
- The contract suite checks the two stay consistent: every entry points at a real adapter, every
  adapter is reachable from at least one entry, every `{placeholder}` in an endpoint template is
  actually collected, and every secret field is marked secret.
- Two capability flags were added for object stores — `nativeFolders` (false: folders are
  synthesised from key prefixes) and `reportsQuota` (false: a bucket reports bytes stored, not an
  allowance) — so the UI can adapt rather than showing an empty quota bar.

## iCloud Drive and Proton Drive

> **Removed 2026-08-22.** The `UNAVAILABLE_PROVIDERS` list, its landing-page section and its API
> field are gone at the owner's request. The reasoning below is kept because it is still true and
> is why neither was built — but Orbit no longer advertises services it does not offer, and an
> always-empty list plus the UI and tests around it is worse than no list.

Both were requested and neither can be supported:

- **iCloud Drive** — Apple publishes no API for third-party access to a user's Drive. CloudKit
  reaches an application's own container, not the user's documents.
- **Proton Drive** — Proton publishes no public Drive API. Working integrations reverse-engineer
  the private one, which means implementing Proton's SRP login and end-to-end encryption against
  an interface that can change without notice.

Rather than omit them silently, they are listed in `UNAVAILABLE_PROVIDERS` with the reason and
what would unblock them, and served from `GET /api/catalogue` so the connect dialog can explain
itself. Shipping stub adapters for them would have been worse: a stub that can never work looks
like an unfinished feature rather than an impossibility.
