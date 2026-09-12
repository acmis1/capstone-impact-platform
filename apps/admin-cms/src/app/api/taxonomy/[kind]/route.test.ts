import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  createSupabaseAdminClient: vi.fn(() => ({ serviceRole: true })),
  create: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('../../../../auth/requireAdmin', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('../../../../lib/supabase/admin', () => ({ createSupabaseAdminClient: mocks.createSupabaseAdminClient }));
vi.mock('../../../../taxonomy/SupabaseTaxonomyGateway', () => ({
  SupabaseTaxonomyGateway: class {
    create = mocks.create;
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

import { NextRequest } from 'next/server';
import { getPermissionsForRoles } from '../../../../auth/permissions';
import { TaxonomyConflictError } from '../../../../taxonomy/taxonomy';
import * as taxonomyRoute from './route';

const context = (kind = 'program') => ({ params: Promise.resolve({ kind }) });
function request(
  body: unknown,
  options: { origin?: string | null; contentLength?: string; rawBody?: string } = {},
) {
  const origin = options.origin === undefined ? 'http://app.test' : options.origin;
  return new NextRequest('http://app.test/api/taxonomy/program', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(origin === null ? {} : { origin }),
      ...(options.contentLength === undefined ? {} : { 'content-length': options.contentLength }),
    },
    body: options.rawBody ?? JSON.stringify(body),
  });
}

describe('taxonomy mutation route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ permissions: getPermissionsForRoles(['admin']) });
    mocks.create.mockResolvedValue({ id: '11111111-1111-1111-8111-111111111111', name: 'Future Program' });
  });

  it('rejects cross-origin mutation before authentication or service-role access', async () => {
    const response = await taxonomyRoute.POST(request({ name: 'Aviation' }, { origin: 'http://evil.test' }), context());
    expect(response.status).toBe(403);
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
    expect(mocks.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it.each(['reviewer', 'editor'] as const)('rejects a %s without taxonomy authority', async (role) => {
    mocks.requireAdmin.mockResolvedValue({ permissions: getPermissionsForRoles([role]) });
    const response = await taxonomyRoute.POST(request({ name: 'Aviation' }), context());
    expect(response.status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('creates a server-validated future program from the catalogue value only', async () => {
    const response = await taxonomyRoute.POST(request({ name: 'Future Program' }), context());
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ success: true, code: 'CREATED', entry: { name: 'Future Program' } });
    expect(mocks.create).toHaveBeenCalledWith('program', 'Future Program');
  });

  it('rejects client-supplied authority fields rather than trusting or persisting them', async () => {
    const response = await taxonomyRoute.POST(request({ name: 'Future Program', permissions: ['taxonomy.manage'] }), context());
    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('maps a duplicate insert to a bounded conflict', async () => {
    mocks.create.mockRejectedValue(new TaxonomyConflictError());
    const response = await taxonomyRoute.POST(request({ name: 'Future Program' }), context());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ success: false, code: 'DUPLICATE' });
  });

  it('does not implement a taxonomy DELETE operation', () => {
    expect(taxonomyRoute).not.toHaveProperty('DELETE');
  });

  it('rejects missing and malformed actual JSON bodies safely', async () => {
    const missing = new NextRequest('http://app.test/api/taxonomy/program', {
      method: 'POST',
      headers: { origin: 'http://app.test', 'content-type': 'application/json' },
    });
    expect((await taxonomyRoute.POST(missing, context())).status).toBe(400);
    expect((await taxonomyRoute.POST(request(null, { rawBody: '{' }), context())).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each(['abc', '01', '-1', '2.5'])('rejects malformed Content-Length %s', async (contentLength) => {
    const response = await taxonomyRoute.POST(request({ name: 'Future Program' }, { contentLength }), context());
    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('rejects declared and actual oversized bodies, including a falsely small declaration', async () => {
    expect((await taxonomyRoute.POST(request({ name: 'x' }, { contentLength: '2049' }), context())).status).toBe(413);
    const oversized = { name: 'x'.repeat(3_000) };
    expect((await taxonomyRoute.POST(request(oversized), context())).status).toBe(413);
    expect((await taxonomyRoute.POST(request(oversized, { contentLength: '10' }), context())).status).toBe(413);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
