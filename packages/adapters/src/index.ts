import type { ProviderAdapter, ProviderId } from '@orbit/shared-types';
import { PROVIDER_IDS } from '@orbit/shared-types';
import { AzureBlobAdapter } from './providers/azure-blob.js';
import { BunnyAdapter } from './providers/bunny.js';
import { DropboxAdapter } from './providers/dropbox.js';
import { GoogleDriveAdapter } from './providers/google-drive.js';
import { MegaAdapter } from './providers/mega.js';
import { OneDriveAdapter } from './providers/onedrive.js';
import { PCloudAdapter } from './providers/pcloud.js';
import { S3CompatibleAdapter } from './providers/s3-compatible.js';

export * from './base.js';
export * from './providers/azure-blob.js';
export * from './providers/bunny.js';
export * from './providers/dropbox.js';
export * from './providers/google-drive.js';
export * from './providers/mega.js';
export * from './providers/onedrive.js';
export * from './providers/pcloud.js';
export * from './providers/s3-compatible.js';

const registry: Record<ProviderId, ProviderAdapter> = {
  google_drive: new GoogleDriveAdapter(),
  onedrive: new OneDriveAdapter(),
  dropbox: new DropboxAdapter(),
  mega: new MegaAdapter(),
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

export function listAdapters(): ProviderAdapter[] {
  return PROVIDER_IDS.map((id) => registry[id]);
}
