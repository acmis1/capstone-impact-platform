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
  return new NextRequest('http://localhost/api/projects/bulk-review/execute', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('bulk review execute route', () => {
  beforeEach(() => {
    auth.requireAdmin.mockReset();
    auth.gateway.loadProjectStates.mockReset();
    auth.gateway.executeAction.mockReset();
    auth.requireAdmin.mockResolvedValue({ adminUserId: 'admin-1', permissions: ['projects.review'] });
    auth.gateway.loadProjectStates.mockResolvedValue(new Map());
  });

  it('rejects oversized selections before authentication or mutation', async () => {
    const publicIds = Array.from({ length: 51 }, (_, index) => `synthetic-${index}`);
    const response = await POST(request({ action: 'approve', publicIds, expectedUpdatedAt: {} }));
    expect(response.status).toBe(400);
    expect(auth.requireAdmin).not.toHaveBeenCalled();
    expect(auth.gateway.executeAction).not.toHaveBeenCalled();
  });

  it.each([undefined, '   '])('rejects a missing or whitespace-only request-changes comment before mutation: %s', async (comments) => {
    const response = await POST(request({
      action: 'request_changes',
      publicIds: ['synthetic-2026-0001'],
      expectedUpdatedAt: { 'synthetic-2026-0001': 'v' },
      ...(comments === undefined ? {} : { comments }),
    }));
    expect(response.status).toBe(400);
    expect(auth.requireAdmin).not.toHaveBeenCalled();
    expect(auth.gateway.executeAction).not.toHaveBeenCalled();
  });

  it('rejects cross-origin requests before authentication or mutation', async () => {
    const response = await POST(request({ action: 'approve', publicIds: ['synthetic-2026-0001'], expectedUpdatedAt: { 'synthetic-2026-0001': 'v' } }, 'http://attacker.invalid'));
    expect(response.status).toBe(403);
    expect(auth.requireAdmin).not.toHaveBeenCalled();
    expect(auth.gateway.executeAction).not.toHaveBeenCalled();
  });

  it('maps an unauthenticated actor to the bounded auth response', async () => {
    auth.requireAdmin.mockRejectedValue(new AdminAuthError('UNAUTHENTICATED', 'private detail'));
    const response = await POST(request({ action: 'approve', publicIds: ['synthetic-2026-0001'], expectedUpdatedAt: { 'synthetic-2026-0001': 'v' } }));
    expect(response.status).toBe(401);
    expect(JSON.stringify(await response.json())).not.toContain('private detail');
  });

  it('passes only the server-authenticated actor to execution and never exposes backend errors', async () => {
    const response = await POST(request({
      action: 'request_changes',
      publicIds: ['synthetic-2026-0001'],
      expectedUpdatedAt: { 'synthetic-2026-0001': null },
      comments: '  Please revise.  ',
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.summary.invalidOrStale).toBe(1);
    expect(JSON.stringify(body)).not.toContain('service_role');
    expect(JSON.stringify(body)).not.toContain('stack');
    expect(auth.gateway.executeAction).not.toHaveBeenCalled();
  });
});
