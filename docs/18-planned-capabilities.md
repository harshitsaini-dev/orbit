# Planned capabilities (beyond the core)

Committed to the roadmap rather than built. Each entry says what it is, how it
fits the constraints already established — Orbit stores no file bytes
(`02-architecture.md` §0), everything runs on free tiers (§1) — and, where it
does not fit, what the honest alternative is.

**Nothing here may introduce a paid dependency without being raised first.**

---

## 1. Instant directory cache and offline browsing

The directory structure — names, ids, paths, sizes, timestamps, never contents
— mirrored into IndexedDB. The workspace paints from the cache immediately and
refreshes from the provider behind a small "Syncing…" indicator. With no
network the tree still browses, while preview and download disable themselves.

This is first because everything after it gets faster for free: Spotlight
searches the cache, the dashboard sums it, the duplicate finder reads it. With
fifteen accounts connected, opening a cold folder today is fifteen provider
round trips.

*Cost: none.* The cache is per browser and disposable; the server keeps its own
mirror already (§8).

*Care:* an entry may be stale. Anything that acts on a file — download, rename,
delete — goes to the provider and reports what the provider says, never what
the cache believed.

## 2. Spotlight (Ctrl/Cmd + K)

A floating command bar over every page. Results carry the provider's badge, so
"which cloud is that invoice in" stops being a question. `/api/search` already
searches every account in parallel with per-account cursors, so this is mostly
UI plus the cache above for instant local matches while provider results
arrive.

*Cost: none.*

## 3. Unified storage dashboard

One donut across every connected account: total allowance, used, and each
provider's share in its own colour, with the existing per-account category
breakdown underneath. The data is already there — `GET /api/accounts` and
`/api/accounts/:id/breakdown`.

*Care:* buckets report no allowance at all (see the S3 adapter, ADR 0009). A
total that silently omits them would be wrong, so measured and unmeasured
storage have to be shown separately.

*Cost: none.*

## 4. Collections (virtual folders)

A "Tax Documents 2026" holding a PDF from S3, a spreadsheet from Drive and an
image from MEGA, without moving or copying anything. Two tables — `collections`
and `collection_items` — holding `(accountId, remoteId)` references and nothing
else.

*Care:* a referenced file can be deleted or renamed at the provider. An entry
that no longer resolves is shown as missing rather than quietly dropped, so the
user finds out rather than wondering.

*Cost: none.*

## 5. Cross-cloud transfer engine

Drag a file from Drive onto an S3 folder and have it move provider to provider,
with a transfer queue in the corner showing progress. Bytes stream through the
server — read from the source adapter, written to the destination's chunked
upload — and are never written to Orbit's disk, which keeps §0 intact.

*Constraint worth stating plainly:* the free Render instance has 512MB of RAM,
sleeps after fifteen minutes idle, and restarts on deploy. A multi-gigabyte
transfer will not survive that. So the design has to be chunk-at-a-time with
the position persisted after each chunk, resumable from where it stopped, and
honest in the UI about a transfer that is paused rather than pretending it is
still moving. Small and medium files work well; very large ones need the
instance kept awake, which the uptime pinger in §1 helps with but cannot
guarantee.

*Cost: none, within those limits.*

## 6. Duplicate finder

The same photo in MEGA and in S3, found by comparing checksums rather than
names.

*Constraint:* the checksum is not always present and not always comparable.
Drive returns a real MD5. S3 returns an ETag that is an MD5 **only for
single-part uploads** — a multipart object's ETag ends in `-<partcount>` and is
not a hash of the content, which is why the S3 adapter already refuses to
present one as a checksum.

So the finder works in tiers:

1. Exact match where both sides have a comparable hash.
2. "Possible duplicate" on size plus name where they do not.
3. An explicit, user-triggered hash-on-download for a shortlist, since that
   costs bandwidth and time.

Presenting tier two as certainty would eventually delete somebody's only copy.

*Cost: none.*

## 7. Metadata viewers: EXIF and hex

Right-click → "File details": camera, lens, GPS and timestamps for a photo, and
a raw byte view for anything. Both read the first few kilobytes over a Range
request rather than downloading the file, which the content route already
supports.

*Care:* GPS in EXIF is somebody's home address. It is shown to the owner
because the file is theirs, but a share link must never carry it — the sharing
work in §7 has to strip EXIF from public views.

*Cost: none.*

## 8. More previewers

- **Fonts** — `.ttf`/`.otf` injected as an `@font-face` into a scoped style
  element, with a sample and a size slider.
