import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  availability: vi.fn(),
  gateway: {
    loadProjects: vi.fn(),
    inspectInput: vi.fn(),
    loadCurrentRun: vi.fn(),
    enqueueProject: vi.fn(),
  },
}));

vi.mock('../../../../../auth/requireAdmin', () => ({ requireAdmin: auth.requireAdmin }));
vi.mock('../../../../../lib/env', () => ({
  getServerEnv: vi.fn(() => ({ supabaseUrl: 'http://127.0.0.1:54321', SUPABASE_DRAFT_BUCKET: 'private' })),
}));
vi.mock('../../../../../lib/supabase/admin', () => ({ createSupabaseAdminClient: vi.fn(() => ({})) }));
vi.mock('../../../../../assistive-validation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../assistive-validation')>();
  return {
    ...actual,
    resolveAssistiveExecutionAvailability: auth.availability,
    SupabaseBulkAssistiveExecutionGateway: class {
      loadProjects = auth.gateway.loadProjects;
      inspectInput = auth.gateway.inspectInput;
      loadCurrentRun = auth.gateway.loadCurrentRun;
      enqueueProject = auth.gateway.enqueueProject;
    },
  };
});

import { POST } from './route';

const hash = 'a'.repeat(64);

function request(body: unknown): NextRequest {
  const payload = JSON.stringify(body);
  return new NextRequest('http://localhost/api/projects/bulk-assistive/execute', {
    method: 'POST',
    headers: {
      origin: 'http://localhost',
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(payload, 'utf8')),
    },
    body: payload,
  });
}

describe('bulk assistive execute route', () => {
  beforeEach(() => {
    auth.requireAdmin.mockReset();
    auth.availability.mockReset();
    Object.values(auth.gateway).forEach((mock) => mock.mockReset());
    auth.requireAdmin.mockResolvedValue({ adminUserId: 'admin-1', permissions: ['projects.edit'] });
    auth.availability.mockResolvedValue({ state: 'ON_DEMAND_READY', canEnqueue: true, message: null });
    auth.gateway.loadProjects.mockResolvedValue(new Map([['project-a', {
      projectId: '11111111-1111-4111-8111-111111111111', publicId: 'project-a', title: 'Project A',
    }]]));
    auth.gateway.inspectInput.mockResolvedValue({ kind: 'VALID', inputHash: hash });
    auth.gateway.loadCurrentRun.mockResolvedValue(null);
    auth.gateway.enqueueProject.mockResolvedValue({
      resultCode: 'ENQUEUED', runId: '22222222-2222-4222-8222-222222222222', status: 'QUEUED',
    });
  });

  it('revalidates the input hash server-side and enqueues through the existing per-project authority', async () => {
    const response = await POST(request({
      publicIds: ['project-a'], expectedInputHashes: { 'project-a': hash },
    }));
    expect(response.status).toBe(200);
    expect((await response.json()).summary).toMatchObject({ total: 1, enqueued: 1 });
    expect(auth.gateway.enqueueProject).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'admin-1',
      hash,
      'project-a',
    );
  });

  it('rejects a read-only caller before availability or mutation', async () => {
    auth.requireAdmin.mockResolvedValue({ adminUserId: 'admin-1', permissions: ['projects.read'] });
    const response = await POST(request({
      publicIds: ['project-a'], expectedInputHashes: { 'project-a': hash },
    }));
    expect(response.status).toBe(403);
    expect(auth.availability).not.toHaveBeenCalled();
    expect(auth.gateway.loadProjects).not.toHaveBeenCalled();
    expect(auth.gateway.enqueueProject).not.toHaveBeenCalled();
  });

  it('rejects 51 IDs before auth or mutation', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `project-${i}`);
    const response = await POST(request({ publicIds: ids, expectedInputHashes: {} }));
    expect(response.status).toBe(400);
    expect(auth.requireAdmin).not.toHaveBeenCalled();
    expect(auth.gateway.enqueueProject).not.toHaveBeenCalled();
  });
});
