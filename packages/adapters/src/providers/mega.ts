import { Readable } from 'node:stream';
import type {
  AccountTokens,
  AuthType,
  BulkResult,
  ByteRange,
  ConnectInput,
  FileStreamResult,
  OrbitFile,
  OrbitFilePage,
  ProviderId,
  Quota,
  SearchQuery,
  UploadMeta,
  UploadSession,
  WorkspaceView,
} from '@orbit/shared-types';
import { mimeForName } from '@orbit/shared-types';
import { File as MegaFile, Storage } from 'megajs';
import { BaseAdapter, joinPath, normalisePath, ProviderError, type AdapterCapabilities } from '../base.js';

/**
 * MEGA.
 *
 * The odd one out in this folder, and worth saying why before any of the code.
 *
 * MEGA publishes no documented API and issues no OAuth tokens. What exists is
 * a private interface and a client-side cryptosystem, reached here through
 * `megajs` - an unofficial SDK that implements both. That has two consequences
 * this adapter is shaped around, and neither can be engineered away:
 *
 * **There is no token to ask for.** Access begins with the account's own email
 * and password, because MEGA derives the key that decrypts the files from the
 * password itself. So the password is taken once, at connect, and exchanged
 * immediately for a session - `Storage.toJSON()`, which is a session id and the
 * derived key. That session is what Orbit stores, encrypted like every other
 * credential, and the password is never written anywhere. It matters: a session
 * appears in MEGA's own *Active sessions* list and can be killed from there,
 * which a stored password could not be.
 *
 * **The interface can change without notice.** Nothing here is a promise MEGA
 * has made. When it breaks it will break at the SDK, and the honest thing is
 * that this is best-effort in a way the OAuth adapters are not.
 *
 * The mechanics are pleasanter than the politics. A MEGA account is a tree held
 * in memory after one load, so listing a folder is a walk rather than a request,
 * and search is a filter rather than a query. What costs is the first load and
 * the bytes themselves.
 */

interface SessionShape {
  key: string;
  sid: string;
  name?: string;
  user?: string;
  options?: Record<string, unknown>;
}

/**
 * A node as `megajs` presents it, named here rather than imported.
 *
 * The SDK's types describe a class with far more on it than this adapter
 * touches, and writing down the eight fields actually used makes it obvious
 * what a change upstream would have to break.
 */
interface Node {
  nodeId?: string;
  name?: string | null;
  size?: number;
  /** Seconds, not milliseconds - MEGA reports UNIX time. */
  timestamp?: number;
  directory?: boolean;
  favorited?: boolean;
  parent?: Node;
  children?: Node[];
  download: (options: { start?: number; end?: number }) => NodeJS.ReadableStream;
  delete: (permanent?: boolean) => Promise<unknown>;
  moveTo: (target: Node) => Promise<unknown>;
  rename: (name: string) => Promise<unknown>;
  setFavorite: (favourite: boolean) => Promise<unknown>;
  mkdir: (name: string) => Promise<Node>;
  upload: (options: { name: string; size: number }, source: NodeJS.ReadableStream) => { complete: Promise<Node> };
}

interface Session {
  root: Node;
  trash: Node;
  files: Record<string, Node>;
  email?: string;
  name?: string;
  reload: () => Promise<unknown>;
  getAccountInfo: () => Promise<{ spaceUsed: number; spaceTotal: number }>;
  toJSON: () => SessionShape;
  close: () => void;
}

/**
 * Sessions held for a short while after use.
 *
 * Resuming means fetching and decrypting the whole file tree, which on a real
 * account is seconds. Doing that once per request would make every listing feel
 * like a cold start, and doing it once per process would mean a tree that
 * silently goes stale. A few minutes is the compromise: long enough that a
 * person clicking through folders pays it once, short enough that a file added
 * from MEGA's own web interface shows up without a restart.
 */
const SESSION_TTL_MS = 3 * 60 * 1000;

/**
 * The size Orbit is asked to hand over at a time.
 *
 * It is not a MEGA constraint - MEGA takes the file in one piece - but the
 * whole upload is held in memory until the last chunk arrives, so this only
 * governs how often progress moves.
 */
const UPLOAD_CHUNK = 8 * 1024 * 1024;

interface Cached {
  session: Session;
  at: number;
}

