import { BaseAdapter, type AdapterCapabilities } from '../base.js';
import type { AuthType, ProviderId } from '@orbit/shared-types';

/**
 * OneDrive adapter.
 * TODO(phase-2/3): implement against the provider API. Until then every call
 * throws NotImplementedError via BaseAdapter.
 */
export class OneDriveAdapter extends BaseAdapter {
  readonly id: ProviderId = 'onedrive';
  readonly authType: AuthType = 'oauth';
  readonly displayName = 'OneDrive';
  readonly capabilities: AdapterCapabilities = {
    star: false,
    sharedWithMe: true,
    delta: true,
    resumableUpload: true,
    rangeRequests: true,
  };
}
