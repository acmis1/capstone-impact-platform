import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
  createPublicFeedHistoryDependencies: vi.fn(),
  isPublicFeedRollbackEnvironmentAvailable: vi.fn(),
  transitionPublicFeedRollbackCapability: vi.fn(),
  env: {
    supabaseUrl: 'https://synthetic-a06-staging.supabase.co',
    SUPABASE_PUBLIC_FEEDS_BUCKET: 'server-public-feeds',
    SUPABASE_PUBLIC_FEED_FILE: 'capstones-latest.json',
  },
}));

vi.mock('../../../../../auth/requireAdmin', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('../../../../../lib/supabase/admin', () => ({
  createSupabaseAdminClient: mocks.createSupabaseAdminClient,
}));
vi.mock('../../../../../lib/env', () => ({ getServerEnv: () => mocks.env }));
vi.mock('../../../../../projects/createPublicFeedHistoryDependencies', () => ({
  createPublicFeedHistoryDependencies: mocks.createPublicFeedHistoryDependencies,
}));
vi.mock('../../../../../projects/publicFeedRollbackPolicy', () => ({
  isPublicFeedRollbackEnvironmentAvailable: mocks.isPublicFeedRollbackEnvironmentAvailable,
}));
vi.mock('../../../../../projects/publicFeedHistoryService', () => ({
  transitionPublicFeedRollbackCapability: mocks.transitionPublicFeedRollbackCapability,
}));

import { NextRequest } from 'next/server';
import { AdminAuthError } from '../../../../../auth/authTypes';
import { POST } from './route';

const EVIDENCE = {
  expectedVersionNumber: 7,
  expectedGeneration: 9,
  expectedFeedHash: 'a'.repeat(64),
  expectedRecordCount: 2,
};
const CONFIRMATION = `ENABLE PUBLIC FEED ROLLBACK FOR VERSION 7 GENERATION 9 HASH ${'a'.repeat(64)} COUNT 2`;
const dependencies = { serverDependencies: true };

function request(body: unknown, origin = 'https://admin-staging.example') {
  return new NextRequest('https://admin-staging.example/api/public-feed/rollback/capability', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function read(response: Response) {
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  return response.json();
}

describe('POST /api/public-feed/rollback/capability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({
      adminUserId: 'server-admin-id',
      permissions: ['projects.publish'],
    });
    mocks.createSupabaseAdminClient.mockReturnValue({ serverClient: true });
    mocks.createPublicFeedHistoryDependencies.mockReturnValue(dependencies);
    mocks.isPublicFeedRollbackEnvironmentAvailable.mockReturnValue(true);
    mocks.transitionPublicFeedRollbackCapability.mockResolvedValue({
      resultCode: 'CAPABILITY_UPDATED',
      eventId: 'safe-event-id',
      createdAt: '2026-09-10T00:00:00.000Z',
      previousEnabled: false,
      rollbackEnabled: true,
      versionNumber: 7,
      generation: 9,
      feedHash: 'a'.repeat(64),
      recordCount: 2,
    });
  });

  it('passes only server-derived identity and exact typed head evidence to the transition', async () => {
    const response = await POST(request({
      enabled: true,
      ...EVIDENCE,
      confirmation: CONFIRMATION,
      adminId: 'browser-admin-id',
      supabaseUrl: 'https://production.supabase.co',
    }));

    expect(response.status).toBe(200);
    expect(await read(response)).toMatchObject({
      success: true,
      result: { resultCode: 'CAPABILITY_UPDATED', rollbackEnabled: true },
    });
    expect(mocks.createPublicFeedHistoryDependencies).toHaveBeenCalledWith(expect.objectContaining({
      adminId: 'server-admin-id',
      supabaseUrl: mocks.env.supabaseUrl,
      feedBucket: 'server-public-feeds',
      feedPath: 'capstones-latest.json',
    }));
    expect(mocks.transitionPublicFeedRollbackCapability).toHaveBeenCalledWith(
      dependencies,
      true,
      {
        versionNumber: 7,
        generation: 9,
        feedHash: 'a'.repeat(64),
        recordCount: 2,
      },
      CONFIRMATION,
    );
  });

  it('rejects cross-origin traffic before authentication', async () => {
    const response = await POST(request({ enabled: true, ...EVIDENCE, confirmation: CONFIRMATION }, 'https://evil.example'));
    expect(response.status).toBe(403);
    expect(await read(response)).toEqual({ success: false, error: 'Access denied.' });
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
  });

  it('uses the bounded authentication error contract', async () => {
    mocks.requireAdmin.mockRejectedValue(new AdminAuthError('UNAUTHENTICATED', 'raw provider detail'));
    const response = await POST(request({ enabled: true, ...EVIDENCE, confirmation: CONFIRMATION }));
    expect(response.status).toBe(401);
    expect(await read(response)).toEqual({ success: false, error: 'Authentication required.' });
  });

  it('rejects staff without publication authority before policy or database work', async () => {
    mocks.requireAdmin.mockResolvedValue({
      adminUserId: 'reviewer-id',
      permissions: ['projects.read', 'projects.review'],
    });
    const response = await POST(request({ enabled: true, ...EVIDENCE, confirmation: CONFIRMATION }));
    expect(response.status).toBe(403);
    expect(await read(response)).toEqual({ success: false, error: 'Access denied.' });
    expect(mocks.isPublicFeedRollbackEnvironmentAvailable).not.toHaveBeenCalled();
    expect(mocks.transitionPublicFeedRollbackCapability).not.toHaveBeenCalled();
  });

  it('rejects malformed or non-exact evidence before policy or database work', async () => {
    const response = await POST(request({
      enabled: true,
      ...EVIDENCE,
      expectedFeedHash: 'A'.repeat(64),
      confirmation: CONFIRMATION,
    }));
    expect(response.status).toBe(400);
    expect(await read(response)).toEqual({ success: false, error: 'Validation failed.' });
    expect(mocks.isPublicFeedRollbackEnvironmentAvailable).not.toHaveBeenCalled();
    expect(mocks.transitionPublicFeedRollbackCapability).not.toHaveBeenCalled();
  });

  it('fails closed before dependency creation when rollback is not verified for this runtime', async () => {
    mocks.isPublicFeedRollbackEnvironmentAvailable.mockReturnValue(false);
    const response = await POST(request({ enabled: true, ...EVIDENCE, confirmation: CONFIRMATION }));
    expect(response.status).toBe(404);
    expect(await read(response)).toEqual({
      success: false,
      code: 'ROLLBACK_UNAVAILABLE',
      error: 'Public feed rollback capability is unavailable.',
    });
    expect(mocks.createPublicFeedHistoryDependencies).not.toHaveBeenCalled();
    expect(mocks.transitionPublicFeedRollbackCapability).not.toHaveBeenCalled();
  });
});
