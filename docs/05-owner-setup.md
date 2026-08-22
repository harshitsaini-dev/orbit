# Owner setup — the accounts and keys only you can create

Everything here is free and none of it needs a payment card. Work top-down: the first section
unblocks the next phase of development, the rest are needed before the first deployment.

After each section, put the values in `.env` (copy `.env.example` first if you have not).
`.env` is gitignored and must never be committed.

---

## 0. One-time local secrets

Two random keys the app needs even in local mode. Run this twice and keep both outputs:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

In `.env`:

```
TOKEN_ENCRYPTION_KEY=<first output>
SESSION_SECRET=<second output>
```

`TOKEN_ENCRYPTION_KEY` encrypts every provider token at rest. **If you lose it, every connected
account has to be reconnected** — keep a copy somewhere safe, and use a *different* value in
production than the one on your laptop.

---

## 1. Google Drive OAuth — unblocks Phase 2

This is the next thing development needs.

1. Go to <https://console.cloud.google.com/> and sign in.
2. Top bar → project dropdown → **New project**. Name it `orbit`. Create, then make sure the
   project dropdown now shows `orbit`.
3. Left menu → **APIs & Services → Library**. Search for **Google Drive API** → **Enable**.
4. Left menu → **APIs & Services → OAuth consent screen**.
   - User type: **External** → Create.
   - App name `Orbit`, user support email: your address, developer contact: your address.
   - Save and continue.
   - **Scopes** → *Add or remove scopes* → add:
     - `https://www.googleapis.com/auth/drive` (full Drive access — needed for upload, rename,
       delete and folder creation)
     - `https://www.googleapis.com/auth/userinfo.email` (to label the connected account)
   - Save and continue.
   - **Test users** → add your own Gmail address. While the app is unpublished only listed test
     users can connect, which is fine for now.
5. Left menu → **APIs & Services → Credentials** → **Create credentials → OAuth client ID**.
   - Application type: **Web application**.
   - Name: `Orbit web`.
   - **Authorised redirect URIs** → add both:
     - `http://localhost:8787/auth/callback/google_drive`
     - `https://api.orbit.harshitsaini.in/auth/callback/google_drive`
   - Create. Copy the **Client ID** and **Client secret**.
6. In `.env`:

```
GOOGLE_CLIENT_ID=<client id>
GOOGLE_CLIENT_SECRET=<client secret>
```

> The redirect URI must match **character for character**, including `http` vs `https` and the
> absence of a trailing slash. A mismatch is the single most common OAuth failure.

### About the `drive` scope and Google's verification

`https://www.googleapis.com/auth/drive` is one of Google's **restricted** scopes. While the app
is in **Testing** mode this costs nothing and works immediately, with two limits:

- only the addresses listed under *Test users* can connect (up to 100), and
- their refresh tokens expire after **7 days**, so a test connection needs reconnecting weekly.

Publishing the app to *In production* removes both limits, but a restricted scope then requires
Google's OAuth verification — which for `drive` includes an annual third-party security
assessment that is not free. Two ways out, neither of which needs verification:

1. **Stay in Testing.** Fine for a personal deployment: add every address that will use Orbit as
   a test user and accept the weekly reconnect.
2. **Use `drive.file` instead.** This narrower scope is not restricted, so it needs no
   verification and no weekly reconnect — but it only grants access to files the app itself
   created or the user explicitly picked. Orbit could not browse a Drive the user already has,
   which defeats the point of an aggregator.

Start in Testing with the full `drive` scope. Revisit this before opening Orbit up to anyone
beyond the test-user list.

**If you are being asked to reconnect every week, this is why.** Orbit refreshes tokens on a
schedule and will not drop a connection over a network blip, but nothing on this side can extend
a refresh token that Google itself expired after seven days.

The fix worth trying: **OAuth consent screen → Publishing status → Publish app**. Moving out of
Testing removes the seven-day expiry. The app stays unverified until you go through Google's
review, so users still see the "Google hasn't verified this app" screen and there is a cap on how
many accounts may grant access — but the weekly reconnect goes away. If Google refuses to publish
without verification for the restricted `drive` scope, you are stuck in Testing until verified,
and reconnecting weekly is the cost.

---

## 1b. OneDrive OAuth — optional, for an adapter never run for real

Written and tested against mocked responses, never against a real account.
Registering the app is free and needs no card. Step by step in
`05-onedrive-dropbox.md`; nothing else waits on it.

