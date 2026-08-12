import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  preparePublicationPlan: vi.fn(),
  getPublicationReadiness: vi.fn(),
  listProjects: vi.fn(),
  listProjectMedia: vi.fn(),
  getPublicUrl: vi.fn(),
}));

vi.mock('../../../../../auth/requireAdmin', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('../../../../../projects/publicationPlanService', () => ({
  preparePublicationPlan: mocks.preparePublicationPlan,
}));
vi.mock('../../../../../repositories/SupabaseProjectRepository', () => ({
  SupabaseProjectRepository: class {
    listProjects = mocks.listProjects;
  },
}));
vi.mock('../../../../../repositories/SupabaseParticipantPreviewRepository', () => ({
  SupabaseParticipantPreviewRepository: class {
    getPublicationReadiness = mocks.getPublicationReadiness;
  },
}));
vi.mock('../../../../../repositories/SupabasePublicationExecutionRepository', () => ({
  SupabasePublicationExecutionRepository: class {
    listProjectMedia = mocks.listProjectMedia;
    getPublicUrl = mocks.getPublicUrl;
  },
}));
vi.mock('../../../../../lib/env', () => ({
  getServerEnv: () => ({
    SUPABASE_DRAFT_BUCKET: 'server-draft-bucket',
    SUPABASE_PUBLIC_ASSETS_BUCKET: 'server-public-assets',
  }),
}));

import { NextRequest } from 'next/server';
import { AdminAuthError } from '../../../../../auth/authTypes';
import { POST } from './route';

const SERVER_ADMIN = {
  adminUserId: 'server-admin-id',
  permissions: ['projects.publish'],
};
const READY_PLAN = {
  resultCode: 'READY_TO_STAGE',
  publicId: 'project_2026',
  confirmedPreviewId: 'server-preview-id',
  confirmedAt: '2026-08-12T03:04:05.000Z',
  recordCount: 2,
  feedHash: 'a'.repeat(64),
};

const context = (publicId: string) => ({ params: Promise.resolve({ publicId }) });

function request(options?: { origin?: string; body?: unknown }) {
  const origin = options?.origin ?? 'http://app.test';
  return new NextRequest('http://app.test/api/projects/project_2026/publication-plan', {
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

async function expectNoStore(response: Response) {
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  return response.json();
}

describe('POST /api/projects/[publicId]/publication-plan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue(SERVER_ADMIN);
    mocks.preparePublicationPlan.mockResolvedValue(READY_PLAN);
    mocks.listProjectMedia.mockResolvedValue([]);
    mocks.getPublicUrl.mockImplementation((bucket: string, path: string) => `http://app.test/${bucket}/${path}`);
  });

  it('authenticates a same-origin canonical underscore ID and returns the complete bounded READY plan', async () => {
    const response = await post('project_2026');

    expect(response.status).toBe(200);
    await expectNoStore(response).then((json) => {
      expect(json).toEqual({ success: true, result: READY_PLAN });
    });
    expect(mocks.requireAdmin).toHaveBeenCalledTimes(1);
    expect(mocks.preparePublicationPlan).toHaveBeenCalledTimes(1);
    expect(mocks.preparePublicationPlan).toHaveBeenCalledWith(
      SERVER_ADMIN.permissions,
      'project_2026',
      {
        getReadiness: expect.any(Function),
        listProjects: expect.any(Function),
        listProjectMedia: expect.any(Function),
        privateBucket: 'server-draft-bucket',
        publicBucket: 'server-public-assets',
        getPublicUrl: expect.any(Function),
      },
    );
  });

  it('rejects an invalid origin before authentication or publication planning', async () => {
    const response = await post('project_2026', { origin: 'http://evil.test' });

    expect(response.status).toBe(403);
    await expectNoStore(response).then((json) => {
      expect(json).toEqual({ success: false, error: 'Access denied.' });
    });
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
    expect(mocks.preparePublicationPlan).not.toHaveBeenCalled();
  });

  it('maps the established unauthenticated AdminAuthError to a public-safe response', async () => {
    mocks.requireAdmin.mockRejectedValue(
      new AdminAuthError('UNAUTHENTICATED', 'raw authentication provider detail'),
    );

    const response = await post('project_2026');

    expect(response.status).toBe(401);
    const json = await expectNoStore(response);
    expect(json).toEqual({ success: false, error: 'Authentication required.' });
    expect(JSON.stringify(json)).not.toContain('raw authentication provider detail');
    expect(mocks.preparePublicationPlan).not.toHaveBeenCalled();
  });

  it('accepts a public ID of exactly 100 valid characters', async () => {
    const publicId = `project_${'a'.repeat(92)}`;

    const response = await post(publicId);

    expect(publicId).toHaveLength(100);
    expect(response.status).toBe(200);
    await expectNoStore(response);
    expect(mocks.preparePublicationPlan).toHaveBeenCalledWith(
      SERVER_ADMIN.permissions,
      publicId,
      expect.objectContaining({
        getReadiness: expect.any(Function),
        listProjects: expect.any(Function),
      }),
    );
  });

  it('rejects a public ID of 101 valid characters before planning', async () => {
    const publicId = `project_${'a'.repeat(93)}`;

    const response = await post(publicId);

    expect(publicId).toHaveLength(101);
    expect(response.status).toBe(400);
    await expectNoStore(response).then((json) => {
      expect(json).toEqual({ success: false, error: 'Validation failed.' });
    });
    expect(mocks.preparePublicationPlan).not.toHaveBeenCalled();
  });

  it('rejects a blank public ID before planning', async () => {
    const response = await post('   ');

    expect(response.status).toBe(400);
    await expectNoStore(response).then((json) => {
      expect(json).toEqual({ success: false, error: 'Validation failed.' });
    });
    expect(mocks.preparePublicationPlan).not.toHaveBeenCalled();
  });

  it('rejects illegal public ID characters before planning', async () => {
    const response = await post('project/attacker');

    expect(response.status).toBe(400);
    await expectNoStore(response).then((json) => {
      expect(json).toEqual({ success: false, error: 'Validation failed.' });
    });
    expect(mocks.preparePublicationPlan).not.toHaveBeenCalled();
  });

  it('maps PERMISSION_DENIED to HTTP 403', async () => {
    mocks.preparePublicationPlan.mockResolvedValue({ resultCode: 'PERMISSION_DENIED' });

    const response = await post('project_2026');

    expect(response.status).toBe(403);
    await expectNoStore(response).then((json) => {
      expect(json).toEqual({ success: false, error: 'Access denied.' });
    });
  });

  it('maps NOT_READY to HTTP 409 while preserving only bounded readiness evidence', async () => {
    mocks.preparePublicationPlan.mockResolvedValue({
      resultCode: 'NOT_READY',
      readinessCode: 'CORRECTION_UNRESOLVED',
      blockers: ['Participant correction remains unresolved'],
    });

    const response = await post('project_2026');

    expect(response.status).toBe(409);
    const json = await expectNoStore(response);
    expect(json).toEqual({
      success: false,
      result: {
        resultCode: 'NOT_READY',
        readinessCode: 'CORRECTION_UNRESOLVED',
        blockers: ['Participant correction remains unresolved'],
      },
      error: 'Publication plan is unavailable.',
    });
    expect(json).not.toHaveProperty('result.privateBucket');
    expect(json).not.toHaveProperty('result.adminUserId');
  });

  it('maps PLAN_UNAVAILABLE to HTTP 409', async () => {
    mocks.preparePublicationPlan.mockResolvedValue({ resultCode: 'PLAN_UNAVAILABLE' });

    const response = await post('project_2026');

    expect(response.status).toBe(409);
    await expectNoStore(response).then((json) => {
      expect(json).toEqual({
        success: false,
        result: { resultCode: 'PLAN_UNAVAILABLE' },
        error: 'Publication plan is unavailable.',
      });
    });
  });

  it('returns a bounded generic 500 when publication planning throws unexpectedly', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.preparePublicationPlan.mockRejectedValue(new Error('raw database connection detail'));

    const response = await post('project_2026');

    expect(response.status).toBe(500);
    const json = await expectNoStore(response);
    expect(json).toEqual({ success: false, error: 'Publication plan is unavailable.' });
    expect(JSON.stringify(json)).not.toContain('raw database connection detail');
    expect(consoleError).toHaveBeenCalledWith('[Publication plan API Error]: unavailable');
    consoleError.mockRestore();
  });

  it('derives identity, permissions, bucket, repositories, and readiness inputs only from the server', async () => {
    const maliciousBody = {
      adminUserId: 'attacker',
      permissions: ['projects.publish'],
      privateBucket: 'project-public-assets',
      publicId: 'attacker-project',
      confirmedPreviewId: 'attacker-preview',
      confirmedAt: '2099-01-01T00:00:00Z',
      feedHash: 'attacker-hash',
    };
    const serverReadiness = {
      ready: true,
      resultCode: 'READY',
      blockers: [],
      confirmedPreviewId: 'server-preview-id',
      confirmedAt: '2026-08-12T03:04:05.000Z',
    };
    const serverProjects = [{ publicId: 'server-project' }];
    mocks.getPublicationReadiness.mockResolvedValue(serverReadiness);
    mocks.listProjects.mockResolvedValue(serverProjects);

    const response = await post('route_project_2026', { body: maliciousBody });

    expect(response.status).toBe(200);
    const json = await expectNoStore(response);
    expect(json).toEqual({ success: true, result: READY_PLAN });
    expect(JSON.stringify(json)).not.toContain('attacker');
    expect(mocks.preparePublicationPlan).toHaveBeenCalledTimes(1);
    const [permissions, publicId, dependencies] = mocks.preparePublicationPlan.mock.calls[0];
    expect(permissions).toEqual(['projects.publish']);
    expect(publicId).toBe('route_project_2026');

    await expect(dependencies.getReadiness()).resolves.toEqual(serverReadiness);
    await expect(dependencies.listProjects()).resolves.toEqual(serverProjects);
    expect(mocks.getPublicationReadiness).toHaveBeenCalledExactlyOnceWith({
      publicId: 'route_project_2026',
      adminId: 'server-admin-id',
      privateBucket: 'server-draft-bucket',
    });
    expect(mocks.listProjects).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.preparePublicationPlan.mock.calls[0])).not.toContain('attacker');
    expect(JSON.stringify(mocks.getPublicationReadiness.mock.calls[0])).not.toContain('attacker');
  });
});
