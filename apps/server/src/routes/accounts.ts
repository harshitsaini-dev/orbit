import { getAdapter, ProviderError } from '@orbit/adapters';
import { catalogueEntry } from '@orbit/shared-types';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../lib/env.js';
import {
  beginAuthorisation,
  consumeAuthorisation,
  isOAuthProvider,
  redirectUriFor,
} from '../lib/oauth.js';
import { requireAuth } from '../middleware/auth.js';
import { findDuplicates, ignoreGroup, unignoreGroup } from '../services/duplicates.js';
import { mirrorSize, recentSyncs, syncAccount } from '../services/sync.js';
import {
  setAccountPriority,
  setAccountWeight,
  setStrategy,
} from '../services/allocation.js';
import {
  createAccount,
  deleteAccount,
  listAccounts,
  refreshQuota,
} from '../services/accounts.js';
import { forgetBreakdown, getBreakdown } from '../services/breakdown.js';
import { seedProfileFrom } from '../services/users.js';

export const accountsRouter: Router = Router();

/**
 * The catalogue entries backed by a working adapter. The catalogue lists what
 * Orbit intends to support; this is what it can support right now, and the
 * connect UI shows only these so nothing offers a dead end.
 */
const CONNECTABLE = [
  'google_drive',
  'onedrive',
  'dropbox',
  'aws_s3',
  'cloudflare_r2',
  'supabase_storage',
  'digitalocean_spaces',
  'backblaze_b2',
  's3_other',
];

/** Sends the browser back to the app with a result it can show. */
function backToApp(outcome: 'connected' | 'failed', detail?: string): string {
  const url = new URL('/quota', env.APP_URL);
  url.searchParams.set('connect', outcome);
  if (detail) url.searchParams.set('reason', detail);
  return url.toString();
}

// --- OAuth connect --------------------------------------------------------

/**
 * Step 1: send the user to the provider. The catalogue key travels through the
 * state cookie rather than the URL, so the callback knows which entry was
 * chosen without trusting a query parameter.
 */
accountsRouter.get('/auth/connect/:provider', requireAuth, (req, res) => {
  const provider = req.params.provider ?? '';

  if (!isOAuthProvider(provider)) {
    res.status(400).json({
      error: { code: 'unsupported_provider', message: `${provider} does not connect by OAuth` },
    });
    return;
  }

  try {
    const { url } = beginAuthorisation(res, provider, backToApp('connected'));
    res.redirect(url);
  } catch (err) {
    res.status(500).json({
      error: {
        code: 'oauth_misconfigured',
        message: err instanceof Error ? err.message : 'OAuth is not configured',
      },
    });
  }
});

/**
 * Step 2: the provider sends the browser back here. Everything is validated
 * against the state cookie before a single token is exchanged.
 */
