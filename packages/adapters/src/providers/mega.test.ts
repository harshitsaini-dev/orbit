import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AccountTokens } from '@orbit/shared-types';
import { ProviderError } from '../base.js';
import { MegaAdapter, megaInternals } from './mega.js';

/**
 * MEGA, against a tree built here rather than a live account.
 *
 * The other adapters are tested by intercepting `fetch`, because they speak
 * HTTP. This one does not: `megajs` holds the whole account as a decrypted tree
 * in memory and every listing, search and path lookup is a walk over it. So the
 * thing worth testing is that walk - the tree is the interface, and a mocked
 * HTTP layer would test the SDK rather than this adapter.
 *
 * What is deliberately not tested here is the SDK itself: logging in, deriving
 * the key, decrypting a stream. That is somebody else's code and it cannot be
 * exercised without a real account and a real password.
 */

const { toOrbitFile, pathOf, folderAt, descend, page, asProviderError } = megaInternals;

/** A node shaped the way `megajs` presents one. */
interface Node {
  nodeId?: string;
  name?: string | null;
  size?: number;
  timestamp?: number;
  directory?: boolean;
  favorited?: boolean;
  parent?: Node;
  children?: Node[];
}

function folder(name: string, children: Node[] = [], id = name): Node {
  const node: Node = {
    nodeId: id,
    name,
    directory: true,
    timestamp: 1_700_000_000,
    children,
  };

  for (const child of children) child.parent = node;
  return node;
}

function file(name: string, size = 100, extra: Partial<Node> = {}): Node {
  return {
    nodeId: `id-${name}`,
    name,
    size,
    directory: false,
    timestamp: 1_700_000_000,
    ...extra,
  };
}

/**
 * A small account: two folders deep, one favourite, one file at the root.
 */
function tree(): Node {
  const invoices = folder('Invoices', [
    file('march.pdf', 2_048),
    file('april.pdf', 4_096, { favorited: true }),
  ]);

  const work = folder('Work', [invoices, file('notes.txt', 12)]);
  const root = folder('Cloud Drive', [work, file('readme.md', 7)], 'root');

  return root;
}

describe('MEGA paths', () => {
  it('builds a path by walking up to the root, which is not part of it', () => {
    const root = tree();
    const invoices = root.children![0]!.children![0]!;
    const march = invoices.children![0]!;

    // The root's own name is MEGA's ("Cloud Drive") and is not somebody's
    // folder, so a path that included it would not match anything they typed.
    assert.equal(pathOf(march as never, root as never), '/Work/Invoices/march.pdf');
    assert.equal(pathOf(root as never, root as never), '/');
  });

  it('walks to a folder by path', () => {
    const root = tree();
    const session = { root } as never;

    assert.equal(folderAt(session, '/Work/Invoices').name, 'Invoices');
    assert.equal(folderAt(session, '/').name, 'Cloud Drive');
    // Trailing slashes and doubles are the same folder.
    assert.equal(folderAt(session, '/Work/').name, 'Work');
  });

  it('says which folder is missing rather than returning nothing', () => {
    const session = { root: tree() } as never;

    assert.throws(
      () => folderAt(session, '/Work/Nowhere'),
      (err: unknown) => err instanceof ProviderError && err.status === 404,
    );
  });

  it('will not walk into a file that shares a folder’s name', () => {
    const session = { root: tree() } as never;

    // notes.txt is not a folder, so this is a miss rather than a match.
    assert.throws(() => folderAt(session, '/Work/notes.txt'), ProviderError);
  });
});

describe('MEGA files', () => {
  it('maps a node into Orbit’s shape', () => {
    const root = tree();
    const readme = root.children![1]!;

    const mapped = toOrbitFile(readme as never, root as never);

    assert.equal(mapped.remoteId, 'id-readme.md');
    assert.equal(mapped.name, 'readme.md');
    assert.equal(mapped.virtualPath, '/readme.md');
    assert.equal(mapped.sizeBytes, 7);
    assert.equal(mapped.isFolder, false);
    // MEGA reports seconds; an ISO string built from them directly would be in
    // 1970.
    assert.equal(mapped.modifiedAt, new Date(1_700_000_000_000).toISOString());
  });

  it('gives a folder no size and its own type', () => {
    const root = tree();
    const mapped = toOrbitFile(root.children![0]! as never, root as never);

    assert.equal(mapped.isFolder, true);
    assert.equal(mapped.sizeBytes, 0);
    assert.equal(mapped.mimeType, 'application/vnd.orbit.folder');
  });

  it('carries the favourite flag through as starred', () => {
    const root = tree();
    const april = root.children![0]!.children![0]!.children![1]!;

    assert.equal(toOrbitFile(april as never, root as never).starred, true);
  });

  it('finds everything beneath a node, depth first', () => {
    const names = descend(tree() as never).map((node) => (node as Node).name);

    assert.deepEqual(names, [
      'Work',
      'Invoices',
      'march.pdf',
      'april.pdf',
      'notes.txt',
      'readme.md',
    ]);
  });
});

