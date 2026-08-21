import { BaseAdapter, type AdapterCapabilities } from '../base.js';
import type { AuthType, ProviderId } from '@orbit/shared-types';

/**
 * Google Cloud Storage adapter.
 * Objects, not files: folders are synthesised from key prefixes, and a bucket reports bytes stored rather than an allowance.
 * TODO(phase-3): implement against the provider API. Until then every call
 * throws NotImplementedError via BaseAdapter.
 */
export class GcsAdapter extends BaseAdapter {
  readonly id: ProviderId = 'gcs';
  readonly authType: AuthType = 'access_key';
  readonly displayName = 'Google Cloud Storage';
  readonly capabilities: AdapterCapabilities = {
    star: false,
    sharedWithMe: false,
    delta: false,
    resumableUpload: true,
    rangeRequests: true,
    nativeFolders: false,
    thumbnails: false,
    search: false,
    fullTextSearch: false,
    recentView: false,
    flatEnumeration: true,
    reportsQuota: false,
  };
}
