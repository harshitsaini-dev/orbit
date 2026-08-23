# Running your own Orbit

Orbit is one Node process and a pile of static files. There is no queue, no
cache server, no object store and no container orchestration — the design rule
that Orbit stores none of your file bytes is also what keeps the deployment
this small.

Two ways to run it, and the difference is not "development" and "production":

- **Local mode** — one person, no sign-in, a SQLite file on disk. This is the
  right answer for a machine you own. It has no authentication at all, which is
  a feature on a laptop and a hole on a network.
- **Hosted mode** — several people, email sign-in codes, a database that lives
  somewhere. This is what `orbit.harshitsaini.in` runs.

Start with local. It needs no accounts, no keys and no domain, and everything
except sign-in behaves identically.

---

## What you need

- **Node 20 or newer.** `node --version`.
- **Git.**
- Nothing else. No Docker, no Postgres, no Redis.

Disk: the repository and its dependencies are a few hundred megabytes. The
database is metadata only — file names, sizes and paths — so a drive with two
hundred thousand files in it costs tens of megabytes, not the size of the files.

---

## Local mode, in four commands

```bash
git clone https://github.com/harshitsaini-dev/orbit.git
cd orbit
npm install
cp .env.example .env
```

Generate the two secrets and put them in `.env`:

```bash
node -e "console.log('TOKEN_ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('base64'))"
node -e "console.log('SESSION_SECRET=' + require('crypto').randomBytes(32).toString('base64'))"
```

Create the database, then start:

```bash
npm run db:migrate
npm run dev
```

The app is on <http://localhost:5173> and the API on <http://localhost:8787>.

`AUTH_MODE=local` means there is no sign-in: the first request creates a single
user and every request is that user. **Do not expose a local-mode instance to a
network.** Anyone who can reach the port is you.

### Migrations do not run on their own

This catches people, including the author. Starting the server does not create
or update the schema — `npm run db:migrate` is a separate step, every time you
pull a change that adds a table. A missing table is a 500 on one endpoint and
nothing anywhere else.

---

## Connecting a drive

Object stores need nothing from you but their own credentials, and work
immediately: **S3, Cloudflare R2, Backblaze B2, DigitalOcean Spaces, Supabase
Storage, Google Cloud Storage, Azure Blob, Bunny.** Open **Quota → Connect**,
pick one, paste the keys.

**MEGA** also works out of the box. It signs in with the account's email and
password because MEGA issues no tokens — the password is used once to open a
session and is never stored; the session is, and you can end it from MEGA under
*Settings → Session history*.

The OAuth providers need an application registered with each service, because
an OAuth client belongs to whoever runs the app. That is you now, not Orbit.

| Provider | What to register | Cost |
|---|---|---|
| Google Drive | A Cloud Console OAuth client | Free |
| Dropbox | An app in the Dropbox App Console | Free |
| OneDrive | An Entra app registration | Free, but needs a directory |
| pCloud | An app, approved by hand | Free, takes days |

