import { PassThrough, Readable } from 'node:stream';
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
 * password itself. So the password is used once, at connect, to open a session -
 * a session id and the derived master key - and that session is what Orbit
 * stores, encrypted like every other credential. The password is not among the
 * fields written down. It matters: a session appears in MEGA's own *Session
 * history* and can be killed from there, which a stored password could not be.
 *
 * Two mistakes were made here and are worth leaving on the record, because both
 * looked correct and neither announced itself:
 *
 * `Storage.toJSON()` returns the *constructor options* alongside the session -
 * and at connect those hold the password. Storing its output wholesale wrote
 * the password into the database while three comments and a form said it was
 * discarded. `SessionShape` now names every field that is kept, so adding one
 * has to be deliberate.
 *
 * And `Storage.close()` is not a disconnect - it sends MEGA `a: "sml"`, a
 * logout, which ends the session id being stored. Closing after export left a
 * connection that worked once and then answered "no permission" for ever. Use
 * `release`, which aborts the request and lets the object go.
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

/**
 * What Orbit stores for a MEGA account, and deliberately all of it.
 *
 * Built by hand rather than taken from `Storage.toJSON()`. That method returns
 * the options the Storage was constructed with - which, at connect, is the
 * email *and the password*. Storing its output wholesale wrote the password
 * into the database, encrypted at rest but present, while three comments and a
 * form said it was discarded. Naming every field here is what makes that
 * impossible to do by accident again.
 */
