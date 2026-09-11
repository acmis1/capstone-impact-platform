import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  createSupabaseAdminClient: vi.fn(() => ({ serviceRole: true })),
  create: vi.fn(),
  isReferenced: vi.fn(),
  remove: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('../../../../auth/requireAdmin', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('../../../../lib/supabase/admin', () => ({ createSupabaseAdminClient: mocks.createSupabaseAdminClient }));
vi.mock('../../../../taxonomy/SupabaseTaxonomyGateway', () => ({
  SupabaseTaxonomyGateway: class {
    create = mocks.create;
    isReferenced = mocks.isReferenced;
    remove = mocks.remove;
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

import { NextRequest } from 'next/server';
import { getPermissionsForRoles } from '../../../../auth/permissions';
import { DELETE, POST } from './route';

const context = (kind = 'program') => ({ params: Promise.resolve({ kind }) });
const request = (method: 'POST' | 'DELETE', body: unknown, origin: string | null = 'http://app.test') => new NextRequest('http://app.test/api/taxonomy/program', {
  method,
  headers: { 'content-type': 'application/json', ...(origin === null ? {} : { origin }) },
  body: JSON.stringify(body),
});

describe('taxonomy mutation route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ permissions: getPermissionsForRoles(['admin']) });
    mocks.create.mockResolvedValue({ id: '11111111-1111-1111-8111-111111111111', name: 'Future Program' });
    mocks.isReferenced.mockResolvedValue(false);
    mocks.remove.mockResolvedValue(true);
  });

  it('rejects cross-origin mutation before authentication or service-role access', async () => {
    const response = await POST(request('POST', { name: 'Aviation' }, 'http://evil.test'), context());
    expect(response.status).toBe(403);
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
    expect(mocks.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it('rejects a reviewer without taxonomy authority', async () => {
    mocks.requireAdmin.mockResolvedValue({ permissions: getPermissionsForRoles(['reviewer']) });
    const response = await POST(request('POST', { name: 'Aviation' }), context());
    expect(response.status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('creates a server-validated future program from the catalogue value only', async () => {
    const response = await POST(request('POST', { name: 'Future Program' }), context());
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ success: true, code: 'CREATED', entry: { name: 'Future Program' } });
    expect(mocks.create).toHaveBeenCalledWith('program', 'Future Program');
  });

  it('rejects client-supplied authority fields rather than trusting or persisting them', async () => {
    const response = await POST(request('POST', { name: 'Future Program', permissions: ['taxonomy.manage'] }), context());
    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('refuses a referenced value before invoking delete', async () => {
    mocks.isReferenced.mockResolvedValue(true);
    const response = await DELETE(request('DELETE', { id: '11111111-1111-1111-8111-111111111111' }), context('discipline'));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ success: false, code: 'IN_USE' });
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
