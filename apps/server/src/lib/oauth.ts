import { createHash, randomBytes } from 'node:crypto';
import type { ProviderId } from '@orbit/shared-types';
import type { CookieOptions, Request, Response } from 'express';
import { env } from './env.js';

export interface OAuthProviderConfig {
  authorizeUrl: string;
  scopes: string[];
  /** Extra parameters the provider needs on the authorise URL. */
  extraParams?: Record<string, string>;
  clientIdEnv: string;
  clientSecretEnv: string;
}

export const OAUTH_PROVIDERS: Partial<Record<ProviderId, OAuthProviderConfig>> = {
  google_drive: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    scopes: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
    extraParams: {
      // Without offline access Google issues no refresh token, so the
      // connection would die in an hour with no way to renew it. prompt=consent
      // forces a fresh one even if the user has authorised before - otherwise a
      // reconnect silently returns an access token only.
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
    },
    clientIdEnv: 'GOOGLE_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
  },
  onedrive: {
    // The "common" tenant accepts both personal Microsoft accounts and work
    // ones; a tenant-specific endpoint would refuse half the people who try.
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    scopes: [
      'Files.ReadWrite.All',
      'User.Read',
      // Without this Microsoft issues no refresh token and the connection dies
      // in an hour, the same trap as Google's access_type=offline.
      'offline_access',
    ],
    clientIdEnv: 'ONEDRIVE_CLIENT_ID',
    clientSecretEnv: 'ONEDRIVE_CLIENT_SECRET',
  },
  pcloud: {
    /*
     * my.pcloud.com works for both regions.
     *
     * pCloud runs a US and an EU service on separate hosts, and which one an
     * account lives on is not knowable before signing in - the token response
     * says. So authorisation goes through the common host and the adapter
     * stores the API host pCloud names.
     */
    authorizeUrl: 'https://my.pcloud.com/oauth2/authorize',
    // pCloud has no scope parameter: an app is granted full access to the
    // account it is authorised against, and asking for less is not offered.
    scopes: [],
    clientIdEnv: 'PCLOUD_CLIENT_ID',
    clientSecretEnv: 'PCLOUD_CLIENT_SECRET',
  },
  dropbox: {
    authorizeUrl: 'https://www.dropbox.com/oauth2/authorize',
    // Dropbox scopes are per-endpoint rather than broad; these are exactly the
    // ones the adapter calls, so the consent screen asks for nothing spare.
    scopes: [
      'files.metadata.read',
      'files.content.read',
      'files.content.write',
      'sharing.read',
      'account_info.read',
    ],
    extraParams: {
      // Without these Dropbox issues a short-lived token and no refresh token,
      // and the connection dies in four hours with no way to renew it.
      token_access_type: 'offline',
      // Ask again even if this app was authorised before, or a reconnect
      // returns an access token only.
      force_reapprove: 'false',
    },
    clientIdEnv: 'DROPBOX_CLIENT_ID',
    clientSecretEnv: 'DROPBOX_CLIENT_SECRET',
  },
};

export function isOAuthProvider(provider: string): provider is ProviderId {
  return provider in OAUTH_PROVIDERS;
}

export function redirectUriFor(provider: ProviderId): string {
  return `${env.API_URL}/auth/callback/${provider}`;
}

const STATE_COOKIE = 'orbit_oauth';
const STATE_TTL_MS = 10 * 60 * 1000;

export interface PendingAuthorisation {
  state: string;
  codeVerifier: string;
  provider: ProviderId;
  /** Where to send the browser once the account is connected. */
  returnTo: string;
}

function stateCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    // Google redirects the browser back to us as a top-level GET, which a
    // strict cookie would not be sent on. lax is the correct level here.
    sameSite: 'lax',
    path: '/auth',
    maxAge: STATE_TTL_MS,
  };
}

/** PKCE: a random verifier, and the SHA-256 challenge derived from it. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function beginAuthorisation(
  res: Response,
  provider: ProviderId,
  returnTo: string,
): { url: string } {
  const config = OAUTH_PROVIDERS[provider];
  if (!config) throw new Error(`${provider} does not use OAuth`);

  const clientId = process.env[config.clientIdEnv];
  if (!clientId) throw new Error(`${config.clientIdEnv} is not set`);

  const state = randomBytes(24).toString('base64url');
  const { verifier, challenge } = createPkcePair();

  const pending: PendingAuthorisation = { state, codeVerifier: verifier, provider, returnTo };
  res.cookie(STATE_COOKIE, JSON.stringify(pending), stateCookieOptions());

  const url = new URL(config.authorizeUrl);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUriFor(provider));
  url.searchParams.set('response_type', 'code');
  // Omitted rather than sent empty: pCloud has no scopes, and `scope=` is a
  // request for no permissions rather than the absence of the question.
  if (config.scopes.length > 0) url.searchParams.set('scope', config.scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  for (const [key, value] of Object.entries(config.extraParams ?? {})) {
    url.searchParams.set(key, value);
  }

  return { url: url.toString() };
}

/**
 * Reads back what beginAuthorisation stored. Returns null on anything
 * unexpected - a missing cookie, a mismatched state, or the wrong provider -
 * all of which mean this callback did not come from a flow we started.
 */
export function consumeAuthorisation(
  req: Request,
  res: Response,
  provider: ProviderId,
  state: string | undefined,
): PendingAuthorisation | null {
  const raw = req.cookies?.[STATE_COOKIE] as string | undefined;
  res.clearCookie(STATE_COOKIE, { ...stateCookieOptions(), maxAge: undefined });

  if (!raw || !state) return null;

  let pending: PendingAuthorisation;
  try {
    pending = JSON.parse(raw) as PendingAuthorisation;
  } catch {
    return null;
  }

  if (pending.provider !== provider) return null;
  if (pending.state !== state) return null;

  return pending;
}