Dropbox, in the same document, is already connected. Its app is in *development*
mode, which caps it at 50 linked accounts - fine while it is only you, and
something to move to production before anyone else uses it.

---

## 1c. pCloud OAuth — free, but approved by hand

The only provider left whose adapter has never seen a real account.

pCloud no longer creates an application on request: **App creation requires
approval**, and the form is a request rather than a registration. It is still
free, and there is no verification of the kind Google runs - a person reads the
request and approves the app. Submitted 2026-08-22, pending since.

1. Sign in at <https://my.pcloud.com/> and open **My applications → New app**.
   (The direct link, if the menu moves, is <https://docs.pcloud.com/my_apps/>.)
2. The request form asks for:

   | Field | What Orbit needs |
   |---|---|
   | App name | `Orbit` |
   | Application type | *Personal use* |
   | Folder access | **All folders** - *Private* is the app's own folder, and a file manager that can only see its own folder is not one |
   | Write access | **Yes** - upload, rename, move, delete and restore all need it |
   | Website | A URL that actually loads, because it is read by a person |
   | Expected number of users | The honest number |
   | Reason | What the app is, why it needs full access, and that it stores no file contents |

3. Once approved, open the app and add the redirect URI
   **`http://localhost:8787/auth/callback/pcloud`**, and
   `https://api.orbit.harshitsaini.in/auth/callback/pcloud` for the deployed
   one. Both may be registered at once. There is no scope list to choose from -
   a pCloud app is granted the account it is authorised against, whole.
4. Copy the **Client ID** and **Client secret** into `.env`:

```
PCLOUD_CLIENT_ID=<id>
PCLOUD_CLIENT_SECRET=<secret>
```

5. Restart the server and connect pCloud from **Quota → Connect an account**.

A pCloud account lives in either the US or the EU region and only sign-in says
which; Orbit stores the host it is told and uses it from then on, so there is
nothing to choose here. Tokens do not expire unless revoked, so there is no
weekly reconnect of the kind Google's testing mode forces.

---

## 2. Resend — sending the sign-in codes

Only needed for hosted mode. Local development prints the code to the server console instead.

1. Sign up at <https://resend.com/> (GitHub sign-in works; no card).
2. **Domains → Add domain** → enter **`signal.harshitsaini.in`**.

   A subdomain rather than the root, and Orbit's own rather than one already on the account:
   `send.harshitsaini.in` belongs to another project here, and keeping the two apart means a
   deliverability problem with one cannot touch the other. The root domain stays out of it
   entirely.
3. Resend shows a set of DNS records (SPF/TXT, DKIM, and usually a return-path CNAME). Add each
   one in Cloudflare (section 5), then press **Verify**. Propagation is usually minutes.
4. **API Keys → Create API Key**, permission *Sending access*. Copy it once — it is not shown
   again.
5. In `.env`:

```
RESEND_API_KEY=<key>
RESEND_FROM="Orbit <no-reply@signal.harshitsaini.in>"
```

Free tier: 3,000 emails/month, 100/day. Far beyond what sign-in codes need.

---

## 3. Turso — the hosted metadata database

1. Sign up at <https://turso.tech/> with GitHub.
2. Install the CLI (Windows PowerShell): `irm get.tur.so/install.ps1 | iex` — or skip the CLI and
   use the dashboard's *Create database* button instead.
3. Then:

```bash
turso auth login
turso db create orbit-prod
turso db show orbit-prod --url
turso db tokens create orbit-prod
```

4. Keep both values for Render (section 4). Do **not** put them in your local `.env` — local
   development should stay on the local SQLite file so tests never touch production data.

5. Apply the migrations to it once, from the repo root:

```bash
DATABASE_URL=libsql://orbit-prod-<org>.turso.io DATABASE_AUTH_TOKEN=<token> npm run db:migrate
```

---

## 4. Render — the backend

1. Sign up at <https://render.com/> with GitHub, and grant it access to the `orbit` repo.
2. **New → Web Service** → pick `harshitsaini-dev/orbit`.
3. Settings — or skip them: `render.yaml` in the repository root is a blueprint with all of
   this in it, so **New → Blueprint** reads it and only asks for the secrets. By hand:
   - Root directory: leave empty (repository root)
   - Runtime: Node
   - Build command: `npm ci --include=dev && npm run build -w @orbit/web`

     Both halves matter. `--include=dev` because `NODE_ENV=production` makes npm skip
     devDependencies, which is where TypeScript, Vite and the `tsx` that *starts* the server
     all live. And the web workspace because the share page's viewer is built from it into the
     server, so `npm ci` alone deploys an API whose share links fall back to the plain preview.
   - Start command: `npm start -w @orbit/server`
   - Health check path: `/health/ready`

     Not `/health`. The cheap one answers from memory and would report "ok" with the database
     unreachable, which is exactly the state Render must not send traffic into.
   - Instance type: **Free**
4. **Environment** → add:

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `AUTH_MODE` | `hosted` |
| `APP_URL` | `https://orbit.harshitsaini.in` |
| `API_URL` | `https://api.orbit.harshitsaini.in` |
| `COOKIE_DOMAIN` | `.harshitsaini.in` |
| `DATABASE_URL` | from section 3 |
| `DATABASE_AUTH_TOKEN` | from section 3 |
| `TOKEN_ENCRYPTION_KEY` | a **new** 32-byte key, not your local one |
| `SESSION_SECRET` | a **new** random value |
| `RESEND_API_KEY` | from section 2 |
| `RESEND_FROM` | `Orbit <no-reply@signal.harshitsaini.in>` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | from section 1 |

Never set `ENABLE_DEV_AUTH_ENDPOINTS` here. It is refused under `NODE_ENV=production` anyway,
but there is no reason for it to appear.

5. **Settings → Custom domain** → add `api.orbit.harshitsaini.in`. Render shows a CNAME target;
   use it in section 5.

---

## 5. Cloudflare — DNS

1. Sign up at <https://dash.cloudflare.com/>, **Add a site** → `harshitsaini.in`, choose the
   **Free** plan.
2. Cloudflare gives you two nameservers. Set them at whichever registrar you bought the domain
   from. This takes anywhere from minutes to a few hours.
3. Once active, **DNS → Records** and add:

| Type | Name | Target | Proxy |
|---|---|---|---|
| CNAME | `orbit` | the target Vercel gives you (section 6) | DNS only |
| CNAME | `api.orbit` | the target Render gave you (section 4) | DNS only |
| _(Resend's records for `signal`, from section 2)_ | | | DNS only |

Resend's records are given relative to `signal.harshitsaini.in`. Cloudflare appends the zone
name automatically, so a record Resend shows as `resend._domainkey` is entered as
`resend._domainkey.signal` — check the row's preview shows the full
`resend._domainkey.signal.harshitsaini.in` before saving.

Use **DNS only** (grey cloud), not the orange proxy — the proxy interferes with the custom-domain
verification both platforms run.

---

## 6. Vercel — the frontend

1. Sign up at <https://vercel.com/> with GitHub.
2. **Add New → Project** → import `harshitsaini-dev/orbit`.
3. Settings — `vercel.json` in the repository root already carries these, so accept what it
   proposes rather than overriding it:
   - Root directory: leave empty (repository root)

     Not `apps/web`. This is an npm-workspaces monorepo: the web app depends on
     `@orbit/shared-types`, which only resolves from an install done at the root.
   - Build command: `npm run build -w @orbit/web`
   - Output directory: `apps/web/dist`
4. **Environment Variables** → `VITE_API_URL` = `https://api.orbit.harshitsaini.in`

   The same file also sets the security headers the app is served with, including a
   content-security-policy that names the API's origin. If the API ever moves, that value moves
   with it - otherwise the browser blocks every request the app makes and the page looks empty
   for no stated reason.
5. Deploy, then **Settings → Domains** → add `orbit.harshitsaini.in`. Vercel shows the CNAME
   target for section 5.

---

## 7. UptimeRobot — keeping the backend warm (optional)

Render's free instance sleeps after 15 minutes idle, so the first visit of the day is slow.

1. Sign up at <https://uptimerobot.com/> (free, no card).
2. **Add New Monitor** → type *HTTP(s)*, URL `https://api.orbit.harshitsaini.in/health`,
   interval 5 minutes.

---

## Checklist

- [ ] `TOKEN_ENCRYPTION_KEY` and `SESSION_SECRET` generated and in local `.env`
- [ ] Google OAuth client created; both redirect URIs registered; keys in `.env`
- [ ] pCloud application created and its id and secret in `.env`
- [ ] Resend domain `signal.harshitsaini.in` verified and API key created
- [ ] Turso database created and migrated
- [ ] Render service deployed with all environment variables
- [ ] Cloudflare nameservers active and both CNAMEs added
- [ ] Vercel project deployed with the custom domain
- [ ] UptimeRobot monitor running
