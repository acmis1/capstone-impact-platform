import { describe, it, expect, vi } from 'vitest';
import { SupabaseProjectRepositoryCore } from '../repositories/SupabaseProjectRepositoryCore';
import { applyReviewActionTransition, getAllowedReviewActions } from '../workflow/projectWorkflow';
import { canPerformReviewAction, getPermissionsForRoles } from '../auth/permissions';
import { POST } from '../app/api/projects/[publicId]/review-action/route';
import { NextRequest } from 'next/server';
import { AdminAuthError } from '../auth/authTypes';
import { getPublicAuthErrorMessage } from '../auth/authHttp';
import { SupabaseProjectRepository } from '../repositories/SupabaseProjectRepository';
import { ReviewActionExecutionError } from '../repositories/ProjectRepository';

// Mock server-only and supabase admin client before imports
vi.mock('server-only', () => ({}));
vi.mock('../lib/supabase/admin', () => ({
  createSupabaseAdminClient: vi.fn(),
}));

vi.mock('../auth/csrf', () => ({
  validateSameOrigin: vi.fn((origin, reqOrigin) => origin === reqOrigin),
}));

vi.mock('../auth/requireAdmin', () => ({
  requireAdmin: vi.fn(),
}));

describe('Transactional Review Actions Repository & API Route Security Unit Tests', () => {
  // ============================================================
  // Repository Atomic RPC Contract Tests
  // ============================================================

  it('1. performReviewAction requires non-empty adminId, publicId, and action parameters', async () => {
    const mockSupabase = { rpc: vi.fn() } as unknown as import('@supabase/supabase-js').SupabaseClient;
    const repo = new SupabaseProjectRepositoryCore(mockSupabase);

    await expect(
      repo.performReviewAction({
        publicId: '2026-proj1',
        action: 'approve',
        adminId: '',
      })
    ).rejects.toThrow('Review action execution failed: INPUT_INVALID');
  });

  it('2. performReviewAction invokes exactly one RPC with expected normalized parameters', async () => {
    const mockRpc = vi.fn().mockResolvedValue({
      data: {
        publicId: '2026-proj1',
        status: 'approved',
        auditRecordId: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
      },
      error: null,
    });

    const mockSupabase = {
      rpc: mockRpc,
      from: vi.fn(),
    } as unknown as import('@supabase/supabase-js').SupabaseClient;

    const repo = new SupabaseProjectRepositoryCore(mockSupabase);

    const result = await repo.performReviewAction({
      publicId: '2026-proj1',
      action: 'approve',
      comments: 'Looks great',
      adminId: '11111111-2222-3333-4444-555555555555',
    });

    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('perform_project_review_action', {
      p_public_id: '2026-proj1',
      p_action: 'approve',
      p_comments: 'Looks great',
      p_admin_id: '11111111-2222-3333-4444-555555555555',
    });

    expect(result).toEqual({
      publicId: '2026-proj1',
      status: 'approved',
      auditRecordId: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
    });

    // Verify it NEVER calls direct from('projects') or from('approval_records')
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it('3. performReviewAction maps malformed or un-validated RPC response payloads to RESPONSE_INVALID', async () => {
    const mockRpc = vi.fn().mockResolvedValue({
      data: {
        publicId: '',
        status: 'invalid_status_name',
        auditRecordId: 'not-a-uuid',
      },
      error: null,
    });

    const mockSupabase = { rpc: mockRpc } as unknown as import('@supabase/supabase-js').SupabaseClient;
    const repo = new SupabaseProjectRepositoryCore(mockSupabase);

    await expect(
      repo.performReviewAction({
        publicId: '2026-proj1',
        action: 'approve',
        adminId: '11111111-2222-3333-4444-555555555555',
      })
    ).rejects.toThrow('Review action execution failed: RESPONSE_INVALID');
  });

  it('4. performReviewAction converts database RPC errors to safe typed internal errors', async () => {
    const mockRpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'REVIEW_TRANSITION_INVALID: Staging transition not allowed' },
    });

    const mockSupabase = { rpc: mockRpc } as unknown as import('@supabase/supabase-js').SupabaseClient;
    const repo = new SupabaseProjectRepositoryCore(mockSupabase);

    await expect(
      repo.performReviewAction({
        publicId: '2026-proj1',
        action: 'approve',
        adminId: '11111111-2222-3333-4444-555555555555',
      })
    ).rejects.toThrow('Review action execution failed: TRANSITION_INVALID');
  });

  // ============================================================
  // API Route Security & Error Mapping Tests
  // ============================================================

  it('5. API route preserves CSRF origin validation rejection', async () => {
    const req = new NextRequest('http://localhost:3000/api/projects/2026-proj1/review-action', {
      method: 'POST',
      headers: {
        origin: 'http://malicious.com',
      },
      body: JSON.stringify({ action: 'approve' }),
    });

    const res = await POST(req, { params: Promise.resolve({ publicId: '2026-proj1' }) });
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.success).toBe(false);
  });

  it('6. API route preserves unauthenticated session rejection', async () => {
    const { requireAdmin } = await import('../auth/requireAdmin');
    vi.mocked(requireAdmin).mockRejectedValueOnce(new AdminAuthError('UNAUTHENTICATED', 'Unauthenticated'));

    const req = new NextRequest('http://localhost:3000/api/projects/2026-proj1/review-action', {
      method: 'POST',
      headers: {
        origin: 'http://localhost:3000',
      },
      body: JSON.stringify({ action: 'approve' }),
    });

    const res = await POST(req, { params: Promise.resolve({ publicId: '2026-proj1' }) });
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.success).toBe(false);
  });

  it('7. API route executes atomic performReviewAction and returns safe success response', async () => {
    const { requireAdmin } = await import('../auth/requireAdmin');
    vi.mocked(requireAdmin).mockResolvedValueOnce({
      authUserId: 'auth-uuid-1',
      adminUserId: 'admin-uuid-1',
      email: 'admin@capstone.test',
      fullName: 'Admin User',
      roles: ['admin'],
      permissions: ['projects.read', 'projects.review', 'projects.archive', 'projects.edit'],
    });

    const mockAction = vi.spyOn(SupabaseProjectRepository.prototype, 'performReviewAction').mockResolvedValueOnce({
      publicId: '2026-proj1',
      status: 'approved',
      auditRecordId: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
    });

    const req = new NextRequest('http://localhost:3000/api/projects/2026-proj1/review-action', {
      method: 'POST',
      headers: {
        origin: 'http://localhost:3000',
      },
      body: JSON.stringify({ action: 'approve', comments: 'Approved' }),
    });

    const res = await POST(req, { params: Promise.resolve({ publicId: '2026-proj1' }) });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      success: true,
      publicId: '2026-proj1',
      status: 'approved',
      action: 'approve',
      auditRecorded: true,
    });

    // Ensure auditRecordId is NOT exposed in public HTTP response
    expect(json.auditRecordId).toBeUndefined();

    // Verify adminUserId passed to repository
    expect(mockAction).toHaveBeenCalledWith({
      publicId: '2026-proj1',
      action: 'approve',
      comments: 'Approved',
      adminId: 'admin-uuid-1',
    });

    mockAction.mockRestore();
  });

  it('8. API route maps PROJECT_NOT_FOUND to HTTP 404', async () => {
    const { requireAdmin } = await import('../auth/requireAdmin');
    vi.mocked(requireAdmin).mockResolvedValueOnce({
      authUserId: 'auth-uuid-1',
      adminUserId: 'admin-uuid-1',
      email: 'admin@capstone.test',
      fullName: 'Admin User',
      roles: ['admin'],
      permissions: ['projects.read', 'projects.review', 'projects.archive', 'projects.edit'],
    });

    const mockAction = vi.spyOn(SupabaseProjectRepository.prototype, 'performReviewAction').mockRejectedValueOnce(
      new ReviewActionExecutionError('PROJECT_NOT_FOUND')
    );

    const req = new NextRequest('http://localhost:3000/api/projects/2026-missing/review-action', {
      method: 'POST',
      headers: { origin: 'http://localhost:3000' },
      body: JSON.stringify({ action: 'approve' }),
    });

    const res = await POST(req, { params: Promise.resolve({ publicId: '2026-missing' }) });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json).toEqual({ success: false, error: 'Project not found.' });

    mockAction.mockRestore();
  });

  it('9. API route maps TRANSITION_INVALID to HTTP 400', async () => {
    const { requireAdmin } = await import('../auth/requireAdmin');
    vi.mocked(requireAdmin).mockResolvedValueOnce({
      authUserId: 'auth-uuid-1',
      adminUserId: 'admin-uuid-1',
      email: 'admin@capstone.test',
      fullName: 'Admin User',
      roles: ['admin'],
      permissions: ['projects.read', 'projects.review', 'projects.archive', 'projects.edit'],
    });

    const mockAction = vi.spyOn(SupabaseProjectRepository.prototype, 'performReviewAction').mockRejectedValueOnce(
      new ReviewActionExecutionError('TRANSITION_INVALID')
    );

    const req = new NextRequest('http://localhost:3000/api/projects/2026-draft/review-action', {
      method: 'POST',
      headers: { origin: 'http://localhost:3000' },
      body: JSON.stringify({ action: 'approve' }),
    });

    const res = await POST(req, { params: Promise.resolve({ publicId: '2026-draft' }) });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toEqual({ success: false, error: 'Invalid workflow transition for project state.' });

    mockAction.mockRestore();
  });

  it('10. API route maps unexpected errors to HTTP 500 without leaking raw SQL details', async () => {
    const { requireAdmin } = await import('../auth/requireAdmin');
    vi.mocked(requireAdmin).mockResolvedValueOnce({
      authUserId: 'auth-uuid-1',
      adminUserId: 'admin-uuid-1',
      email: 'admin@capstone.test',
      fullName: 'Admin User',
      roles: ['admin'],
      permissions: ['projects.read', 'projects.review', 'projects.archive', 'projects.edit'],
    });

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mockAction = vi.spyOn(SupabaseProjectRepository.prototype, 'performReviewAction').mockRejectedValueOnce(
      new ReviewActionExecutionError('INTERNAL_FAILURE')
    );

    const req = new NextRequest('http://localhost:3000/api/projects/2026-proj1/review-action', {
      method: 'POST',
      headers: { origin: 'http://localhost:3000' },
      body: JSON.stringify({ action: 'approve' }),
    });

    const res = await POST(req, { params: Promise.resolve({ publicId: '2026-proj1' }) });
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.success).toBe(false);
    expect(json.error).toBe(getPublicAuthErrorMessage('UNKNOWN'));

    consoleSpy.mockRestore();
    mockAction.mockRestore();
  });

  // ============================================================
  // Safe Error Boundary & Secret Exclusion Verification Tests
  // ============================================================

  it('13. Safe Error Boundary: SECRET_SQL_DETAIL_SHOULD_NOT_ESCAPE appears nowhere in repository error, HTTP body, or console log', async () => {
    const rawBackendMessage = 'REVIEW_TRANSITION_INVALID: SECRET_SQL_DETAIL_SHOULD_NOT_ESCAPE in table pg_proc';
    const mockRpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: rawBackendMessage },
    });

    const mockSupabase = { rpc: mockRpc } as unknown as import('@supabase/supabase-js').SupabaseClient;
    const repo = new SupabaseProjectRepositoryCore(mockSupabase);

    let caughtRepoError: ReviewActionExecutionError | null = null;
    try {
      await repo.performReviewAction({
        publicId: '2026-proj1',
        action: 'approve',
        adminId: '11111111-2222-3333-4444-555555555555',
      });
    } catch (err) {
      if (err instanceof ReviewActionExecutionError) {
        caughtRepoError = err;
      }
    }

    expect(caughtRepoError).not.toBeNull();
    expect(caughtRepoError?.code).toBe('TRANSITION_INVALID');
    expect(caughtRepoError?.message).not.toContain('SECRET_SQL_DETAIL_SHOULD_NOT_ESCAPE');
    expect(caughtRepoError?.message).not.toContain('pg_proc');

    // Route test
    const { requireAdmin } = await import('../auth/requireAdmin');
    vi.mocked(requireAdmin).mockResolvedValueOnce({
      authUserId: 'auth-uuid-1',
      adminUserId: 'admin-uuid-1',
      email: 'admin@capstone.test',
      fullName: 'Admin User',
      roles: ['admin'],
      permissions: ['projects.read', 'projects.review', 'projects.archive', 'projects.edit'],
    });

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mockAction = vi.spyOn(SupabaseProjectRepository.prototype, 'performReviewAction').mockRejectedValueOnce(
      caughtRepoError!
    );

    const req = new NextRequest('http://localhost:3000/api/projects/2026-proj1/review-action', {
      method: 'POST',
      headers: { origin: 'http://localhost:3000' },
      body: JSON.stringify({ action: 'approve' }),
    });

    const res = await POST(req, { params: Promise.resolve({ publicId: '2026-proj1' }) });
    const json = await res.json();
    const jsonStr = JSON.stringify(json);

    expect(jsonStr).not.toContain('SECRET_SQL_DETAIL_SHOULD_NOT_ESCAPE');
    expect(jsonStr).not.toContain('pg_proc');

    // Verify console log arguments contain no raw SQL or secret details
    for (const call of consoleSpy.mock.calls) {
      for (const arg of call) {
        const argStr = typeof arg === 'object' ? JSON.stringify(arg) : String(arg);
        expect(argStr).not.toContain('SECRET_SQL_DETAIL_SHOULD_NOT_ESCAPE');
        expect(argStr).not.toContain('pg_proc');
      }
    }

    consoleSpy.mockRestore();
    mockAction.mockRestore();
  });

  // ============================================================
  // Workflow & Role Parity Tests
  // ============================================================

  it('11. Workflow parity: allowed actions match projectWorkflow.ts definitions', () => {
    expect(getAllowedReviewActions('submitted')).toEqual(['request_changes', 'approve', 'archive']);
    expect(getAllowedReviewActions('in_review')).toEqual(['request_changes', 'approve', 'archive']);
    expect(getAllowedReviewActions('changes_requested')).toEqual(['approve']);
    expect(getAllowedReviewActions('approved')).toEqual(['request_changes', 'archive']);
    expect(getAllowedReviewActions('published')).toEqual(['archive']);
    expect(getAllowedReviewActions('draft')).toEqual([]);
    expect(getAllowedReviewActions('archived')).toEqual([]);
    expect(getAllowedReviewActions('deleted')).toEqual([]);

    expect(applyReviewActionTransition('submitted', 'approve')).toEqual({ allowed: true, fromStatus: 'submitted', toStatus: 'approved' });
    expect(applyReviewActionTransition('draft', 'approve')).toEqual({ allowed: false, fromStatus: 'draft', error: expect.any(String) });
  });

  it('12. Role parity: permission mapping matches permissions.ts definitions', () => {
    const adminPerms = getPermissionsForRoles(['admin']);
    const reviewerPerms = getPermissionsForRoles(['reviewer']);
    const editorPerms = getPermissionsForRoles(['editor']);

    expect(canPerformReviewAction(adminPerms, 'request_changes')).toBe(true);
    expect(canPerformReviewAction(adminPerms, 'approve')).toBe(true);
    expect(canPerformReviewAction(adminPerms, 'archive')).toBe(true);

    expect(canPerformReviewAction(reviewerPerms, 'request_changes')).toBe(true);
    expect(canPerformReviewAction(reviewerPerms, 'approve')).toBe(true);
    expect(canPerformReviewAction(reviewerPerms, 'archive')).toBe(false);

    expect(canPerformReviewAction(editorPerms, 'request_changes')).toBe(false);
    expect(canPerformReviewAction(editorPerms, 'approve')).toBe(false);
    expect(canPerformReviewAction(editorPerms, 'archive')).toBe(false);
  });
});
