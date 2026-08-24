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

function request(body: unknown, origin = 'http://localhost'): NextRequest {
  return new NextRequest('http://localhost/api/projects/bulk-review/preflight', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
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
