import { accounts, collectionItems, collections } from '@orbit/db';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../lib/db.js';
import { useAccount } from './accounts.js';

/**
 * Virtual folders.
 *
 * Providers give you a hierarchy; people want tags. A collection groups files
 * from any number of accounts by reference, so nothing moves and nothing is
 * copied — which is the only way to do it while Orbit stores no file bytes.
 */

export interface CollectionSummary {
  id: string;
  name: string;
  colour: string | null;
  itemCount: number;
  /** What the collection points at, added up. */
  totalBytes: number;
  /**
   * Which services it spans, for the icons on the card.
   *
   * A collection's whole point is holding files from more than one place, so
   * the card says which without having to open it.
   */
  services: string[];
  createdAt: string;
}

export interface CollectionItem {
  id: string;
  accountId: string;
  /** Which account it lives in, for the badge on each row. */
  accountNickname: string;
  provider: string;
  catalogueKey: string | null;
  name: string;
  mimeType: string;
  sizeBytes: number;
  isFolder: boolean;
  virtualPath: string;
  addedAt: string;
  /**
   * Whether the file is still where it was.
   *
   * Only known after a check, which is why it is optional: a listing does not
   * ask every provider about every item, but opening one item does.
   */
  missing?: boolean;
}

export async function listCollections(userId: string): Promise<CollectionSummary[]> {
  const rows = await db()
    .select()
    .from(collections)
    .where(eq(collections.ownerId, userId))
    .orderBy(desc(collections.createdAt));

  if (rows.length === 0) return [];

  // One query for every summary rather than one per collection: fifty
  // collections would otherwise be fifty round trips to draw a list of cards.
  const items = await db()
    .select({
      collectionId: collectionItems.collectionId,
      sizeBytes: collectionItems.sizeBytes,
      catalogueKey: accounts.catalogueKey,
      provider: accounts.provider,
    })
    .from(collectionItems)
    .innerJoin(accounts, eq(accounts.id, collectionItems.accountId))
    .where(
      inArray(
        collectionItems.collectionId,
        rows.map((row) => row.id),
      ),
    );

  const summaries = new Map<string, { count: number; bytes: number; services: Set<string> }>();

  for (const item of items) {
    const current = summaries.get(item.collectionId) ?? {
      count: 0,
      bytes: 0,
      services: new Set<string>(),
    };

    current.count += 1;
    current.bytes += item.sizeBytes;
    current.services.add(item.catalogueKey ?? item.provider);
    summaries.set(item.collectionId, current);
  }

  return rows.map((row) => {
    const summary = summaries.get(row.id);
    return {
      id: row.id,
      name: row.name,
      colour: row.colour,
      itemCount: summary?.count ?? 0,
      totalBytes: summary?.bytes ?? 0,
      services: [...(summary?.services ?? [])],
      createdAt: row.createdAt,
    };
  });
}

export async function createCollection(
  userId: string,
  name: string,
  colour?: string,
): Promise<CollectionSummary> {
  const [row] = await db()
    .insert(collections)
    .values({ id: nanoid(), ownerId: userId, name, colour: colour ?? null })
    .returning();

  if (!row) throw new Error('Failed to create collection');

  return {
    id: row.id,
    name: row.name,
    colour: row.colour,
    itemCount: 0,
    totalBytes: 0,
    services: [],
    createdAt: row.createdAt,
  };
}

export async function renameCollection(
  userId: string,
  id: string,
  name: string,
): Promise<boolean> {
  const [row] = await db()
    .update(collections)
    .set({ name })
    .where(and(eq(collections.id, id), eq(collections.ownerId, userId)))
    .returning();

  return Boolean(row);
}

export async function deleteCollection(userId: string, id: string): Promise<boolean> {
  const [row] = await db()
    .delete(collections)
    .where(and(eq(collections.id, id), eq(collections.ownerId, userId)))
    .returning();

  return Boolean(row);
}

