import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  executeControlledPublication: vi.fn(),
  createControlledPublicationDependencies: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
  isStagingPublicationExecutionAvailable: vi.fn(),
  env: {
    supabaseUrl: 'https://synthetic-pp1-staging.supabase.co',
    SUPABASE_DRAFT_BUCKET: 'server-draft-bucket',
    SUPABASE_PUBLIC_ASSETS_BUCKET: 'server-public-assets',
    SUPABASE_PUBLIC_FEEDS_BUCKET: 'server-public-feeds',
    SUPABASE_PUBLIC_FEED_FILE: 'capstones-latest.json',
  },
}));

vi.mock('../../../../../auth/requireAdmin', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('../../../../../projects/controlledPublicationService', () => ({
  executeControlledPublication: mocks.executeControlledPublication,
}));
vi.mock('../../../../../projects/createControlledPublicationDependencies', () => ({
  createControlledPublicationDependencies: mocks.createControlledPublicationDependencies,
}));
vi.mock('../../../../../projects/publicationExecutionPolicy', () => ({
  isStagingPublicationExecutionAvailable: mocks.isStagingPublicationExecutionAvailable,
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
const FEED_PUBLIC_URL = 'https://synthetic-pp1-staging.supabase.co/storage/v1/object/public/server-public-feeds/capstones-latest.json';
const COMPLETED = {
  resultCode: 'COMPLETED',
  attemptId: 'internal-attempt-id',
  snapshotId: 'safe-snapshot-id',
  auditRecordId: 'internal-audit-id',
  recordCount: 2,
  feedHash: 'a'.repeat(64),
  feedPublicUrl: FEED_PUBLIC_URL,
};
const dependencies = { assertExecutionEnvironment: vi.fn(), executionToken: 'server-token' };
const supabase = { serverClient: true };
const context = (publicId: string) => ({ params: Promise.resolve({ publicId }) });

function request(options?: { origin?: string; body?: unknown }) {
  return new NextRequest('https://admin-staging.example/api/projects/project_2026/staging-publication', {
    method: 'POST',
    headers: {
      origin: options?.origin ?? 'https://admin-staging.example',
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

describe('POST /api/projects/[publicId]/staging-publication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue(SERVER_ADMIN);
    mocks.createSupabaseAdminClient.mockReturnValue(supabase);
    mocks.createControlledPublicationDependencies.mockReturnValue(dependencies);
    mocks.isStagingPublicationExecutionAvailable.mockReturnValue(true);
    mocks.executeControlledPublication.mockResolvedValue(COMPLETED);
  });

  it('executes an authorized staging request and returns safe stable-feed evidence', async () => {
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
        feedPublicUrl: FEED_PUBLIC_URL,
      },
    });
    expect(mocks.isStagingPublicationExecutionAvailable).toHaveBeenCalledWith(mocks.env.supabaseUrl);
    expect(mocks.createControlledPublicationDependencies).toHaveBeenCalledWith({
      supabase,
      supabaseUrl: mocks.env.supabaseUrl,
      publicId: 'project_2026',
      adminId: 'server-admin-id',
      privateBucket: 'server-draft-bucket',
      publicFeedBucket: 'server-public-feeds',
      publicFeedPath: 'capstones-latest.json',
      executionTarget: 'staging',
    });
    expect(mocks.executeControlledPublication).toHaveBeenCalledWith({
      permissions: ['projects.publish'],
      publicId: 'project_2026',
      privateBucket: 'server-draft-bucket',
      publicAssetsBucket: 'server-public-assets',
      publicFeedBucket: 'server-public-feeds',
      publicFeedPath: 'capstones-latest.json',
      dependencies,
    });
  });

  it('rejects cross-origin requests before authentication or policy evaluation', async () => {
    const response = await post('project_2026', { origin: 'https://evil.example' });
    expect(response.status).toBe(403);
    expect(await read(response)).toEqual({ success: false, error: 'Access denied.' });
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
    expect(mocks.isStagingPublicationExecutionAvailable).not.toHaveBeenCalled();
  });

  it('rejects malformed public IDs before authentication or execution', async () => {
    const response = await post('project/attacker');
    expect(response.status).toBe(400);
    expect(await read(response)).toEqual({ success: false, error: 'Validation failed.' });
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
    expect(mocks.executeControlledPublication).not.toHaveBeenCalled();
  });

  it('maps unauthenticated access through the bounded auth contract', async () => {
    mocks.requireAdmin.mockRejectedValue(new AdminAuthError('UNAUTHENTICATED', 'raw provider detail'));
    const response = await post('project_2026');
    expect(response.status).toBe(401);
    const json = await read(response);
    expect(json).toEqual({ success: false, error: 'Authentication required.' });
    expect(JSON.stringify(json)).not.toContain('raw provider detail');
    expect(mocks.isStagingPublicationExecutionAvailable).not.toHaveBeenCalled();
  });

  it('rejects staff without publication permission before policy evaluation', async () => {
    mocks.requireAdmin.mockResolvedValue({ adminUserId: 'reviewer-id', permissions: ['projects.read', 'projects.review'] });
    const response = await post('project_2026');
    expect(response.status).toBe(403);
    expect(await read(response)).toEqual({ success: false, error: 'Access denied.' });
    expect(mocks.isStagingPublicationExecutionAvailable).not.toHaveBeenCalled();
    expect(mocks.executeControlledPublication).not.toHaveBeenCalled();
  });

  it('fails closed before dependency creation when staging publication is unavailable', async () => {
    mocks.isStagingPublicationExecutionAvailable.mockReturnValue(false);
    const response = await post('project_2026');
    expect(response.status).toBe(404);
    expect(await read(response)).toEqual({
      success: false,
      code: 'STAGING_PUBLICATION_UNAVAILABLE',
      error: 'Staging showcase publication is unavailable.',
    });
    expect(mocks.createControlledPublicationDependencies).not.toHaveBeenCalled();
    expect(mocks.executeControlledPublication).not.toHaveBeenCalled();
  });

  it('maps ALREADY_COMPLETED to a bounded idempotent success with feed evidence', async () => {
    mocks.executeControlledPublication.mockResolvedValue({ ...COMPLETED, resultCode: 'ALREADY_COMPLETED' });
    const response = await post('project_2026');
    expect(response.status).toBe(200);
    expect(await read(response)).toMatchObject({
      success: true,
      result: { resultCode: 'ALREADY_COMPLETED', feedPublicUrl: FEED_PUBLIC_URL },
    });
  });

  it('maps readiness changes to HTTP 409 with bounded evidence', async () => {
    mocks.executeControlledPublication.mockResolvedValue({
      resultCode: 'NOT_READY',
      readinessCode: 'CONFIRMATION_STALE',
      blockers: ['Participant confirmation is stale'],
    });
    const response = await post('project_2026');
    expect(response.status).toBe(409);
    expect(await read(response)).toEqual({
      success: false,
      result: {
        resultCode: 'NOT_READY',
        readinessCode: 'CONFIRMATION_STALE',
        blockers: ['Participant confirmation is stale'],
      },
      error: 'Readiness changed. Generate a new publication plan.',
    });
  });

  it('maps publication-in-progress and required recovery to bounded HTTP 409 results', async () => {
    mocks.executeControlledPublication.mockResolvedValue({ resultCode: 'PUBLICATION_IN_PROGRESS' });
    let response = await post('project_2026');
    expect(response.status).toBe(409);
    expect(await read(response)).toEqual({
      success: false,
      code: 'PUBLICATION_IN_PROGRESS',
      error: 'Another publication is already in progress.',
    });

    mocks.executeControlledPublication.mockResolvedValue({ resultCode: 'RECOVERY_REQUIRED' });
    response = await post('project_2026');
    expect(response.status).toBe(409);
    expect(await read(response)).toEqual({
      success: false,
      code: 'RECOVERY_REQUIRED',
      error: 'Publication recovery is incomplete and requires attention.',
    });
  });

  it('preserves the coordinator policy assertion as a second unavailable boundary', async () => {
    mocks.executeControlledPublication.mockResolvedValue({
      resultCode: 'EXECUTION_FAILED',
      failureCode: 'EXECUTION_POLICY_DENIED',
    });
    const response = await post('project_2026');
    expect(response.status).toBe(404);
    expect(await read(response)).toMatchObject({
      success: false,
      code: 'STAGING_PUBLICATION_UNAVAILABLE',
    });
  });

  it('ignores browser-supplied environment, credentials, and storage destinations', async () => {
    const response = await post('route_project_2026', {
      body: {
        staging: true,
        supabaseUrl: 'https://production.supabase.co',
        serviceRoleKey: 'browser-secret-value',
        publicFeedBucket: 'attacker-feed',
        publicFeedPath: 'attacker.json',
        executionTarget: 'staging',
      },
    });
    expect(response.status).toBe(200);
    const json = await read(response);
    expect(JSON.stringify(json)).not.toContain('browser-secret-value');
    expect(JSON.stringify(mocks.createControlledPublicationDependencies.mock.calls[0])).not.toContain('attacker');
    expect(mocks.createControlledPublicationDependencies).toHaveBeenCalledWith(expect.objectContaining({
      supabaseUrl: mocks.env.supabaseUrl,
      publicFeedBucket: 'server-public-feeds',
      publicFeedPath: 'capstones-latest.json',
      executionTarget: 'staging',
    }));
  });
});
