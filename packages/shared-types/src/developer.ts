/**
 * The public API's vocabulary: what a token may do, and what one looks like
 * once it has been created.
 *
 * Here rather than in the server so the Developer tab and the API agree on the
 * spelling of a scope. A scope the UI can offer and the API does not know is a
 * token that silently grants nothing.
 */

export const API_SCOPES = [
  'files:read',
  'files:download',
  'files:write',
  'files:delete',
  'accounts:read',
  'accounts:write',
  'shares:read',
  'shares:write',
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

/** What each scope actually grants, in the words the Developer tab shows. */
export const SCOPE_DESCRIPTIONS: Record<ApiScope, string> = {
  'files:read': 'List folders and read file details',
  'files:download': 'Download file contents',
  'files:write': 'Upload, rename, move, and create folders',
  'files:delete': 'Delete files and folders',
  'accounts:read': 'List connected accounts and their storage',
  'accounts:write': 'Connect and disconnect accounts',
  'shares:read': 'See share links',
  'shares:write': 'Create and revoke share links',
};

/**
 * Deliberately absent: any scope that hands over a provider's own credentials.
 *
 * Orbit proxies every byte, so a token reaches files without ever exposing the
 * Google or Dropbox token behind them. That is the property that makes opening
 * the API up safe at all, and no scope may ever break it.
 */

export function isApiScope(value: string): value is ApiScope {
  return (API_SCOPES as readonly string[]).includes(value);
}

/** A token as the owner sees it afterwards - never the secret itself. */
export interface PublicApiToken {
  id: string;
  name: string;
  /** The last few characters, so two tokens can be told apart in a list. */
  tail: string;
  scopes: ApiScope[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

/**
 * The prefix every personal access token carries.
 *
 * Two reasons. A secret scanner can find a leaked token by its shape, which is
 * why GitHub, Stripe and everyone else does this. And the API can reject a
 * malformed credential before it touches the database.
 */
export const TOKEN_PREFIX = 'orbit_pat_';
