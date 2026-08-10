import { describe, it, expect, vi } from 'vitest';
import { SupabaseParticipantPreviewRepositoryCore } from '../repositories/SupabaseParticipantPreviewRepositoryCore';
import { ParticipantPreviewExecutionError } from '../repositories/ParticipantPreviewRepository';
import { canManageParticipantPreview, getPermissionsForRoles } from '../auth/permissions';
import { validatePreviewPublicId } from '../auth/participantPreviewInput';
import { generateRawPreviewToken, hashPreviewToken, isPlausibleRawPreviewToken } from '../previews/participantPreviewToken';
import { POST, DELETE } from '../app/api/projects/[publicId]/participant-preview/route';
import { NextRequest } from 'next/server';
import { AdminAuthError, AdminRole, AdminPermission, AuthenticatedAdminContext } from '../auth/authTypes';

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

vi.mock('../lib/env', () => ({
  getServerEnv: vi.fn(() => ({
    SUPABASE_DRAFT_BUCKET: 'project-drafts-private',
    SUPABASE_PUBLIC_ASSETS_BUCKET: 'project-public-assets',
    SUPABASE_PUBLIC_FEEDS_BUCKET: 'public-feeds',
    SUPABASE_PUBLIC_FEED_FILE: 'capstones-latest.json',
  })),
}));

const ADMIN_ID = '11111111-2222-3333-4444-555555555555';