accountsRouter.get('/auth/callback/:provider', requireAuth, async (req, res, next) => {
  const provider = req.params.provider ?? '';
  const { code, state, error } = req.query as Record<string, string | undefined>;

  if (!isOAuthProvider(provider)) {
    res.redirect(backToApp('failed', 'unsupported_provider'));
    return;
  }

  const pending = consumeAuthorisation(req, res, provider, state);

  // The user pressed cancel, or this callback did not come from a flow we began.
  if (error) {
    res.redirect(backToApp('failed', error));
    return;
  }
  if (!pending || !code) {
    res.redirect(backToApp('failed', 'invalid_state'));
    return;
  }

  try {
    const adapter = getAdapter(provider);
    const tokens = await adapter.connect({
      kind: 'oauth',
      code,
      redirectUri: redirectUriFor(provider),
      codeVerifier: pending.codeVerifier,
    });

    // Label the account with the address it belongs to, so several connections
    // to the same provider stay tellable apart, and seed an empty profile from
    // the same lookup.
    let nickname = adapter.displayName;
    let remoteAccountId: string | undefined;

    /*
     * Asked of whatever can answer, rather than of Google alone.
     *
     * This used to be gated on the adapter being Google Drive, so Dropbox and
     * OneDrive - both of which implement it - were never asked. Every Dropbox
     * connection was therefore called "Dropbox", with nothing to say whose it
     * was, and had no remote id, so reconnecting one added a second row beside
     * the first instead of updating it.
     */
    if (adapter.getAccountIdentity) {
      const identity = await adapter
        .getAccountIdentity(tokens)
        .catch((): { email?: string; displayName?: string; photoUrl?: string } => ({}));

      // The address first: it is unique, and it is what somebody looking at two
      // connections to the same provider needs to tell them apart. A display
      // name is better than nothing when the provider gives no address.
      const label = identity.email ?? identity.displayName;
      if (label) nickname = label;
      if (identity.email) remoteAccountId = identity.email;

      await seedProfileFrom(req.user!.id, identity).catch(() => undefined);
    }

    const account = await createAccount({
      userId: req.user!.id,
      provider,
      catalogueKey: provider,
      nickname,
      remoteAccountId,
      tokens,
    });

    // Best effort: a quota failure must not undo a successful connection.
    await refreshQuota(req.user!.id, account.id).catch(() => undefined);

    res.redirect(backToApp('connected'));
  } catch (err) {
    next(err);
  }
});

// --- account management ---------------------------------------------------

accountsRouter.get('/api/accounts', requireAuth, async (req, res, next) => {
  try {
    res.json({ accounts: await listAccounts(req.user!.id) });
  } catch (err) {
    next(err);
  }
});

accountsRouter.post('/api/accounts/:id/refresh-quota', requireAuth, async (req, res, next) => {
  try {
    const account = await refreshQuota(req.user!.id, req.params.id!);
    if (!account) {
      res.status(404).json({ error: { code: 'not_found', message: 'No such account' } });
      return;
    }
    res.json({ account });
  } catch (err) {
    if (err instanceof Error && err.message === 'needs_reauth') {
      res.status(409).json({
        error: { code: 'needs_reauth', message: 'This account needs to be reconnected' },
      });
      return;
    }
    next(err);
  }
});

