import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { STAGING_OPERATIONS_REGISTRY, getStagingOperation } from './stagingOperationRegistry';
import { runSeedStagingProjects } from '../scripts/seedStagingProjects';
import { runSeedFakeMediaAssets } from '../scripts/seedFakeMediaAssets';
import { runImportStagingPackage } from '../scripts/importStagingPackage';
import { runPublishStagingFeed } from '../scripts/publishStagingFeed';
import { runLinkExistingStagingAdmin } from '../scripts/linkExistingStagingAdmin';
import { runCheckStagingProjects } from '../scripts/checkStagingProjects';
import { runCheckMediaAssets } from '../scripts/checkMediaAssets';
import { runCheckStagingAuth } from '../scripts/checkStagingAuth';
import { runCheckImportBatches } from '../scripts/checkImportBatches';
import { runCheckHostedDeploymentReadiness } from '../scripts/checkHostedDeploymentReadiness';
import { runCheckSampleFeed } from '../scripts/checkSampleFeed';
import * as adminCore from '../lib/supabase/adminCore';

describe('Staging Scripts Integration & Classification Registry Tests', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.CAPSTONE_RUNTIME_ENV = 'staging';
    process.env.CAPSTONE_EXPECTED_SUPABASE_HOST = 'app-staging.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://app-staging.supabase.co';
    process.env.CAPSTONE_STAGING_MUTATION_CONFIRMATION = 'capstone-admin-cms-staging-2026';
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('1. Central operation registry contains exactly 10 staging operations with explicit classifications', () => {
    const registeredIds = Object.keys(STAGING_OPERATIONS_REGISTRY);
    expect(registeredIds.length).toBe(10);

    const expectedIds = [
      'seed-staging-projects',
      'seed-fake-media-assets',
      'import-staging-package',
      'publish-staging-feed',
      'link-existing-staging-admin',
      'check-staging-projects',
      'check-media-assets',
      'check-staging-auth',
      'check-import-batches',
      'check-hosted-deployment-readiness',
    ];

    expect(registeredIds).toEqual(expect.arrayContaining(expectedIds));
    expect(registeredIds).not.toContain('check-sample-feed');

    expectedIds.forEach((id) => {
      const op = getStagingOperation(id);
      expect(op.id).toBe(id);
      expect(['read_only', 'mutating']).toContain(op.type);
      expect(typeof op.expectedEffect).toBe('string');
    });
  });

  it('2. Exactly 5 scripts are classified as mutating and 5 as read_only', () => {
    const ops = Object.values(STAGING_OPERATIONS_REGISTRY);
    const mutatingOps = ops.filter((o) => o.type === 'mutating');
    const readOnlyOps = ops.filter((o) => o.type === 'read_only');

    expect(mutatingOps.length).toBe(5);
    expect(readOnlyOps.length).toBe(5);
  });

  it('3. Specific operations enforce exact touchesAuth and changesDatabaseRows flags', () => {
    const checkAuthOp = getStagingOperation('check-staging-auth');
    expect(checkAuthOp.touchesAuth).toBe(false);
    expect(checkAuthOp.type).toBe('read_only');

    const linkAdminOp = getStagingOperation('link-existing-staging-admin');
    expect(linkAdminOp.touchesAuth).toBe(true);
    expect(linkAdminOp.type).toBe('mutating');

    const publishFeedOp = getStagingOperation('publish-staging-feed');
    expect(publishFeedOp.changesDatabaseRows).toBe(true);
    expect(publishFeedOp.touchesStorage).toBe(true);
    expect(publishFeedOp.type).toBe('mutating');
  });

  it('4. Registry expectedEffect descriptions are executably accurate', () => {
    const seedProjectsOp = getStagingOperation('seed-staging-projects');
    expect(seedProjectsOp.expectedEffect).toContain('Deletes matching synthetic public IDs');
    expect(seedProjectsOp.expectedEffect).toContain('inserts');
    expect(seedProjectsOp.expectedEffect).not.toContain('Upserts');

    const importOp = getStagingOperation('import-staging-package');
    expect(importOp.expectedEffect).toContain('runtime-import-demo');
    expect(importOp.expectedEffect).toContain('import_batches');
    expect(importOp.expectedEffect).toContain('cleanup');
    expect(importOp.expectedEffect).toContain('Storage');
    expect(importOp.expectedEffect).toContain('validation_flags');
    expect(importOp.expectedEffect).not.toContain('ZIP');

    const mediaSeedOp = getStagingOperation('seed-fake-media-assets');
    expect(mediaSeedOp.expectedEffect).toContain('Deletes existing media_assets rows');
    expect(mediaSeedOp.expectedEffect).toContain('promotes assets to public');
    expect(mediaSeedOp.expectedEffect).toContain('updates project poster/snapshot URLs');
  });

  it('5. checkSampleFeed is not in registry and runs cleanly with staging variables absent', () => {
    delete process.env.CAPSTONE_RUNTIME_ENV;
    delete process.env.CAPSTONE_EXPECTED_SUPABASE_HOST;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;

    expect(() => getStagingOperation('check-sample-feed')).toThrowError(/Unregistered staging script identifier/);

    const result = runCheckSampleFeed();
    expect(result).toBe(true);
  });

  it('6. All ten staging-capable runner modules are imported and callable', () => {
    expect(typeof runSeedStagingProjects).toBe('function');
    expect(typeof runSeedFakeMediaAssets).toBe('function');
    expect(typeof runImportStagingPackage).toBe('function');
    expect(typeof runPublishStagingFeed).toBe('function');
    expect(typeof runLinkExistingStagingAdmin).toBe('function');
    expect(typeof runCheckStagingProjects).toBe('function');
    expect(typeof runCheckMediaAssets).toBe('function');
    expect(typeof runCheckStagingAuth).toBe('function');
    expect(typeof runCheckImportBatches).toBe('function');
    expect(typeof runCheckHostedDeploymentReadiness).toBe('function');
  });

  it('7. Default mutating script invocations create zero Supabase admin clients (dry-run protection)', async () => {
    const adminClientSpy = vi.spyOn(adminCore, 'createSupabaseAdminClientCore');

    const resSeedProjects = await runSeedStagingProjects([]);
    const resSeedMedia = await runSeedFakeMediaAssets([]);
    const resImportPackage = await runImportStagingPackage([]);
    const resPublishFeed = await runPublishStagingFeed([]);
    const resLinkAdmin = await runLinkExistingStagingAdmin([]);

    expect(resSeedProjects).toBe(false);
    expect(resSeedMedia).toBe(false);
    expect(resImportPackage).toBe(false);
    expect(resPublishFeed).toBe(false);
    expect(resLinkAdmin).toBe(false);

    expect(adminClientSpy).not.toHaveBeenCalled();
  });
});