const cache = new Map<string, Cached>();

function cacheKey(tokens: AccountTokens): string {
  return tokens.accessToken ?? '';
}

/** Lets go of every cached session. For tests, and for a clean shutdown. */
export function closeMegaSessions(): void {
  for (const entry of cache.values()) entry.session.close();
  cache.clear();
}

async function open(tokens: AccountTokens): Promise<Session> {
  const key = cacheKey(tokens);
  if (!key) throw new ProviderError('mega', 401, 'This MEGA account is not connected');

  const held = cache.get(key);
  if (held && Date.now() - held.at < SESSION_TTL_MS) return held.session;
  if (held) held.session.close();

  let shape: SessionShape;
  try {
    shape = JSON.parse(key) as SessionShape;
  } catch {
    throw new ProviderError('mega', 401, 'This MEGA connection needs setting up again');
  }

  try {
    const session = Storage.fromJSON(shape as never) as unknown as Session;
    // The tree is not loaded by `fromJSON`; without this every listing is empty
    // and nothing says why.
    await session.reload();

    cache.set(key, { session, at: Date.now() });
    return session;
  } catch (err) {
    cache.delete(key);
    throw asProviderError(err);
  }
}

function asProviderError(err: unknown): ProviderError {
  const message = err instanceof Error ? err.message : String(err);

  /*
   * MEGA answers with numeric codes rather than HTTP statuses, and `megajs`
   * turns them into messages. Only the two worth acting on are picked out: a
   * dead session needs a reconnection, and a quota refusal is not a fault.
   */
  if (/EACCESS|ESID|EBLOCKED|ELOGINREQUIRED|expired/i.test(message)) {
    return new ProviderError('mega', 401, 'MEGA has ended this session. Reconnect it.');
  }
  if (/EOVERQUOTA|EGOINGOVERQUOTA/i.test(message)) {
    return new ProviderError('mega', 507, 'This MEGA account is out of space');
  }
  if (/ENOENT|ENOTFOUND/i.test(message)) {
    return new ProviderError('mega', 404, 'That is not in this MEGA account');
  }

  return new ProviderError('mega', 502, message);
}

/** The path of a node, built by walking up to the root. */
function pathOf(node: Node, root: Node): string {
  const parts: string[] = [];

  for (let at: Node | undefined = node; at && at !== root; at = at.parent) {
    if (at.name) parts.unshift(at.name);
  }

  return `/${parts.join('/')}`;
}

function toOrbitFile(node: Node, root: Node): OrbitFile {
  const name = node.name ?? 'Untitled';

  return {
    remoteId: node.nodeId ?? '',
    name,
    virtualPath: pathOf(node, root),
    // MEGA stores no content type; it is a cryptosystem with filenames on top.
    mimeType: node.directory ? 'application/vnd.orbit.folder' : mimeForName(name),
    sizeBytes: node.directory ? 0 : (node.size ?? 0),
    isFolder: Boolean(node.directory),
    starred: Boolean(node.favorited),
    modifiedAt: new Date((node.timestamp ?? 0) * 1000).toISOString(),
  };
}

/** Walks to a folder by path, or says which part of it does not exist. */
function folderAt(session: Session, path: string): Node {
  const wanted = normalisePath(path);
  if (wanted === '/') return session.root;

  let at: Node = session.root;

  for (const segment of wanted.split('/').filter(Boolean)) {
    const next = (at.children ?? []).find((child) => child.directory && child.name === segment);
    if (!next) throw new ProviderError('mega', 404, `No folder at ${wanted}`);
    at = next;
  }

  return at;
}

function nodeById(session: Session, remoteId: string): Node {
  const node = session.files[remoteId];
  if (!node) throw new ProviderError('mega', 404, 'That is not in this MEGA account');
  return node;
}

/** Everything under a node, depth first, the root itself excluded. */
function descend(node: Node, into: Node[] = []): Node[] {
  for (const child of node.children ?? []) {
    into.push(child);
    if (child.directory) descend(child, into);
  }

  return into;
}

/**
 * A page out of a list already in memory.
 *
 * The whole tree is loaded, so paging is not about sparing the provider - it is
 * about not handing a caller forty thousand rows in one response.
 */
const PAGE = 500;

