# Orbit

One workspace for every cloud drive you own.

Orbit aggregates Google Drive, OneDrive, Dropbox, MEGA, pCloud, and any S3-compatible
bucket behind a single, consistent interface — browse, upload, download, share,
and manage files across every connected account without switching tabs.

Orbit never stores your files. It keeps metadata and encrypted credentials, and streams bytes
on demand from the provider they already live in.

## Features

- **Multi-provider aggregation** — connect several accounts, including multiple accounts from
  the same provider, all normalised through one adapter layer.
- **Unified workspace** — Home, My Drive, Recent, Starred, Shared with me, and Quota views over
  a provider-agnostic virtual path.
- **File management** — browse, create folders, rename, delete (including bulk), download,
  preview, star.
- **Uploads** — drag-and-drop, folder upload, chunked/resumable transfers, live progress over
  WebSocket, and automatic account selection via a configurable allocation strategy.
- **Sharing** — short links on your own domain plus QR codes; the underlying provider URL is
  never exposed.
- **Sync** — scheduled delta sync into a local metadata mirror for fast navigation.
- **Auth** — passwordless email OTP in hosted mode, single-user local mode for self-hosting.
- **RBAC** — workspace roles and a superadmin panel with an audit trail.
- **PWA** — installable, responsive from 360 px up, light/dark/system theming with an accent
  picker.

## Stack

React + Vite + three.js · Express + `ws` + node-cron · Drizzle ORM over libSQL/Turso ·
Playwright · TypeScript throughout, in an npm-workspaces monorepo.

## Getting started

```bash
npm install
cp .env.example .env
# generate the secrets .env needs
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

npm run db:generate
npm run db:migrate

npm run dev          # api on :8787, web on :5173
```

On Windows you can skip all of that and double-click **`start.bat`** — it installs
dependencies, creates `.env` and the database on first run, then opens both servers in their own
windows. **`stop.bat`** shuts them down, **`restart.bat`** does both.

Install the local git hooks once per clone:

```bash
sh scripts/install-hooks.sh
```

## Testing

```bash
npm test             # unit tests across all workspaces
npm run test:e2e     # Playwright, headed
npm run test:e2e:ci  # Playwright, headless
```

## Documentation

| Document | Contents |
|---|---|
| `docs/01-project-state.md` | Current phase, what's done, what's next |
| `docs/02-architecture.md` | Full architecture, data model, adapter contract, roadmap |
| `docs/03-api-reference.md` | Route-by-route API reference |
| `docs/04-deployment.md` | Deployment runbook |
| `docs/05-owner-setup.md` | Step-by-step account, API key, and DNS setup |
| `docs/decisions/` | Architecture decision records |
| `docs/daily-log/` | Dated development log |

## Licence

MIT
