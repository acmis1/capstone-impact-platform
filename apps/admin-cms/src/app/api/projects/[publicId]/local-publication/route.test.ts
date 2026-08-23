import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  executeControlledPublication: vi.fn(),
  createControlledPublicationDependencies: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
  env: {
    supabaseUrl: 'http://127.0.0.1:54321',
    SUPABASE_DRAFT_BUCKET: 'server-draft-bucket',
    SUPABASE_PUBLIC_ASSETS_BUCKET: 'server-public-assets',
    SUPABASE_PUBLIC_FEEDS_BUCKET: 'server-public-feeds',
    SUPABASE_PUBLIC_FEED_FILE: 'server-feed.json',
  },
}));

vi.mock('../../../../../auth/requireAdmin', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('../../../../../projects/controlledPublicationService', () => ({
  executeControlledPublication: mocks.executeControlledPublication,
}));
vi.mock('../../../../../projects/createControlledPublicationDependencies', () => ({
  createControlledPublicationDependencies: mocks.createControlledPublicationDependencies,
}));
vi.mock('../../../../../lib/supabase/admin', () => ({
  createSupabaseAdminClient: mocks.createSupabaseAdminClient,
}));
vi.mock('../../../../../lib/env', () => ({ getServerEnv: () => mocks.env }));

import { NextRequest } from 'next/server';
import { AdminAuthError } from '../../../../../auth/authTypes';
import { POST } from './route';

const SERVER_ADMIN = {
  adminUserId: 'server-admin-id',
  permissions: ['projects.publish'],
};
const COMPLETED = {
  resultCode: 'COMPLETED',
  attemptId: 'internal-attempt-id',
  snapshotId: 'safe-snapshot-id',
  auditRecordId: 'internal-audit-id',
  recordCount: 2,
  feedHash: 'a'.repeat(64),
  feedPublicUrl: 'http://127.0.0.1:54321/storage/v1/object/public/server-public-feeds/server-feed.json',
};
const dependencies = { assertExecutionEnvironment: vi.fn(), executionToken: 'server-token' };
const supabase = { serverClient: true };
const context = (publicId: string) => ({ params: Promise.resolve({ publicId }) });

function request(options?: { origin?: string; body?: unknown }) {
  const origin = options?.origin ?? 'http://app.test';
  return new NextRequest('http://app.test/api/projects/project_2026/local-publication', {
    method: 'POST',
    headers: {
      origin,
      ...(options?.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: options?.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function post(publicId: string, options?: { origin?: string; body?: unknown }) {
  return POST(request(options), context(publicId));
}

async function read(response: Response) {
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  return response.json();
}

describe('POST /api/projects/[publicId]/local-publication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.env.supabaseUrl = 'http://127.0.0.1:54321';
    mocks.requireAdmin.mockResolvedValue(SERVER_ADMIN);
    mocks.createSupabaseAdminClient.mockReturnValue(supabase);
    mocks.createControlledPublicationDependencies.mockReturnValue(dependencies);
    mocks.executeControlledPublication.mockResolvedValue(COMPLETED);
  });

  it('executes a same-origin admin request with an underscore ID and returns bounded completion evidence', async () => {
    const response = await post('project_2026');

    expect(response.status).toBe(200);
    expect(await read(response)).toEqual({
      success: true,
      result: {
        resultCode: 'COMPLETED',
        publicId: 'project_2026',
        snapshotId: 'safe-snapshot-id',
        recordCount: 2,
        feedHash: 'a'.repeat(64),
        feedPublicUrl: COMPLETED.feedPublicUrl,
      },
    });
    expect(mocks.createControlledPublicationDependencies).toHaveBeenCalledWith({
      supabase,
      supabaseUrl: 'http://127.0.0.1:54321',
      publicId: 'project_2026',
      adminId: 'server-admin-id',
      privateBucket: 'server-draft-bucket',
      publicFeedBucket: 'server-public-feeds',
      publicFeedPath: 'server-feed.json',
      executionTarget: 'local',
    });
    expect(mocks.executeControlledPublication).toHaveBeenCalledWith({
      permissions: ['projects.publish'],
      publicId: 'project_2026',
      privateBucket: 'server-draft-bucket',
      publicAssetsBucket: 'server-public-assets',
      publicFeedBucket: 'server-public-feeds',
      publicFeedPath: 'server-feed.json',
      dependencies,
    });
  });

  it('rejects an invalid Origin before authentication or execution', async () => {
    const response = await post('project_2026', { origin: 'http://evil.test' });
    expect(response.status).toBe(403);
    expect(await read(response)).toEqual({ success: false, error: 'Access denied.' });
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
    expect(mocks.executeControlledPublication).not.toHaveBeenCalled();
  });

  it('maps unauthenticated access through the established bounded auth contract', async () => {
    mocks.requireAdmin.mockRejectedValue(new AdminAuthError('UNAUTHENTICATED', 'raw provider detail'));
    const response = await post('project_2026');
    expect(response.status).toBe(401);
    const json = await read(response);
    expect(json).toEqual({ success: false, error: 'Authentication required.' });
    expect(JSON.stringify(json)).not.toContain('raw provider detail');
    expect(mocks.executeControlledPublication).not.toHaveBeenCalled();
  });

  it.each([
    ['reviewer', ['projects.read', 'projects.review']],
    ['editor', ['projects.read', 'projects.edit']],
  ])('rejects a %s without projects.publish before dependency creation', async (_role, permissions) => {
    mocks.requireAdmin.mockResolvedValue({ adminUserId: 'staff-id', permissions });
    const response = await post('project_2026');
    expect(response.status).toBe(403);
    expect(await read(response)).toEqual({ success: false, error: 'Access denied.' });
    expect(mocks.createControlledPublicationDependencies).not.toHaveBeenCalled();
    expect(mocks.executeControlledPublication).not.toHaveBeenCalled();
  });

  it('rejects an invalid public ID before authentication or execution', async () => {
    const response = await post('project/attacker');
    expect(response.status).toBe(400);
    expect(await read(response)).toEqual({ success: false, error: 'Validation failed.' });
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
    expect(mocks.executeControlledPublication).not.toHaveBeenCalled();
  });

  it('accepts a public ID of exactly 100 valid characters', async () => {
    const publicId = `project_${'a'.repeat(92)}`;
    const response = await post(publicId);
    expect(publicId).toHaveLength(100);
    expect(response.status).toBe(200);
    await read(response);
    expect(mocks.executeControlledPublication).toHaveBeenCalledWith(expect.objectContaining({ publicId }));
  });

  it('rejects a public ID of 101 characters before execution', async () => {
    const publicId = `project_${'a'.repeat(93)}`;
    const response = await post(publicId);
    expect(publicId).toHaveLength(101);
    expect(response.status).toBe(400);
    await read(response);
    expect(mocks.executeControlledPublication).not.toHaveBeenCalled();
  });

  it('fails closed before dependency creation on a hosted Supabase endpoint', async () => {
    mocks.env.supabaseUrl = 'https://hosted-project.supabase.co';
    const response = await post('project_2026');
    expect(response.status).toBe(404);
    expect(await read(response)).toEqual({
      success: false,
      code: 'LOCAL_PUBLICATION_UNAVAILABLE',
      error: 'Local publication execution is unavailable.',
    });
    expect(mocks.createControlledPublicationDependencies).not.toHaveBeenCalled();
    expect(mocks.executeControlledPublication).not.toHaveBeenCalled();
  });

  it('maps ALREADY_COMPLETED to a bounded idempotent HTTP 200 result', async () => {
    mocks.executeControlledPublication.mockResolvedValue({ ...COMPLETED, resultCode: 'ALREADY_COMPLETED' });
    const response = await post('project_2026');
    expect(response.status).toBe(200);
    expect(await read(response)).toMatchObject({ success: true, result: { resultCode: 'ALREADY_COMPLETED' } });
  });

  it('maps NOT_READY to HTTP 409 with bounded readiness evidence', async () => {
    mocks.executeControlledPublication.mockResolvedValue({
      resultCode: 'NOT_READY',
      readinessCode: 'CONFIRMATION_STALE',
      blockers: ['Participant confirmation is stale'],
    });
    const response = await post('project_2026');
    expect(response.status).toBe(409);
    expect(await read(response)).toEqual({
      success: false,
      result: { resultCode: 'NOT_READY', readinessCode: 'CONFIRMATION_STALE', blockers: ['Participant confirmation is stale'] },
      error: 'Readiness changed. Generate a new publication plan.',
    });
  });

  it('maps PUBLICATION_IN_PROGRESS to a bounded HTTP 409 response', async () => {
    mocks.executeControlledPublication.mockResolvedValue({ resultCode: 'PUBLICATION_IN_PROGRESS' });
    const response = await post('project_2026');
    expect(response.status).toBe(409);
    expect(await read(response)).toEqual({ success: false, code: 'PUBLICATION_IN_PROGRESS', error: 'Another publication is already in progress.' });
  });

  it('maps COMPENSATION_INCOMPLETE to a bounded intervention response', async () => {
    mocks.executeControlledPublication.mockResolvedValue({ resultCode: 'COMPENSATION_INCOMPLETE' });
    const response = await post('project_2026');
    expect(response.status).toBe(409);
    expect(await read(response)).toEqual({ success: false, code: 'COMPENSATION_INCOMPLETE', error: 'Publication recovery is incomplete and requires attention.' });
  });

  it('maps a newly failed compensation to the same bounded intervention response', async () => {
    mocks.executeControlledPublication.mockResolvedValue({
      resultCode: 'EXECUTION_FAILED',
      failureCode: 'FEED_UPLOAD_FAILED',
      compensationFailureCode: 'raw-internal-compensation-code',
    });
    const response = await post('project_2026');
    expect(response.status).toBe(409);
    const json = await read(response);
    expect(json).toEqual({ success: false, code: 'COMPENSATION_INCOMPLETE', error: 'Publication recovery is incomplete and requires attention.' });
    expect(JSON.stringify(json)).not.toContain('raw-internal-compensation-code');
  });

  it('maps coordinator PERMISSION_DENIED to HTTP 403', async () => {
    mocks.executeControlledPublication.mockResolvedValue({ resultCode: 'PERMISSION_DENIED' });
    const response = await post('project_2026');
    expect(response.status).toBe(403);
    expect(await read(response)).toEqual({ success: false, error: 'Access denied.' });
  });

  it('preserves the coordinator-level policy failure as a second unavailable boundary', async () => {
    mocks.executeControlledPublication.mockResolvedValue({ resultCode: 'EXECUTION_FAILED', failureCode: 'EXECUTION_POLICY_DENIED' });
    const response = await post('project_2026');
    expect(response.status).toBe(404);
    expect(await read(response)).toMatchObject({ success: false, code: 'LOCAL_PUBLICATION_UNAVAILABLE' });
  });

  it('returns a bounded 500 without raw coordinator exception detail', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.executeControlledPublication.mockRejectedValue(new Error('raw database storage detail'));
    const response = await post('project_2026');
    expect(response.status).toBe(500);
    const json = await read(response);
    expect(json).toEqual({ success: false, error: 'Local publication could not be completed.' });
    expect(JSON.stringify(json)).not.toContain('raw database storage detail');
    expect(consoleError).toHaveBeenCalledWith('[Local publication API Error]: unavailable');
    consoleError.mockRestore();
  });

  it('ignores every malicious browser authority field and uses only route, admin, and environment authority', async () => {
    const maliciousBody = {
      adminUserId: 'attacker',
      permissions: ['projects.publish'],
      privateBucket: 'project-public-assets',
      publicAssetsBucket: 'attacker-assets',
      publicFeedBucket: 'attacker-feed',
      publicFeedPath: 'attacker.json',
      confirmedPreviewId: 'attacker-preview',
      confirmedAt: '2099-01-01T00:00:00Z',
      feedHash: 'attacker-hash',
      recordCount: 999999,
      executionToken: 'attacker-token',
    };
    const response = await post('route_project_2026', { body: maliciousBody });
    expect(response.status).toBe(200);
    const json = await read(response);
    expect(JSON.stringify(json)).not.toContain('attacker');
    expect(JSON.stringify(mocks.createControlledPublicationDependencies.mock.calls[0])).not.toContain('attacker');
    expect(JSON.stringify(mocks.executeControlledPublication.mock.calls[0])).not.toContain('attacker');
    expect(mocks.executeControlledPublication).toHaveBeenCalledWith(expect.objectContaining({
      publicId: 'route_project_2026',
      permissions: ['projects.publish'],
      privateBucket: 'server-draft-bucket',
      publicAssetsBucket: 'server-public-assets',
      publicFeedBucket: 'server-public-feeds',
      publicFeedPath: 'server-feed.json',
      dependencies,
    }));
  });
});
