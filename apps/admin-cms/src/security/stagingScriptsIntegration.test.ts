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
import { runCheckSampleFeed } from '../scripts/checkSampleFeed';
import * as adminCore from '../lib/supabase/adminCore';

describe('Staging Scripts Integration & Classification Registry Tests', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.CAPSTONE_RUNTIME_ENV = 'staging';
    process.env.CAPSTONE_EXPECTED_SUPABASE_HOST = 'app-staging.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://app-staging.supabase.co';
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('1. Central operation registry contains exactly 9 staging operations with explicit classifications', () => {
    const registeredIds = Object.keys(STAGING_OPERATIONS_REGISTRY);
    expect(registeredIds.length).toBe(9);

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

  it('2. Exactly 5 scripts are classified as mutating and 4 as read_only', () => {
    const ops = Object.values(STAGING_OPERATIONS_REGISTRY);
    const mutatingOps = ops.filter((o) => o.type === 'mutating');
    const readOnlyOps = ops.filter((o) => o.type === 'read_only');

    expect(mutatingOps.length).toBe(5);
    expect(readOnlyOps.length).toBe(4);
  });

  it('3. checkSampleFeed is not in registry and runs cleanly with staging variables absent', () => {
    delete process.env.CAPSTONE_RUNTIME_ENV;
    delete process.env.CAPSTONE_EXPECTED_SUPABASE_HOST;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;

    expect(() => getStagingOperation('check-sample-feed')).toThrowError(/Unregistered staging script identifier/);

    const result = runCheckSampleFeed();
    expect(result).toBe(true);
  });

  it('4. All nine staging-capable runner modules are imported and callable', () => {
    expect(typeof runSeedStagingProjects).toBe('function');
    expect(typeof runSeedFakeMediaAssets).toBe('function');
    expect(typeof runImportStagingPackage).toBe('function');
    expect(typeof runPublishStagingFeed).toBe('function');
    expect(typeof runLinkExistingStagingAdmin).toBe('function');
    expect(typeof runCheckStagingProjects).toBe('function');
    expect(typeof runCheckMediaAssets).toBe('function');
    expect(typeof runCheckStagingAuth).toBe('function');
    expect(typeof runCheckImportBatches).toBe('function');
  });

  it('5. Default mutating script invocations create zero Supabase admin clients (dry-run protection)', async () => {
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

    // Verify zero client instantiations occurred
    expect(adminClientSpy).not.toHaveBeenCalled();
  });
});
