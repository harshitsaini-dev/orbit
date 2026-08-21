import { GoogleDriveAdapter, getAdapter } from '@orbit/adapters';
import { catalogueEntry } from '@orbit/shared-types';
import { Router } from 'express';
import { env } from '../lib/env.js';
import {
  beginAuthorisation,
  consumeAuthorisation,
  isOAuthProvider,
  redirectUriFor,
} from '../lib/oauth.js';
import { requireAuth } from '../middleware/auth.js';
import {
  createAccount,
  deleteAccount,
  listAccounts,
  refreshQuota,
} from '../services/accounts.js';
import { forgetBreakdown, getBreakdown } from '../services/breakdown.js';

export const accountsRouter: Router = Router();

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
    // to the same provider stay tellable apart.
    let nickname = adapter.displayName;
    if (adapter instanceof GoogleDriveAdapter) {
      const email = await adapter.getAccountEmail(tokens).catch(() => undefined);
      if (email) nickname = email;
    }

    const account = await createAccount({
      userId: req.user!.id,
      provider,
      catalogueKey: provider,
      nickname,
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

/** Which catalogue entries can actually be connected today. */
accountsRouter.get('/api/connectable', requireAuth, (_req, res) => {
  res.json({
    entries: ['google_drive']
      .map((key) => catalogueEntry(key))
      .filter((entry) => entry !== undefined),
  });
});