describe('Participant Preview Token Utilities', () => {
  it('generates a 256-bit (64 hex char) raw token each call, never repeating', () => {
    const a = generateRawPreviewToken();
    const b = generateRawPreviewToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it('hashes a raw token to a deterministic 64-hex-char SHA-256 digest', () => {
    const raw = 'a'.repeat(64);
    const hash1 = hashPreviewToken(raw);
    const hash2 = hashPreviewToken(raw);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(raw);
  });

  it('isPlausibleRawPreviewToken accepts only well-formed 64-hex-char candidates', () => {
    expect(isPlausibleRawPreviewToken('a'.repeat(64))).toBe(true);
    expect(isPlausibleRawPreviewToken('not-hex-'.repeat(8))).toBe(false);
    expect(isPlausibleRawPreviewToken('short')).toBe(false);
    expect(isPlausibleRawPreviewToken('a'.repeat(600))).toBe(false);
    expect(isPlausibleRawPreviewToken(null)).toBe(false);
    expect(isPlausibleRawPreviewToken(undefined)).toBe(false);
    expect(isPlausibleRawPreviewToken(12345)).toBe(false);
  });
});

describe('Participant Preview Permission Reuse', () => {
  it('reuses the existing projects.review permission (admin/reviewer yes, editor no)', () => {
    const adminPerms = getPermissionsForRoles(['admin']);
    const reviewerPerms = getPermissionsForRoles(['reviewer']);
    const editorPerms = getPermissionsForRoles(['editor']);

    expect(canManageParticipantPreview(adminPerms)).toBe(true);
    expect(canManageParticipantPreview(reviewerPerms)).toBe(true);
    expect(canManageParticipantPreview(editorPerms)).toBe(false);
  });
});

describe('Participant Preview publicId Validation', () => {
  it('accepts a well-formed publicId and rejects unsafe/empty/oversized values', () => {
    expect(validatePreviewPublicId('2026-my-project')).toEqual({ valid: true, publicId: '2026-my-project' });
    expect(validatePreviewPublicId('')).toEqual({ valid: false, error: expect.any(String) });
    expect(validatePreviewPublicId('a/../b')).toEqual({ valid: false, error: expect.any(String) });
    expect(validatePreviewPublicId('a'.repeat(101))).toEqual({ valid: false, error: expect.any(String) });
    expect(validatePreviewPublicId(42)).toEqual({ valid: false, error: expect.any(String) });
  });
});

describe('SupabaseParticipantPreviewRepositoryCore', () => {
  it('generatePreview requires non-empty publicId/adminId/tokenHash before calling the RPC', async () => {
    const mockSupabase = { rpc: vi.fn() } as unknown as import('@supabase/supabase-js').SupabaseClient;
    const repo = new SupabaseParticipantPreviewRepositoryCore(mockSupabase);

    await expect(
      repo.generatePreview({ publicId: '', adminId: ADMIN_ID, tokenHash: 'a'.repeat(64), privateBucket: 'project-drafts-private' })
    ).rejects.toThrow('Participant preview execution failed: INPUT_INVALID');
    expect(mockSupabase.rpc).not.toHaveBeenCalled();
  });

  it('generatePreview requires a non-empty privateBucket before calling the RPC', async () => {
    const mockSupabase = { rpc: vi.fn() } as unknown as import('@supabase/supabase-js').SupabaseClient;
    const repo = new SupabaseParticipantPreviewRepositoryCore(mockSupabase);

    await expect(
      repo.generatePreview({ publicId: '2026-proj1', adminId: ADMIN_ID, tokenHash: 'a'.repeat(64), privateBucket: '' })
    ).rejects.toThrow('Participant preview execution failed: INPUT_INVALID');
    expect(mockSupabase.rpc).not.toHaveBeenCalled();
  });

  it('generatePreview invokes exactly one RPC call with only the token hash (never the raw token)', async () => {
    const mockRpc = vi.fn().mockResolvedValue({
      data: {
        resultCode: 'SUCCESS',
        previewId: 'p1',
        publicId: '2026-proj1',
        createdAt: '2026-08-10T00:00:00.000Z',
        expiresAt: '2026-08-17T00:00:00.000Z',
      },
      error: null,
    });
    const mockSupabase = { rpc: mockRpc } as unknown as import('@supabase/supabase-js').SupabaseClient;
    const repo = new SupabaseParticipantPreviewRepositoryCore(mockSupabase);

    const tokenHash = hashPreviewToken('raw-token-value-should-never-appear-in-rpc-args');
    const result = await repo.generatePreview({ publicId: '2026-proj1', adminId: ADMIN_ID, tokenHash, privateBucket: 'project-drafts-private' });

    expect(mockRpc).toHaveBeenCalledTimes(1);
    const [, callArgs] = mockRpc.mock.calls[0];
    expect(callArgs).toEqual({
      p_public_id: '2026-proj1',
      p_admin_id: ADMIN_ID,
      p_token_hash: tokenHash,
      p_expires_in_seconds: 7 * 24 * 60 * 60,
      p_private_bucket: 'project-drafts-private',
    });
    expect(JSON.stringify(callArgs)).not.toContain('raw-token-value-should-never-appear-in-rpc-args');
    expect(result).toEqual({ previewId: 'p1', publicId: '2026-proj1', createdAt: '2026-08-10T00:00:00.000Z', expiresAt: '2026-08-17T00:00:00.000Z' });
  });

  it('generatePreview maps every RPC resultCode to its typed error', async () => {
    const cases: Array<[string, string]> = [
      ['PROJECT_NOT_FOUND', 'PROJECT_NOT_FOUND'],
      ['INVALID_PROJECT_STATE', 'INVALID_PROJECT_STATE'],
      ['PREVIEW_PERMISSION_DENIED', 'PERMISSION_DENIED'],
      ['ACTIVE_PREVIEW_EXISTS', 'ACTIVE_PREVIEW_EXISTS'],
      ['SOMETHING_UNEXPECTED', 'INPUT_INVALID'],
    ];

    for (const [resultCode, expectedCode] of cases) {
      const mockSupabase = {
        rpc: vi.fn().mockResolvedValue({ data: { resultCode }, error: null }),
      } as unknown as import('@supabase/supabase-js').SupabaseClient;
      const repo = new SupabaseParticipantPreviewRepositoryCore(mockSupabase);

      let caught: ParticipantPreviewExecutionError | null = null;
      try {
        await repo.generatePreview({ publicId: '2026-proj1', adminId: ADMIN_ID, tokenHash: 'a'.repeat(64), privateBucket: 'project-drafts-private' });
      } catch (err) {
        if (err instanceof ParticipantPreviewExecutionError) caught = err;
      }
      expect(caught?.code).toBe(expectedCode);
    }
  });

  it('generatePreview converts raw RPC errors to INTERNAL_FAILURE without leaking detail', async () => {
    const mockSupabase = {
      rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'SECRET_SQL_DETAIL pg_proc leak' } }),
    } as unknown as import('@supabase/supabase-js').SupabaseClient;
    const repo = new SupabaseParticipantPreviewRepositoryCore(mockSupabase);

    let caught: ParticipantPreviewExecutionError | null = null;
    try {
      await repo.generatePreview({ publicId: '2026-proj1', adminId: ADMIN_ID, tokenHash: 'a'.repeat(64), privateBucket: 'project-drafts-private' });
    } catch (err) {
      if (err instanceof ParticipantPreviewExecutionError) caught = err;
    }
    expect(caught?.code).toBe('INTERNAL_FAILURE');
    expect(caught?.message).not.toContain('SECRET_SQL_DETAIL');
    expect(caught?.message).not.toContain('pg_proc');
  });

  it('revokePreview invokes exactly one RPC call with the expected parameters', async () => {
    const mockRpc = vi.fn().mockResolvedValue({
      data: { resultCode: 'SUCCESS', previewId: 'p1', publicId: '2026-proj1', revokedAt: '2026-08-10T01:00:00.000Z' },
      error: null,
    });
    const mockSupabase = { rpc: mockRpc } as unknown as import('@supabase/supabase-js').SupabaseClient;
    const repo = new SupabaseParticipantPreviewRepositoryCore(mockSupabase);

    const result = await repo.revokePreview({ publicId: '2026-proj1', adminId: ADMIN_ID });

    expect(mockRpc).toHaveBeenCalledWith('revoke_participant_preview', { p_public_id: '2026-proj1', p_admin_id: ADMIN_ID });
    expect(result).toEqual({ previewId: 'p1', publicId: '2026-proj1', revokedAt: '2026-08-10T01:00:00.000Z' });
  });

  it('revokePreview maps NO_ACTIVE_PREVIEW correctly', async () => {
    const mockSupabase = {
      rpc: vi.fn().mockResolvedValue({ data: { resultCode: 'NO_ACTIVE_PREVIEW' }, error: null }),
    } as unknown as import('@supabase/supabase-js').SupabaseClient;
    const repo = new SupabaseParticipantPreviewRepositoryCore(mockSupabase);

    await expect(repo.revokePreview({ publicId: '2026-proj1', adminId: ADMIN_ID })).rejects.toThrow(
      'Participant preview execution failed: NO_ACTIVE_PREVIEW'
    );
  });

  it('getActivePreview never exposes the token hash column and returns null when no active row exists', async () => {
    const selectSpy = vi.fn().mockReturnThis();
    const eqSpy = vi.fn().mockReturnThis();
    const maybeSingleSpy = vi.fn().mockResolvedValue({ data: null, error: null });
    const fromSpy = vi.fn().mockReturnValue({ select: selectSpy, eq: eqSpy, maybeSingle: maybeSingleSpy });
    const mockSupabase = { from: fromSpy } as unknown as import('@supabase/supabase-js').SupabaseClient;
    const repo = new SupabaseParticipantPreviewRepositoryCore(mockSupabase);

    const result = await repo.getActivePreview('project-uuid-1');

    expect(fromSpy).toHaveBeenCalledWith('participant_previews');
    const selectedFields = selectSpy.mock.calls[0][0] as string;
    expect(selectedFields).not.toContain('token_hash');
    expect(selectedFields).not.toContain('snapshot');
    expect(result).toBeNull();
  });

  it('resolveByTokenHash returns null for every non-SUCCESS or malformed RPC outcome (no distinguishable reason)', async () => {
    const outcomes = [
      { data: { resultCode: 'NOT_FOUND' }, error: null },
      { data: null, error: { message: 'db error' } },
      { data: { resultCode: 'SUCCESS' }, error: null }, // missing required fields
    ];

    for (const outcome of outcomes) {
      const mockSupabase = { rpc: vi.fn().mockResolvedValue(outcome) } as unknown as import('@supabase/supabase-js').SupabaseClient;
      const repo = new SupabaseParticipantPreviewRepositoryCore(mockSupabase);
      const result = await repo.resolveByTokenHash('a'.repeat(64));
      expect(result).toBeNull();
    }
  });

  it('resolveByTokenHash returns the snapshot and media on a genuine SUCCESS result', async () => {
    const mockSupabase = {
      rpc: vi.fn().mockResolvedValue({
        data: {
          resultCode: 'SUCCESS',
          previewId: 'p1',
          snapshot: { title: 'Test Project' },
          mediaSnapshot: [{ mediaAssetId: 'm1', assetType: 'poster_image', fileName: 'p.png', storageBucket: 'project-drafts-private', storagePath: 'drafts/x/poster_image/p.png', mimeType: 'image/png' }],
          expiresAt: '2026-08-17T00:00:00.000Z',
        },
        error: null,
      }),
    } as unknown as import('@supabase/supabase-js').SupabaseClient;
    const repo = new SupabaseParticipantPreviewRepositoryCore(mockSupabase);

    const result = await repo.resolveByTokenHash('a'.repeat(64));
    expect(result?.previewId).toBe('p1');
    expect(result?.snapshot).toEqual({ title: 'Test Project' });
    expect(result?.mediaSnapshot).toHaveLength(1);
  });

  it('confirmPreview sends only the token hash to the RPC and never a preview/project id, timestamp, or actor identity', async () => {
    const mockRpc = vi.fn().mockResolvedValue({
      data: { resultCode: 'SUCCESS', confirmationId: 'c1', confirmedAt: '2026-08-11T00:00:00.000Z', alreadyConfirmed: false },
      error: null,
    });
    const mockSupabase = { rpc: mockRpc } as unknown as import('@supabase/supabase-js').SupabaseClient;
    const repo = new SupabaseParticipantPreviewRepositoryCore(mockSupabase);

    const tokenHash = 'a'.repeat(64);
    const result = await repo.confirmPreview(tokenHash);

    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('confirm_participant_preview', { p_token_hash: tokenHash });
    expect(result).toEqual({ confirmationId: 'c1', confirmedAt: '2026-08-11T00:00:00.000Z', alreadyConfirmed: false });
  });

  it('confirmPreview reports alreadyConfirmed on an idempotent repeat submission', async () => {
    const mockSupabase = {
      rpc: vi.fn().mockResolvedValue({
        data: { resultCode: 'SUCCESS', confirmationId: 'c1', confirmedAt: '2026-08-11T00:00:00.000Z', alreadyConfirmed: true },
        error: null,
      }),
    } as unknown as import('@supabase/supabase-js').SupabaseClient;
    const repo = new SupabaseParticipantPreviewRepositoryCore(mockSupabase);

    const result = await repo.confirmPreview('a'.repeat(64));
    expect(result?.alreadyConfirmed).toBe(true);
  });

  it('confirmPreview returns null for every non-SUCCESS or malformed RPC outcome (malformed/unknown/expired/revoked all collapse identically)', async () => {
    const outcomes = [
      { data: { resultCode: 'NOT_FOUND' }, error: null },
      { data: null, error: { message: 'db error' } },
      { data: { resultCode: 'SUCCESS' }, error: null }, // missing required fields
      { data: {}, error: null },
    ];

    for (const outcome of outcomes) {
      const mockSupabase = { rpc: vi.fn().mockResolvedValue(outcome) } as unknown as import('@supabase/supabase-js').SupabaseClient;
      const repo = new SupabaseParticipantPreviewRepositoryCore(mockSupabase);
      const result = await repo.confirmPreview('a'.repeat(64));
      expect(result).toBeNull();
    }
  });

  it('confirmPreview requires a non-empty token hash before calling the RPC', async () => {
    const mockSupabase = { rpc: vi.fn() } as unknown as import('@supabase/supabase-js').SupabaseClient;
    const repo = new SupabaseParticipantPreviewRepositoryCore(mockSupabase);

    const result = await repo.confirmPreview('');
    expect(result).toBeNull();
    expect(mockSupabase.rpc).not.toHaveBeenCalled();
  });

  it('getConfirmationStatus reads confirmed_at only, keyed by the already-resolved preview id, and returns null when unconfirmed', async () => {
    const maybeSingleSpy = vi.fn().mockResolvedValue({ data: { confirmed_at: '2026-08-11T00:00:00.000Z' }, error: null });
    const eqSpy = vi.fn().mockReturnValue({ maybeSingle: maybeSingleSpy });
    const selectSpy = vi.fn().mockReturnValue({ eq: eqSpy });
    const fromSpy = vi.fn().mockReturnValue({ select: selectSpy });
    const mockSupabase = { from: fromSpy } as unknown as import('@supabase/supabase-js').SupabaseClient;
    const repo = new SupabaseParticipantPreviewRepositoryCore(mockSupabase);

    const result = await repo.getConfirmationStatus('preview-uuid-1');

    expect(fromSpy).toHaveBeenCalledWith('participant_preview_confirmations');
    expect(selectSpy).toHaveBeenCalledWith('confirmed_at');
    expect(eqSpy).toHaveBeenCalledWith('participant_preview_id', 'preview-uuid-1');
    expect(result).toEqual({ confirmedAt: '2026-08-11T00:00:00.000Z' });
  });

  it('getConfirmationStatus returns null when no confirmation row exists or the query errors', async () => {
    const notFoundSupabase = {
      from: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) }) }) }),
    } as unknown as import('@supabase/supabase-js').SupabaseClient;
    const repoA = new SupabaseParticipantPreviewRepositoryCore(notFoundSupabase);
    expect(await repoA.getConfirmationStatus('preview-uuid-1')).toBeNull();

    const erroredSupabase = {
      from: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: 'db error' } }) }) }) }),
    } as unknown as import('@supabase/supabase-js').SupabaseClient;
    const repoB = new SupabaseParticipantPreviewRepositoryCore(erroredSupabase);
    expect(await repoB.getConfirmationStatus('preview-uuid-1')).toBeNull();
  });
});

