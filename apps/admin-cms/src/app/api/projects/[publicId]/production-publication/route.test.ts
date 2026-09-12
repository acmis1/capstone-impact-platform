import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  executeControlledPublication: vi.fn(),
  createControlledPublicationDependencies: vi.fn(),
  createSupabaseAdminClientForServerEnv: vi.fn(),
  isProductionPublicationExecutionAvailable: vi.fn(),
  getServerEnv: vi.fn(),
}));

vi.mock('../../../../../auth/requireAdmin', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('../../../../../projects/controlledPublicationService', () => ({ executeControlledPublication: mocks.executeControlledPublication }));
vi.mock('../../../../../projects/createControlledPublicationDependencies', () => ({ createControlledPublicationDependencies: mocks.createControlledPublicationDependencies }));
vi.mock('../../../../../projects/publicationExecutionPolicy', () => ({ isProductionPublicationExecutionAvailable: mocks.isProductionPublicationExecutionAvailable }));
vi.mock('../../../../../lib/supabase/admin', () => ({ createSupabaseAdminClientForServerEnv: mocks.createSupabaseAdminClientForServerEnv }));
vi.mock('../../../../../lib/env', () => ({ getServerEnv: mocks.getServerEnv }));

import { NextRequest } from 'next/server';
import { AdminAuthError } from '../../../../../auth/authTypes';
import { POST } from './route';

const ENV = {
  supabaseUrl: 'https://synthetic-pp1-production.supabase.co',
  SUPABASE_DRAFT_BUCKET: 'server-drafts',
  SUPABASE_PUBLIC_ASSETS_BUCKET: 'server-assets',
  SUPABASE_PUBLIC_FEEDS_BUCKET: 'server-feeds',
  SUPABASE_PUBLIC_FEED_FILE: 'capstones-latest.json',
};
const ADMIN = {
  adminUserId: 'server-admin-id',
  roles: ['admin'],
  permissions: ['projects.publish'],
};
const COMPLETED = {
  resultCode: 'COMPLETED', snapshotId: 'snapshot-id', recordCount: 3,
  feedHash: 'a'.repeat(64), feedPublicUrl: `${ENV.supabaseUrl}/storage/v1/object/public/server-feeds/capstones-latest.json`,
};
const dependencies = { assertExecutionEnvironment: vi.fn() };
const supabase = { serverClient: true };
const context = (publicId: string) => ({ params: Promise.resolve({ publicId }) });

function request(origin: string | null = 'https://admin.production.example', body?: unknown) {
  const headers = new Headers();
  if (origin) headers.set('origin', origin);
  if (body !== undefined) headers.set('content-type', 'application/json');
  return new NextRequest('https://admin.production.example/api/projects/project-2026/production-publication', {
    method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function read(response: Response) {
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  return response.json();
}

describe('POST /api/projects/[publicId]/production-publication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('CAPSTONE_RUNTIME_ENV', 'production');
    vi.stubEnv('CAPSTONE_EXPECTED_SUPABASE_HOST', 'synthetic-pp1-production.supabase.co');
    vi.stubEnv('CAPSTONE_PRODUCTION_PUBLICATION_ENABLED', 'true');
    mocks.getServerEnv.mockReturnValue(ENV);
    mocks.requireAdmin.mockResolvedValue(ADMIN);
    mocks.isProductionPublicationExecutionAvailable.mockReturnValue(true);
    mocks.createSupabaseAdminClientForServerEnv.mockReturnValue(supabase);
    mocks.createControlledPublicationDependencies.mockReturnValue(dependencies);
    mocks.executeControlledPublication.mockResolvedValue(COMPLETED);
  });

  afterEach(() => vi.unstubAllEnvs());

  it('executes only with server-bound production identity, destination, and admin authority', async () => {
    const response = await POST(request(undefined, {
      executionTarget: 'staging', supabaseUrl: 'https://attacker.example',
      publicFeedPath: 'attacker.json', serviceRoleKey: 'browser-value',
    }), context('project-2026'));

    expect(response.status).toBe(200);
    expect(await read(response)).toEqual({ success: true, result: {
      ...COMPLETED, publicId: 'project-2026',
    } });
    const executionEnvironment = expect.objectContaining({
      CAPSTONE_RUNTIME_ENV: 'production',
      CAPSTONE_EXPECTED_SUPABASE_HOST: 'synthetic-pp1-production.supabase.co',
      CAPSTONE_PRODUCTION_PUBLICATION_ENABLED: 'true',
      NEXT_PUBLIC_SUPABASE_URL: ENV.supabaseUrl,
    });
    expect(mocks.isProductionPublicationExecutionAvailable).toHaveBeenCalledWith(ENV.supabaseUrl, executionEnvironment);
    expect(mocks.createSupabaseAdminClientForServerEnv).toHaveBeenCalledWith(ENV);
    expect(mocks.createControlledPublicationDependencies).toHaveBeenCalledWith(expect.objectContaining({
      supabase, supabaseUrl: ENV.supabaseUrl, publicId: 'project-2026', adminId: 'server-admin-id',
      publicFeedBucket: 'server-feeds', publicFeedPath: 'capstones-latest.json',
      executionTarget: 'production', executionEnvironment,
    }));
    expect(JSON.stringify(mocks.createControlledPublicationDependencies.mock.calls[0])).not.toContain('browser-value');
  });

  it('rejects cross-origin, unauthenticated, and unauthorized requests before policy execution', async () => {
    let response = await POST(request('https://evil.example'), context('project-2026'));
    expect(response.status).toBe(403);
    expect(mocks.requireAdmin).not.toHaveBeenCalled();

    mocks.requireAdmin.mockRejectedValueOnce(new AdminAuthError('UNAUTHENTICATED', 'private detail'));
    response = await POST(request(), context('project-2026'));
    expect(response.status).toBe(401);
    expect(await read(response)).toEqual({ success: false, error: 'Authentication required.' });

    mocks.requireAdmin.mockResolvedValueOnce({ adminUserId: 'reviewer', permissions: ['projects.read'] });
    response = await POST(request(), context('project-2026'));
    expect(response.status).toBe(403);
    expect(mocks.isProductionPublicationExecutionAvailable).not.toHaveBeenCalled();
  });

  it('rejects inactive staff and non-Administrator roles through the existing authority boundary', async () => {
    mocks.requireAdmin.mockRejectedValueOnce(new AdminAuthError('STAFF_DEACTIVATED', 'private lifecycle detail'));
    let response = await POST(request(), context('project-2026'));
    expect(response.status).toBe(403);
    expect(await read(response)).toEqual({ success: false, error: 'Access denied.' });

    mocks.requireAdmin.mockResolvedValueOnce({
      adminUserId: 'editor-id', roles: ['editor'], permissions: ['projects.read', 'projects.edit'],
    });
    response = await POST(request(), context('project-2026'));
    expect(response.status).toBe(403);
    expect(mocks.isProductionPublicationExecutionAvailable).not.toHaveBeenCalled();
    expect(mocks.createSupabaseAdminClientForServerEnv).not.toHaveBeenCalled();
  });

  it('rejects an invalid public ID before authentication or target evaluation', async () => {
    const response = await POST(request(), context('project/attacker'));
    expect(response.status).toBe(400);
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
    expect(mocks.isProductionPublicationExecutionAvailable).not.toHaveBeenCalled();
  });

  it('fails closed before client construction when the production policy is unavailable', async () => {
    mocks.isProductionPublicationExecutionAvailable.mockReturnValue(false);
    const response = await POST(request(), context('project-2026'));
    expect(response.status).toBe(404);
    expect(await read(response)).toEqual({
      success: false,
      code: 'PRODUCTION_PUBLICATION_UNAVAILABLE',
      error: 'Live showcase publication is unavailable.',
    });
    expect(mocks.createSupabaseAdminClientForServerEnv).not.toHaveBeenCalled();
    expect(mocks.executeControlledPublication).not.toHaveBeenCalled();
  });

  it('maps readiness drift and forward-recovery blocks without leaking internal evidence', async () => {
    mocks.executeControlledPublication.mockResolvedValueOnce({
      resultCode: 'NOT_READY', readinessCode: 'CONFIRMATION_STALE', blockers: ['Confirmation changed'],
    });
    let response = await POST(request(), context('project-2026'));
    expect(response.status).toBe(409);
    expect(await read(response)).toMatchObject({ result: { readinessCode: 'CONFIRMATION_STALE' } });

    mocks.executeControlledPublication.mockResolvedValueOnce({ resultCode: 'RECOVERY_REQUIRED' });
    response = await POST(request(), context('project-2026'));
    expect(response.status).toBe(409);
    expect(await read(response)).toMatchObject({ code: 'RECOVERY_REQUIRED' });
  });

  it('preserves idempotent no-change success and the coordinator policy boundary', async () => {
    mocks.executeControlledPublication.mockResolvedValueOnce({
      ...COMPLETED, resultCode: 'ALREADY_COMPLETED',
    });
    let response = await POST(request(), context('project-2026'));
    expect(response.status).toBe(200);
    expect(await read(response)).toMatchObject({
      success: true,
      result: { resultCode: 'ALREADY_COMPLETED', snapshotId: 'snapshot-id' },
    });

    mocks.executeControlledPublication.mockResolvedValueOnce({
      resultCode: 'EXECUTION_FAILED', failureCode: 'EXECUTION_POLICY_DENIED',
    });
    response = await POST(request(), context('project-2026'));
    expect(response.status).toBe(404);
    expect(await read(response)).toMatchObject({ code: 'PRODUCTION_PUBLICATION_UNAVAILABLE' });
  });

  it('returns a bounded generic failure without internal coordinator detail', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.executeControlledPublication.mockRejectedValueOnce(new Error('private operation and storage detail'));
    const response = await POST(request(), context('project-2026'));
    expect(response.status).toBe(500);
    const body = await read(response);
    expect(body).toEqual({ success: false, error: 'Live showcase publication could not be completed.' });
    expect(JSON.stringify(body)).not.toContain('private operation');
    errorSpy.mockRestore();
  });
});
