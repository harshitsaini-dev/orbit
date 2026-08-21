import { BaseAdapter, type AdapterCapabilities } from '../base.js';
import type { AuthType, ProviderId } from '@orbit/shared-types';

/**
 * pCloud adapter.
 * TODO(phase-2/3): implement against the provider API. Until then every call
 * throws NotImplementedError via BaseAdapter.
 */
export class PCloudAdapter extends BaseAdapter {
  readonly id: ProviderId = 'pcloud';
  readonly authType: AuthType = 'oauth';
  readonly displayName = 'pCloud';
  readonly capabilities: AdapterCapabilities = {
    star: false,
    sharedWithMe: true,
    delta: true,
    resumableUpload: true,
    rangeRequests: true,
    nativeFolders: true,
    flatEnumeration: false,
    reportsQuota: true,
  };
}