function page(nodes: Node[], root: Node, pageToken?: string): OrbitFilePage {
  const from = pageToken ? Number(pageToken) : 0;
  const slice = nodes.slice(from, from + PAGE);
  const next = from + PAGE;

  return {
    files: slice.map((node) => toOrbitFile(node, root)),
    ...(next < nodes.length ? { nextPageToken: String(next) } : {}),
  };
}

export class MegaAdapter extends BaseAdapter {
  readonly id: ProviderId = 'mega';
  readonly authType: AuthType = 'account_password';
  readonly displayName = 'MEGA';

  readonly capabilities: AdapterCapabilities = {
    // A favourite flag exists and is what star maps to.
    star: true,
    // Shares exist but are inbound mounts with their own key handling; not
    // claimed rather than half-supported.
    sharedWithMe: false,
    // No change feed. The tree is reloaded, which is why the session is cached.
    delta: false,
    // The SDK uploads in one pass and needs the size up front.
    resumableUpload: false,
    rangeRequests: true,
    nativeFolders: true,
    trash: true,
    purgeTrash: true,
    relocate: true,
    reportsQuota: true,
    flatEnumeration: true,
    recentView: true,
    // MEGA renders none - a server that cannot read the file cannot draw it.
    thumbnails: false,
    search: true,
    fullTextSearch: false,
  };

  /**
   * Takes an email and a password, and keeps neither.
   *
   * The password is the only way in - MEGA derives the file-decrypting key from
   * it - so it is used once here and exchanged for a session, which is what
   * Orbit stores. A session can be ended from MEGA's own Active sessions page;
   * a stored password could not be.
   */
  override async connect(input: ConnectInput): Promise<AccountTokens> {
    if (input.kind !== 'credentials') {
      throw new ProviderError('mega', 400, 'MEGA connects with an email and password, not OAuth');
    }

    const email = input.values.username?.trim();
    const password = input.values.password;

    if (!email || !password) {
      throw new ProviderError(
        'mega',
        400,
        'missing credentials',
        'A MEGA email and password are needed',
      );
    }

    try {
      const session = (await new Storage({
        email,
        password,
        // The tree is loaded here anyway, and connecting without checking the
        // account can be read would accept a password that is not enough.
        autoload: true,
        keepalive: false,
      }).ready) as unknown as Session;

      const shape = session.toJSON();
      session.close();

      return { accessToken: JSON.stringify(shape) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // The one failure worth naming, because it is the one people cause.
      if (/EARGS|ENOENT|wrong password|EBLOCKED/i.test(message)) {
        throw new ProviderError('mega', 401, 'MEGA refused that email and password');
      }

      throw asProviderError(err);
    }
  }

  /**
   * Nothing to refresh.
   *
   * A MEGA session has no expiry to renew against; it lives until somebody ends
   * it. Returning the tokens unchanged is the honest implementation - the
   * alternative would be a call that pretends to do something.
   */
  override refreshToken(tokens: AccountTokens): Promise<AccountTokens> {
    return Promise.resolve(tokens);
  }

  async getAccountIdentity(
    tokens: AccountTokens,
  ): Promise<{ email?: string; displayName?: string }> {
    const session = await open(tokens);

    return {
      ...(session.email ? { email: session.email } : {}),
      ...(session.name ? { displayName: session.name } : {}),
    };
  }

  override async getQuota(tokens: AccountTokens): Promise<Quota> {
    const session = await open(tokens);

    try {
      const info = await session.getAccountInfo();
      return { usedBytes: info.spaceUsed, totalBytes: info.spaceTotal };
    } catch (err) {
      throw asProviderError(err);
    }
  }

  override async listFolder(
    tokens: AccountTokens,
    path: string,
    pageToken?: string,
  ): Promise<OrbitFilePage> {
    const session = await open(tokens);
    const folder = folderAt(session, path);

    // Folders first, then by name: the tree arrives in whatever order MEGA
    // stored it, which is no order at all to read.
    const children = [...(folder.children ?? [])].sort((a, b) => {
      if (Boolean(a.directory) !== Boolean(b.directory)) return a.directory ? -1 : 1;
      return (a.name ?? '').localeCompare(b.name ?? '');
    });

    return page(children, session.root, pageToken);
  }

  override async listAllFiles(
    tokens: AccountTokens,
    pageToken?: string,
  ): Promise<OrbitFilePage> {
    const session = await open(tokens);
    return page(descend(session.root), session.root, pageToken);
  }

  override async listView(
    tokens: AccountTokens,
    view: WorkspaceView,
    pageToken?: string,
  ): Promise<OrbitFilePage> {
    const session = await open(tokens);
    const all = descend(session.root);

    if (view === 'starred') {
      return page(all.filter((node) => node.favorited), session.root, pageToken);
    }

    if (view === 'recent') {
      const recent = all
        .filter((node) => !node.directory)
        .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));

      return page(recent, session.root, pageToken);
    }

