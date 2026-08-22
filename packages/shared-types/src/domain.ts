export type SystemRole = 'user' | 'superadmin';
export type WorkspaceRole = 'owner' | 'editor' | 'viewer';

export const ALLOCATION_STRATEGIES = [
  'round_robin',
  'weighted_round_robin',
  'least_used',
  'most_free',
  'manual',
  /**
   * Do not pick at all - ask.
   *
   * The right answer for somebody who keeps work and personal storage apart:
   * any rule Orbit could follow would sometimes put a file in the wrong one,
   * and a file in the wrong cloud is a nuisance to notice and a nuisance to
   * undo.
   */
  'ask',
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
  /**
   * Which catalogue entry this connection was made from. Five entries run on
   * the s3 adapter, so `provider` alone cannot tell an R2 bucket from a
   * Backblaze one - and the UI has to name and badge them differently.
   */
  catalogueKey: string | null;
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
  /**
   * Whether this drive belongs to the person asking, or was granted to them.
   * An owner always has full say over their own connection.
   */
  isOwner: boolean;
  /**
   * How far the caller may go with it. Describes the relationship, not the
   * drive - the same connection is `admin` to its owner and `read` to a guest.
   */
  accessLevel: AccessLevel;
}

/** Ordered, least to most. Each level contains the ones before it. */
export type AccessLevel = 'read' | 'write' | 'full' | 'admin';

/** Somebody who has been given access to one drive. */
export interface DriveMember {
  userId: string;
  email: string;
  displayName: string | null;
  avatar: string | null;
  level: AccessLevel;
  /** Null until they have signed in for the first time. */
  joinedAt: string | null;
  invitedAt: string;
}

export interface ShareLink {
  shortId: string;
  url: string;
  permission: SharePermission;
  expiresAt: string | null;
  accessCount: number;
}
