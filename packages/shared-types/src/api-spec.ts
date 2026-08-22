import type { ApiScope } from './developer.js';

/**
 * What `/v1` is, as data.
 *
 * Written once and read twice: the documentation page renders it, and a server
 * test compares it against the routes actually registered on the router - in
 * both directions, so an endpoint added without an entry fails, and an entry
 * describing something that no longer exists fails too.
 *
 * That test is the whole reason this is data rather than a page of prose. Hand
 * written API documentation is wrong within a release; the only documentation
 * worth publishing is documentation something checks.
 */

export interface ApiParam {
  name: string;
  /** Where it goes: in the path, the query string, or the JSON body. */
  in: 'path' | 'query' | 'body';
  required: boolean;
  description: string;
  example?: string;
}

export interface ApiEndpoint {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Express's own path, so the test can compare it without translating. */
  path: string;
  summary: string;
  /** Why it exists, or what is surprising about it. Skipped when neither. */
  detail?: string;
  scope: ApiScope | null;
  params: ApiParam[];
  /** A trimmed but real response, not an invented one. */
  response: string;
}

const ACCOUNT_ID: ApiParam = {
  name: 'accountId',
  in: 'query',
  required: true,
  description: 'Which connected drive to act on. From GET /v1/accounts.',
  example: 'gfjsYqzFOtwENT3s3JkaH',
};

