import { BaseAdapter, type AdapterCapabilities } from '../base.js';
import type { AuthType, ProviderId } from '@orbit/shared-types';

/**
 * Azure Blob Storage adapter.
 * Blobs in a single container. Virtual directories come from the blob name.
 * TODO(phase-3): implement against the provider API. Until then every call
 * throws NotImplementedError via BaseAdapter.
 */
export class AzureBlobAdapter extends BaseAdapter {
  readonly id: ProviderId = 'azure_blob';
  readonly authType: AuthType = 'access_key';
  readonly displayName = 'Azure Blob Storage';
  readonly capabilities: AdapterCapabilities = {
    star: false,
    sharedWithMe: false,
    delta: false,
    resumableUpload: true,
    rangeRequests: true,
    nativeFolders: false,
    trash: false,
    purgeTrash: false,
    relocate: false,
    thumbnails: false,
    search: false,
    fullTextSearch: false,
    recentView: false,
    flatEnumeration: true,
    reportsQuota: false,
  };
}
