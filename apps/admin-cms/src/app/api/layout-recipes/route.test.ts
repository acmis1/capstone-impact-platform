import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { AdminAuthError } from '../../../auth/authTypes';
import { getPermissionsForRoles } from '../../../auth/permissions';
import { createLayoutConfigFromStock } from '../../../domain/layoutConfig';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  createSupabaseAdminClient: vi.fn(() => ({ serviceRole: true })),
  list: vi.fn(),
  create: vi.fn(),
  duplicate: vi.fn(),
  version: vi.fn(),
  retire: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('../../../auth/requireAdmin', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('../../../lib/supabase/admin', () => ({ createSupabaseAdminClient: mocks.createSupabaseAdminClient }));
vi.mock('../../../layout-recipes/SupabaseLayoutRecipeGateway', () => ({
  SupabaseLayoutRecipeGateway: class {
    list = mocks.list;
    create = mocks.create;
    duplicate = mocks.duplicate;
    version = mocks.version;
    retire = mocks.retire;
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

import * as route from './route';

const URL = 'http://app.test/api/layout-recipes';
const ADMIN = {
  adminUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  permissions: getPermissionsForRoles(['admin']),
};

function request(method: 'POST' | 'PATCH', body: unknown, origin = 'http://app.test') {
  const raw = JSON.stringify(body);
  return new NextRequest(URL, {
    method,
    headers: { origin, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(raw)) },
    body: raw,
  });
}

describe('/api/layout-recipes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue(ADMIN);
    mocks.list.mockResolvedValue([
      { id: 'active', status: 'active', name: 'Team first' },
      { id: 'retired', status: 'retired', name: 'Old layout' },
    ]);
    mocks.create.mockResolvedValue({ resultCode: 'CREATED', recipeVersionId: '11111111-1111-4111-8111-111111111111' });
    mocks.duplicate.mockResolvedValue({ resultCode: 'DUPLICATED', recipeVersionId: '22222222-2222-4222-8222-222222222222' });
    mocks.version.mockResolvedValue({ resultCode: 'VERSIONED', recipeVersionId: '33333333-3333-4333-8333-333333333333' });
    mocks.retire.mockResolvedValue({ resultCode: 'RETIRED', recipeVersionId: '44444444-4444-4444-8444-444444444444' });
  });

  it('returns only active recipes to an authenticated intake session', async () => {
    const response = await route.GET();
    expect(response.status).toBe(200);
    expect((await response.json()).recipes).toEqual([{ id: 'active', status: 'active', name: 'Team first' }]);
  });

  it('rejects unauthenticated reads without opening persistence', async () => {
    mocks.requireAdmin.mockRejectedValue(new AdminAuthError('UNAUTHENTICATED', 'required'));
    expect((await route.GET()).status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('rejects cross-origin writes before authentication and service-role access', async () => {
    const response = await route.POST(request('POST', { action: 'create' }, 'http://evil.test'));
    expect(response.status).toBe(403);
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
    expect(mocks.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it.each(['reviewer', 'editor'] as const)('leaves no changes for unauthorized %s writes', async (role) => {
    mocks.requireAdmin.mockResolvedValue({ ...ADMIN, permissions: getPermissionsForRoles([role]) });
    const response = await route.POST(request('POST', {
      action: 'create', name: 'Team first', config: createLayoutConfigFromStock('poster_showcase'),
    }));
    expect(response.status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('creates a strictly bounded recipe and revalidates future-choice surfaces', async () => {
    const response = await route.POST(request('POST', {
      action: 'create', name: 'Team first', config: createLayoutConfigFromStock('poster_showcase'),
    }));
    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(ADMIN.adminUserId, 'Team first', expect.objectContaining({ templateId: 'poster_showcase' }));
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/admin/imports/new');
  });

  it('rejects method/action mismatches and client-supplied authority fields', async () => {
    const sourceVersionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    expect((await route.POST(request('POST', { action: 'retire', sourceVersionId, expectedVersion: 1 }))).status).toBe(400);
    expect((await route.PATCH(request('PATCH', { action: 'retire', sourceVersionId, expectedVersion: 1, permissions: ['taxonomy.manage'] }))).status).toBe(400);
    expect(mocks.retire).not.toHaveBeenCalled();
  });

  it('bounds actual request bytes even when Content-Length is falsely small', async () => {
    const raw = JSON.stringify({ action: 'create', name: 'x'.repeat(9_000) });
    const oversized = new NextRequest(URL, {
      method: 'POST', headers: { origin: 'http://app.test', 'content-length': '10' }, body: raw,
    });
    expect((await route.POST(oversized)).status).toBe(413);
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
  });

  it('maps a stale version race to conflict without retrying', async () => {
    mocks.version.mockResolvedValue({ resultCode: 'VERSION_CONFLICT' });
    const response = await route.PATCH(request('PATCH', {
      action: 'version', name: 'Revised',
      sourceVersionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', expectedVersion: 2,
      config: createLayoutConfigFromStock('technical_detail'),
    }));
    expect(response.status).toBe(409);
    expect(mocks.version).toHaveBeenCalledTimes(1);
  });
});
