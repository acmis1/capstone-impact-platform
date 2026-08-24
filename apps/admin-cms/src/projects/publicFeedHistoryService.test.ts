import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executePublicFeedWriter: vi.fn(),
  getBlockingOperation: vi.fn(),
}));

vi.mock('../repositories/SupabasePublicFeedLedgerRepositoryCore', () => ({
  SupabasePublicFeedLedgerRepositoryCore: class {
    getBlockingOperation = mocks.getBlockingOperation;
  },
}));

vi.mock('./publicFeedWriterCoordinator', () => ({
  executePublicFeedWriter: mocks.executePublicFeedWriter,
  inspectPublicFeedHead: vi.fn(),
}));

import { recoverPublicFeedOperation } from './publicFeedHistoryService';

describe('recoverPublicFeedOperation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps rollback recovery blocked outside the explicit Local-only capability', async () => {
    mocks.getBlockingOperation.mockResolvedValue({
      id: 'operation-id', kind: 'rollback', state: 'RECOVERY_REQUIRED',
      publicationMode: null, publicId: null, rollbackPreparationId: 'preparation-id',
      storageBucket: 'public-feed', storagePath: 'feed.json', candidateFeedContent: '[]\n',
    });

    const result = await recoverPublicFeedOperation({
      supabase: {} as never,
      supabaseUrl: 'https://staging.example.supabase.co',
      adminId: 'admin-id',
      permissions: ['projects.publish'],
      feedBucket: 'public-feed',
      feedPath: 'feed.json',
      listProjects: vi.fn(),
      assertActivationEnvironment: vi.fn(),
      environment: {
        CAPSTONE_RUNTIME_ENV: 'staging',
        CAPSTONE_LOCAL_PUBLIC_FEED_ROLLBACK_ENABLED: 'true',
      },
    });

    expect(result).toEqual({ resultCode: 'RECOVERY_REQUIRED' });
    expect(mocks.executePublicFeedWriter).not.toHaveBeenCalled();
  });
});
