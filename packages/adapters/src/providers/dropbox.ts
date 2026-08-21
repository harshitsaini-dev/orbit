import { BaseAdapter, type AdapterCapabilities } from '../base.js';
import type { AuthType, ProviderId } from '@orbit/shared-types';

/**
 * Dropbox adapter.
 * TODO(phase-2/3): implement against the provider API. Until then every call
 * throws NotImplementedError via BaseAdapter.
 */
export class DropboxAdapter extends BaseAdapter {
  readonly id: ProviderId = 'dropbox';
  readonly authType: AuthType = 'oauth';
  readonly displayName = 'Dropbox';
  readonly capabilities: AdapterCapabilities = {
    star: false,
    sharedWithMe: true,
    delta: true,
    resumableUpload: true,
    rangeRequests: true,
    nativeFolders: true,
    search: true,
    fullTextSearch: true,
    recentView: true,
    flatEnumeration: true,
    reportsQuota: true,
  };
}
