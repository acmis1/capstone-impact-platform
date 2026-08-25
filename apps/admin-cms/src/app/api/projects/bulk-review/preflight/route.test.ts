import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminAuthError } from '../../../../../auth/authTypes';

const auth = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  gateway: { loadProjectStates: vi.fn(), executeAction: vi.fn() },
}));

vi.mock('../../../../../auth/requireAdmin', () => ({ requireAdmin: auth.requireAdmin }));
vi.mock('../../../../../lib/supabase/admin', () => ({ createSupabaseAdminClient: vi.fn(() => ({})) }));
vi.mock('../../../../../projects/SupabaseBulkProjectReviewGateway', () => ({
  SupabaseBulkProjectReviewGateway: class {
    loadProjectStates = auth.gateway.loadProjectStates;
    executeAction = auth.gateway.executeAction;
  },
}));

import { POST } from './route';

function request(body: unknown, origin = 'http://localhost', contentLength?: string | null): NextRequest {
  const payload = JSON.stringify(body);
  const headers: Record<string, string> = { origin, 'content-type': 'application/json' };
  // NextRequest does not derive this in the test environment, and the route requires a stated,
  // bounded body length before it reads the payload.
  const stated = contentLength === undefined ? String(Buffer.byteLength(payload, 'utf8')) : contentLength;
  if (stated !== null) headers['content-length'] = stated;
  return new NextRequest('http://localhost/api/projects/bulk-review/preflight', {
    method: 'POST',
    headers,
    body: payload,
  });
}

describe('bulk review preflight route', () => {
  beforeEach(() => {
    auth.requireAdmin.mockReset();
    auth.gateway.loadProjectStates.mockReset();
    auth.gateway.executeAction.mockReset();
    auth.requireAdmin.mockResolvedValue({ adminUserId: 'admin-1', permissions: ['projects.edit'] });
    auth.gateway.loadProjectStates.mockResolvedValue(new Map());
  });

  it('rejects malformed input before authentication or database access', async () => {
    const response = await POST(request({ action: 'approve', publicIds: ['bad/id'] }));
    expect(response.status).toBe(400);
    expect(auth.requireAdmin).not.toHaveBeenCalled();
    expect(auth.gateway.loadProjectStates).not.toHaveBeenCalled();
  });

  it('rejects an unstated or oversized body before the payload is read', async () => {
    const valid = { action: 'approve', publicIds: ['synthetic-2026-0001'] };

    const unstated = await POST(request(valid, 'http://localhost', null));
    expect(unstated.status).toBe(413);

    const oversized = await POST(request(valid, 'http://localhost', String(64 * 1024 + 1)));
    expect(oversized.status).toBe(413);

    const malformed = await POST(request(valid, 'http://localhost', '12x'));
    expect(malformed.status).toBe(413);

    expect(auth.requireAdmin).not.toHaveBeenCalled();
    expect(auth.gateway.loadProjectStates).not.toHaveBeenCalled();
  });

  it('rejects cross-origin requests before authentication or database access', async () => {
    const response = await POST(request({ action: 'approve', publicIds: ['synthetic-2026-0001'] }, 'http://attacker.invalid'));
    expect(response.status).toBe(403);
    expect(auth.requireAdmin).not.toHaveBeenCalled();
    expect(auth.gateway.loadProjectStates).not.toHaveBeenCalled();
  });

  it('maps an unauthenticated actor to the bounded auth response', async () => {
    auth.requireAdmin.mockRejectedValue(new AdminAuthError('UNAUTHENTICATED', 'private detail'));
    const response = await POST(request({ action: 'approve', publicIds: ['synthetic-2026-0001'] }));
    expect(response.status).toBe(401);
    expect(JSON.stringify(await response.json())).not.toContain('private detail');
  });

  it('returns a bounded read-only classification and never executes a mutation', async () => {
    const response = await POST(request({ action: 'submit_for_review', publicIds: ['synthetic-2026-0001'] }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.action).toBe('submit_for_review');
    expect(body.summary).toMatchObject({ total: 1, invalidOrStale: 1 });
    expect(body.items[0].reasons.length).toBeLessThanOrEqual(5);
    expect(auth.gateway.executeAction).not.toHaveBeenCalled();
  });

  it('enforces the action permission before querying selected projects', async () => {
    auth.requireAdmin.mockResolvedValue({ adminUserId: 'editor-1', permissions: ['projects.edit'] });
    const response = await POST(request({ action: 'approve', publicIds: ['synthetic-2026-0001'] }));
    expect(response.status).toBe(403);
    expect(auth.gateway.loadProjectStates).not.toHaveBeenCalled();
  });
});
