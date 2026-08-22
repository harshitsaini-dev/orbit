# OneDrive and Dropbox — registering the OAuth apps

Both adapters are written and tested, but neither has run against a real
account yet. That needs an OAuth app on each side, both free, neither asking
for a card.

Nothing here is urgent: Orbit works with the providers already connected. Do
these when you want to test the two new adapters end to end.

Everywhere below, replace `http://localhost:8787` with your `API_URL` if you
have changed it, and add the production URL alongside the local one so the same
app works after deploying.

---

## 1. OneDrive — Microsoft Entra (Azure)

1. Go to <https://portal.azure.com/> and sign in with any Microsoft account. A
   free personal account is enough; there is no subscription to create.
2. Search the top bar for **Microsoft Entra ID** and open it. (It used to be
   called Azure Active Directory, and some pages still say so.)
3. Left menu → **App registrations** → **New registration**.
4. Fill in:
   - **Name**: `Orbit`
   - **Supported account types**: **Accounts in any organizational directory
     (Any Microsoft Entra ID tenant — Multitenant) and personal Microsoft
     accounts (e.g. Skype, Xbox)**.

     This one matters. The single-tenant option refuses personal
     `@outlook.com` and `@hotmail.com` accounts, which is most people — and the
     failure comes at sign-in time, not here.
   - **Redirect URI**: platform **Web**, value
     `http://localhost:8787/auth/callback/onedrive`
5. **Register**. Copy the **Application (client) ID** from the overview page.
6. Left menu → **Certificates & secrets** → **Client secrets** →
   **New client secret**.
   - Description: `orbit`
   - Expires: 24 months (the longest offered; note the date, because the
     connection stops working when it lapses).
   - **Add**, then copy the **Value** — not the Secret ID. The value is shown
     once and never again; if you navigate away you have to make a new one.
7. Left menu → **API permissions** → **Add a permission** → **Microsoft Graph**
   → **Delegated permissions**. Add:
   - `Files.ReadWrite.All` — listing, downloading, uploading, renaming, deleting
   - `User.Read` — to label the connection with the account's address
   - `offline_access` — without this Microsoft issues no refresh token and the
     connection dies in an hour with no way to renew it

   No admin consent is needed for a personal account.
8. Still in **Authentication**, add the production redirect URI too:
   `https://api.orbit.harshitsaini.in/auth/callback/onedrive`
9. In `.env`:

```
ONEDRIVE_CLIENT_ID=<application (client) id>
ONEDRIVE_CLIENT_SECRET=<the secret Value>
```

10. `restart.bat`, then Quota → Connect → OneDrive.

---

## 2. Dropbox

1. Go to <https://www.dropbox.com/developers/apps> and sign in.
2. **Create app**.
   - API: **Scoped access**
   - Access type: **Full Dropbox**

     "App folder" confines Orbit to a folder of its own, which is safer but
     means it can only see files put there — not the account's existing ones,
     which is the point of connecting it.
   - Name: something unique across all of Dropbox, e.g. `orbit-<yourname>`.
3. On the app's **Permissions** tab, tick:
   - `account_info.read`
   - `files.metadata.read`
   - `files.content.read`
   - `files.content.write`
   - `sharing.read`

   Then **Submit** at the bottom of that tab.

   Set the permissions **before** connecting the account. Dropbox grants
   exactly the scopes that were ticked at the moment consent was given, so
   adding one later means disconnecting and reconnecting.
4. On the **Settings** tab:
   - **OAuth 2 → Redirect URIs**: add
     `http://localhost:8787/auth/callback/dropbox`, then **Add**. Add the
     production one the same way:
     `https://api.orbit.harshitsaini.in/auth/callback/dropbox`
   - Copy the **App key** and **App secret** (click *Show*).
5. In `.env`:

```
DROPBOX_CLIENT_ID=<app key>
DROPBOX_CLIENT_SECRET=<app secret>
```

6. `restart.bat`, then Quota → Connect → Dropbox.

> A new Dropbox app is in **Development** status, which caps it at a small
> number of linked accounts. That is fine for personal use; "Apply for
> production" is only needed to let other people connect.

---

## What to expect once connected

The two providers do not offer the same things, and Orbit hides what a provider
cannot do rather than offering it and failing:

- **Neither has starring.** The star control disappears for files in these
  accounts. Both services have starred/favourite files in their own apps, but
  neither exposes an API for it.
- **Dropbox has no Recent view.** It will not appear in the merged Recent list,
  and the page says so rather than silently omitting it.
- **Dropbox search matches names only.** Searching inside file contents is a
  paid-plan feature, and asking for it on a free account fails the whole
  request, so Orbit does not ask.
- **Everything else works on both**: browsing, search, download with seeking,
  chunked upload, rename, delete to the provider's own trash, thumbnails,
  storage totals, and the delta feed the sync engine will use.

## If a connection fails

- **"The redirect URI does not match"** — it must match character for
  character, including `http` against `https` and the absence of a trailing
  slash. This is the most common OAuth failure by a wide margin.
- **Microsoft rejects a personal account** — the app registration was created
  as single-tenant. Change it under **Authentication → Supported account
  types**.
- **Dropbox says a scope is missing** — the permissions were changed after the
  account was connected. Disconnect it in Quota and connect again; consent is
  fixed at the moment it is given.
- **The connection works and then stops after an hour** — `offline_access` is
  missing from the Microsoft permissions, so no refresh token was issued.
