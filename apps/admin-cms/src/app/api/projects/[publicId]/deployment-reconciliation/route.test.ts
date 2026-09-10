import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  executeControlledPublication: vi.fn(),
  createControlledPublicationDependencies: vi.fn(),
  createSupabaseAdminClientForServerEnv: vi.fn(),
  getServerEnv: vi.fn(),
  resolvePublicationExecutionTarget: vi.fn(),
}));

vi.mock('../../../../../auth/requireAdmin', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('../../../../../projects/controlledPublicationService', () => ({ executeControlledPublication: mocks.executeControlledPublication }));
vi.mock('../../../../../projects/createControlledPublicationDependencies', () => ({ createControlledPublicationDependencies: mocks.createControlledPublicationDependencies }));
vi.mock('../../../../../projects/publicationExecutionPolicy', () => ({
  resolvePublicationExecutionTarget: mocks.resolvePublicationExecutionTarget,
}));
vi.mock('../../../../../lib/supabase/admin', () => ({ createSupabaseAdminClientForServerEnv: mocks.createSupabaseAdminClientForServerEnv }));
vi.mock('../../../../../lib/env', () => ({ getServerEnv: mocks.getServerEnv }));

import { NextRequest } from 'next/server';
import { POST } from './route';

const ENV = {
  supabaseUrl: 'https://synthetic-production.supabase.co',
  SUPABASE_DRAFT_BUCKET: 'server-drafts',
  SUPABASE_PUBLIC_ASSETS_BUCKET: 'server-assets',
  SUPABASE_PUBLIC_FEEDS_BUCKET: 'server-feeds',
  SUPABASE_PUBLIC_FEED_FILE: 'capstones-latest.json',
};
const context = { params: Promise.resolve({ publicId: 'project-2026' }) };
const request = () => new NextRequest('https://admin.production.example/api/projects/project-2026/deployment-reconciliation', {
  method: 'POST', headers: { origin: 'https://admin.production.example' },
});

describe('POST deployment reconciliation production target', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ adminUserId: 'server-admin', permissions: ['projects.publish'] });
    mocks.getServerEnv.mockReturnValue(ENV);
    mocks.resolvePublicationExecutionTarget.mockReturnValue('production');
    mocks.createSupabaseAdminClientForServerEnv.mockReturnValue({ serverClient: true });
    mocks.createControlledPublicationDependencies.mockReturnValue({ dependencies: true });
    mocks.executeControlledPublication.mockResolvedValue({
      resultCode: 'COMPLETED', recordCount: 2, feedHash: 'c'.repeat(64),
    });
  });

  it('uses the distinct production policy and controlled coordinator', async () => {
    const response = await POST(request(), context);
    expect(response.status).toBe(200);
    expect(mocks.createControlledPublicationDependencies).toHaveBeenCalledWith(expect.objectContaining({
      executionTarget: 'production',
      executionEnvironment: expect.objectContaining({ NEXT_PUBLIC_SUPABASE_URL: ENV.supabaseUrl }),
      publicFeedBucket: 'server-feeds',
      publicFeedPath: 'capstones-latest.json',
    }));
    expect(mocks.resolvePublicationExecutionTarget).toHaveBeenCalledWith(
      ENV.supabaseUrl,
      expect.objectContaining({ NEXT_PUBLIC_SUPABASE_URL: ENV.supabaseUrl }),
    );
    expect(mocks.executeControlledPublication).toHaveBeenCalledWith(expect.objectContaining({
      publicationMode: 'deployment_reconciliation',
      publicId: 'project-2026',
    }));
  });

  it('fails closed before creating a client when no named execution target is available', async () => {
    mocks.resolvePublicationExecutionTarget.mockReturnValue(null);
    const response = await POST(request(), context);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'PUBLICATION_UNAVAILABLE' });
    expect(mocks.createSupabaseAdminClientForServerEnv).not.toHaveBeenCalled();
    expect(mocks.executeControlledPublication).not.toHaveBeenCalled();
  });

  it('rejects cross-origin and wrong-role actors before target resolution', async () => {
    let response = await POST(new NextRequest(
      'https://admin.production.example/api/projects/project-2026/deployment-reconciliation',
      { method: 'POST', headers: { origin: 'https://evil.example' } },
    ), context);
    expect(response.status).toBe(403);
    expect(mocks.requireAdmin).not.toHaveBeenCalled();

    mocks.requireAdmin.mockResolvedValueOnce({
      adminUserId: 'reviewer', permissions: ['projects.read', 'projects.review'],
    });
    response = await POST(request(), context);
    expect(response.status).toBe(403);
    expect(mocks.resolvePublicationExecutionTarget).not.toHaveBeenCalled();
    expect(mocks.createSupabaseAdminClientForServerEnv).not.toHaveBeenCalled();
  });
});
