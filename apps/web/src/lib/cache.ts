import type { OrbitFile } from '@orbit/shared-types';

/**
 * The directory tree, mirrored into IndexedDB.
 *
 * Names, paths, sizes and timestamps — never contents. Opening a folder paints
 * from here immediately and refreshes from the provider behind it, which with
 * several accounts connected is the difference between an instant list and a
 * round trip per account.
 *
 * Everything in here is stale by definition. It decides what to *draw*, never
 * what to *do*: a download, a rename or a delete goes to the provider and
 * reports what the provider says, because the cache's answer would be a guess
 * about a file somebody may have moved on another device.
 */

const DB_NAME = 'orbit-cache';
const DB_VERSION = 1;
const FOLDERS = 'folders';

/** Past this a listing is more likely to mislead than to help. */
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface CachedFolder {
  /** `${accountId}:${path}` — one row per folder per account. */
  key: string;
  accountId: string;
  path: string;
  files: OrbitFile[];
  /** True when the listing was cut short, so it must not be trusted as whole. */
  partial: boolean;
  cachedAt: number;
}

let opening: Promise<IDBDatabase | null> | null = null;

/**
 * Opens the database, once.
 *
 * Returns null rather than throwing where IndexedDB is unavailable — private
 * windows in some browsers, and storage the user has blocked. The cache is an
 * optimisation, so its absence has to be survivable rather than fatal.
 */
function open(): Promise<IDBDatabase | null> {
  if (opening) return opening;

  opening = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(FOLDERS)) {
        const store = database.createObjectStore(FOLDERS, { keyPath: 'key' });
        // Dropping one account's cache on disconnect has to be possible without
        // walking every row.
        store.createIndex('accountId', 'accountId', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });

  return opening;
}

function run<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  return open().then(
    (database) =>
      new Promise<T | null>((resolve) => {
        if (!database) {
          resolve(null);
          return;
        }

        try {
          const transaction = database.transaction(FOLDERS, mode);
          const request = work(transaction.objectStore(FOLDERS));

          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(null);
          transaction.onabort = () => resolve(null);
        } catch {
          // A closed or deleted database throws synchronously; that is not a
          // reason for the folder not to load.
          resolve(null);
        }
      }),
  );
}

const keyOf = (accountId: string, path: string) => `${accountId}:${path}`;

/** The cached listing for a folder, or null when there is none worth using. */
export async function readFolder(
  accountId: string,
  path: string,
): Promise<CachedFolder | null> {
  const row = await run<CachedFolder>('readonly', (store) =>
    store.get(keyOf(accountId, path)) as IDBRequest<CachedFolder>,
  );

  if (!row) return null;

  // Old enough to be misleading. Dropped rather than shown greyed out: a week
  // is long enough for a folder to be unrecognisable.
  if (Date.now() - row.cachedAt > MAX_AGE_MS) {
    void forgetFolder(accountId, path);
    return null;
  }

  return row;
}

export async function writeFolder(
  accountId: string,
  path: string,
  files: OrbitFile[],
  partial = false,
): Promise<void> {
  const row: CachedFolder = {
    key: keyOf(accountId, path),
    accountId,
    path,
    files,
    partial,
    cachedAt: Date.now(),
  };

  await run('readwrite', (store) => store.put(row) as IDBRequest<unknown>);
}

export async function forgetFolder(accountId: string, path: string): Promise<void> {
  await run('readwrite', (store) => store.delete(keyOf(accountId, path)) as IDBRequest<unknown>);
}

/**
 * Everything cached for one account.
 *
 * Called when an account is disconnected: leaving its folders behind would mean
 * a drive that is no longer connected still browsing from a stale copy.
 */
export async function forgetAccount(accountId: string): Promise<void> {
  const database = await open();
  if (!database) return;

  await new Promise<void>((resolve) => {
    try {
      const transaction = database.transaction(FOLDERS, 'readwrite');
      const store = transaction.objectStore(FOLDERS);
      const cursorRequest = store.index('accountId').openKeyCursor(IDBKeyRange.only(accountId));

      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        store.delete(cursor.primaryKey);
        cursor.continue();
      };

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** Wipes the lot. Offered in the account menu, and used when signing out. */
export async function clearCache(): Promise<void> {
  await run('readwrite', (store) => store.clear() as IDBRequest<unknown>);
}

/** How much is cached, for the line in the account menu that offers to clear it. */
export async function cacheSize(): Promise<{ folders: number; files: number }> {
  const database = await open();
  if (!database) return { folders: 0, files: 0 };

  return new Promise((resolve) => {
    try {
      const transaction = database.transaction(FOLDERS, 'readonly');
      const request = transaction.objectStore(FOLDERS).getAll() as IDBRequest<CachedFolder[]>;

      request.onsuccess = () =>
        resolve({
          folders: request.result.length,
          files: request.result.reduce((sum, row) => sum + row.files.length, 0),
        });
      request.onerror = () => resolve({ folders: 0, files: 0 });
    } catch {
      resolve({ folders: 0, files: 0 });
    }
  });
}

/**
 * Every cached file whose name matches, across every account.
 *
 * This is what makes Spotlight feel instant: the provider search still runs and
 * still decides the answer, but something appears while it is in flight. What
 * comes from here is explicitly a subset - only folders that have been opened -
 * so the UI has to say so rather than presenting it as the whole result.
 */
export async function searchCache(
  text: string,
  limit = 30,
): Promise<Array<OrbitFile & { accountId: string }>> {
  if (text.trim() === '') return [];

  const database = await open();
  if (!database) return [];

  const needle = text.toLowerCase();

  return new Promise((resolve) => {
    try {
      const transaction = database.transaction(FOLDERS, 'readonly');
      const request = transaction.objectStore(FOLDERS).getAll() as IDBRequest<CachedFolder[]>;

      request.onsuccess = () => {
        const seen = new Set<string>();
        const hits: Array<OrbitFile & { accountId: string }> = [];

        for (const folder of request.result) {
          for (const file of folder.files) {
            if (hits.length >= limit) break;
            if (!file.name.toLowerCase().includes(needle)) continue;

            // The same file appears in every folder listing that contains it,
            // and once more per account it is cached under.
            const key = `${folder.accountId}:${file.remoteId}`;
            if (seen.has(key)) continue;

            seen.add(key);
            hits.push({ ...file, accountId: folder.accountId });
          }
        }

        resolve(hits);
      };
      request.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}
