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

const params = { params: Promise.resolve({ publicId: 'p-1' }) };
function request(body: unknown, origin = 'http://localhost'): NextRequest {
  const payload = JSON.stringify(body);
  return new NextRequest('http://localhost/api/projects/p-1/soft-delete', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) },
    body: payload,
  });
}

describe('single project soft delete route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ adminUserId: 'server-admin', permissions: ['projects.delete'] });
    mocks.execute.mockResolvedValue({
      resultCode: 'DELETED', publicId: 'p-1', status: 'deleted', fromStatus: 'draft',
      deletedAt: '2026-09-17T00:00:01.000Z', auditRecordId: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('rejects stale-shape, spoofed identity, and cross-origin requests before mutation', async () => {
    expect((await POST(request({}), params)).status).toBe(400);
    expect((await POST(request({ expectedUpdatedAt: '2026-09-17T00:00:00.000Z', adminId: 'spoofed' }), params)).status).toBe(400);
    expect((await POST(request({ expectedUpdatedAt: '2026-09-17T00:00:00.000Z' }, 'http://attacker.invalid'), params)).status).toBe(403);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('passes the expected version and server-derived actor only', async () => {
    const response = await POST(request({ expectedUpdatedAt: '2026-09-17T00:00:00.000Z' }), params);
    expect(response.status).toBe(200);
    expect(mocks.execute).toHaveBeenCalledWith({
      publicId: 'p-1', expectedUpdatedAt: '2026-09-17T00:00:00.000Z', adminId: 'server-admin',
    });
  });

  it.each([
    ['STALE_VERSION', 409],
    ['PUBLISHED_REQUIRES_ARCHIVE', 409],
    ['CURRENTLY_PUBLIC', 409],
    ['PUBLICATION_OR_REMOVAL_PENDING', 409],
    ['REMOVAL_EVIDENCE_AMBIGUOUS', 409],
    ['PROJECT_NOT_FOUND', 404],
  ])('maps %s to a bounded response', async (resultCode, status) => {
    mocks.execute.mockResolvedValue({ resultCode, publicId: 'p-1', status: 'draft', reason: 'bounded' });
    const response = await POST(request({ expectedUpdatedAt: '2026-09-17T00:00:00.000Z' }), params);
    expect(response.status).toBe(status);
    expect(JSON.stringify(await response.json())).not.toContain('service_role');
  });

  it('returns ALREADY_DELETED explicitly without claiming a new audit', async () => {
    mocks.execute.mockResolvedValue({
      resultCode: 'ALREADY_DELETED', publicId: 'p-1', status: 'deleted', deletedAt: '2026-09-17T00:00:01.000Z',
    });
    const response = await POST(request({ expectedUpdatedAt: '2026-09-17T00:00:00.000Z' }), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, result: { resultCode: 'ALREADY_DELETED' } });
  });
});
