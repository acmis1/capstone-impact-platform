import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as stageMediaPOST } from '../app/api/imports/stage-media/route';
import { requireAdmin } from '../auth/requireAdmin';
import { AdminAuthError } from '../auth/authTypes';

vi.mock('../auth/requireAdmin', () => ({ requireAdmin: vi.fn() }));

const ADMIN_MUTATION_ROUTES = [
  'src/app/api/imports/admin-reference/inspect/route.ts',
  'src/app/api/imports/preview/route.ts',
  'src/app/api/imports/stage-metadata/route.ts',
  'src/app/api/imports/stage-media/route.ts',
  'src/app/api/imports/[batchId]/submit-for-review/route.ts',
  'src/app/api/projects/[publicId]/review-action/route.ts',
  'src/app/api/projects/[publicId]/participant-preview/route.ts',
  'src/app/api/projects/[publicId]/participant-preview/correction-resolution/route.ts',
  'src/app/api/projects/[publicId]/participant-preview/reminders/route.ts',
  'src/app/api/projects/[publicId]/publication-plan/route.ts',
  'src/app/api/projects/[publicId]/local-publication/route.ts',
  'src/app/api/projects/[publicId]/local-archive/route.ts',
  'src/app/api/staff/invitations/route.ts',
] as const;

function read(relativePath: string): string {
  const normCwd = process.cwd().replace(/\\/g, '/');
  const root = normCwd.endsWith('apps/admin-cms')
    ? process.cwd()
    : path.resolve(process.cwd(), 'apps/admin-cms');
  return fs.readFileSync(path.resolve(root, relativePath), 'utf8');
}

describe('Admin mutation CSRF inventory', () => {
  let originalRender: string | undefined;
  let originalRenderExternalUrl: string | undefined;

  beforeEach(() => {
    originalRender = process.env.RENDER;
    originalRenderExternalUrl = process.env.RENDER_EXTERNAL_URL;
    delete process.env.RENDER;
    delete process.env.RENDER_EXTERNAL_URL;
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalRender === undefined) delete process.env.RENDER;
    else process.env.RENDER = originalRender;

    if (originalRenderExternalUrl === undefined) delete process.env.RENDER_EXTERNAL_URL;
    else process.env.RENDER_EXTERNAL_URL = originalRenderExternalUrl;
  });

  it.each(ADMIN_MUTATION_ROUTES)('%s validates exact same-origin before authentication', (route) => {
    const source = read(route);
    const csrfIndex = source.indexOf('validateSameOrigin(');
    const authIndex = source.indexOf('requireAdmin(');
    expect(csrfIndex).toBeGreaterThan(-1);
    expect(authIndex).toBeGreaterThan(-1);
    expect(csrfIndex).toBeLessThan(authIndex);
  });

  it('rejects a crafted stage-media request with no Origin before body processing', async () => {
    const response = await stageMediaPOST(
      new NextRequest('http://localhost:3000/api/imports/stage-media', {
        method: 'POST',
        headers: { 'content-length': '100' },
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      code: 'CROSS_ORIGIN_REJECTED',
      error: 'The request was not accepted.',
    });
  });

  it('allows an authoritative Render external Origin to progress beyond CSRF', async () => {
    const externalOrigin = 'https://capstone-admin-cms-staging-v2.onrender.com';
    process.env.RENDER = 'true';
    process.env.RENDER_EXTERNAL_URL = externalOrigin;
    vi.mocked(requireAdmin).mockRejectedValueOnce(
      new AdminAuthError('UNAUTHENTICATED', 'Authentication required.'),
    );

    const response = await stageMediaPOST(
      new NextRequest('http://internal-render:10000/api/imports/stage-media', {
        method: 'POST',
        headers: { origin: externalOrigin },
      }),
    );

    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe('UNAUTHENTICATED');
    expect(requireAdmin).toHaveBeenCalledOnce();
  });

  it('rejects an attacker Origin despite spoofed forwarding headers', async () => {
    const externalOrigin = 'https://capstone-admin-cms-staging-v2.onrender.com';
    process.env.RENDER = 'true';
    process.env.RENDER_EXTERNAL_URL = externalOrigin;

    const response = await stageMediaPOST(
      new NextRequest('http://internal-render:10000/api/imports/stage-media', {
        method: 'POST',
        headers: {
          origin: 'https://evil.example',
          'x-forwarded-host': 'capstone-admin-cms-staging-v2.onrender.com',
          'x-forwarded-proto': 'https',
        },
      }),
    );

    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('CROSS_ORIGIN_REJECTED');
    expect(requireAdmin).not.toHaveBeenCalled();
  });

  it('keeps metadata editing inside the Server Action auth and permission boundary', () => {
    const source = read('src/app/admin/projects/[publicId]/actions.ts');
    expect(source).toContain("'use server'");
    expect(source).toContain('requireAdmin()');
    expect(source).toContain('saveAuthorizedProjectMetadata(');
  });

  it('keeps participant responses token-bound and outside staff authentication', () => {
    const source = read('src/app/participant-preview/[token]/route.ts');
    expect(source).toContain('validateSameOrigin(');
    expect(source).not.toContain('requireAdmin(');
  });
});