interface SessionShape {
  /** The master key, base64. Decrypts the file keys. */
  key: string;
  /** The session id. Appears in MEGA's Session history and can be killed there. */
  sid: string;
  name?: string;
  user?: string;
  /**
   * Kept because `fromJSON` does not restore it, and without it the connection
   * is labelled "MEGA" rather than with the address it belongs to.
   */
  email?: string;
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
  copyTo: (target: Node) => Promise<Node>;
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
  toJSON: () => { key: string; sid: string; name?: string; user?: string };
  /** Aborts what is in flight. Not a logout - see `release`. */
  api?: { close: () => void };
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
 * The size Orbit hands over at a time.
 *
 * Not a MEGA constraint. The upload is opened once, at the size the caller
 * declared, and the chunks are written into it as they arrive - so this governs
 * how often progress moves and nothing else. It used to govern how much of the
 * file sat in memory, which is why it mattered rather more.
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

/**
 * Lets go of a session without ending it.
 *
 * Not `Storage.close()`. That sends MEGA `a: "sml"` - a logout - which kills
 * the very session id Orbit has stored, so the connection worked once and then
 * answered "no permission" for ever afterwards. This aborts the outstanding
 * request and drops the object; the session stays alive at MEGA until somebody
 * ends it there.
 */
function release(session: Session): void {
  try {
    session.api?.close();
  } catch {
    // Nothing in flight, which is the ordinary case.
  }
}

/** Drops every cached session. For tests, and for a clean shutdown. */
export function closeMegaSessions(): void {
  for (const entry of cache.values()) release(entry.session);
  cache.clear();
}

async function open(tokens: AccountTokens): Promise<Session> {
  const key = cacheKey(tokens);
  if (!key) throw new ProviderError('mega', 401, 'This MEGA account is not connected');

  const held = cache.get(key);
  if (held && Date.now() - held.at < SESSION_TTL_MS) return held.session;
  if (held) release(held.session);

  let shape: SessionShape;
  try {
    shape = JSON.parse(key) as SessionShape;
  } catch {
    throw new ProviderError('mega', 401, 'This MEGA connection needs setting up again');
  }

  try {
    /*
     * A fresh `options` object every time. `fromJSON` calls `Object.assign` on
     * whatever it is handed and keeps the result, so passing the same one twice
     * would have the second session inherit the first's mutations - and
     * omitting it entirely throws, because `Object.assign(undefined, …)` does.
     */
    const session = Storage.fromJSON({
      key: shape.key,
      sid: shape.sid,
      name: shape.name,
      user: shape.user,
      options: {},
    } as never) as unknown as Session;

    // Not restored by `fromJSON`, and it is how the connection is named.
    if (shape.email) session.email = shape.email;

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
    /*
     * An interrupted MEGA upload starts again; there is nothing to resume into.
     * That is not the same as buffering it - the file is streamed through, so
     * this costs restarts rather than memory.
     */
    resumableUpload: false,
    rangeRequests: true,
    nativeFolders: true,
    trash: true,
    purgeTrash: true,
    relocate: true,
    reportsQuota: true,
    flatEnumeration: true,
    recentView: true,
    /*
     * False means "the provider does not render them", not "there are none".
     *
     * MEGA cannot draw a thumbnail because MEGA cannot read the file - that is
     * the point of it. Orbit can: it holds the key, so it fetches a prefix,
     * decrypts it and renders the tile itself, exactly as it does for an object
     * store. This flag is what routes it down that path.
     */
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
    // MEGA's own two-factor code, when the account has it turned on.
    const code = input.values.totpCode?.trim();

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
        // MEGA calls it that; it is the six digits from an authenticator app.
        ...(code ? { secondFactorCode: code } : {}),
        // The tree is loaded here anyway, and connecting without checking the
        // account can be read would accept a password that is not enough.
        autoload: true,
        keepalive: false,
      }).ready) as unknown as Session;

      const exported = session.toJSON();

      /*
       * Field by field, and the password is not among them.
       *
       * `toJSON()` also returns the constructor options - which hold the
       * password - so handing its result straight to the database wrote the
       * password down while the form promised it would not be.
       */
      const shape: SessionShape = {
        key: exported.key,
        sid: exported.sid,
        ...(exported.name ? { name: exported.name } : {}),
        ...(exported.user ? { user: exported.user } : {}),
        email,
      };

      // Released rather than closed. Closing logs the session out at MEGA, and
      // the session is the thing being kept.
      release(session);

      return { accessToken: JSON.stringify(shape) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      /*
       * A missing or wrong two-factor code, which MEGA answers with EMFAREQUIRED
       * or EFAILED. Worth its own sentence: "wrong password" sends somebody to
       * reset a password that was correct.
       */
      if (/EMFAREQUIRED|EFAILED|two.?factor|mfa/i.test(message)) {
        throw new ProviderError(
          'mega',
          401,
          'two-factor code required or wrong',
          code
            ? 'That two-factor code was not accepted. Codes expire in seconds - try the next one.'
            : 'This MEGA account has two-factor authentication on. Add the six-digit code from your authenticator app.',
        );
      }

      // The one failure worth naming, because it is the one people cause.
      if (/EARGS|ENOENT|wrong password|EBLOCKED/i.test(message)) {
        throw new ProviderError(
          'mega',
          401,
          'credentials refused',
          'MEGA refused that email and password.',
        );
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
     * Both are one request and neither moves a byte.
     *
     * A copy adds a second node pointing at the same stored object, with the
     * file key re-wrapped for its new parent - so copying a two-gigabyte video
     * is as cheap as copying an empty file. That is worth knowing, because the
     * obvious assumption about an end-to-end encrypted store is the opposite.
     */
    try {
      if (!options.copy) {
        await node.moveTo(target);
        return toOrbitFile(node, session.root);
      }

      const placed = await node.copyTo(target);

      /*
       * Reloaded, then looked up again.
       *
       * The copy is a node the tree in memory has never seen, and the object
       * `copyTo` hands back is not wired into it - so its parent chain is
       * empty and the path built from it would be a bare filename at the root.
       */
      await session.reload();
      const fresh = placed.nodeId ? (session.files[placed.nodeId] ?? placed) : placed;

      return toOrbitFile(fresh, session.root);
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
   * Uploaded as it arrives, not collected and then sent.
   *
   * MEGA wants the length before the first byte, which is the whole reason
   * this looked like it had to be buffered - but Orbit is told the length at
   * `initUpload` too. So the upload is opened there at the declared size, and
   * each chunk is written straight into it. A two-gigabyte file costs one chunk
   * of memory rather than two gigabytes of it.
   *
   * `resumableUpload` stays false, and honestly: an interrupted MEGA upload
   * cannot be picked up where it stopped. It has to start again. That is a
   * different thing from holding the file in memory, and only the second one
   * was ever fixable here.
   */
  override async initUpload(
    tokens: AccountTokens,
    path: string,
    meta: UploadMeta,
  ): Promise<UploadSession> {
    const session = await open(tokens);
    const folder = folderAt(session, normalisePath(path));

    const body = new PassThrough();

    // Started now and awaited at the end. MEGA reads the stream as Orbit
    // writes it, so the two run together rather than one after the other.
    const upload = folder.upload({ name: meta.name, size: meta.sizeBytes }, body).complete;

    // An upload nobody finishes would otherwise leave MEGA holding a request
    // open for a stream that never ends.
    upload.catch(() => body.destroy());

    return {
      provider: this.id,
      // No provider-side handle to remember: the open stream is the session.
      remoteSessionId: joinPath(normalisePath(path), meta.name),
      chunkSize: UPLOAD_CHUNK,
      state: { tokens, body, upload, written: 0, size: meta.sizeBytes },
    };
  }

  override async uploadChunk(
    session: UploadSession,
    chunk: Uint8Array,
    onProgress: (uploadedBytes: number) => void,
  ): Promise<{ done: boolean; file?: OrbitFile }> {
    const state = session.state as unknown as {
      tokens: AccountTokens;
      body: PassThrough;
      upload: Promise<Node>;
      written: number;
      size: number;
    };

    try {
      // Waits when MEGA is slower than the browser, which is what stops a fast
      // uploader filling memory with what a slow connection has not taken yet.
      if (!state.body.write(Buffer.from(chunk))) {
        await new Promise<void>((resolve) => state.body.once('drain', resolve));
      }
    } catch (err) {
      throw asProviderError(err);
    }

    state.written += chunk.byteLength;
    onProgress(chunk.byteLength);

    if (state.written < state.size) return { done: false };

    state.body.end();

    try {
      const uploaded = await state.upload;
      const live = await open(state.tokens);

      // The tree in memory predates the upload, so the new node is not in it.
      await live.reload();

      return { done: true, file: toOrbitFile(uploaded, live.root) };
    } catch (err) {
      state.body.destroy();
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
