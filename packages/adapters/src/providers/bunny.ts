import { BaseAdapter, type AdapterCapabilities } from '../base.js';
import type { AuthType, ProviderId } from '@orbit/shared-types';

/**
 * Bunny Storage adapter.
 * Bunny Edge Storage speaks its own REST API rather than S3, and has no multipart upload.
 * TODO(phase-3): implement against the provider API. Until then every call
 * throws NotImplementedError via BaseAdapter.
 */
export class BunnyAdapter extends BaseAdapter {
  readonly id: ProviderId = 'bunny';
  readonly authType: AuthType = 'access_key';
  readonly displayName = 'Bunny Storage';
  readonly capabilities: AdapterCapabilities = {
    star: false,
    sharedWithMe: false,
    delta: false,
    resumableUpload: false,
    rangeRequests: true,
    nativeFolders: true,
    relocate: false,
    thumbnails: false,
    search: false,
    fullTextSearch: false,
    recentView: false,
    flatEnumeration: false,
    reportsQuota: false,
  };
}