export const V1_ENDPOINTS: ApiEndpoint[] = [
  {
    method: 'GET',
    path: '/v1/me',
    summary: 'Who this token belongs to, and what it may do',
    detail:
      'Lets a program find out its own scopes rather than discovering them one 403 at a time.',
    scope: null,
    params: [],
    response: `{
  "user": { "id": "GDc2o6uB…", "email": "you@example.com", "displayName": "You" },
  "scopes": ["files:read", "accounts:read"]
}`,
  },
  {
    method: 'GET',
    path: '/v1/accounts',
    summary: 'Every drive you have connected',
    detail:
      'The aggregation itself: one list covering Google Drive, Dropbox, pCloud and every S3-compatible bucket, with each one’s quota and status.',
    scope: 'accounts:read',
    params: [],
    response: `{
  "accounts": [
    {
      "id": "gfjsYqzFOtwENT3s3JkaH",
      "provider": "s3",
      "catalogueKey": "supabase_storage",
      "nickname": "media",
      "usedBytes": 1048576,
      "quotaBytes": 0,
      "status": "ok"
    }
  ]
}`,
  },
  {
    method: 'GET',
    path: '/v1/files',
    summary: 'One folder',
    detail:
      'Paged by cursor, never by offset: the drive changes under a reader, so page 3 of a list that shifted is not page 3 of anything. Pass the nextCursor back as cursor to continue; it is null when the listing is finished.',
    scope: 'files:read',
    params: [
      ACCOUNT_ID,
      {
        name: 'path',
        in: 'query',
        required: false,
        description: 'Folder to list. Defaults to the root.',
        example: '/Photos',
      },
      {
        name: 'cursor',
        in: 'query',
        required: false,
        description: 'The nextCursor from the previous page.',
      },
    ],
    response: `{
  "accountId": "gfjsYqzFOtwENT3s3JkaH",
  "path": "/Photos",
  "files": [
    {
      "remoteId": "1AbCd…",
      "name": "beach.jpg",
      "virtualPath": "/Photos/beach.jpg",
      "mimeType": "image/jpeg",
      "sizeBytes": 2048576,
      "isFolder": false,
      "modifiedAt": "2026-08-01T10:00:00.000Z"
    }
  ],
  "nextCursor": null
}`,
  },
  {
    method: 'GET',
    path: '/v1/files/:id',
    summary: 'One file’s details',
    scope: 'files:read',
    params: [
      { name: 'id', in: 'path', required: true, description: 'The file’s remoteId.' },
      ACCOUNT_ID,
    ],
    response: `{ "file": { "remoteId": "1AbCd…", "name": "beach.jpg", "sizeBytes": 2048576 } }`,
  },
  {
    method: 'GET',
    path: '/v1/files/:id/content',
    summary: 'The bytes',
    detail:
      'Streamed through Orbit, so the provider’s own URL never reaches the client. Honours Range, so a player can seek and a download can resume. The response is the file, not JSON.',
    scope: 'files:download',
    params: [
      { name: 'id', in: 'path', required: true, description: 'The file’s remoteId.' },
      ACCOUNT_ID,
    ],
    response: `HTTP/1.1 206 Partial Content
content-type: image/jpeg
content-range: bytes 0-1023/2048576
accept-ranges: bytes`,
  },
  {
    method: 'POST',
    path: '/v1/files/folder',
    summary: 'Create a folder',
    scope: 'files:write',
    params: [
      { ...ACCOUNT_ID, in: 'body' },
      {
        name: 'path',
        in: 'body',
        required: false,
        description: 'Where to create it. Defaults to the root.',
        example: '/Photos',
      },
      { name: 'name', in: 'body', required: true, description: 'The folder’s name.', example: '2026' },
    ],
    response: `{ "file": { "remoteId": "1XyZ…", "name": "2026", "isFolder": true } }`,
  },
  {
    method: 'PATCH',
    path: '/v1/files/:id',
    summary: 'Rename a file or folder',
    scope: 'files:write',
    params: [
      { name: 'id', in: 'path', required: true, description: 'The file’s remoteId.' },
      { ...ACCOUNT_ID, in: 'body' },
      { name: 'name', in: 'body', required: true, description: 'The new name.', example: 'holiday.jpg' },
    ],
    response: `{ "file": { "remoteId": "1AbCd…", "name": "holiday.jpg" } }`,
  },
  {
    method: 'DELETE',
    path: '/v1/files',
    summary: 'Delete files and folders',
    detail:
      'Up to 200 at a time, and partial success is reported rather than flattened: a bulk delete where one file was already gone is not a failed request, and a program deserves to know which of the two hundred actually went. Where the provider has a bin, this puts them in it.',
    scope: 'files:delete',
    params: [
      { ...ACCOUNT_ID, in: 'body' },
      {
        name: 'remoteIds',
        in: 'body',
        required: true,
        description: 'The files to delete, by remoteId.',
        example: '["1AbCd…", "1EfGh…"]',
      },
    ],
    response: `{ "succeeded": ["1AbCd…"], "failed": [{ "remoteId": "1EfGh…", "reason": "not found" }] }`,
  },
  {
    method: 'GET',
    path: '/v1/shares',
    summary: 'Every link you have published',
    scope: 'shares:read',
    params: [],
    response: `{
  "shares": [
    {
      "shortId": "9gntxwabjbuw",
      "url": "https://api.orbit.harshitsaini.in/s/9gntxwabjbuw",
      "name": "beach.jpg",
      "permission": "download",
      "expiresAt": null,
      "accessCount": 4
    }
  ]
}`,
  },
  {
    method: 'POST',
    path: '/v1/shares',
    summary: 'Publish a link to a file',
    detail:
      'Returns the existing link if one is already live for that file, rather than minting a second one nothing can revoke from the UI.',
    scope: 'shares:write',
    params: [
      { ...ACCOUNT_ID, in: 'body' },
      { name: 'remoteId', in: 'body', required: true, description: 'The file to publish.' },
      {
        name: 'permission',
        in: 'body',
        required: false,
        description: '"view" or "download". Defaults to view.',
      },
      {
        name: 'password',
        in: 'body',
        required: false,
        description: 'Required from anyone opening the link.',
      },
      {
        name: 'expiresInDays',
        in: 'body',
        required: false,
        description: 'After this the link stops working on its own.',
        example: '7',
      },
    ],
    response: `{ "share": { "shortId": "9gntxwabjbuw", "url": "https://…/s/9gntxwabjbuw" } }`,
  },
  {
    method: 'DELETE',
    path: '/v1/shares/:shortId',
    summary: 'Revoke a link',
    detail: 'It stops working immediately, and answers as if it had never existed.',
    scope: 'shares:write',
    params: [
      { name: 'shortId', in: 'path', required: true, description: 'From the share’s url.' },
    ],
    response: `204 No Content`,
  },
];

/** The error every failure answers with. */
export const API_ERROR_SHAPE = `{
  "error": {
    "code": "insufficient_scope",
    "message": "This token needs the files:delete scope",
    "requestId": "b7422acd0a201630"
  }
}`;

export interface ApiErrorCode {
  status: number;
  code: string;
  meaning: string;
}

export const API_ERROR_CODES: ApiErrorCode[] = [
  { status: 401, code: 'unauthenticated', meaning: 'No credential was sent.' },
  {
    status: 401,
    code: 'invalid_token',
    meaning: 'Expired, revoked, or never existed - deliberately not distinguished.',
  },
  { status: 403, code: 'insufficient_scope', meaning: 'A real token, without the scope for this.' },
  { status: 404, code: 'not_found', meaning: 'No such account, file, link, or endpoint.' },
  { status: 400, code: 'invalid_request', meaning: 'A parameter is missing or the wrong shape.' },
  { status: 409, code: 'needs_reauth', meaning: 'That drive’s connection has expired.' },
  { status: 429, code: 'rate_limited', meaning: 'Too many requests. Retry-After says when.' },
  { status: 501, code: 'unsupported', meaning: 'That provider cannot do this at all.' },
  { status: 502, code: 'provider_unavailable', meaning: 'The provider did not answer.' },
];
