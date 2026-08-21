import { BaseAdapter, type AdapterCapabilities } from '../base.js';
import type { AuthType, ProviderId } from '@orbit/shared-types';

/**
 * MEGA adapter.
 * TODO(phase-2/3): implement against the provider API. Until then every call
 * throws NotImplementedError via BaseAdapter.
 */
export class MegaAdapter extends BaseAdapter {
  readonly id: ProviderId = 'mega';
  readonly authType: AuthType = 'account_password';
  readonly displayName = 'MEGA';
  readonly capabilities: AdapterCapabilities = {
    star: false,
    sharedWithMe: false,
    delta: false,
    resumableUpload: true,
    rangeRequests: true,
  };
}
