import { BaseAdapter, type AdapterCapabilities } from '../base.js';
import type { AuthType, ProviderId } from '@orbit/shared-types';

/**
 * S3-compatible adapter.
 * TODO(phase-2/3): implement against the provider API. Until then every call
 * throws NotImplementedError via BaseAdapter.
 */
export class S3CompatibleAdapter extends BaseAdapter {
  readonly id: ProviderId = 's3';
  readonly authType: AuthType = 'access_key';
  readonly displayName = 'S3-compatible';
  readonly capabilities: AdapterCapabilities = {
    star: false,
    sharedWithMe: false,
    delta: false,
    resumableUpload: true,
    rangeRequests: true,
    nativeFolders: false,
    flatEnumeration: true,
    reportsQuota: false,
  };
}
