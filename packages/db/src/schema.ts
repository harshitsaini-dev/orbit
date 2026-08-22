import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    displayName: text('display_name'),
    /** Small square PNG/JPEG as a data URL. App data, not a user file. */
    avatar: text('avatar'),
    role: text('role', { enum: ['user', 'superadmin'] }).notNull().default('user'),
    theme: text('theme', { enum: ['light', 'dark', 'system'] }).notNull().default('system'),
    accent: text('accent').notNull().default('#6c8cff'),
    language: text('language').notNull().default('en'),
    allocationStrategy: text('allocation_strategy', {
      enum: ['round_robin', 'weighted_round_robin', 'least_used', 'most_free', 'manual'],
    })
      .notNull()
      .default('round_robin'),
    /** Rotation cursor for round_robin / weighted_round_robin. */
    allocationCursor: integer('allocation_cursor').notNull().default(0),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [uniqueIndex('users_email_uq').on(t.email)],
);

export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider', {
      enum: ['google_drive', 'onedrive', 'dropbox', 'mega', 'pcloud', 'gcs', 'azure_blob', 'bunny', 's3'],
    }).notNull(),
    nickname: text('nickname').notNull(),
    /**
     * The provider's own identifier for the connected account (an email for the
     * OAuth providers). Reconnecting - which happens whenever a grant expires -
     * has to update the existing connection rather than add a second identical
     * one, and this is what makes the two tellable apart. Null where the
     * provider gives us nothing stable; SQLite treats those as distinct, so
     * such connections simply never deduplicate.
     */
    remoteAccountId: text('remote_account_id'),
    /** Which catalogue entry the user picked - several map onto the s3 adapter. */
    catalogueKey: text('catalogue_key'),
    /** AES-256-GCM ciphertext of the AccountTokens JSON. Never logged, never returned by the API. */
    encryptedTokens: text('encrypted_tokens').notNull(),
    /** S3-compatible connections only. */
    s3Endpoint: text('s3_endpoint'),
    s3Bucket: text('s3_bucket'),
    s3Region: text('s3_region'),
    usedBytes: real('used_bytes').notNull().default(0),
    quotaBytes: real('quota_bytes').notNull().default(0),
    /** Bytes uploaded through Orbit - drives the least_used strategy. */
    uploadedViaOrbitBytes: real('uploaded_via_orbit_bytes').notNull().default(0),
    priorityOrder: integer('priority_order').notNull().default(0),
    weight: integer('weight').notNull().default(1),
    status: text('status', { enum: ['ok', 'needs_reauth', 'error'] }).notNull().default('ok'),
    deltaCursor: text('delta_cursor'),
    lastSyncedAt: text('last_synced_at'),
    lastRefreshedAt: text('last_refreshed_at'),
    connectedAt: text('connected_at').notNull().default(now),
  },
  (t) => [
    index('accounts_user_idx').on(t.userId),
    uniqueIndex('accounts_remote_uq').on(t.userId, t.provider, t.remoteAccountId),
  ],
);

export const filesMirror = sqliteTable(
  'files_mirror',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    remoteFileId: text('remote_file_id').notNull(),
    parentRemoteId: text('parent_remote_id'),
    virtualPath: text('virtual_path').notNull(),
    name: text('name').notNull(),
    mimeType: text('mime_type').notNull().default('application/octet-stream'),
    sizeBytes: real('size_bytes').notNull().default(0),
    isFolder: integer('is_folder', { mode: 'boolean' }).notNull().default(false),
    starred: integer('starred', { mode: 'boolean' }).notNull().default(false),
    trashed: integer('trashed', { mode: 'boolean' }).notNull().default(false),
    sharedWithMe: integer('shared_with_me', { mode: 'boolean' }).notNull().default(false),
    checksum: text('checksum'),
    modifiedAt: text('modified_at'),
    syncedAt: text('synced_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('files_account_remote_uq').on(t.accountId, t.remoteFileId),
    index('files_path_idx').on(t.accountId, t.virtualPath),
    index('files_modified_idx').on(t.modifiedAt),
    index('files_starred_idx').on(t.starred),
  ],
);

/**
 * A public link to one file.
 *
 * Keyed on the account and the provider's own id rather than on a row in the
 * mirror: the mirror is filled by the sync engine, so a link that depended on
 * it could not be made for a file the owner is looking at right now - which is
 * the only moment anyone wants to share something.
 *
 * The name, type and size are copied in rather than read from the provider on
 * every view. A share page is public and can be opened by anyone any number of
 * times; fetching metadata each time would turn a link into a way to make Orbit
 * hammer someone's Drive.
 */
export const shareLinks = sqliteTable(
  'share_links',
  {
    shortId: text('short_id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    remoteId: text('remote_id').notNull(),

    /** Snapshot taken when the link was made. */
    name: text('name').notNull(),
    mimeType: text('mime_type').notNull().default('application/octet-stream'),
    sizeBytes: real('size_bytes').notNull().default(0),

    /** `view` shows it in the page; `download` also offers the file itself. */
    permission: text('permission', { enum: ['view', 'download'] }).notNull().default('download'),
    /** scrypt, as everywhere else here. Null when the link has no password. */
    passwordHash: text('password_hash'),
    expiresAt: text('expires_at'),
    accessCount: integer('access_count').notNull().default(0),
    lastAccessedAt: text('last_accessed_at'),
    revokedAt: text('revoked_at'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [
    index('share_owner_idx').on(t.ownerId),
    // Reused when the same file is shared twice, so one file has one link
    // rather than a new one per click.
    index('share_target_idx').on(t.accountId, t.remoteId),
  ],
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    expiresAt: text('expires_at').notNull(),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [uniqueIndex('sessions_token_uq').on(t.tokenHash), index('sessions_user_idx').on(t.userId)],
);

export const otpCodes = sqliteTable(
  'otp_codes',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    codeHash: text('code_hash').notNull(),
    attempts: integer('attempts').notNull().default(0),
    consumedAt: text('consumed_at'),
    expiresAt: text('expires_at').notNull(),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('otp_email_idx').on(t.email)],
);

export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  ownerId: text('owner_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').notNull().default(now),
});

export const workspaceMembers = sqliteTable(
  'workspace_members',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['owner', 'editor', 'viewer'] }).notNull().default('viewer'),
    addedAt: text('added_at').notNull().default(now),
  },
  (t) => [uniqueIndex('workspace_member_uq').on(t.workspaceId, t.userId)],
);

export const syncLog = sqliteTable(
  'sync_log',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['ok', 'error'] }).notNull(),
    deltaCount: integer('delta_count').notNull().default(0),
    durationMs: integer('duration_ms').notNull().default(0),
    message: text('message'),
    ranAt: text('ran_at').notNull().default(now),
  },
  (t) => [index('sync_account_idx').on(t.accountId, t.ranAt)],
);

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    metadata: text('metadata'),
    ip: text('ip'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('audit_actor_idx').on(t.actorId, t.createdAt)],
);
