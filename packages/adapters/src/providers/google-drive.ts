import { BaseAdapter, type AdapterCapabilities } from '../base.js';
import type { AuthType, ProviderId } from '@orbit/shared-types';

/**
 * Google Drive adapter.
 * TODO(phase-2/3): implement against the provider API. Until then every call
 * throws NotImplementedError via BaseAdapter.
 */
export class GoogleDriveAdapter extends BaseAdapter {
  readonly id: ProviderId = 'google_drive';
  readonly authType: AuthType = 'oauth';
  readonly displayName = 'Google Drive';
  readonly capabilities: AdapterCapabilities = {
    star: true,
    sharedWithMe: true,
    delta: true,
    resumableUpload: true,
    rangeRequests: true,
    nativeFolders: true,
    reportsQuota: true,
  };
}
