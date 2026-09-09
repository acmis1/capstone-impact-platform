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

const record = { projectId: '11111111-1111-4111-8111-111111111111', publicId: 'project-a', title: 'Project A' };
const hash = 'a'.repeat(64);

function request(body: unknown, origin = 'http://localhost', contentLength?: string | null): NextRequest {
  const payload = JSON.stringify(body);
  const headers: Record<string, string> = { origin, 'content-type': 'application/json' };
  const stated = contentLength === undefined ? String(Buffer.byteLength(payload, 'utf8')) : contentLength;
  if (stated !== null) headers['content-length'] = stated;
  return new NextRequest('http://localhost/api/projects/bulk-assistive/preflight', {
    method: 'POST', headers, body: payload,
  });
}

describe('bulk assistive preflight route', () => {
  beforeEach(() => {
    auth.requireAdmin.mockReset();
    auth.availability.mockReset();
    Object.values(auth.gateway).forEach((mock) => mock.mockReset());
    auth.requireAdmin.mockResolvedValue({ adminUserId: 'admin-1', permissions: ['projects.edit'] });
    auth.availability.mockResolvedValue({ state: 'READY', canEnqueue: true, message: null });
    auth.gateway.loadProjects.mockResolvedValue(new Map([['project-a', record]]));
    auth.gateway.inspectInput.mockResolvedValue({ kind: 'VALID', inputHash: hash });
    auth.gateway.loadCurrentRun.mockResolvedValue(null);
  });

  it('rejects more than 50 IDs before auth or project access', async () => {
    const response = await POST(request({ publicIds: Array.from({ length: 51 }, (_, i) => `project-${i}`) }));
    expect(response.status).toBe(400);
    expect(auth.requireAdmin).not.toHaveBeenCalled();
    expect(auth.gateway.loadProjects).not.toHaveBeenCalled();
  });

  it('derives permission and availability on the server and returns a bounded preflight', async () => {
    const response = await POST(request({ publicIds: ['project-a'] }));
    expect(response.status).toBe(200);
    expect((await response.json()).summary).toMatchObject({ total: 1, eligible: 1 });
    expect(auth.availability).toHaveBeenCalledTimes(1);
    expect(auth.gateway.enqueueProject).not.toHaveBeenCalled();
  });

  it('returns blocked items when the worker is unavailable without inspecting private input', async () => {
    auth.availability.mockResolvedValue({ state: 'TEMPORARILY_UNAVAILABLE', canEnqueue: false, message: 'Worker unavailable.' });
    const response = await POST(request({ publicIds: ['project-a'] }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.summary.blocked).toBe(1);
    expect(auth.gateway.inspectInput).not.toHaveBeenCalled();
  });

  it('denies a read-only caller before availability or project access', async () => {
    auth.requireAdmin.mockResolvedValue({ adminUserId: 'admin-1', permissions: ['projects.read'] });
    const response = await POST(request({ publicIds: ['project-a'] }));
    expect(response.status).toBe(403);
    expect(auth.availability).not.toHaveBeenCalled();
    expect(auth.gateway.loadProjects).not.toHaveBeenCalled();
  });
});
