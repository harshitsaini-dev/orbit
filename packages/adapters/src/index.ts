import { BaseAdapter } from './base.js';
import type { ProviderAdapter, ProviderId } from '@orbit/shared-types';
import { PROVIDER_IDS } from '@orbit/shared-types';
import { AzureBlobAdapter } from './providers/azure-blob.js';
import { BunnyAdapter } from './providers/bunny.js';
import { DropboxAdapter } from './providers/dropbox.js';
import { GoogleDriveAdapter } from './providers/google-drive.js';
import { OneDriveAdapter } from './providers/onedrive.js';
import { PCloudAdapter } from './providers/pcloud.js';
import { S3CompatibleAdapter } from './providers/s3-compatible.js';

export * from './base.js';
export * from './providers/azure-blob.js';
export * from './providers/bunny.js';
export * from './providers/dropbox.js';
export * from './providers/google-drive.js';
export * from './providers/onedrive.js';
export * from './providers/pcloud.js';
export * from './providers/s3-compatible.js';

const registry: Record<ProviderId, ProviderAdapter> = {
  google_drive: new GoogleDriveAdapter(),
  onedrive: new OneDriveAdapter(),
  dropbox: new DropboxAdapter(),
  pcloud: new PCloudAdapter(),
  azure_blob: new AzureBlobAdapter(),
  bunny: new BunnyAdapter(),
  s3: new S3CompatibleAdapter(),
};

export function getAdapter(provider: ProviderId): ProviderAdapter {
  const adapter = registry[provider];
  if (!adapter) throw new Error(`Unknown provider: ${provider}`);
  return adapter;
}

/**
 * Whether an adapter is actually built, rather than a scaffold.
 *
 * Derived by asking whether it overrides the two methods nothing works
 * without: connecting, and listing a folder. A scaffold inherits the base's
 * stubs, which throw.
 *
 * This replaced a hand-written list of connectable providers, which is the
 * sixth thing in this codebase to have drifted from what it described - Azure
 * and Bunny were implemented and still missing from the connect screen because
 * nobody had remembered to add them to it. Derived, that cannot happen: an
 * adapter is offered exactly when it works.
 */
export function isImplemented(provider: ProviderId): boolean {
  const adapter = registry[provider];
  if (!adapter) return false;

  return (
    adapter.connect !== BaseAdapter.prototype.connect &&
    adapter.listFolder !== BaseAdapter.prototype.listFolder
  );
}

export function listAdapters(): ProviderAdapter[] {
  return PROVIDER_IDS.map((id) => registry[id]);
}
