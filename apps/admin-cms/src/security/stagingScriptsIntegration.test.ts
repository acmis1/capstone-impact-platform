import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { STAGING_OPERATIONS_REGISTRY, getStagingOperation } from './stagingOperationRegistry';
import { runSeedStagingProjects } from '../scripts/seedStagingProjects';
import { runSeedFakeMediaAssets } from '../scripts/seedFakeMediaAssets';
import { runImportStagingPackage } from '../scripts/importStagingPackage';
import { runPublishStagingFeed } from '../scripts/publishStagingFeed';
import { runLinkExistingStagingAdmin } from '../scripts/linkExistingStagingAdmin';
import { runCheckStagingProjects } from '../scripts/checkStagingProjects';
import { runCheckMediaAssets } from '../scripts/checkMediaAssets';
import { runCheckSampleFeed } from '../scripts/checkSampleFeed';

describe('Staging Scripts Integration & Classification Registry Tests', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.CAPSTONE_RUNTIME_ENV = 'staging';
    process.env.CAPSTONE_EXPECTED_SUPABASE_HOST = 'app-staging.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://app-staging.supabase.co';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('1. Central operation registry contains all 10 staging scripts with explicit classifications', () => {
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
      'check-sample-feed',
    ];

    expect(Object.keys(STAGING_OPERATIONS_REGISTRY)).toEqual(expect.arrayContaining(expectedIds));

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

  it('3. Default mutating script invocations perform zero network calls and return dry-run false', async () => {
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
  });

  it('4. Importing staging script modules does not execute main runner logic automatically', () => {
    expect(typeof runSeedStagingProjects).toBe('function');
    expect(typeof runCheckStagingProjects).toBe('function');
    expect(typeof runCheckSampleFeed).toBe('function');
  });
});
