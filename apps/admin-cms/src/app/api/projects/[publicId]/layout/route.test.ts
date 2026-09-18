import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  update: vi.fn(),
}));

vi.mock('../../../../../auth/requireAdmin', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('../../../../../lib/supabase/admin', () => ({ createSupabaseAdminClient: vi.fn(() => ({})) }));
vi.mock('../../../../../projects/SupabaseProjectLayoutMaintenanceGateway', () => ({
  SupabaseProjectLayoutMaintenanceGateway: class { update = mocks.update; },
}));

import { PATCH } from './route';

const params = { params: Promise.resolve({ publicId: 'route-project' }) };
const layoutConfig = {
  templateId: 'technical_detail',
  featuredMedia: 'snapshots',
  sectionOrder: ['solution', 'background', 'snapshots', 'video', 'team', 'links', 'citations', 'accessibilityText'],
  hiddenSections: [],
};

function request(body: unknown, origin = 'http://localhost'): NextRequest {
  const payload = JSON.stringify(body);
  return new NextRequest('http://localhost/api/projects/route-project/layout', {
    method: 'PATCH',
    headers: { origin, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) },
    body: payload,
  });
}

describe('project layout maintenance route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ adminUserId: 'server-admin', roles: ['admin'], permissions: ['projects.edit'] });
    mocks.update.mockResolvedValue({ resultCode: 'UPDATED', publicId: 'route-project', status: 'draft', updatedAt: '2026-09-18T10:01:00.000Z', auditRecordId: '11111111-1111-4111-8111-111111111111', revokedActivePreviewCount: 1 });
  });

  it('rejects cross-origin and malformed bodies before any write', async () => {
    expect((await PATCH(request({ expectedUpdatedAt: '2026-09-18T10:00:00.000Z', layoutConfig }, 'http://attacker.invalid'), params)).status).toBe(403);
    expect((await PATCH(request({ expectedUpdatedAt: '2026-09-18T10:00:00.000Z', layoutConfig: null }), params)).status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('uses the route identity and server-derived admin identity, not body authority fields', async () => {
    const response = await PATCH(request({ publicId: 'spoofed', expectedUpdatedAt: '2026-09-18T10:00:00.000Z', layoutConfig }), params);
    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith({
      publicId: 'route-project', expectedUpdatedAt: '2026-09-18T10:00:00.000Z', layoutConfig, recipeVersionId: null, adminId: 'server-admin',
    });
  });

  it.each([
    ['STALE_VERSION', 409],
    ['LAYOUT_STATUS_INELIGIBLE', 400],
    ['RECIPE_VERSION_INACTIVE_OR_CHANGED', 400],
  ])('maps %s without exposing privileged details', async (resultCode, status) => {
    mocks.update.mockResolvedValue({ resultCode, publicId: 'route-project', reason: 'bounded' });
    const response = await PATCH(request({ expectedUpdatedAt: '2026-09-18T10:00:00.000Z', layoutConfig }), params);
    expect(response.status).toBe(status);
    expect(JSON.stringify(await response.json())).not.toContain('service_role');
  });
});
