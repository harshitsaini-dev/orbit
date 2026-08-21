# 0009 — One adapter for every S3-compatible store

**Status:** accepted
**Date:** 2026-08-21

## Context

Amazon S3, Cloudflare R2, Supabase Storage, DigitalOcean Spaces, Backblaze B2,
MinIO and several others all speak the same API. They differ in the endpoint,
in whether the bucket goes in the hostname or the path, and in whether they care
about the region at all — but not in the protocol.

Object stores also differ from drives in a way that matters more: there are no
folders, no rename, no search, and nothing can be starred. A key is a flat
string that happens to contain slashes.

## Decision

One `s3` adapter serves every S3-compatible catalogue entry. The catalogue
supplies the endpoint template, the addressing style and the default region;
the adapter supplies the protocol.

SigV4 is implemented directly against `node:crypto` rather than taken from the
AWS SDK.

Folders are synthesised from key prefixes rather than declined. Rename is a copy
followed by a delete. Search narrows by prefix at the store and matches names
while paging.

## Consequences

- Five catalogue entries became connectable from one adapter, and adding a sixth
  S3-compatible service is a catalogue entry rather than code.
- `provider` no longer identifies a service. `catalogueKey` is stored on the
  account and returned with it, because an R2 bucket and a Backblaze bucket must
  not present as the same thing.
- The `search` capability now means "the adapter can answer a search", not "the
  provider has a search endpoint". Read the other way, every bucket would be
  silently unsearchable.
- Renaming a folder costs one copy and one delete per key beneath it. This is
  what the API offers; there is no cheaper move.
- Quota reports bytes used and no allowance, counted over a bounded walk. Past
  the bound the figure is a floor. A bucket has no limit to report and inventing
  one would draw a usage bar against a number that does not exist.

## Alternatives considered

**The AWS SDK.** Tens of megabytes of client code for one signing algorithm, on
a deployment that has to fit a free tier. It also assumes AWS endpoint
conventions that R2, Backblaze and Supabase do not all share, so the parts that
would have saved work are the parts that need overriding.

**One adapter per service.** Five near-identical files differing in two
constants, and five places for a protocol fix to be applied four times.

**Declining folders and showing flat keys.** Honest, and unusable: a bucket with
ten thousand keys is a wall of text. The delimiter the list API already offers
makes the folder view cost nothing extra.
