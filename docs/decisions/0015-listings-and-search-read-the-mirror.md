# 0015 — Listings and search read the mirror

Status: **reversed 2026-08-26** — see "What this got wrong" at the end
Date: 2026-08-23

## Context

Orbit has kept a local metadata mirror since the first sync engine — `files_mirror`, filled
every fifteen minutes by `SYNC_CRON`, holding names, paths, sizes, checksums and dates. Never
bytes.

Only three things ever read it: the duplicate finder, the storage breakdown, and the sync pass
itself. Browsing and searching went to the provider every single time.

That is a network round trip per page, and the round trips are *serial*, because each page needs
the cursor the one before it returned. A folder of fifty thousand files at a thousand a page is
fifty of them, one after another, each carrying its own auth and rate limiting. Search is worse:
it walks every page of every connected account before it can answer.

Meanwhile the same question against SQLite is one indexed lookup, and the answer was already
sitting in the database.

## Decision

**Listings and search read the mirror when it can answer, and the provider when it cannot.**

Four parts:

1. **`created_at` on the mirror**, plus indexes on `(account_id, name)`, `(created_at)` and
   `(account_id, parent_remote_id)`. Null created date keeps meaning "this provider does not
   report one" — never the epoch.
2. **An FTS5 virtual table over the name**, kept current by triggers, matched by prefix so the
   search box answers before the word is finished. `LIKE '%term%'` can never use an index; this
   can.
3. **A read path** in `services/mirror.ts` that both the listing route and the search service
   go through.
4. **Write-through on every mutation.** Upload, create folder, rename, star, move, copy and
   delete all update the mirror as part of the request.

The fallback is generous on purpose: no rows for the account, *or a first page that comes back
empty*, sends the request to the provider. An unmirrored folder and an empty one are the same
query result, and reporting somebody's drive as empty is far worse than one wasted round trip.

A continuation never switches sides — mixing a row offset with per-account provider cursors in
one token is how a result set silently repeats or drops files.

## Consequences

**A listing is as current as the last sync pass.** This is the whole cost and it is not
hypothetical: a file added from another device is invisible to Orbit until the mirror learns
about it, where before every listing was live.

Three things keep it bearable:

- **The user's own actions are never stale.** Write-through is what buys that, and it is the
  case that would otherwise read as data loss rather than as staleness — upload a file, watch
  the folder not change.
- **The age is on screen.** A mirrored listing says "synced 4m ago" rather than implying it is
  showing the drive as it stands.
- **Refresh means refresh.** The button sends `fresh=1`, which goes past the mirror to the
  provider. Somebody presses it precisely because they think what they can see is old.

**Opening and downloading still go to the provider.** Only listing and searching moved. Being a
few minutes behind on a listing is survivable; being wrong about where the bytes are is not.

**No new manual work.** The sync pass that fills the mirror already ran every fifteen minutes
for the duplicate finder and the breakdown. Nothing about deployment changes except the standing
rule that `npm run db:migrate` is a separate step — which was already true of every migration.

**Renaming a folder has to repair its subtree.** A folder's path is a prefix of every path
beneath it, so renaming the row and stopping there would leave its children filed under a
directory that no longer exists — invisible when browsing and still returned by search. Same for
deleting a folder. Both are one statement over a range rather than fifty thousand reads.

**Category filtering still happens in TypeScript**, because it falls back to the file extension
when the mime type is useless. Rows are read in batches and filtered until the page is full, and
the cursor counts rows *scanned* rather than rows kept, so continuing neither repeats nor skips.

**FTS5 matches tokens, not substrings.** "repo" finds "report"; "port" does not. Provider search
mostly behaves the same way, so this is not a regression, but it is a real difference and worth
knowing before somebody reports it as a bug.

## Alternatives considered

**Leave it live and cache in the browser.** Already done, and it only helps the second visit to
a folder. The first visit — and every search — was still the full chain of round trips.

**Mirror-only, no fallback.** Simpler, and wrong for any account whose enumeration is capped or
whose provider has no delta feed. Those drives would appear empty rather than slow.

**Merge mirror results with provider results per account.** The honest version of partial
coverage, and it needs one opaque cursor holding a row offset and a set of provider page tokens.
Getting that wrong is a result set that quietly loses files, which is the one failure mode a
file manager cannot have. All-or-nothing per query instead.

---

## What this got wrong

**Reversed on 2026-08-26.** `MIRROR_ANSWERS_LISTINGS` is `false`; listings and searches go to the
provider again.

The decision above rests on a sentence that was never checked: that the mirror describes the same
tree the provider does. It does not, and could not, because of what it was built for. The storage
breakdown and the duplicate finder ask *what do you have* — names, sizes, checksums — and neither
has ever needed a path.

So two things were true the whole time and neither was noticed:

- **Every adapter drops folders from its flat enumeration.** `listAllFiles` on Drive filters
  `mimeType != folder`; Dropbox filters `!file.isFolder`; OneDrive filters `!item.folder`. A
  folder listing read out of the mirror therefore shows files and no subfolders at all.
- **Drive files had no real path in it.** Both `listAllFiles` and the delta filed everything as
  `/${name}`. In production that was **4,860 of 5,214 rows sitting at the root**.

What the user saw: browsing showed the whole drive flattened into the root with its folders
missing, and a file appeared to come back every fifteen minutes as each sync pass rewrote its row.
Pressing Refresh went to the provider and looked correct, which made a real data problem read as a
display glitch — the most expensive kind of wrong, because it points the search away from the
cause.

**The lesson is narrow and worth stating.** The performance reasoning was sound and the query work
was sound. The failure was accepting "the mirror has the files" as equivalent to "the mirror has
the folder structure", when one `SELECT` against production would have shown otherwise in seconds.
The check that would have caught it cost nothing and was not run.

**What stands.** Nothing here is deleted, because none of it is the part that was wrong: the
`created_at` column, the name and date indexes, the FTS5 table, write-through on every mutation,
and a delta that now resolves real ancestor paths instead of assuming the root. The read path and
its sixteen tests stay too. Turning it back on is one constant.

**What turning it back on requires**, and it is a separate piece of work:

1. Every adapter's flat enumeration includes folders.
2. Every adapter's flat enumeration reports a real virtual path — for Drive that means walking
   ancestors, which `resolveVirtualPath` already does and the delta now uses.
3. A re-enumeration of what is already stored, since existing rows carry the wrong paths.
4. A test that browsing a mirrored subfolder returns its subfolders, which is the assertion whose
   absence let this ship.
