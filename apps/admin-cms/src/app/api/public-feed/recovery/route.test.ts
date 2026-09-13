import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getServerEnv: vi.fn(),
  resolvePublicationExecutionTarget: vi.fn(),
  createSupabaseAdminClientForServerEnv: vi.fn(),
  createPublicFeedHistoryDependencies: vi.fn(),
  recoverPublicFeedOperation: vi.fn(),
}));

vi.mock('../../../../auth/requireAdmin', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('../../../../lib/env', () => ({ getServerEnv: mocks.getServerEnv }));
vi.mock('../../../../projects/publicationExecutionPolicy', () => ({
  resolvePublicationExecutionTarget: mocks.resolvePublicationExecutionTarget,
}));
vi.mock('../../../../lib/supabase/admin', () => ({
  createSupabaseAdminClientForServerEnv: mocks.createSupabaseAdminClientForServerEnv,
}));
vi.mock('../../../../projects/createPublicFeedHistoryDependencies', () => ({
  createPublicFeedHistoryDependencies: mocks.createPublicFeedHistoryDependencies,
}));
vi.mock('../../../../projects/publicFeedHistoryService', () => ({
  recoverPublicFeedOperation: mocks.recoverPublicFeedOperation,
}));

import { NextRequest } from 'next/server';
import { POST } from './route';

const ENV = {
  supabaseUrl: 'https://synthetic-production.supabase.co',
  SUPABASE_PUBLIC_FEEDS_BUCKET: 'public-feeds',
  SUPABASE_PUBLIC_FEED_FILE: 'capstones-latest.json',
};
const request = () => new NextRequest('https://admin.production.example/api/public-feed/recovery', {
  method: 'POST', headers: { origin: 'https://admin.production.example' },
});

describe('POST /api/public-feed/recovery production boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ adminUserId: 'admin-id', permissions: ['projects.publish'] });
    mocks.getServerEnv.mockReturnValue(ENV);
    mocks.resolvePublicationExecutionTarget.mockReturnValue('production');
    mocks.createSupabaseAdminClientForServerEnv.mockReturnValue({ serverClient: true });
    mocks.createPublicFeedHistoryDependencies.mockReturnValue({ dependencies: true });
    mocks.recoverPublicFeedOperation.mockResolvedValue({ resultCode: 'NO_RECOVERY_REQUIRED' });
  });

  it('uses the explicit production target for forward recovery', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mocks.createPublicFeedHistoryDependencies).toHaveBeenCalledWith(expect.objectContaining({
      executionTarget: 'production',
      supabaseUrl: ENV.supabaseUrl,
      feedBucket: 'public-feeds',
      feedPath: 'capstones-latest.json',
    }));
    expect(mocks.recoverPublicFeedOperation).toHaveBeenCalledOnce();
  });

  it('performs no privileged-client or recovery work when target resolution fails', async () => {
    mocks.resolvePublicationExecutionTarget.mockReturnValue(null);
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ success: false, code: 'EXECUTION_FAILED' });
    expect(mocks.createSupabaseAdminClientForServerEnv).not.toHaveBeenCalled();
    expect(mocks.recoverPublicFeedOperation).not.toHaveBeenCalled();
  });

  it('preserves a denied rollback-recovery result without treating it as success', async () => {
    mocks.recoverPublicFeedOperation.mockResolvedValue({ resultCode: 'RECOVERY_REQUIRED' });
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ success: false, code: 'RECOVERY_REQUIRED' });
  });
});