function makeAdminContext(overrides?: Partial<{ roles: AdminRole[]; permissions: AdminPermission[] }>): AuthenticatedAdminContext {
  return {
    authUserId: 'auth-uuid-1',
    adminUserId: ADMIN_ID,
    email: 'admin@capstone.test',
    fullName: 'Admin User',
    roles: overrides?.roles ?? ['admin'],
    permissions: overrides?.permissions ?? ['projects.read', 'projects.review', 'projects.archive', 'projects.edit'],
  };
}

describe('Participant Preview Admin API Route Security', () => {
  it('POST rejects cross-origin requests before touching auth or the repository', async () => {
    const req = new NextRequest('http://localhost:3000/api/projects/2026-proj1/participant-preview', {
      method: 'POST',
      headers: { origin: 'http://malicious.com' },
    });
    const res = await POST(req, { params: Promise.resolve({ publicId: '2026-proj1' }) });
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.success).toBe(false);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('POST rejects unauthenticated sessions', async () => {
    const { requireAdmin } = await import('../auth/requireAdmin');
    vi.mocked(requireAdmin).mockRejectedValueOnce(new AdminAuthError('UNAUTHENTICATED', 'Unauthenticated'));

    const req = new NextRequest('http://localhost:3000/api/projects/2026-proj1/participant-preview', {
      method: 'POST',
      headers: { origin: 'http://localhost:3000' },
    });
    const res = await POST(req, { params: Promise.resolve({ publicId: '2026-proj1' }) });
    expect(res.status).toBe(401);
  });

  it('POST rejects a session without projects.review (editor-only)', async () => {
    const { requireAdmin } = await import('../auth/requireAdmin');
    vi.mocked(requireAdmin).mockResolvedValueOnce(makeAdminContext({ roles: ['editor'], permissions: ['projects.read', 'projects.edit'] }));

    const req = new NextRequest('http://localhost:3000/api/projects/2026-proj1/participant-preview', {
      method: 'POST',
      headers: { origin: 'http://localhost:3000' },
    });
    const res = await POST(req, { params: Promise.resolve({ publicId: '2026-proj1' }) });
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.success).toBe(false);
  });

  it('POST returns the raw token exactly once and never exposes a token hash field', async () => {
    const { requireAdmin } = await import('../auth/requireAdmin');
    vi.mocked(requireAdmin).mockResolvedValueOnce(makeAdminContext());

    const { SupabaseParticipantPreviewRepository } = await import('../repositories/SupabaseParticipantPreviewRepository');
    const mockGenerate = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'generatePreview').mockResolvedValueOnce({
      previewId: 'p1',
      publicId: '2026-proj1',
      createdAt: '2026-08-10T00:00:00.000Z',
      expiresAt: '2026-08-17T00:00:00.000Z',
    });

    const req = new NextRequest('http://localhost:3000/api/projects/2026-proj1/participant-preview', {
      method: 'POST',
      headers: { origin: 'http://localhost:3000' },
    });
    const res = await POST(req, { params: Promise.resolve({ publicId: '2026-proj1' }) });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(typeof json.previewToken).toBe('string');
    expect(json.previewToken).toMatch(/^[0-9a-f]{64}$/);
    expect(json.previewUrl).toContain(json.previewToken);
    expect(json.tokenHash).toBeUndefined();
    expect(res.headers.get('Cache-Control')).toBe('no-store');

    // The generated token hash passed to the repository must be the SHA-256 of the returned raw token.
    const generateArgs = mockGenerate.mock.calls[0][0];
    expect(generateArgs.tokenHash).toBe(hashPreviewToken(json.previewToken));
    expect(generateArgs.adminId).toBe(ADMIN_ID);

    mockGenerate.mockRestore();
  });

  it('POST maps ACTIVE_PREVIEW_EXISTS to a controlled 409 conflict response', async () => {
    const { requireAdmin } = await import('../auth/requireAdmin');
    vi.mocked(requireAdmin).mockResolvedValueOnce(makeAdminContext());

    const { SupabaseParticipantPreviewRepository } = await import('../repositories/SupabaseParticipantPreviewRepository');
    const mockGenerate = vi
      .spyOn(SupabaseParticipantPreviewRepository.prototype, 'generatePreview')
      .mockRejectedValueOnce(new ParticipantPreviewExecutionError('ACTIVE_PREVIEW_EXISTS'));

    const req = new NextRequest('http://localhost:3000/api/projects/2026-proj1/participant-preview', {
      method: 'POST',
      headers: { origin: 'http://localhost:3000' },
    });
    const res = await POST(req, { params: Promise.resolve({ publicId: '2026-proj1' }) });
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.code).toBe('ACTIVE_PREVIEW_EXISTS');

    mockGenerate.mockRestore();
  });

  it('POST maps INVALID_PROJECT_STATE (ineligible project) to HTTP 400', async () => {
    const { requireAdmin } = await import('../auth/requireAdmin');
    vi.mocked(requireAdmin).mockResolvedValueOnce(makeAdminContext());

    const { SupabaseParticipantPreviewRepository } = await import('../repositories/SupabaseParticipantPreviewRepository');
    const mockGenerate = vi
      .spyOn(SupabaseParticipantPreviewRepository.prototype, 'generatePreview')
      .mockRejectedValueOnce(new ParticipantPreviewExecutionError('INVALID_PROJECT_STATE'));

    const req = new NextRequest('http://localhost:3000/api/projects/2026-draft/participant-preview', {
      method: 'POST',
      headers: { origin: 'http://localhost:3000' },
    });
    const res = await POST(req, { params: Promise.resolve({ publicId: '2026-draft' }) });
    expect(res.status).toBe(400);

    mockGenerate.mockRestore();
  });

  it('DELETE rejects cross-origin requests', async () => {
    const req = new NextRequest('http://localhost:3000/api/projects/2026-proj1/participant-preview', {
      method: 'DELETE',
      headers: { origin: 'http://malicious.com' },
    });
    const res = await DELETE(req, { params: Promise.resolve({ publicId: '2026-proj1' }) });
    expect(res.status).toBe(403);
  });

  it('DELETE succeeds for an authorized reviewer and returns no token/hash fields', async () => {
    const { requireAdmin } = await import('../auth/requireAdmin');
    vi.mocked(requireAdmin).mockResolvedValueOnce(makeAdminContext({ roles: ['reviewer'], permissions: ['projects.read', 'projects.review'] }));

    const { SupabaseParticipantPreviewRepository } = await import('../repositories/SupabaseParticipantPreviewRepository');
    const mockRevoke = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'revokePreview').mockResolvedValueOnce({
      previewId: 'p1',
      publicId: '2026-proj1',
      revokedAt: '2026-08-10T02:00:00.000Z',
    });

    const req = new NextRequest('http://localhost:3000/api/projects/2026-proj1/participant-preview', {
      method: 'DELETE',
      headers: { origin: 'http://localhost:3000' },
    });
    const res = await DELETE(req, { params: Promise.resolve({ publicId: '2026-proj1' }) });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.tokenHash).toBeUndefined();
    expect(json.previewToken).toBeUndefined();

    mockRevoke.mockRestore();
  });
});
