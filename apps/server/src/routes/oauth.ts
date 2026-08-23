import { API_SCOPES, isApiScope } from '@orbit/shared-types';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../lib/env.js';
import { requireAuth } from '../middleware/auth.js';
import { record } from '../services/audit.js';
import {
  allowedApps,
  createApp,
  deleteApp,
  exchangeCode,
  findByClientId,
  isUsableRedirect,
  issueCode,
  listApps,
  refresh,
  revokeGrant,
  rotateAppSecret,
} from '../services/oauth-apps.js';

/**
 * The authorisation endpoints, and the screens around them.
 *
 * `/oauth/authorize` is deliberately not a page. It validates the request and
 * then hands the browser to Orbit's own consent screen, so the thing a person
 * reads before granting access to their drives is rendered by the app they
 * already trust and are already signed in to - not by a page this router
 * assembles as a string.
 *
 * What that split buys: every failure below happens *before* anything is
 * shown, so a malformed or hostile request never reaches a screen with an
 * Allow button on it.
 */

export const oauthRouter: Router = Router();

/**
 * A request that cannot be trusted is refused here, not redirected.
 *
 * The rule that matters: an unregistered `redirect_uri` is an error page, never
 * a redirect. Sending the error *to* the address in the request is how an
 * attacker learns whether a client id exists, and worse, how an open redirect
 * gets built out of an authorisation server.
 */
oauthRouter.get('/oauth/authorize', async (req, res, next) => {
  const query = z
    .object({
      response_type: z.literal('code'),
      client_id: z.string().min(1),
      redirect_uri: z.string().min(1),
      scope: z.string().default(''),
      state: z.string().max(512).optional(),
      code_challenge: z.string().min(43).max(128),
      code_challenge_method: z.literal('S256'),
    })
    .safeParse(req.query);

  if (!query.success) {
    res.status(400).type('text/plain').send(
      'This authorisation request is not valid. It needs response_type=code, a client_id, a ' +
        'registered redirect_uri, and a PKCE challenge with code_challenge_method=S256.',
    );
    return;
  }

  try {
    const app = await findByClientId(query.data.client_id);
    if (!app) {
      res.status(400).type('text/plain').send('No application is registered with that client id.');
      return;
    }

    // Exact match, never a prefix. A prefix match is how a redirect to
    // `https://app.example.com.attacker.test/` gets accepted.
    if (!app.redirectUris.includes(query.data.redirect_uri)) {
      res
        .status(400)
        .type('text/plain')
        .send('That redirect address is not registered for this application.');
      return;
    }

    const asked = query.data.scope.split(/[\s+]+/).filter(isApiScope);
    const wanted = asked.length > 0 ? asked : app.scopes;

    // An app cannot ask for more than it registered for, whatever the URL says.
    const granted = wanted.filter((scope) => app.scopes.includes(scope));

    if (granted.length === 0) {
      res
        .status(400)
        .type('text/plain')
        .send('That application has not registered any of the permissions it is asking for.');
      return;
    }

    /*
     * Handed to the app's own screen. The consent page reads these from the
     * URL, shows what is being asked for, and posts back to /oauth/consent -
     * which is where the session is checked, because that is the request that
     * actually grants something.
     */
    const consent = new URL('/authorize', env.APP_URL);
    consent.searchParams.set('client_id', query.data.client_id);
    consent.searchParams.set('redirect_uri', query.data.redirect_uri);
    consent.searchParams.set('scope', granted.join(' '));
    consent.searchParams.set('code_challenge', query.data.code_challenge);
    if (query.data.state) consent.searchParams.set('state', query.data.state);

    res.redirect(consent.toString());
  } catch (err) {
    next(err);
  }
});