describe('MEGA paging', () => {
  it('hands back a cursor only while there is more', () => {
    const root = tree();
    const many = Array.from({ length: 1200 }, (_, i) => file(`f${i}.txt`));

    const first = page(many as never, root as never);
    assert.equal(first.files.length, 500);
    assert.equal(first.nextPageToken, '500');

    const second = page(many as never, root as never, first.nextPageToken);
    assert.equal(second.nextPageToken, '1000');

    const last = page(many as never, root as never, second.nextPageToken);
    assert.equal(last.files.length, 200);
    // Absent rather than empty: a caller loops until it is gone.
    assert.equal(last.nextPageToken, undefined);
  });
});

describe('MEGA failures', () => {
  it('reads a dead session as needing a reconnection', () => {
    for (const message of ['EACCESS', 'ESID', 'session expired']) {
      const err = asProviderError(new Error(message));
      assert.equal(err.status, 401);
    }
  });

  it('reads a full account as out of space, not as a fault', () => {
    assert.equal(asProviderError(new Error('EOVERQUOTA')).status, 507);
  });

  it('passes anything it does not recognise through as the provider’s', () => {
    assert.equal(asProviderError(new Error('something new')).status, 502);
  });
});

describe('MegaAdapter', () => {
  const adapter = new MegaAdapter();

  it('is an email-and-password provider, because MEGA issues no tokens', () => {
    assert.equal(adapter.id, 'mega');
    assert.equal(adapter.authType, 'account_password');
  });

  it('claims only what it can do', () => {
    const can = adapter.capabilities;

    assert.equal(can.star, true);
    assert.equal(can.trash, true);
    assert.equal(can.relocate, true);
    assert.equal(can.rangeRequests, true);

    // A server that cannot read the file cannot draw a picture of it, and a
    // half-supported share is worse than none.
    assert.equal(can.thumbnails, false);
    assert.equal(can.sharedWithMe, false);
    // MEGA takes a file in one piece and needs the size first.
    assert.equal(can.resumableUpload, false);
    assert.equal(can.delta, false);
  });

  it('refuses an OAuth connect, which MEGA has no such thing as', async () => {
    await assert.rejects(
      () => adapter.connect({ kind: 'oauth', code: 'x', redirectUri: 'y' }),
      (err: unknown) => err instanceof ProviderError && err.status === 400,
    );
  });

  it('refuses a connect with half the credentials', async () => {
    await assert.rejects(
      () => adapter.connect({ kind: 'credentials', values: { username: 'a@b.c' } }),
      (err: unknown) =>
        err instanceof ProviderError && /email and password/i.test(err.userMessage ?? ''),
    );
  });

  it('refuses to copy within an account rather than doing it the slow way', async () => {
    const tokens: AccountTokens = { accessToken: 'not-json' };

    /*
     * MEGA has no server-side copy: a file is one encrypted object, and a
     * second copy means uploading a second one. Refusing is better than a
     * button labelled Copy that quietly downloads and re-uploads.
     */
    await assert.rejects(
      () => adapter.relocate(tokens, 'id', '/somewhere', { copy: true }),
      ProviderError,
    );
  });

  it('asks for a reconnection when the stored session is not a session', async () => {
    await assert.rejects(
      () => adapter.listFolder({ accessToken: 'not-json' }, '/'),
      (err: unknown) => err instanceof ProviderError && err.status === 401,
    );
  });

  it('asks for a reconnection when there is nothing stored at all', async () => {
    await assert.rejects(
      () => adapter.listFolder({}, '/'),
      (err: unknown) => err instanceof ProviderError && err.status === 401,
    );
  });
});