/** The items in one collection, with the account each came from. */
export async function readCollection(
  userId: string,
  id: string,
): Promise<{ collection: CollectionSummary; items: CollectionItem[] } | null> {
  const [row] = await db()
    .select()
    .from(collections)
    .where(and(eq(collections.id, id), eq(collections.ownerId, userId)))
    .limit(1);

  if (!row) return null;

  const items = await db()
    .select({
      item: collectionItems,
      nickname: accounts.nickname,
      provider: accounts.provider,
      catalogueKey: accounts.catalogueKey,
    })
    .from(collectionItems)
    .innerJoin(accounts, eq(accounts.id, collectionItems.accountId))
    .where(eq(collectionItems.collectionId, id))
    .orderBy(asc(collectionItems.name));

  return {
    collection: {
      id: row.id,
      name: row.name,
      colour: row.colour,
      itemCount: items.length,
      totalBytes: items.reduce((sum, { item }) => sum + item.sizeBytes, 0),
      services: [
        ...new Set(items.map(({ catalogueKey, provider }) => catalogueKey ?? provider)),
      ],
      createdAt: row.createdAt,
    },
    items: items.map(({ item, nickname, provider, catalogueKey }) => ({
      id: item.id,
      accountId: item.accountId,
      accountNickname: nickname,
      provider,
      catalogueKey,
      name: item.name,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
      isFolder: item.isFolder,
      virtualPath: item.virtualPath,
      addedAt: item.addedAt,
    })),
  };
}

/**
 * Adds a file by reference, with a snapshot of what it is.
 *
 * The snapshot comes from the provider once, here — rendering a collection that
 * spans five accounts would otherwise be five round trips before a single row
 * appears.
 */
export async function addToCollection(
  userId: string,
  collectionId: string,
  accountId: string,
  remoteId: string,
  /**
   * The path the caller was looking at.
   *
   * A provider's own metadata call returns the file, not the walk to it - Drive
   * would need a request per ancestor to say where it is. The caller was
   * standing in that folder, so it knows for free, and the adapter's answer is
   * the fallback rather than the source.
   */
  virtualPath?: string,
): Promise<CollectionItem | null> {
  const [owned] = await db()
    .select({ id: collections.id })
    .from(collections)
    .where(and(eq(collections.id, collectionId), eq(collections.ownerId, userId)))
    .limit(1);

  if (!owned) return null;

  const active = await useAccount(userId, accountId, 'read');
  if (!active) return null;

  const file = await active.adapter.getFileMeta(active.tokens, remoteId);

  const [inserted] = await db()
    .insert(collectionItems)
    .values({
      id: nanoid(),
      collectionId,
      accountId,
      remoteId,
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      isFolder: file.isFolder,
      virtualPath: virtualPath ?? file.virtualPath,
    })
    // Adding the same file twice is what someone does when they forget they
    // already did; refreshing the snapshot is more useful than an error.
    .onConflictDoUpdate({
      target: [collectionItems.collectionId, collectionItems.accountId, collectionItems.remoteId],
      set: {
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        virtualPath: virtualPath ?? file.virtualPath,
      },
    })
    .returning();

  if (!inserted) return null;

  return {
    id: inserted.id,
    accountId,
    accountNickname: active.row.nickname,
    provider: active.row.provider,
    catalogueKey: active.row.catalogueKey ?? null,
    name: inserted.name,
    mimeType: inserted.mimeType,
    sizeBytes: inserted.sizeBytes,
    isFolder: inserted.isFolder,
    virtualPath: inserted.virtualPath,
    addedAt: inserted.addedAt,
  };
}

/**
 * Removes the reference, never the file.
 *
 * Worth being explicit about: this is the one destructive-looking action in a
 * collection that is not destructive at all.
 */
export async function removeFromCollection(
  userId: string,
  collectionId: string,
  itemId: string,
): Promise<boolean> {
  const [owned] = await db()
    .select({ id: collections.id })
    .from(collections)
    .where(and(eq(collections.id, collectionId), eq(collections.ownerId, userId)))
    .limit(1);

  if (!owned) return false;

  const [removed] = await db()
    .delete(collectionItems)
    .where(and(eq(collectionItems.id, itemId), eq(collectionItems.collectionId, collectionId)))
    .returning();

  return Boolean(removed);
}