Each one gives you an id and a secret. They go in `.env` as
`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, `DROPBOX_*`, `ONEDRIVE_*`,
`PCLOUD_*`. The redirect URI to register is:

```
http://localhost:8787/auth/callback/<provider>
```

`<provider>` is `google_drive`, `dropbox`, `onedrive` or `pcloud`. Full
click-by-click instructions are in [`05-owner-setup.md`](05-owner-setup.md) and
[`05-onedrive-dropbox.md`](05-onedrive-dropbox.md).

**A provider you have not registered simply does not appear** in the connect
screen. Orbit derives that list from which adapters have credentials, so there
is never a dead end to click on.

---

## Hosted mode

Only worth it if other people are going to use it. Four things change.

### 1. A database that is not a file

`AUTH_MODE=hosted` expects a libSQL/Turso URL:

```
DATABASE_URL=libsql://your-db.turso.io
DATABASE_AUTH_TOKEN=…
```

Turso's free tier is generous and the database is small — it holds metadata,
not files. A local SQLite file also works if the server has persistent disk;
most cheap hosts do not, and a disk that resets on deploy loses every connected
account.

### 2. Somewhere to send sign-in codes

```
RESEND_API_KEY=…
RESEND_FROM="Orbit <no-reply@yourdomain>"
```

Hosted mode refuses to start without a key, because email is the only way in.
Any provider works if you swap the transport in `apps/server/src/services/email.ts`;
Resend is there because its free tier needs no card.

### 3. Real addresses

```
APP_URL=https://orbit.example.com
API_URL=https://api.orbit.example.com
COOKIE_DOMAIN=.example.com
```

Both must be **https** in production — the server refuses to start otherwise,
because a session cookie is marked `Secure` and a browser on an http origin
drops it silently, so nobody can stay signed in and nothing says why.

`COOKIE_DOMAIN` is only needed when the app and the API are on different
subdomains, which they are in the deployment above.

### 4. Fresh secrets

Generate new ones. Do not carry your development keys into a deployment, and
never commit them. `TOKEN_ENCRYPTION_KEY` encrypts every provider token at rest
— **losing it means every connected account has to be reconnected**, and
changing it means the same.

---

## Deploying it

The shape that works: the API anywhere that runs a Node process, the built
front end on any static host.

```bash
npm run build          # both
npm start -w @orbit/server
```

`apps/web/dist` is the static site. It is a single-page app, so the host must
rewrite unknown paths to `index.html`.

The repository carries a [`render.yaml`](../render.yaml) and a
[`vercel.json`](../vercel.json) for the combination the author uses. Neither is
required.

**One trap worth naming.** `NODE_ENV=production` makes npm skip devDependencies
— where `tsc`, `vite` and `tsx` live. If your build fails with *Cannot find type
definition file for 'vite/client'*, that is why: install with
`npm ci --include=dev`.

### Keep the process alive

`node-cron` runs inside the API process. If your host sleeps idle instances, a
sleeping Orbit misses the sync pass, the shared-drive measurements and every
scheduled job — it is not just a slow first request. An uptime check against
`/health/ready` every five minutes is the fix.

---

## What it costs to run

Nothing, on the free tiers, and that is a design constraint rather than an
accident:

- **No file storage bill**, because Orbit stores no file bytes. Everything is
  streamed from the provider on demand.
- **No egress surprise** either, for the same reason — bytes pass through, they
  do not accumulate.
- **No TURN server** for direct transfers. About one in ten cannot connect
  without one, and Orbit says so and points at upload-and-share rather than
  quietly buying bandwidth.
- **No OCR, transcoding or AI service.** Considered and declined; each is a bill
  per file.

The database grows with the number of files you have, not their size.

---

## Checking it works

```bash
npm run typecheck
npm test               # unit and integration
npm run test:e2e       # Playwright, headed
```

`npm run test:e2e` starts its own server and its own database — it will not
touch yours. `npm run test:e2e:ci` is the headless version.

---

## Adding a provider

Everything about a provider lives in one file. There is a rule in
`packages/shared-types/src/provider.ts` and it is enforced by every review: **no
route, view or engine may special-case a provider id.**

1. Implement `ProviderAdapter` in `packages/adapters/src/providers/`.
2. Declare its capability flags honestly. The UI hides what an adapter says it
   cannot do — a flag set to `true` optimistically becomes a button that fails.
3. Register it in `packages/adapters/src/index.ts` and add its id to
   `PROVIDER_IDS`.
4. Add a catalogue entry with the fields the connect form should collect.
5. Write an adapter test against mocked provider responses before wiring it in.

If you find yourself editing a route to make your provider work, the abstraction
has a hole in it and that hole is the bug. When MEGA was added, the connect
route turned out to forward only S3-shaped fields — the fix was to make the
route general, not to teach it about MEGA.

---

## Where things are

| Path | What |
|---|---|
| `apps/server` | Express API, WebSocket hub, cron |
| `apps/web` | React front end, and the share page |
| `packages/adapters` | One file per provider |
| `packages/db` | Drizzle schema and hand-written migrations |
| `packages/shared-types` | The contracts both ends agree on |
| `docs/decisions` | Why things are the way they are |

[`02-architecture.md`](02-architecture.md) is the long version.

---

## Things that will bite you

- **Migrations are manual.** Said twice on purpose.
- **`AUTH_MODE=local` has no authentication.** Not a weak one — none.
- **Losing `TOKEN_ENCRYPTION_KEY`** means reconnecting every drive.
- **Disconnecting a drive cascades.** Its share links, collection items,
  transfer history and any grants given to other people go with it. Connecting
  an account Orbit already has *updates* it, so reconnecting to refresh a token
  costs nothing — do that instead of disconnecting first.
- **Google in Testing mode expires refresh tokens after seven days.** Publish
  the consent screen; verification is a separate and much larger thing you
  probably do not need.
