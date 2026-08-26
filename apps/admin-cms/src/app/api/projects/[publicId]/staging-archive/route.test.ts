import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  executeControlledPublicRemoval: vi.fn(),
  createControlledPublicRemovalDependencies: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
  createSupabaseAdminClientForServerEnv: vi.fn(),
  isStagingPublicationExecutionAvailable: vi.fn(),
  getServerEnv: vi.fn(),
  env: {
    supabaseUrl: 'https://synthetic-pp1-staging.supabase.co',
    supabaseDatabaseAdminKey: 'synthetic-server-secret',
    SUPABASE_PUBLIC_FEEDS_BUCKET: 'server-public-feeds',
    SUPABASE_PUBLIC_FEED_FILE: 'capstones-latest.json',
  },
}));

vi.mock('../../../../../auth/requireAdmin', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('../../../../../projects/controlledPublicRemovalService', () => ({
  executeControlledPublicRemoval: mocks.executeControlledPublicRemoval,
}));
vi.mock('../../../../../projects/createControlledPublicRemovalDependencies', () => ({
  createControlledPublicRemovalDependencies: mocks.createControlledPublicRemovalDependencies,
}));
vi.mock('../../../../../projects/publicationExecutionPolicy', () => ({
  isStagingPublicationExecutionAvailable: mocks.isStagingPublicationExecutionAvailable,
}));
vi.mock('../../../../../lib/supabase/admin', () => ({
  createSupabaseAdminClient: mocks.createSupabaseAdminClient,
  createSupabaseAdminClientForServerEnv: mocks.createSupabaseAdminClientForServerEnv,
}));
vi.mock('../../../../../lib/env', () => ({ getServerEnv: mocks.getServerEnv }));

import { NextRequest } from 'next/server';
import { AdminAuthError } from '../../../../../auth/authTypes';
import { POST } from './route';

const ADMIN = { adminUserId: 'server-admin-id', permissions: ['projects.archive'] };
const COMPLETED = {
  resultCode: 'COMPLETED',
  attemptId: 'internal-operation-id',
  auditRecordId: 'internal-audit-id',
  recordCount: 2,
  feedHash: 'a'.repeat(64),
  content: '[]',
};
const supabase = { serverClient: true };
const dependencies = { assertExecutionEnvironment: vi.fn(), serverOnly: true };
const context = (publicId: string) => ({ params: Promise.resolve({ publicId }) });

function request(body: unknown = { archiveReason: '  Retired staging entry  ' }, origin = 'https://admin-staging.example') {
  return new NextRequest('https://admin-staging.example/api/projects/project_2026/staging-archive', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function rawRequest(body: string | undefined, origin: string | null = 'https://admin-staging.example') {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (origin !== null) headers.set('origin', origin);
  return new NextRequest('https://admin-staging.example/api/projects/project_2026/staging-archive', {
    method: 'POST', headers, body,
  });
}

async function post(publicId = 'project_2026', body?: unknown, origin?: string) {
  return POST(request(body, origin), context(publicId));
}

async function read(response: Response) {
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  return response.json();
}

describe('POST /api/projects/[publicId]/staging-archive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getServerEnv.mockReturnValue(mocks.env);
    mocks.requireAdmin.mockResolvedValue(ADMIN);
    mocks.createSupabaseAdminClientForServerEnv.mockReturnValue(supabase);
    mocks.createControlledPublicRemovalDependencies.mockReturnValue(dependencies);
    mocks.isStagingPublicationExecutionAvailable.mockReturnValue(true);
    mocks.executeControlledPublicRemoval.mockResolvedValue(COMPLETED);
  });

  afterEach(() => vi.unstubAllEnvs());

  it('executes an authorized staging archive with only server-bound destination authority', async () => {
    vi.stubEnv('CAPSTONE_RUNTIME_ENV', 'staging');
    vi.stubEnv('CAPSTONE_EXPECTED_SUPABASE_HOST', 'synthetic-pp1-staging.supabase.co');
    vi.stubEnv('CAPSTONE_STAGING_PUBLICATION_ENABLED', 'true');
    const response = await post();
    expect(response.status).toBe(200);
    expect(await read(response)).toEqual({
      success: true,
      result: {
        resultCode: 'COMPLETED', publicId: 'project_2026', recordCount: 2,
        feedHash: 'a'.repeat(64),
      },
    });
    expect(mocks.getServerEnv).toHaveBeenCalledOnce();
    expect(mocks.isStagingPublicationExecutionAvailable).toHaveBeenCalledWith(
      mocks.env.supabaseUrl,
      {
        CAPSTONE_RUNTIME_ENV: 'staging',
        CAPSTONE_EXPECTED_SUPABASE_HOST: 'synthetic-pp1-staging.supabase.co',
        CAPSTONE_STAGING_PUBLICATION_ENABLED: 'true',
        NEXT_PUBLIC_SUPABASE_URL: mocks.env.supabaseUrl,
      },
    );
    expect(mocks.createSupabaseAdminClientForServerEnv).toHaveBeenCalledWith(mocks.env);
    expect(mocks.createSupabaseAdminClient).not.toHaveBeenCalled();
    const executionEnvironment = mocks.isStagingPublicationExecutionAvailable.mock.calls[0][1];
    expect(mocks.createControlledPublicRemovalDependencies).toHaveBeenCalledWith({
      supabase,
      supabaseUrl: mocks.env.supabaseUrl,
      publicId: 'project_2026',
      adminId: 'server-admin-id',
      feedBucket: 'server-public-feeds',
      feedPath: 'capstones-latest.json',
      executionTarget: 'staging',
      executionEnvironment,
    });
    expect(mocks.executeControlledPublicRemoval).toHaveBeenCalledWith({
      permissions: ['projects.archive'],
      publicId: 'project_2026',
      archiveReason: 'Retired staging entry',
      dependencies,
    });
  });

  it('rejects a cross-origin request before authentication or execution', async () => {
    const response = await post('project_2026', undefined, 'https://evil.example');
    expect(response.status).toBe(403);
    expect(await read(response)).toEqual({ success: false, error: 'Access denied.' });
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
    expect(mocks.executeControlledPublicRemoval).not.toHaveBeenCalled();
  });

  it('rejects a missing Origin before authentication or execution', async () => {
    const response = await POST(rawRequest('{}', null), context('project_2026'));
    expect(response.status).toBe(403);
    expect(await read(response)).toEqual({ success: false, error: 'Access denied.' });
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
    expect(mocks.executeControlledPublicRemoval).not.toHaveBeenCalled();
  });

  it('maps unauthenticated access through the bounded auth contract', async () => {
    mocks.requireAdmin.mockRejectedValue(new AdminAuthError('UNAUTHENTICATED', 'raw provider detail'));
    const response = await post();
    expect(response.status).toBe(401);
    const json = await read(response);
    expect(json).toEqual({ success: false, error: 'Authentication required.' });
    expect(JSON.stringify(json)).not.toContain('raw provider detail');
    expect(mocks.isStagingPublicationExecutionAvailable).not.toHaveBeenCalled();
  });

  it('rejects staff without projects.archive before policy evaluation', async () => {
    mocks.requireAdmin.mockResolvedValue({ adminUserId: 'reviewer-id', permissions: ['projects.read', 'projects.review'] });
    const response = await post();
    expect(response.status).toBe(403);
    expect(await read(response)).toEqual({ success: false, error: 'Access denied.' });
    expect(mocks.isStagingPublicationExecutionAvailable).not.toHaveBeenCalled();
    expect(mocks.executeControlledPublicRemoval).not.toHaveBeenCalled();
  });

  it.each([
    'staging flag false',
    'staging flag missing',
    'staging identity unavailable',
  ])('fails closed before dependency creation when %s', async () => {
    mocks.isStagingPublicationExecutionAvailable.mockReturnValue(false);
    const response = await post();
    expect(response.status).toBe(404);
    expect(await read(response)).toEqual({
      success: false,
      code: 'STAGING_ARCHIVE_UNAVAILABLE',
      error: 'Staging showcase archive is unavailable.',
    });
    expect(mocks.createControlledPublicRemovalDependencies).not.toHaveBeenCalled();
    expect(mocks.executeControlledPublicRemoval).not.toHaveBeenCalled();
  });

  it('rejects invalid target or archive reason before policy evaluation', async () => {
    expect((await post('project/attacker')).status).toBe(400);
    expect((await post('project_2026', { archiveReason: ' ' })).status).toBe(400);
    expect((await post('project_2026', { archiveReason: 42 })).status).toBe(400);
    expect((await post('project_2026', { archiveReason: 'x'.repeat(4001) })).status).toBe(400);
    expect(mocks.isStagingPublicationExecutionAvailable).not.toHaveBeenCalled();
    expect(mocks.executeControlledPublicRemoval).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed JSON', '{'],
    ['empty body', undefined],
  ])('rejects %s before policy evaluation', async (_label, body) => {
    const response = await POST(rawRequest(body), context('project_2026'));
    expect(response.status).toBe(400);
    expect(await read(response)).toEqual({ success: false, error: 'Validation failed.' });
    expect(mocks.isStagingPublicationExecutionAvailable).not.toHaveBeenCalled();
  });

  it('maps idempotency, competing operation, and recovery results without exposing internal evidence', async () => {
    mocks.executeControlledPublicRemoval.mockResolvedValue({ ...COMPLETED, resultCode: 'ALREADY_COMPLETED' });
    let response = await post();
    expect(response.status).toBe(200);
    expect(await read(response)).toMatchObject({ success: true, result: { resultCode: 'ALREADY_COMPLETED' } });

    mocks.executeControlledPublicRemoval.mockResolvedValue({ resultCode: 'PUBLICATION_IN_PROGRESS' });
    response = await post();
    expect(response.status).toBe(409);
    expect(await read(response)).toEqual({
      success: false, code: 'PUBLICATION_IN_PROGRESS',
      error: 'Another public-feed operation is already in progress.',
    });

    mocks.executeControlledPublicRemoval.mockResolvedValue({ resultCode: 'RECOVERY_REQUIRED' });
    response = await post();
    expect(response.status).toBe(409);
    expect(await read(response)).toEqual({
      success: false, code: 'RECOVERY_REQUIRED',
      error: 'Public-feed recovery is incomplete and requires attention.',
    });
  });

  it('preserves the dependency policy assertion as a second unavailable boundary', async () => {
    mocks.executeControlledPublicRemoval.mockResolvedValue({
      resultCode: 'EXECUTION_FAILED', failureCode: 'NON_LOCAL_ENVIRONMENT',
    });
    const response = await post();
    expect(response.status).toBe(404);
    expect(await read(response)).toMatchObject({ code: 'STAGING_ARCHIVE_UNAVAILABLE' });
  });

  it('maps not-published, divergence, and generic failures to exact bounded codes', async () => {
    mocks.executeControlledPublicRemoval.mockResolvedValue({ resultCode: 'NOT_PUBLISHED' });
    let response = await post();
    expect(response.status).toBe(409);
    expect(await read(response)).toEqual({
      success: false, code: 'NOT_PUBLISHED', error: 'The project is not currently published.',
    });

    mocks.executeControlledPublicRemoval.mockResolvedValue({
      resultCode: 'EXECUTION_FAILED', failureCode: 'CURRENT_FEED_DIVERGED',
    });
    response = await post();
    expect(response.status).toBe(409);
    expect(await read(response)).toEqual({
      success: false,
      code: 'CURRENT_FEED_DIVERGED',
      error: 'The canonical staging feed no longer matches the authoritative database. Archive was not performed.',
    });

    mocks.executeControlledPublicRemoval.mockResolvedValue({
      resultCode: 'EXECUTION_FAILED', failureCode: 'RAW_INTERNAL_STORAGE_DETAIL',
    });
    response = await post();
    expect(response.status).toBe(500);
    const failure = await read(response);
    expect(failure).toEqual({
      success: false,
      code: 'STAGING_ARCHIVE_FAILED',
      error: 'Staging showcase archive could not be completed.',
    });
    expect(JSON.stringify(failure)).not.toContain('RAW_INTERNAL');
  });

  it('returns a bounded generic failure when execution throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.executeControlledPublicRemoval.mockRejectedValue(new Error('raw operation id and storage URL'));
    const response = await post();
    expect(response.status).toBe(500);
    const failure = await read(response);
    expect(failure).toEqual({
      success: false,
      code: 'STAGING_ARCHIVE_FAILED',
      error: 'Staging showcase archive could not be completed.',
    });
    expect(JSON.stringify(failure)).not.toContain('raw operation');
    errorSpy.mockRestore();
  });

  it('ignores browser-supplied destination, operation identity, rollback, and media-deletion fields', async () => {
    const response = await post('route_project_2026', {
      archiveReason: 'Server-bound reason',
      publicId: 'browser_override',
      supabaseUrl: 'https://production.supabase.co',
      serviceRoleKey: 'browser-secret-value',
      feedBucket: 'attacker-feed',
      feedPath: 'attacker.json',
      operationId: 'attacker-operation',
      rollbackCapability: true,
      deletePublicMedia: true,
      publicAssetsBucket: 'attacker-assets',
    });
    expect(response.status).toBe(200);
    const json = await read(response);
    expect(JSON.stringify(json)).not.toContain('browser-secret-value');
    expect(JSON.stringify(mocks.createControlledPublicRemovalDependencies.mock.calls[0])).not.toContain('attacker');
    expect(mocks.createControlledPublicRemovalDependencies).toHaveBeenCalledWith(expect.objectContaining({
      supabaseUrl: mocks.env.supabaseUrl,
      feedBucket: 'server-public-feeds',
      feedPath: 'capstones-latest.json',
      executionTarget: 'staging',
      executionEnvironment: expect.any(Object),
    }));
    expect(mocks.executeControlledPublicRemoval).toHaveBeenCalledWith({
      permissions: ['projects.archive'],
      publicId: 'route_project_2026',
      archiveReason: 'Server-bound reason',
      dependencies,
    });
  });
});