/** What the consent screen needs to draw itself, and to refuse to. */
oauthRouter.get('/api/oauth/request', requireAuth, async (req, res, next) => {
  const clientId = typeof req.query.client_id === 'string' ? req.query.client_id : '';
  const redirectUri = typeof req.query.redirect_uri === 'string' ? req.query.redirect_uri : '';
  const scope = typeof req.query.scope === 'string' ? req.query.scope : '';

  try {
    const app = await findByClientId(clientId);

    if (!app || !app.redirectUris.includes(redirectUri)) {
      res.status(404).json({ error: { code: 'not_found', message: 'No such application' } });
      return;
    }

    res.json({
      app: {
        name: app.name,
        description: app.description,
        website: app.website,
        confidential: app.confidential,
      },
      scopes: scope.split(' ').filter(isApiScope).filter((s) => app.scopes.includes(s)),
      redirectUri,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * The moment access is actually granted.
 *
 * A POST, and behind the session: a GET that granted access could be triggered
 * by an image tag on any page the person happens to visit.
 */
oauthRouter.post('/api/oauth/consent', requireAuth, async (req, res, next) => {
  const parsed = z
    .object({
      client_id: z.string().min(1),
      redirect_uri: z.string().min(1),
      scope: z.string().min(1),
      code_challenge: z.string().min(43).max(128),
      state: z.string().max(512).optional(),
    })
    .safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'Bad consent' } });
    return;
  }

  try {
    const app = await findByClientId(parsed.data.client_id);

    if (!app || !app.redirectUris.includes(parsed.data.redirect_uri)) {
      res.status(404).json({ error: { code: 'not_found', message: 'No such application' } });
      return;
    }

    const scopes = parsed.data.scope
      .split(' ')
      .filter(isApiScope)
      .filter((scope) => app.scopes.includes(scope));

    if (scopes.length === 0) {
      res.status(400).json({ error: { code: 'invalid_scope', message: 'Nothing to grant' } });
      return;
    }

    const code = await issueCode({
      appId: app.id,
      userId: req.user!.id,
      redirectUri: parsed.data.redirect_uri,
      scopes,
      challenge: parsed.data.code_challenge,
    });

    await record({
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: 'oauth.grant',
      targetId: app.id,
      summary: `Allowed ${app.name} to ${scopes.join(', ')}`,
      ip: req.ip,
    });

    const target = new URL(parsed.data.redirect_uri);
    target.searchParams.set('code', code);
    if (parsed.data.state) target.searchParams.set('state', parsed.data.state);

    // Handed back rather than redirected to: the browser is on Orbit's own
    // page, and it navigates itself once it has this.
    res.json({ redirectTo: target.toString() });
  } catch (err) {
    next(err);
  }
});

/**
 * Code for tokens, or refresh for tokens.
 *
 * Form-encoded and unauthenticated by session, as the specification requires -
 * the client proves itself with its secret, or with PKCE if it has none.
 */
oauthRouter.post('/oauth/token', async (req, res, next) => {
  // Never cached, anywhere: the response is a credential.
  res.setHeader('cache-control', 'no-store');
  res.setHeader('pragma', 'no-cache');

  const body = (req.body ?? {}) as Record<string, unknown>;
  const str = (key: string): string | undefined =>
    typeof body[key] === 'string' ? body[key] : undefined;

  const grantType = str('grant_type');

  try {
    if (grantType === 'authorization_code') {
      const code = str('code');
      const clientId = str('client_id');
      const redirectUri = str('redirect_uri');
      const verifier = str('code_verifier');

      if (!code || !clientId || !redirectUri || !verifier) {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }

      const result = await exchangeCode({
        code,
        clientId,
        clientSecret: str('client_secret'),
        redirectUri,
        verifier,
      });

      if (!result.ok) {
        // One error for every reason a code was refused. Telling a caller
        // which check failed is telling an attacker which one to work on.
        res.status(400).json({ error: result.why === 'invalid_client' ? 'invalid_client' : 'invalid_grant' });
        return;
      }

      res.json({
        access_token: result.tokens.accessToken,
        refresh_token: result.tokens.refreshToken,
        token_type: 'Bearer',
        expires_in: result.tokens.expiresIn,
        scope: result.tokens.scopes.join(' '),
      });
      return;
    }

    if (grantType === 'refresh_token') {
      const token = str('refresh_token');
      const clientId = str('client_id');

      if (!token || !clientId) {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }

      const result = await refresh({
        refreshToken: token,
        clientId,
        clientSecret: str('client_secret'),
      });

      if (!result.ok) {
        res.status(400).json({ error: result.why === 'invalid_client' ? 'invalid_client' : 'invalid_grant' });
        return;
      }

      res.json({
        access_token: result.tokens.accessToken,
        refresh_token: result.tokens.refreshToken,
        token_type: 'Bearer',
        expires_in: result.tokens.expiresIn,
        scope: result.tokens.scopes.join(' '),
      });
      return;
    }

    res.status(400).json({ error: 'unsupported_grant_type' });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Managing your own applications, and the ones you have allowed.
// ---------------------------------------------------------------------------

const appSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(400).optional(),
  website: z.string().max(2048).optional(),
  redirectUris: z.array(z.string().min(1).max(2048)).min(1).max(10),
  scopes: z.array(z.enum(API_SCOPES)).min(1),
  confidential: z.boolean().default(true),
});

oauthRouter.get('/api/oauth/apps', requireAuth, async (req, res, next) => {
  try {
    res.json({ apps: await listApps(req.user!.id) });
  } catch (err) {
    next(err);
  }
});

oauthRouter.post('/api/oauth/apps', requireAuth, async (req, res, next) => {
  const parsed = appSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: { code: 'invalid_request', message: 'A name, a redirect address and a scope' },
    });
    return;
  }

  const bad = parsed.data.redirectUris.find((uri) => !isUsableRedirect(uri));

  if (bad) {
    res.status(400).json({
      error: {
        code: 'bad_redirect',
        message: `${bad} cannot receive an authorisation. Use https, or http on localhost.`,
      },
    });
    return;
  }

  try {
    const made = await createApp({ ownerId: req.user!.id, ...parsed.data });

    await record({
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: 'oauth.app',
      targetId: made.app.id,
      summary: `Registered the application ${parsed.data.name}`,
      ip: req.ip,
    });

    res.status(201).json(made);
  } catch (err) {
    next(err);
  }
});

oauthRouter.post('/api/oauth/apps/:id/rotate', requireAuth, async (req, res, next) => {
  try {
    const secret = await rotateAppSecret(req.user!.id, req.params.id!);

    if (!secret) {
      res.status(404).json({ error: { code: 'not_found', message: 'No such application' } });
      return;
    }

    res.json({ secret });
  } catch (err) {
    next(err);
  }
});

oauthRouter.delete('/api/oauth/apps/:id', requireAuth, async (req, res, next) => {
  try {
    const removed = await deleteApp(req.user!.id, req.params.id!);

    if (!removed) {
      res.status(404).json({ error: { code: 'not_found', message: 'No such application' } });
      return;
    }

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/** The other side: what this person has allowed, and taking it back. */
oauthRouter.get('/api/oauth/allowed', requireAuth, async (req, res, next) => {
  try {
    res.json({ apps: await allowedApps(req.user!.id) });
  } catch (err) {
    next(err);
  }
});

oauthRouter.delete('/api/oauth/allowed/:appId', requireAuth, async (req, res, next) => {
  try {
    const revoked = await revokeGrant(req.user!.id, req.params.appId!);

    if (!revoked) {
      res.status(404).json({ error: { code: 'not_found', message: 'Nothing to revoke' } });
      return;
    }

    await record({
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: 'oauth.revoke',
      targetId: req.params.appId!,
      summary: 'Withdrew an application’s access',
      ip: req.ip,
    });

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