accountsRouter.delete('/api/accounts/:id', requireAuth, async (req, res, next) => {
  try {
    forgetBreakdown(req.user!.id, req.params.id!);
    const removed = await deleteAccount(req.user!.id, req.params.id!);
    if (!removed) {
      res.status(404).json({ error: { code: 'not_found', message: 'No such account' } });
      return;
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * What is actually using the space, by category. The scan is bounded and its
 * result cached for half an hour; `?refresh=1` forces a new one.
 */
accountsRouter.get('/api/accounts/:id/breakdown', requireAuth, async (req, res, next) => {
  try {
    const force = req.query.refresh === '1';
    const breakdown = await getBreakdown(req.user!.id, req.params.id!, { force });

    if (!breakdown) {
      res.status(404).json({ error: { code: 'not_found', message: 'No such account' } });
      return;
    }
    res.json({ breakdown });
  } catch (err) {
    if (err instanceof Error && err.message === 'breakdown_unsupported') {
      res.status(501).json({
        error: {
          code: 'breakdown_unsupported',
          message: 'This provider cannot enumerate its files in one pass',
        },
      });
      return;
    }
    if (err instanceof Error && err.message === 'needs_reauth') {
      res.status(409).json({
        error: { code: 'needs_reauth', message: 'This account needs to be reconnected' },
      });
      return;
    }
    next(err);
  }
});

// --- credentials connect --------------------------------------------------

const connectSchema = z.object({
  catalogueKey: z.string().min(1),
  /** Whatever the entry's fields asked for. Validated against them below. */
  values: z.record(z.string(), z.string()),
});

/**
 * Fills an endpoint template from the values the form collected.
 *
 * The catalogue holds the shape - `https://{accountId}.r2.cloudflarestorage.com`
 * - so that a user pastes an account id rather than assembling a URL, and so
 * that a typo in the host is not something they can make.
 */
export function resolveEndpoint(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = values[name];
    return value === undefined ? whole : hostLabel(value);
  });
}

/**
 * The bit of a hostname a template wants, from whatever was pasted.
 *
 * Supabase's own settings page shows the full S3 endpoint, so pasting that into
 * a field labelled "project reference" is the obvious thing to do rather than a
 * mistake. Left alone it produced
 * `https://https://ref.storage.supabase.co/....supabase.co/storage/v1/s3`,
 * which fails at DNS with "fetch failed" - a message that points at nothing.
 *
 * A value with no scheme, dot or slash is already a bare reference and is
 * returned untouched, so this only ever fires on something that was a URL.
 */
export function hostLabel(value: string): string {
  const trimmed = value.trim();
  if (!/[./]/.test(trimmed)) return trimmed;

  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const host = withoutScheme.split('/')[0] ?? '';

  // The first label: everything before the first dot is the project reference,
  // whichever of Supabase's host forms was copied.
  return host.split('.')[0] ?? trimmed;
}

/**
 * Connects a store that authenticates with keys rather than a redirect.
 *
 * Unlike OAuth this is a plain request, so the outcome is JSON rather than a
 * redirect back into the app.
 */
accountsRouter.post('/api/accounts/connect', requireAuth, async (req, res, next) => {
  const parsed = connectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'Malformed connection' } });
    return;
  }

  const entry = catalogueEntry(parsed.data.catalogueKey);
  if (!entry || !CONNECTABLE.includes(entry.key)) {
    res.status(404).json({ error: { code: 'not_found', message: 'No such provider' } });
    return;
  }
  if (isOAuthProvider(entry.provider)) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'This provider uses OAuth' } });
    return;
  }

  const values = parsed.data.values;
  const missing = (entry.fields ?? [])
    .filter((field) => !field.optional && !values[field.name]?.trim())
    .map((field) => field.label);
  if (missing.length > 0) {
    res.status(400).json({
      error: { code: 'invalid_request', message: `Missing: ${missing.join(', ')}` },
    });
    return;
  }

  const wrongField = obviouslyWrong(entry.key, values);
  if (wrongField) {
    res.status(400).json({ error: { code: 'invalid_request', message: wrongField } });
    return;
  }

  try {
    const adapter = getAdapter(entry.provider);
    const region = values['region']?.trim() || entry.defaultRegion;

    const tokens = await adapter.connect({
      kind: 'credentials',
      values: {
        accessKeyId: values['accessKeyId'],
        secretAccessKey: values['secretAccessKey'],
        bucket: values['bucket'],
        endpoint: entry.endpointTemplate
          ? resolveEndpoint(entry.endpointTemplate, { ...values, ...(region ? { region } : {}) })
          : values['endpoint'],
        ...(region ? { region } : {}),
        ...(entry.forcePathStyle === undefined ? {} : { forcePathStyle: entry.forcePathStyle }),
      },
    });

    const account = await createAccount({
      userId: req.user!.id,
      provider: entry.provider,
      catalogueKey: entry.key,
      // Two buckets on the same service have to be tellable apart, and the
      // bucket name is the only thing about them that differs.
      nickname: values['bucket'] ?? entry.label,
      // The same bucket at the same endpoint is the same connection, so
      // re-entering its keys refreshes it rather than adding a twin.
      remoteAccountId: `${tokens.endpoint}/${tokens.bucket}`,
      tokens,
    });

    await refreshQuota(req.user!.id, account.id).catch(() => undefined);

    res.status(201).json({ account });
  } catch (err) {
    // A refused key is the user's to fix, not a fault to report as a 500 - but
    // "could not connect" is not something anyone can act on. The store says
    // which of the four fields is wrong, and that is the whole difference
    // between fixing it in a minute and guessing.
    if (err instanceof ProviderError) {
      console.error(`connect ${entry.key} failed:`, err.message);

      res.status(400).json({
        error: { code: 'connect_failed', message: explainConnectFailure(err) },
      });
      return;
    }
    next(err);
  }
});

