/**
 * Staging Operation Definition Interface
 *
 * Note on touchesAuth property:
 * touchesAuth=true signifies that the operation directly invokes the Supabase Auth service
 * or Auth Admin API (e.g. creating/linking Auth users, generating invite links, or updating auth.users),
 * NOT merely querying application profile tables (admin_users) or referencing an auth_user_id column.
 */
export interface StagingOperationDefinition {
  id: string;
  type: 'read_only' | 'mutating';
  expectedEffect: string;
  usesFileInput: boolean;
  touchesStorage: boolean;
  touchesAuth: boolean;
  changesDatabaseRows: boolean;
}

export const STAGING_OPERATIONS_REGISTRY: Record<string, StagingOperationDefinition> = {
  'seed-staging-projects': {
    id: 'seed-staging-projects',
    type: 'mutating',
    expectedEffect: 'Deletes matching synthetic public IDs from projects table and inserts synthetic demo project records',
    usesFileInput: false,
    touchesStorage: false,
    touchesAuth: false,
    changesDatabaseRows: true,
  },
  'seed-fake-media-assets': {
    id: 'seed-fake-media-assets',
    type: 'mutating',
    expectedEffect: 'Deletes existing media_assets rows and Storage objects for target demo projects, performs private uploads, promotes assets to public, inserts media_assets database records, and updates project poster/snapshot URLs',
    usesFileInput: false,
    touchesStorage: true,
    touchesAuth: false,
    changesDatabaseRows: true,
  },
  'import-staging-package': {
    id: 'import-staging-package',
    type: 'mutating',
    expectedEffect: 'Reads the committed runtime-import-demo package directory, creates/updates import_batches records, performs existing media cleanup, inserts or updates project rows, performs Storage draft media uploads, and inserts media_assets and validation_flags records',
    usesFileInput: true,
    touchesStorage: true,
    touchesAuth: false,
    changesDatabaseRows: true,
  },
  'publish-staging-feed': {
    id: 'publish-staging-feed',
    type: 'mutating',
    expectedEffect: 'Compiles public feed array, uploads JSON feed artifact to Storage public-feeds bucket, and inserts audit log record into published_snapshots database table',
    usesFileInput: false,
    touchesStorage: true,
    touchesAuth: false,
    changesDatabaseRows: true,
  },
  'link-existing-staging-admin': {
    id: 'link-existing-staging-admin',
    type: 'mutating',
    expectedEffect: 'Executes bootstrap RPC to link an Auth user identity to an admin_users profile record and assign initial admin privileges via Auth service RPC',
    usesFileInput: false,
    touchesStorage: false,
    touchesAuth: true,
    changesDatabaseRows: true,
  },
  'check-staging-projects': {
    id: 'check-staging-projects',
    type: 'read_only',
    expectedEffect: 'Reads projects table and reports counts of projects by status and public showcase eligibility',
    usesFileInput: false,
    touchesStorage: false,
    touchesAuth: false,
    changesDatabaseRows: false,
  },
  'check-media-assets': {
    id: 'check-media-assets',
    type: 'read_only',
    expectedEffect: 'Reads media_assets table and reports counts by asset type, storage bucket, approval status, and storage paths',
    usesFileInput: false,
    touchesStorage: false,
    touchesAuth: false,
    changesDatabaseRows: false,
  },
  'check-staging-auth': {
    id: 'check-staging-auth',
    type: 'read_only',
    expectedEffect: 'Reads application admin_users profile, user_roles assignment, and approval_records audit-attribution linkage records without calling Auth Admin API',
    usesFileInput: false,
    touchesStorage: false,
    touchesAuth: false,
    changesDatabaseRows: false,
  },
  'check-import-batches': {
    id: 'check-import-batches',
    type: 'read_only',
    expectedEffect: 'Reads import_batches table and reports total count and latest batch execution runs',
    usesFileInput: false,
    touchesStorage: false,
    touchesAuth: false,
    changesDatabaseRows: false,
  },
};

export function getStagingOperation(id: string): StagingOperationDefinition {
  const op = STAGING_OPERATIONS_REGISTRY[id];
  if (!op) {
    throw new Error(`Staging Operation Error: Unregistered staging script identifier [${id}].`);
  }
  return op;
}
