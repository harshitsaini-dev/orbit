export type SystemRole = 'user' | 'superadmin';
export type WorkspaceRole = 'owner' | 'editor' | 'viewer';

export const ALLOCATION_STRATEGIES = [
  'round_robin',
  'weighted_round_robin',
  'least_used',
  'most_free',
  'manual',
] as const;
export type AllocationStrategy = (typeof ALLOCATION_STRATEGIES)[number];

export type AppMode = 'local' | 'hosted';
export type ThemeMode = 'light' | 'dark' | 'system';
export type SharePermission = 'view' | 'download';

export interface PublicUser {
  id: string;
  email: string;
  displayName: string | null;
  avatar: string | null;
  role: SystemRole;
  theme: ThemeMode;
  accent: string;
  allocationStrategy: AllocationStrategy;
  createdAt: string;
}

/** Account as exposed over the API — token material is never included. */
export interface PublicAccount {
  id: string;
  provider: string;
  nickname: string;
  usedBytes: number;
  quotaBytes: number;
  priorityOrder: number;
  weight: number;
  status: 'ok' | 'needs_reauth' | 'error';
  lastSyncedAt: string | null;
  /** When the access token was last renewed. Null until the first refresh. */
  lastRefreshedAt: string | null;
  connectedAt: string;
}

export interface ShareLink {
  shortId: string;
  url: string;
  permission: SharePermission;
  expiresAt: string | null;
  accessCount: number;
}
