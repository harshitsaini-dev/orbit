# 0012 — The share page runs the workspace's own viewer

Status: accepted
Date: 2026-08-22

## Context

A share link opens a page rendered by the API, not by the React application. That was a
deliberate choice: the bytes are streamed from `/s/:shortId/content` on that same origin, which
is what keeps the provider's URL out of the browser, and a page that ran no JavaScript could be
served under `default-src 'none'` — worth having on the one surface a stranger is pointed at.

The cost was a viewer that could only show what a browser renders natively: an image, a video, a
PDF. The workspace itself has viewers for spreadsheets, documents, presentations, archives,
fonts, markdown, code and CSV. So the owner of a file saw it, and the person they sent it to got
a Download button — which is the opposite of what a link is for.

Duplicating those viewers in the server-rendered page was never realistic. They are React
components, some of them thousands of lines, and a second implementation would drift from the
first the moment either gained a format.

## Decision

**The share page mounts the workspace's own viewer, built as its own bundle and served from the
API's origin.**

- `apps/web/src/share.tsx` is a second Vite entry. It renders `FileViewer` — the same component
  the workspace's preview dialog renders — from one file's worth of data.
- It is built into `apps/server/public/share` and served at `/s/asset`, so the script, its
  chunks and the bytes it renders all come from one origin.
- The server still renders a complete page first. The bundle replaces what is inside
  `#share-root`; if it is missing, blocked, or still loading, the visitor sees the native
  preview and the download button rather than an empty screen.
- In development the page loads the entry from the Vite server instead, so the viewer can be
  worked on without rebuilding between edits. If Vite is not running, the fallback stands.

## Consequences

The policy can no longer say `default-src 'none'` and stop there. It now allows scripts from
this origin, a worker and blob URLs — the archive, font and PDF viewers each decode bytes and
hand the result back to the page. `'unsafe-inline'` and `'unsafe-eval'` are still refused, the
inline fallback script still runs on a per-response nonce, and a test asserts all of it.

The viewer's chunks are exempt from the share rate limit. A PDF pulls several of them, and
spending a stranger's budget on Orbit's own assets would lock them out of the file they came
for.

`npm run build -w @orbit/web` now produces two bundles, and the second must reach whatever runs
the API. That is the real cost of this decision: a deployment that ships only the server misses
the viewer, and share pages quietly fall back to the native preview rather than failing loudly.
