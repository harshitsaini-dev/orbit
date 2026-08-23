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

## MEGA

> **Removed 2026-08-22. Added back 2026-08-23, at the owner's request and with the reasoning
> below still true.**
>
> MEGA publishes no official API and issues no OAuth tokens. Every working integration reaches
> the private one and implements MEGA's client-side cryptography; Orbit does that through
> `megajs`, an unofficial MIT-licensed SDK, rather than writing the cryptosystem itself.
>
> Two things follow, and neither can be engineered away:
>
> **Access begins with a password.** MEGA derives the key that decrypts the files from the
> password itself, so there is no token to ask for. The adapter uses the password once, at
> connect, to open a session — a session id and the derived master key — and stores that. The
> password is not among the fields kept. This is not a formality: a session appears in MEGA's own
> *Session history* and can be killed from there, which a stored password could not be.
>
> Two mistakes were made getting there, both found only once a real account was connected, and
> both worth recording because each looked correct:
>
> - `Storage.toJSON()` returns the constructor options alongside the session, and at connect
>   those hold the password. Storing its output wholesale wrote the password into the database
>   while three comments and the connect form said it was discarded. The stored shape now names
>   every field, so adding one has to be deliberate.
> - `Storage.close()` is not a disconnect. It sends `a: "sml"` — a logout — which ends the
>   session id being stored. Closing after export produced a connection that authenticated once
>   and then answered "no permission" to everything: no file listing, no quota, and a nickname
>   that fell back to "MEGA" because even the identity lookup was refused.
>
> **Two-factor is supported.** MEGA's own TOTP, as an optional field at connect. It is used once
> and never stored, and a wrong or missing code says so rather than reporting a wrong password —
> which would send somebody to reset a password that was correct.
>
> **The interface can change without notice.** Nothing here rests on a promise MEGA has made.
> When it breaks it will break at the SDK, and this adapter is best-effort in a way the OAuth
> ones are not. That is written in the adapter's own header so nobody later mistakes it for the
> same class of thing as Drive.
>
> Capabilities are claimed narrowly, and three of them read as limits that turned out not to be:
>
> - **Thumbnails.** `thumbnails: false` means *the provider* does not render them, and routes tiles
>   to Orbit's own renderer — the same path an S3 bucket takes. MEGA cannot draw a thumbnail
>   because MEGA cannot read the file; Orbit holds the key and can. Tiles work.
> - **Copying.** MEGA does have a server-side copy: a second node pointing at the same stored
>   object with the key re-wrapped for its new parent. Copying a two-gigabyte video costs what
>   copying an empty file costs, which is the opposite of the obvious assumption about an
>   end-to-end encrypted store.
> - **Uploads.** MEGA wants the length before the first byte, which looked like it forced the
>   whole file into memory — but Orbit is told the length at `initUpload` too. The upload is
>   opened there and the chunks are written into it as they arrive. `resumableUpload` stays false
>   and honestly: an interrupted upload has to start again. That is a different thing from
>   buffering it, and only the second was ever fixable here.
>
> What is genuinely absent: inbound shares, which are mounts with their own key handling and are
> not claimed rather than half-supported.
>
> **What this cost elsewhere, and gained.** The connect route forwarded five S3-shaped fields and
> dropped anything else, so MEGA's email and password arrived as `undefined`. It now passes
> through whatever the catalogue entry declares, and names the connection from the adapter's own
> identity where it has one. That removed a special case rather than adding one — which is the
> rule this document exists to hold.

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
