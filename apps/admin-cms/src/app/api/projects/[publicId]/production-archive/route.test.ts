import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  executeControlledPublicRemoval: vi.fn(),
  createControlledPublicRemovalDependencies: vi.fn(),
  createSupabaseAdminClientForServerEnv: vi.fn(),
  isProductionPublicationExecutionAvailable: vi.fn(),
  getServerEnv: vi.fn(),
}));

vi.mock('../../../../../auth/requireAdmin', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('../../../../../projects/controlledPublicRemovalService', () => ({ executeControlledPublicRemoval: mocks.executeControlledPublicRemoval }));
vi.mock('../../../../../projects/createControlledPublicRemovalDependencies', () => ({ createControlledPublicRemovalDependencies: mocks.createControlledPublicRemovalDependencies }));
vi.mock('../../../../../projects/publicationExecutionPolicy', () => ({ isProductionPublicationExecutionAvailable: mocks.isProductionPublicationExecutionAvailable }));
vi.mock('../../../../../lib/supabase/admin', () => ({ createSupabaseAdminClientForServerEnv: mocks.createSupabaseAdminClientForServerEnv }));
vi.mock('../../../../../lib/env', () => ({ getServerEnv: mocks.getServerEnv }));

import { NextRequest } from 'next/server';
import { AdminAuthError } from '../../../../../auth/authTypes';
import { POST } from './route';

const ENV = {
  supabaseUrl: 'https://synthetic-pp1-production.supabase.co',
  SUPABASE_PUBLIC_FEEDS_BUCKET: 'server-feeds',
  SUPABASE_PUBLIC_FEED_FILE: 'capstones-latest.json',
};
const ADMIN = {
  adminUserId: 'server-admin-id',
  roles: ['admin'],
  permissions: ['projects.archive'],
};
const COMPLETED = { resultCode: 'COMPLETED', recordCount: 2, feedHash: 'b'.repeat(64) };
const dependencies = { assertExecutionEnvironment: vi.fn() };
const supabase = { serverClient: true };
const context = (publicId: string) => ({ params: Promise.resolve({ publicId }) });

function request(body: unknown = { archiveReason: 'Institution-authorized retirement' }, origin: string | null = 'https://admin.production.example') {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (origin) headers.set('origin', origin);
  return new NextRequest('https://admin.production.example/api/projects/project-2026/production-archive', {
    method: 'POST', headers, body: JSON.stringify(body),
  });
}

async function read(response: Response) {
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  return response.json();
}

describe('POST /api/projects/[publicId]/production-archive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('CAPSTONE_RUNTIME_ENV', 'production');
    vi.stubEnv('CAPSTONE_EXPECTED_SUPABASE_HOST', 'synthetic-pp1-production.supabase.co');
    vi.stubEnv('CAPSTONE_PRODUCTION_PUBLICATION_ENABLED', 'true');
    mocks.getServerEnv.mockReturnValue(ENV);
    mocks.requireAdmin.mockResolvedValue(ADMIN);
    mocks.isProductionPublicationExecutionAvailable.mockReturnValue(true);
    mocks.createSupabaseAdminClientForServerEnv.mockReturnValue(supabase);
    mocks.createControlledPublicRemovalDependencies.mockReturnValue(dependencies);
    mocks.executeControlledPublicRemoval.mockResolvedValue(COMPLETED);
  });

  afterEach(() => vi.unstubAllEnvs());

  it('executes controlled removal with only server-derived production authority', async () => {
    const response = await POST(request({
      archiveReason: 'Institution-authorized retirement', publicId: 'attacker',
      executionTarget: 'staging', feedPath: 'attacker.json', serviceRoleKey: 'browser-value',
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
    expect(mocks.createControlledPublicRemovalDependencies).toHaveBeenCalledWith({
      supabase, supabaseUrl: ENV.supabaseUrl, publicId: 'project-2026', adminId: 'server-admin-id',
      feedBucket: 'server-feeds', feedPath: 'capstones-latest.json',
      executionTarget: 'production', executionEnvironment,
    });
    expect(mocks.executeControlledPublicRemoval).toHaveBeenCalledWith({
      permissions: ['projects.archive'], publicId: 'project-2026',
      archiveReason: 'Institution-authorized retirement', dependencies,
    });
    expect(JSON.stringify(mocks.createControlledPublicRemovalDependencies.mock.calls[0])).not.toContain('browser-value');
  });

  it('rejects cross-origin and unauthorized requests before policy execution', async () => {
    let response = await POST(request(undefined, 'https://evil.example'), context('project-2026'));
    expect(response.status).toBe(403);
    expect(mocks.requireAdmin).not.toHaveBeenCalled();

    mocks.requireAdmin.mockResolvedValueOnce({ adminUserId: 'reviewer', permissions: ['projects.read'] });
    response = await POST(request(), context('project-2026'));
    expect(response.status).toBe(403);
    expect(mocks.isProductionPublicationExecutionAvailable).not.toHaveBeenCalled();
  });

  it('rejects inactive staff and non-Administrator roles before target or client creation', async () => {
    mocks.requireAdmin.mockRejectedValueOnce(new AdminAuthError('STAFF_DEACTIVATED', 'private lifecycle detail'));
    let response = await POST(request(), context('project-2026'));
    expect(response.status).toBe(403);
    expect(await read(response)).toEqual({ success: false, error: 'Access denied.' });

    mocks.requireAdmin.mockResolvedValueOnce({
      adminUserId: 'reviewer-id', roles: ['reviewer'], permissions: ['projects.read', 'projects.review'],
    });
    response = await POST(request(), context('project-2026'));
    expect(response.status).toBe(403);
    expect(mocks.isProductionPublicationExecutionAvailable).not.toHaveBeenCalled();
    expect(mocks.createSupabaseAdminClientForServerEnv).not.toHaveBeenCalled();
  });

  it('rejects malformed removal input before production policy evaluation', async () => {
    const response = await POST(request({ archiveReason: '   ' }), context('project-2026'));
    expect(response.status).toBe(400);
    expect(mocks.isProductionPublicationExecutionAvailable).not.toHaveBeenCalled();
    expect(mocks.executeControlledPublicRemoval).not.toHaveBeenCalled();
  });

  it('fails closed before client construction when production publication is disabled', async () => {
    mocks.isProductionPublicationExecutionAvailable.mockReturnValue(false);
    const response = await POST(request(), context('project-2026'));
    expect(response.status).toBe(404);
    expect(await read(response)).toEqual({
      success: false,
      code: 'PRODUCTION_ARCHIVE_UNAVAILABLE',
      error: 'Live showcase removal is unavailable.',
    });
    expect(mocks.createSupabaseAdminClientForServerEnv).not.toHaveBeenCalled();
    expect(mocks.executeControlledPublicRemoval).not.toHaveBeenCalled();
  });

  it('maps recovery and exact-head divergence to bounded production outcomes', async () => {
    mocks.executeControlledPublicRemoval.mockResolvedValueOnce({ resultCode: 'RECOVERY_REQUIRED' });
    let response = await POST(request(), context('project-2026'));
    expect(response.status).toBe(409);
    expect(await read(response)).toMatchObject({ code: 'RECOVERY_REQUIRED' });

    mocks.executeControlledPublicRemoval.mockResolvedValueOnce({
      resultCode: 'EXECUTION_FAILED', failureCode: 'CURRENT_FEED_DIVERGED',
    });
    response = await POST(request(), context('project-2026'));
    expect(response.status).toBe(409);
    expect(await read(response)).toEqual({
      success: false,
      code: 'CURRENT_FEED_DIVERGED',
      error: 'The canonical production feed no longer matches the authoritative database. Removal was not performed.',
    });
  });

  it('preserves idempotent already-removed success and refuses coordinator policy drift', async () => {
    mocks.executeControlledPublicRemoval.mockResolvedValueOnce({
      ...COMPLETED, resultCode: 'ALREADY_COMPLETED',
    });
    let response = await POST(request(), context('project-2026'));
    expect(response.status).toBe(200);
    expect(await read(response)).toMatchObject({
      success: true,
      result: { resultCode: 'ALREADY_COMPLETED', publicId: 'project-2026' },
    });

    mocks.executeControlledPublicRemoval.mockResolvedValueOnce({
      resultCode: 'EXECUTION_FAILED', failureCode: 'NON_LOCAL_ENVIRONMENT',
    });
    response = await POST(request(), context('project-2026'));
    expect(response.status).toBe(404);
    expect(await read(response)).toMatchObject({ code: 'PRODUCTION_ARCHIVE_UNAVAILABLE' });
  });

  it('returns a bounded generic failure without internal removal detail', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.executeControlledPublicRemoval.mockRejectedValueOnce(new Error('private feed and operation detail'));
    const response = await POST(request(), context('project-2026'));
    expect(response.status).toBe(500);
    const body = await read(response);
    expect(body).toEqual({
      success: false,
      code: 'PRODUCTION_ARCHIVE_FAILED',
      error: 'Live showcase removal could not be completed.',
    });
    expect(JSON.stringify(body)).not.toContain('private feed');
    errorSpy.mockRestore();
  });
});
