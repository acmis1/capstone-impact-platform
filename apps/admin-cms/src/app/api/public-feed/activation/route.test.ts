import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getServerEnv: vi.fn(),
  resolvePublicationExecutionTarget: vi.fn(),
  createSupabaseAdminClientForServerEnv: vi.fn(),
  createPublicFeedHistoryDependencies: vi.fn(),
  activatePublicFeedHistory: vi.fn(),
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
  activatePublicFeedHistory: mocks.activatePublicFeedHistory,
}));

import { NextRequest } from 'next/server';
import { POST } from './route';

const ENV = {
  supabaseUrl: 'https://synthetic-production.supabase.co',
  SUPABASE_PUBLIC_FEEDS_BUCKET: 'public-feeds',
  SUPABASE_PUBLIC_FEED_FILE: 'capstones-latest.json',
};

function request(origin = 'https://admin.production.example') {
  return new NextRequest('https://admin.production.example/api/public-feed/activation', {
    method: 'POST', headers: { origin },
  });
}

describe('POST /api/public-feed/activation production boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ adminUserId: 'admin-id', permissions: ['projects.publish'] });
    mocks.getServerEnv.mockReturnValue(ENV);
    mocks.resolvePublicationExecutionTarget.mockReturnValue('production');
    mocks.createSupabaseAdminClientForServerEnv.mockReturnValue({ serverClient: true });
    mocks.createPublicFeedHistoryDependencies.mockReturnValue({ dependencies: true });
    mocks.activatePublicFeedHistory.mockResolvedValue({
      resultCode: 'COMPLETED', versionNumber: 1, recordCount: 0, feedHash: 'a'.repeat(64),
    });
  });

  it('passes one server-derived production target snapshot to qualified activation', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mocks.resolvePublicationExecutionTarget).toHaveBeenCalledWith(
      ENV.supabaseUrl,
      expect.objectContaining({ NEXT_PUBLIC_SUPABASE_URL: ENV.supabaseUrl }),
    );
    expect(mocks.createPublicFeedHistoryDependencies).toHaveBeenCalledWith(expect.objectContaining({
      executionTarget: 'production',
      supabaseUrl: ENV.supabaseUrl,
      feedBucket: 'public-feeds',
      feedPath: 'capstones-latest.json',
    }));
  });

  it('performs no privileged-client or activation work when target resolution fails', async () => {
    mocks.resolvePublicationExecutionTarget.mockReturnValue(null);
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ success: false, code: 'EXECUTION_FAILED' });
    expect(mocks.createSupabaseAdminClientForServerEnv).not.toHaveBeenCalled();
    expect(mocks.activatePublicFeedHistory).not.toHaveBeenCalled();
  });

  it('rejects cross-origin requests before authentication and target resolution', async () => {
    const response = await POST(request('https://evil.example'));
    expect(response.status).toBe(403);
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
    expect(mocks.resolvePublicationExecutionTarget).not.toHaveBeenCalled();
  });
});
