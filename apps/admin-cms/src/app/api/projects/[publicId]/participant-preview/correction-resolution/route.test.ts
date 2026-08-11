import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('../../../../../../lib/supabase/admin', () => ({
  createSupabaseAdminClient: vi.fn(() => ({})),
}));

import { NextRequest } from 'next/server';
import { POST as correctionResolutionPOST } from './route';
import { requireAdmin } from '../../../../../../auth/requireAdmin';
import { validateSameOrigin } from '../../../../../../auth/csrf';
import { SupabaseParticipantPreviewRepository } from '../../../../../../repositories/SupabaseParticipantPreviewRepository';
import { ParticipantPreviewExecutionError } from '../../../../../../repositories/ParticipantPreviewRepository';
import { AdminAuthError } from '../../../../../../auth/authTypes';

vi.mock('../../../../../../auth/requireAdmin');
vi.mock('../../../../../../auth/csrf');

describe('POST /api/projects/[publicId]/participant-preview/correction-resolution Route Handler Tests', () => {
  const mockPublicId = 'proj-test-456';
  const mockAdminId = '00000000-0000-0000-0000-000000000001';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSameOrigin).mockReturnValue(true);
  });

  function createRequest(origin = 'http://localhost:3000') {
    return new NextRequest(`http://localhost:3000/api/projects/${mockPublicId}/participant-preview/correction-resolution`, {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
      },
    });
  }

  it('1. Rejects request when validateSameOrigin fails (CSRF)', async () => {
    vi.mocked(validateSameOrigin).mockReturnValue(false);
    const req = createRequest('http://evil.com');
    const res = await correctionResolutionPOST(req, { params: Promise.resolve({ publicId: mockPublicId }) });

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe('Access denied.');
    expect(validateSameOrigin).toHaveBeenCalledWith('http://evil.com', 'http://localhost:3000');
  });

  it('2. Rejects unauthenticated request when requireAdmin throws AdminAuthError', async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new AdminAuthError('UNAUTHENTICATED', 'Access denied.'));
    const req = createRequest();
    const res = await correctionResolutionPOST(req, { params: Promise.resolve({ publicId: mockPublicId }) });

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  it('3. Rejects request for reviewer-only staff', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({
      adminUserId: mockAdminId,
      permissions: ['projects.review'],
    } as never);

    const req = createRequest();
    const res = await correctionResolutionPOST(req, { params: Promise.resolve({ publicId: mockPublicId }) });

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  it('4. Rejects request for editor-only staff', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({
      adminUserId: mockAdminId,
      permissions: ['projects.edit'],
    } as never);

    const req = createRequest();
    const res = await correctionResolutionPOST(req, { params: Promise.resolve({ publicId: mockPublicId }) });

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  it('5. Allows start correction resolution for combined edit+review staff', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({
      adminUserId: mockAdminId,
      permissions: ['projects.edit', 'projects.review'],
    } as never);

    const mockStartResolution = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'startCorrectionResolution').mockResolvedValue({
      correctionRequestId: 'corr-req-1',
      resolutionStartedAt: '2026-08-11T12:00:00Z',
      alreadyInProgress: false,
    });

    const req = createRequest();
    const res = await correctionResolutionPOST(req, { params: Promise.resolve({ publicId: mockPublicId }) });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.correctionRequestId).toBe('corr-req-1');
    expect(mockStartResolution).toHaveBeenCalledWith({
      publicId: mockPublicId,
      adminId: mockAdminId,
    });
  });

  it('6. Maps PROJECT_NOT_FOUND error to HTTP 404', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({
      adminUserId: mockAdminId,
      permissions: ['projects.edit', 'projects.review'],
    } as never);

    vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'startCorrectionResolution').mockRejectedValue(
      new ParticipantPreviewExecutionError('PROJECT_NOT_FOUND')
    );

    const req = createRequest();
    const res = await correctionResolutionPOST(req, { params: Promise.resolve({ publicId: mockPublicId }) });

    expect(res.status).toBe(404);
  });

  it('7. Maps INVALID_PROJECT_STATE error to HTTP 400', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({
      adminUserId: mockAdminId,
      permissions: ['projects.edit', 'projects.review'],
    } as never);

    vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'startCorrectionResolution').mockRejectedValue(
      new ParticipantPreviewExecutionError('INVALID_PROJECT_STATE')
    );

    const req = createRequest();
    const res = await correctionResolutionPOST(req, { params: Promise.resolve({ publicId: mockPublicId }) });

    expect(res.status).toBe(400);
  });

  it('8. Maps NO_OPEN_CORRECTION error to HTTP 400', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({
      adminUserId: mockAdminId,
      permissions: ['projects.edit', 'projects.review'],
    } as never);

    vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'startCorrectionResolution').mockRejectedValue(
      new ParticipantPreviewExecutionError('NO_OPEN_CORRECTION')
    );

    const req = createRequest();
    const res = await correctionResolutionPOST(req, { params: Promise.resolve({ publicId: mockPublicId }) });

    expect(res.status).toBe(400);
  });

  it('9. Maps AMBIGUOUS_CORRECTION_REQUEST error to HTTP 409', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({
      adminUserId: mockAdminId,
      permissions: ['projects.edit', 'projects.review'],
    } as never);

    vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'startCorrectionResolution').mockRejectedValue(
      new ParticipantPreviewExecutionError('AMBIGUOUS_CORRECTION_REQUEST')
    );

    const req = createRequest();
    const res = await correctionResolutionPOST(req, { params: Promise.resolve({ publicId: mockPublicId }) });

    expect(res.status).toBe(409);
  });

  it('10. Maps CONFLICTING_ACTIVE_PREVIEW error to HTTP 409', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({
      adminUserId: mockAdminId,
      permissions: ['projects.edit', 'projects.review'],
    } as never);

    vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'startCorrectionResolution').mockRejectedValue(
      new ParticipantPreviewExecutionError('CONFLICTING_ACTIVE_PREVIEW')
    );

    const req = createRequest();
    const res = await correctionResolutionPOST(req, { params: Promise.resolve({ publicId: mockPublicId }) });

    expect(res.status).toBe(409);
  });
});
