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
    expectedEffect: 'Upserts synthetic demo projects into the database',
    usesFileInput: false,
    touchesStorage: false,
    touchesAuth: false,
    changesDatabaseRows: true,
  },
  'seed-fake-media-assets': {
    id: 'seed-fake-media-assets',
    type: 'mutating',
    expectedEffect: 'Uploads synthetic media files to Storage and inserts media_assets database records',
    usesFileInput: false,
    touchesStorage: true,
    touchesAuth: false,
    changesDatabaseRows: true,
  },
  'import-staging-package': {
    id: 'import-staging-package',
    type: 'mutating',
    expectedEffect: 'Imports an admin package zip file into projects and media_assets',
    usesFileInput: true,
    touchesStorage: true,
    touchesAuth: false,
    changesDatabaseRows: true,
  },
  'publish-staging-feed': {
    id: 'publish-staging-feed',
    type: 'mutating',
    expectedEffect: 'Compiles and uploads the public project feed to Storage public-feeds bucket',
    usesFileInput: false,
    touchesStorage: true,
    touchesAuth: false,
    changesDatabaseRows: false,
  },
  'link-existing-staging-admin': {
    id: 'link-existing-staging-admin',
    type: 'mutating',
    expectedEffect: 'Links an Auth user identity to an admin_users profile record',
    usesFileInput: false,
    touchesStorage: false,
    touchesAuth: true,
    changesDatabaseRows: true,
  },
  'check-staging-projects': {
    id: 'check-staging-projects',
    type: 'read_only',
    expectedEffect: 'Reads and reports counts of projects by status',
    usesFileInput: false,
    touchesStorage: false,
    touchesAuth: false,
    changesDatabaseRows: false,
  },
  'check-media-assets': {
    id: 'check-media-assets',
    type: 'read_only',
    expectedEffect: 'Reads and checks media_assets table records',
    usesFileInput: false,
    touchesStorage: false,
    touchesAuth: false,
    changesDatabaseRows: false,
  },
  'check-staging-auth': {
    id: 'check-staging-auth',
    type: 'read_only',
    expectedEffect: 'Verifies staging Auth user identities and profile linkages',
    usesFileInput: false,
    touchesStorage: false,
    touchesAuth: true,
    changesDatabaseRows: false,
  },
  'check-import-batches': {
    id: 'check-import-batches',
    type: 'read_only',
    expectedEffect: 'Reads and lists import_batches records',
    usesFileInput: false,
    touchesStorage: false,
    touchesAuth: false,
    changesDatabaseRows: false,
  },
  'check-sample-feed': {
    id: 'check-sample-feed',
    type: 'read_only',
    expectedEffect: 'Reads public project data and checks feed compilation eligibility',
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
