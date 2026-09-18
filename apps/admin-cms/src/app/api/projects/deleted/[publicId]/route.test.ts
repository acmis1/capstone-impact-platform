import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  detail: vi.fn(),
  recover: vi.fn(),
}));

vi.mock('../../../../../auth/requireAdmin', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('../../../../../lib/supabase/admin', () => ({ createSupabaseAdminClient: vi.fn(() => ({})) }));
vi.mock('../../../../../recovery/SupabaseDeletedProjectMaintenanceGateway', () => ({
  SupabaseDeletedProjectMaintenanceGateway: class { detail = mocks.detail; recover = mocks.recover; },
}));

import { GET, POST } from './route';

const params = { params: Promise.resolve({ publicId: 'deleted-project' }) };
function postRequest(body: unknown, origin = 'http://localhost'): NextRequest {
  const payload = JSON.stringify(body);
  return new NextRequest('http://localhost/api/projects/deleted/deleted-project', {
    method: 'POST', headers: { origin, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }, body: payload,
  });
}

describe('deleted project detail and recovery route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ adminUserId: 'server-admin', roles: ['admin'], permissions: ['projects.delete'] });
    mocks.detail.mockResolvedValue({ resultCode: 'FOUND', project: { publicId: 'deleted-project' }, recovery: { code: 'READY_FOR_RECOVERY', reason: 'ready' }, media: [], approvalHistory: [], participantPreviews: [], feedHistory: [] });
    mocks.recover.mockResolvedValue({ resultCode: 'RECOVERED', publicId: 'deleted-project', status: 'draft' });
  });

  it('checks delete authority before privileged detail reads and hides the view from non-admins', async () => {
    mocks.requireAdmin.mockResolvedValue({ adminUserId: 'reviewer', roles: ['reviewer'], permissions: ['projects.delete'] });
    expect((await GET(new NextRequest('http://localhost/api/projects/deleted/deleted-project'), params)).status).toBe(403);
    expect(mocks.detail).not.toHaveBeenCalled();
  });

  it('rejects cross-origin and extra-body recovery attempts without mutation', async () => {
    const valid = { expectedUpdatedAt: '2026-09-18T10:00:00.000Z', expectedDeletedAt: '2026-09-18T09:00:00.000Z' };
    expect((await POST(postRequest(valid, 'http://attacker.invalid'), params)).status).toBe(403);
    expect((await POST(postRequest({ ...valid, adminId: 'spoofed' }), params)).status).toBe(400);
    expect(mocks.recover).not.toHaveBeenCalled();
  });

  it('passes both tombstone CAS values and the server actor, including explicit already-recovered handling', async () => {
    const valid = { expectedUpdatedAt: '2026-09-18T10:00:00.000Z', expectedDeletedAt: '2026-09-18T09:00:00.000Z' };
    expect((await POST(postRequest(valid), params)).status).toBe(200);
    expect(mocks.recover).toHaveBeenCalledWith({ ...valid, publicId: 'deleted-project', adminId: 'server-admin' });
    mocks.recover.mockResolvedValue({ resultCode: 'ALREADY_RECOVERED', publicId: 'deleted-project', status: 'draft' });
    expect((await POST(postRequest(valid), params)).status).toBe(200);
    expect(await (await POST(postRequest(valid), params)).json()).toMatchObject({ success: true, result: { resultCode: 'ALREADY_RECOVERED' } });
  });
});
