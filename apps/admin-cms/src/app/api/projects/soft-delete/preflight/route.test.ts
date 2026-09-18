import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  preflight: vi.fn(),
  execute: vi.fn(),
}));

vi.mock('../../../../../auth/requireAdmin', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('../../../../../lib/supabase/admin', () => ({ createSupabaseAdminClient: vi.fn(() => ({})) }));
vi.mock('../../../../../projects/SupabaseProjectSoftDeleteGateway', () => ({
  SupabaseProjectSoftDeleteGateway: class {
    preflight = mocks.preflight;
    execute = mocks.execute;
  },
}));

import { POST } from './route';

function request(body: unknown, origin = 'http://localhost'): NextRequest {
  const payload = JSON.stringify(body);
  return new NextRequest('http://localhost/api/projects/soft-delete/preflight', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) },
    body: payload,
  });
}

describe('project soft delete preflight route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ adminUserId: 'server-admin', permissions: ['projects.delete'] });
    mocks.preflight.mockResolvedValue([{
      publicId: 'p-1', title: 'P1', status: 'draft', updatedAt: '2026-09-17T00:00:00.000Z',
      disposition: 'eligible', reasonCode: 'ELIGIBLE', reason: 'Eligible.', previouslyPublished: false,
    }]);
  });

  it('rejects cross-origin and browser identity input before authentication or data access', async () => {
    expect((await POST(request({ publicIds: ['p-1'] }, 'http://attacker.invalid'))).status).toBe(403);
    expect((await POST(request({ publicIds: ['p-1'], adminId: 'spoofed' }))).status).toBe(400);
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
    expect(mocks.preflight).not.toHaveBeenCalled();
  });

  it.each([
    ['editor', ['projects.edit']],
    ['reviewer', ['projects.review']],
  ])('denies %s without invoking database preflight', async (_label, permissions) => {
    mocks.requireAdmin.mockResolvedValue({ adminUserId: 'staff-1', permissions });
    const response = await POST(request({ publicIds: ['p-1'] }));
    expect(response.status).toBe(403);
    expect(mocks.preflight).not.toHaveBeenCalled();
  });

  it('passes only the authenticated server actor to the database authority', async () => {
    const response = await POST(request({ publicIds: ['p-1'] }));
    expect(response.status).toBe(200);
    expect(mocks.preflight).toHaveBeenCalledWith(['p-1'], 'server-admin');
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