- **Markdown** — rendered and raw, toggled. Rendering goes through a library
  that escapes by default; hand-rolled markdown is where cross-site scripting
  lives.
- **Archives** — see below.
- **3D models** — `.gltf`/`.obj` with orbit controls. `three` is already a
  dependency for the landing hero.

*Cost: none.*

## 9. Archive browsing without downloading

A ZIP's index lives at the *end* of the file, so its contents can be listed by
range-requesting the last few kilobytes and reading the central directory —
never the whole archive. Opening one file inside it is a second range request
for that entry, inflated with the browser's own `DecompressionStream`.

Worth stating because the obvious approach — hand the file to a ZIP library —
needs the entire archive in memory first, so listing the contents of a 2GB
backup would download 2GB.

*Cost: none. No library required.*

## 10. Automatic tagging by OCR

Text extracted from receipts and scans so that searching "Amity" finds the
photo of the receipt. Tesseract.js runs in a Web Worker, so the work happens on
the user's machine and nothing is sent anywhere.

*Constraint:* the WASM bundle is roughly ten to fifteen megabytes, loaded only
when OCR is asked for and never as part of the app. It also only sees files
that pass through that browser — existing files need a scan the user starts
deliberately, on a folder they choose, with a visible cost.

Server-side OCR would be simpler and would cost money, so it is not on the
table.

*Cost: none.*

## 11. Peer-to-peer direct transfer

Send a large file to someone without uploading it anywhere first: WebRTC
between two open browsers, signalled over the WebSocket connection Orbit
already has.

*Constraint, and the one paid-service trap in this list:* WebRTC needs STUN to
discover addresses, which is free, and TURN to relay when both peers are behind
symmetric NAT, which is not. Somewhere between one and two connections in ten
fail without TURN.

The answer is not to buy TURN. It is to detect the failure and offer the
ordinary path — upload to a connected account and share the link — rather than
leaving the user watching a transfer that will never start.

*Cost: none, with that fallback.*

## 12. Scheduled jobs

"Every Sunday at 2am, back up Drive photos to MEGA." node-cron is already in
the stack for the sync engine (§8), and the transfer engine above is the thing
being scheduled, so this is a schedule table and a UI once both exist.

*Care:* a job that fires while the instance is asleep does not fire. Schedules
have to be checked on wake and run late rather than skipped silently.

*Cost: none.*

## 13. Share analytics

Where and when a share link was opened, on a map.

*Constraint:* turning an IP into a country needs a database. MaxMind's GeoLite2
is free but requires an account and a licence key; `ip-api.com` is free only
for non-commercial use at 45 requests a minute. Either is acceptable, but it is
a signup that must be raised before it is added, per §1.

*Care:* this logs where someone opened a link. It stays coarse — country level
— with a short retention window.

## 14. HLS video streaming — declined, with an alternative

The request was on-the-fly HLS chunking so a 4K file plays without downloading.
The download is already avoided: the content route honours Range, so a browser
seeks within an MP4 by fetching only the bytes it needs. That is why the player
scrubs a large file without buffering it.

What HLS adds beyond that is *adaptive bitrate* — dropping quality on a poor
connection — and that requires transcoding the source into several renditions.
Transcoding is sustained CPU, which the free tier has neither the capacity nor
the request time limits for, quite apart from where the renditions would live
given Orbit stores no bytes (§0).

So: Range streaming stays the answer for direct play, an HLS source is passed
through untouched, and transcoding is noted as something that would need paid
compute — to be raised, never assumed.

---

## Suggested order

Each phase leaves the app shippable, and earlier ones make later ones cheaper.

| Phase | Capability | Why here |
|---|---|---|
| 12 | Directory cache + offline (1) | Everything after it gets faster for free |
| 13 | Spotlight (2) | Mostly UI once the cache exists |
| 14 | Unified dashboard (3) | Data already collected |
| 15 | Collections (4) | Self-contained; two tables |
| 16 | Metadata + previewers (7, 8, 9) | No new infrastructure |
| 17 | Transfer engine (5) | Needs persisted, resumable jobs |
| 18 | Duplicate finder (6) | Reads the cache from phase 12 |
| 19 | Scheduled jobs (12) | Schedules what phase 17 built |
| 20 | OCR tagging (10) | Heavy; wants the cache and search settled |
| 21 | P2P transfer (11) | Independent, and the fallback matters more than the feature |
| 22 | Share analytics (13) | After sharing itself (phase 7) is real |