    return { files: [] };
  }

  override async search(
    tokens: AccountTokens,
    query: SearchQuery,
    pageToken?: string,
  ): Promise<OrbitFilePage> {
    const session = await open(tokens);
    const needle = (query.text ?? '').trim().toLowerCase();

    // A filter over a loaded tree, because MEGA has no search to ask. It only
    // ever sees names: the contents are encrypted, including from MEGA.
    const found = descend(session.root).filter((node) =>
      needle ? (node.name ?? '').toLowerCase().includes(needle) : true,
    );

    return page(found, session.root, pageToken);
  }

  override async getFileMeta(tokens: AccountTokens, remoteId: string): Promise<OrbitFile> {
    const session = await open(tokens);
    return toOrbitFile(nodeById(session, remoteId), session.root);
  }

  override async getFileStream(
    tokens: AccountTokens,
    remoteId: string,
    range?: ByteRange,
  ): Promise<FileStreamResult> {
    const session = await open(tokens);
    const node = nodeById(session, remoteId);
    const size = node.size ?? 0;

    const start = range?.start ?? 0;
    const end = range?.end !== undefined ? Math.min(range.end, size - 1) : size - 1;

    try {
      // The SDK decrypts as it goes, so this is plaintext by the time it leaves.
      const stream = node.download({ start, end });

      return {
        stream: Readable.toWeb(Readable.from(stream)) as ReadableStream<Uint8Array>,
        contentType: mimeForName(node.name ?? ''),
        contentLength: end - start + 1,
        ...(range ? { contentRange: `bytes ${start}-${end}/${size}` } : {}),
      };
    } catch (err) {
      throw asProviderError(err);
    }
  }

  override async createFolder(
    tokens: AccountTokens,
    path: string,
    name: string,
  ): Promise<OrbitFile> {
    const session = await open(tokens);
    const parent = folderAt(session, path);

    try {
      const made = await parent.mkdir(name);
      return toOrbitFile(made, session.root);
    } catch (err) {
      throw asProviderError(err);
    }
  }

  override async rename(
    tokens: AccountTokens,
    remoteId: string,
    newName: string,
  ): Promise<void> {
    const session = await open(tokens);

    try {
      await nodeById(session, remoteId).rename(newName);
    } catch (err) {
      throw asProviderError(err);
    }
  }

  override async relocate(
    tokens: AccountTokens,
    remoteId: string,
    targetPath: string,
    options: { copy: boolean },
  ): Promise<OrbitFile> {
    const session = await open(tokens);
    const node = nodeById(session, remoteId);
    const target = folderAt(session, targetPath);

    /*
     * Moving is one call; copying is not a call at all.
     *
     * MEGA has no server-side copy for a node in your own account - a file is
     * one encrypted object, and a second copy means uploading a second one.
     * Refusing here is better than silently downloading and re-uploading behind
     * a button labelled Copy: the transfer engine does that deliberately and
     * says how long it will take.
     */
    if (options.copy) {
      throw new ProviderError(
        'mega',
        501,
        'copy within account unsupported',
        'MEGA cannot copy a file within an account. Move it, or send it to another drive.',
      );
    }

    try {
      await node.moveTo(target);
      return toOrbitFile(node, session.root);
    } catch (err) {
      throw asProviderError(err);
    }
  }

  override async remove(tokens: AccountTokens, remoteIds: string[]): Promise<BulkResult> {
    const session = await open(tokens);
    const succeeded: string[] = [];
    const failed: BulkResult['failed'] = [];

    for (const remoteId of remoteIds) {
      try {
        // To the bin, not destroyed: `delete(true)` is what purge is for.
        await nodeById(session, remoteId).delete(false);
        succeeded.push(remoteId);
      } catch (err) {
        failed.push({ remoteId, reason: asProviderError(err).message });
      }
    }

    return { succeeded, failed };
  }

  override async star(
    tokens: AccountTokens,
    remoteId: string,
    starred: boolean,
  ): Promise<void> {
    const session = await open(tokens);

    try {
      await nodeById(session, remoteId).setFavorite(starred);
    } catch (err) {
      throw asProviderError(err);
    }
  }

  async listTrash(
    tokens: AccountTokens,
    pageToken?: string,
  ): Promise<OrbitFilePage> {
    const session = await open(tokens);
    return page(descend(session.trash), session.trash, pageToken);
  }

  async restoreFromTrash(tokens: AccountTokens, remoteId: string): Promise<void> {
    const session = await open(tokens);

    /*
     * Back to the root, not to where it was.
     *
     * MEGA does not record the previous parent, so there is nothing to restore
     * to. The root is the honest destination - the alternative is guessing at a
     * folder and putting somebody's file somewhere they will not look.
     */
    try {
      await nodeById(session, remoteId).moveTo(session.root);
    } catch (err) {
      throw asProviderError(err);
    }
  }

  async purgeFromTrash(tokens: AccountTokens, remoteId: string): Promise<void> {
    const session = await open(tokens);

    try {
      await nodeById(session, remoteId).delete(true);
    } catch (err) {
      throw asProviderError(err);
    }
  }

  /**
   * Uploads arrive whole.
   *
   * MEGA needs the length before the first byte, and the SDK reads a stream to
   * the end. So the session carries the destination and nothing else, the
   * chunks are collected here, and the file is written when the last one lands
   * - which is why `resumableUpload` is false: an interrupted MEGA upload has
   * nothing to resume from.
   */
  override initUpload(
    tokens: AccountTokens,
    path: string,
    meta: UploadMeta,
  ): Promise<UploadSession> {
    return Promise.resolve({
      provider: this.id,
      // No provider-side handle: there is no session at MEGA to hold one.
      remoteSessionId: joinPath(normalisePath(path), meta.name),
      chunkSize: UPLOAD_CHUNK,
      state: { tokens, path: normalisePath(path), meta, parts: [] as Uint8Array[], seen: 0 },
    });
  }

  override async uploadChunk(
    session: UploadSession,
    chunk: Uint8Array,
    onProgress: (uploadedBytes: number) => void,
  ): Promise<{ done: boolean; file?: OrbitFile }> {
    const state = session.state as unknown as {
      tokens: AccountTokens;
      path: string;
      meta: UploadMeta;
      parts: Uint8Array[];
      seen: number;
    };

    state.parts.push(chunk);
    state.seen += chunk.byteLength;
    onProgress(chunk.byteLength);

    // Held until the size is known, because that is what MEGA asks for first.
    if (state.seen < state.meta.sizeBytes) return { done: false };

    const live = await open(state.tokens);
    const folder = folderAt(live, state.path);
    const body = Buffer.concat(state.parts.map((part) => Buffer.from(part)));

    try {
      const uploaded = await folder.upload(
        { name: state.meta.name, size: body.length },
        Readable.from(body),
      ).complete;

      // The tree in memory predates the upload, so the new node is not in it.
      await live.reload();

      return { done: true, file: toOrbitFile(uploaded, live.root) };
    } catch (err) {
      throw asProviderError(err);
    }
  }

  /**
   * A public link, which MEGA makes by putting the key in the fragment.
   *
   * Not wired into Orbit's own sharing - Orbit shares by proxying bytes so that
   * a provider URL never reaches a browser, and a MEGA link is the opposite of
   * that by construction. Here because the adapter would otherwise be lying
   * about what it can do.
   */
  async publicLink(tokens: AccountTokens, remoteId: string): Promise<string> {
    const session = await open(tokens);
    const node = nodeById(session, remoteId) as Node & { link: () => Promise<string> };

    try {
      return await node.link();
    } catch (err) {
      throw asProviderError(err);
    }
  }
}

/** Exported for the one test that needs a node without a live account. */
export const megaInternals = { toOrbitFile, pathOf, folderAt, descend, page, asProviderError };

export { MegaFile };