// --- duplicates -----------------------------------------------------------

/**
 * Reads the mirror rather than the providers.
 *
 * Comparing every file in every account against every other over the network
 * would be thousands of requests; the mirror already holds the three things a
 * comparison needs.
 */
accountsRouter.get('/api/duplicates', requireAuth, async (req, res, next) => {
  try {
    const minSizeBytes =
      typeof req.query.minSize === 'string' ? Number(req.query.minSize) : undefined;

    res.json(
      await findDuplicates(req.user!.id, {
        ...(Number.isFinite(minSizeBytes) ? { minSizeBytes } : {}),
        // So the page can show what it has been hiding, rather than the
        // dismissals being a one-way door.
        includeIgnored: req.query.includeIgnored === '1',
      }),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * Marks a set as not duplicates.
 *
 * Two files can share a size and a name and be genuinely different, and a
 * report that insists otherwise every time it is opened is a report people stop
 * reading. Nothing is deleted; the set is simply not raised again.
 */
accountsRouter.post('/api/duplicates/ignore', requireAuth, async (req, res, next) => {
  const parsed = z
    .object({ key: z.string().min(1).max(400), label: z.string().max(255).default('') })
    .safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'A set is required' } });
    return;
  }

  try {
    await ignoreGroup(req.user!.id, parsed.data.key, parsed.data.label);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

accountsRouter.delete('/api/duplicates/ignore', requireAuth, async (req, res, next) => {
  const parsed = z.object({ key: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'A set is required' } });
    return;
  }

  try {
    if (!(await unignoreGroup(req.user!.id, parsed.data.key))) {
      res.status(404).json({ error: { code: 'not_found', message: 'That set was not dismissed' } });
      return;
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// --- the mirror -----------------------------------------------------------

/**
 * Syncs one account now.
 *
 * Answers immediately rather than waiting for the pass: a full enumeration can
 * take minutes, and a request held open that long dies on the way through most
 * proxies. Progress arrives on the `sync:{accountId}` channel.
 */
accountsRouter.post('/api/accounts/:id/sync', requireAuth, async (req, res, next) => {
  const accountId = req.params.id ?? '';

  try {
    const owned = (await listAccounts(req.user!.id)).some((account) => account.id === accountId);
    if (!owned) {
      res.status(404).json({ error: { code: 'not_found', message: 'No such account' } });
      return;
    }

    void syncAccount(req.user!.id, accountId).catch(() => undefined);
    res.status(202).json({ started: true, channel: `sync:${accountId}` });
  } catch (err) {
    next(err);
  }
});

/** What the mirror holds, and how the last pass went. */
accountsRouter.get('/api/accounts/:id/sync', requireAuth, async (req, res, next) => {
  const accountId = req.params.id ?? '';

  try {
    const owned = (await listAccounts(req.user!.id)).some((account) => account.id === accountId);
    if (!owned) {
      res.status(404).json({ error: { code: 'not_found', message: 'No such account' } });
      return;
    }

    res.json({ files: await mirrorSize(accountId), history: await recentSyncs(accountId) });
  } catch (err) {
    next(err);
  }
});

// --- where uploads go -----------------------------------------------------

const strategySchema = z.object({
  strategy: z.enum(['round_robin', 'weighted_round_robin', 'least_used', 'most_free', 'manual']),
});

accountsRouter.put('/api/allocation', requireAuth, async (req, res, next) => {
  const parsed = strategySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'Unknown strategy' } });
    return;
  }

  try {
    await setStrategy(req.user!.id, parsed.data.strategy);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

const weightSchema = z.object({ weight: z.number().int().min(0).max(100) });

accountsRouter.put('/api/accounts/:id/weight', requireAuth, async (req, res, next) => {
  const parsed = weightSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'Weight must be 0 to 100' } });
    return;
  }

  try {
    const updated = await setAccountWeight(req.user!.id, req.params.id ?? '', parsed.data.weight);
    if (!updated) {
      res.status(404).json({ error: { code: 'not_found', message: 'No such account' } });
      return;
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

const orderSchema = z.object({ order: z.array(z.string().min(1)).max(50) });

accountsRouter.put('/api/allocation/order', requireAuth, async (req, res, next) => {
  const parsed = orderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'Malformed order' } });
    return;
  }

  try {
    await setAccountPriority(req.user!.id, parsed.data.order);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * Mistakes worth catching before the request leaves.
 *
 * Not validation for its own sake: each of these is a value the provider hands
 * out beside the right one, so pasting it is a slip rather than carelessness -
 * and the provider's own answer names a length rather than a field.
 */
function obviouslyWrong(key: string, values: Record<string, string>): string | null {
  const accessKeyId = values['accessKeyId']?.trim() ?? '';

  if (key === 'cloudflare_r2') {
    // R2 shows three values together: an API token, an access key id and a
    // secret. Only the last two work here, and Cloudflare answers the first
    // with "Credential access key has length 53, should be 32".
    if (accessKeyId.startsWith('cfat_')) {
      return 'That is the API token value, which is for Cloudflare’s own API. The access key ID is the 32-character hex value shown beside it.';
    }
    if (accessKeyId !== '' && !/^[0-9a-f]{32}$/i.test(accessKeyId)) {
      return `An R2 access key ID is 32 hexadecimal characters; this one is ${accessKeyId.length}. Check it is the "Access Key ID" and not the token value.`;
    }
  }

  if (key === 'supabase_storage' && /^(eyJ|sb[ps]?_)/.test(accessKeyId)) {
    // The anon and service_role keys are JWTs and sit on the same settings
    // page as the S3 keys.
    return 'That looks like a project API key. The S3 access key comes from Project Settings, Storage, S3 access keys.';
  }

  return null;
}

/**
 * Turns a store's refusal into the field to go and check.
 *
 * These four failures account for nearly every first attempt, and each points
 * at a different box on the form. The provider's own wording is quoted at the
 * end because it occasionally says something more specific, and it contains no
 * credential material - `providerFetch` quotes bodies, never headers.
 */
function explainConnectFailure(err: ProviderError): string {
  const detail = err.message.replace(/^s3 \[\d+\]: /, '').slice(0, 200);

  if (/SignatureDoesNotMatch/i.test(detail)) {
    return `The signature was rejected. This is almost always the region: it must match the project's region exactly, not "auto". Check the secret key too. (${detail})`;
  }
  if (/NoSuchBucket/i.test(detail)) {
    return `That bucket does not exist at this endpoint. Check the bucket name, and that it was created in this project. (${detail})`;
  }
  if (/InvalidAccessKeyId/i.test(detail)) {
    return `The access key was not recognised. For Supabase these come from Project Settings, Storage, S3 access keys - not the anon or service keys. (${detail})`;
  }
  if (/AccessDenied|Forbidden/i.test(detail) || err.status === 403) {
    return `The keys were accepted but are not allowed to list that bucket. (${detail})`;
  }
  if (err.status === 404) {
    return `Nothing answered at that endpoint. Check the project reference or endpoint URL. (${detail})`;
  }

  return `Could not reach that bucket: ${detail}`;
}

/** Which catalogue entries can actually be connected today. */
accountsRouter.get('/api/connectable', requireAuth, (_req, res) => {
  res.json({
    entries: CONNECTABLE.map((key) => catalogueEntry(key)).filter((entry) => entry !== undefined),
  });
});
