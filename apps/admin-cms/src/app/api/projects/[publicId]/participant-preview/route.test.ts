import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('../../../../../lib/supabase/admin', () => ({
  createSupabaseAdminClient: vi.fn(() => ({})),
}));
vi.mock('../../../../../lib/supabase/buckets', () => ({
  getStagingBuckets: vi.fn(() => ({ DRAFT_PRIVATE: 'project-draft-private-assets' })),
}));
vi.mock('../../../../../notifications/participantPreviewEmailConfig', () => ({
  resolveParticipantPreviewEmailConfig: vi.fn(),
}));
vi.mock('../../../../../notifications/smtpParticipantPreviewEmailTransport', () => ({
  SmtpParticipantPreviewEmailTransport: vi.fn(),
}));
vi.mock('../../../../../notifications/participantPreviewNotificationService', () => ({
  executeParticipantPreviewNotification: vi.fn(),
}));

import { NextRequest } from 'next/server';
import { POST as previewPOST } from './route';
import { requireAdmin } from '../../../../../auth/requireAdmin';
import { resolveCanonicalPublicOrigin, validateSameOrigin } from '../../../../../auth/csrf';
import { SupabaseParticipantPreviewRepository } from '../../../../../repositories/SupabaseParticipantPreviewRepository';
import { SupabaseParticipantPreviewNotificationRepository } from '../../../../../repositories/SupabaseParticipantPreviewNotificationRepository';
import { ParticipantPreviewExecutionError } from '../../../../../repositories/ParticipantPreviewRepository';
import { AdminAuthError } from '../../../../../auth/authTypes';
import { resolveParticipantPreviewEmailConfig } from '../../../../../notifications/participantPreviewEmailConfig';
import { executeParticipantPreviewNotification } from '../../../../../notifications/participantPreviewNotificationService';

vi.mock('../../../../../auth/requireAdmin');
vi.mock('../../../../../auth/csrf');

describe('POST /api/projects/[publicId]/participant-preview Route Handler Tests', () => {
  const mockPublicId = 'proj-test-123';
  const mockAdminId = '00000000-0000-0000-0000-000000000001';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSameOrigin).mockReturnValue(true);
    vi.mocked(resolveCanonicalPublicOrigin).mockReturnValue('http://localhost:3000');
    vi.mocked(resolveParticipantPreviewEmailConfig).mockReturnValue({ enabled: false });
  });

  function createRequest(options?: { origin?: string; body?: unknown }) {
    const origin = options?.origin ?? 'http://localhost:3000';
    const headers: Record<string, string> = {
      origin,
      'content-type': 'application/json',
    };
    const body = options?.body !== undefined ? JSON.stringify(options.body) : undefined;
    return new NextRequest(`http://localhost:3000/api/projects/${mockPublicId}/participant-preview`, {
      method: 'POST',
      headers,
      body,
    });
  }

  it('1. Rejects request when validateSameOrigin fails (CSRF)', async () => {
    vi.mocked(validateSameOrigin).mockReturnValue(false);
    const req = createRequest({ origin: 'http://evil.com' });
    const res = await previewPOST(req, { params: Promise.resolve({ publicId: mockPublicId }) });

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe('Access denied.');
    expect(validateSameOrigin).toHaveBeenCalledWith('http://evil.com', 'http://localhost:3000');
  });

  it('2. Rejects unauthenticated request when requireAdmin throws AdminAuthError', async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new AdminAuthError('UNAUTHENTICATED', 'Access denied.'));
    const req = createRequest();
    const res = await previewPOST(req, { params: Promise.resolve({ publicId: mockPublicId }) });

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  it('3. Allows ordinary generation for staff with review permission', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({
      adminUserId: mockAdminId,
      permissions: ['projects.review'],
    } as never);

    const mockGenerate = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'generatePreview').mockResolvedValue({
      previewId: 'prev-1',
      publicId: mockPublicId,
      createdAt: '2026-08-11T12:00:00Z',
      expiresAt: '2026-08-18T12:00:00Z',
    });

    const req = createRequest();
    const res = await previewPOST(req, { params: Promise.resolve({ publicId: mockPublicId }) });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.publicId).toBe(mockPublicId);
    expect(json.previewUrl).toMatch(/^http:\/\/localhost:3000\/participant-preview\/[0-9a-f]{64}$/);
    expect(mockGenerate).toHaveBeenCalledWith(expect.objectContaining({
      isCorrectionReissue: false,
    }));
  });

  it('4. Rejects corrected reissue (isCorrectionReissue=true) for reviewer-only staff', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({
      adminUserId: mockAdminId,
      permissions: ['projects.review'],
    } as never);

    const req = createRequest({ body: { isCorrectionReissue: true } });
    const res = await previewPOST(req, { params: Promise.resolve({ publicId: mockPublicId }) });

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  it('5. Rejects corrected reissue (isCorrectionReissue=true) for editor-only staff', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({
      adminUserId: mockAdminId,
      permissions: ['projects.edit'],
    } as never);

    const req = createRequest({ body: { isCorrectionReissue: true } });
    const res = await previewPOST(req, { params: Promise.resolve({ publicId: mockPublicId }) });

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  it('6. Allows corrected reissue (isCorrectionReissue=true) for combined edit+review staff', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({
      adminUserId: mockAdminId,
      permissions: ['projects.edit', 'projects.review'],
    } as never);

    const mockGenerate = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'generatePreview').mockResolvedValue({
      previewId: 'prev-2',
      publicId: mockPublicId,
      createdAt: '2026-08-11T12:00:00Z',
      expiresAt: '2026-08-18T12:00:00Z',
    });

    const req = createRequest({ body: { isCorrectionReissue: true } });
    const res = await previewPOST(req, { params: Promise.resolve({ publicId: mockPublicId }) });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(mockGenerate).toHaveBeenCalledWith(expect.objectContaining({
      isCorrectionReissue: true,
    }));
  });

  it('7. Maps CORRECTION_RESOLUTION_REQUIRED error to HTTP 409', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({
      adminUserId: mockAdminId,
      permissions: ['projects.review'],
    } as never);

    vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'generatePreview').mockRejectedValue(
      new ParticipantPreviewExecutionError('CORRECTION_RESOLUTION_REQUIRED')
    );

    const req = createRequest();
    const res = await previewPOST(req, { params: Promise.resolve({ publicId: mockPublicId }) });

    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.code).toBe('CORRECTION_RESOLUTION_REQUIRED');
  });

  it('8. Maps NO_CORRECTION_IN_PROGRESS error to HTTP 400', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({
      adminUserId: mockAdminId,
      permissions: ['projects.edit', 'projects.review'],
    } as never);

    vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'generatePreview').mockRejectedValue(
      new ParticipantPreviewExecutionError('NO_CORRECTION_IN_PROGRESS')
    );

    const req = createRequest({ body: { isCorrectionReissue: true } });
    const res = await previewPOST(req, { params: Promise.resolve({ publicId: mockPublicId }) });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.code).toBe('NO_CORRECTION_IN_PROGRESS');
  });

  it('9. Maps AMBIGUOUS_CORRECTION_REQUEST error to HTTP 409', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({
      adminUserId: mockAdminId,
      permissions: ['projects.edit', 'projects.review'],
    } as never);

    vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'generatePreview').mockRejectedValue(
      new ParticipantPreviewExecutionError('AMBIGUOUS_CORRECTION_REQUEST')
    );

    const req = createRequest({ body: { isCorrectionReissue: true } });
    const res = await previewPOST(req, { params: Promise.resolve({ publicId: mockPublicId }) });

    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.code).toBe('AMBIGUOUS_CORRECTION_REQUEST');
  });

  it('10. Uses the canonical public origin instead of the internal request origin', async () => {
    vi.mocked(resolveCanonicalPublicOrigin).mockReturnValue('https://capstone-admin-cms-staging-v2.onrender.com');
    vi.mocked(requireAdmin).mockResolvedValue({
      adminUserId: mockAdminId,
      permissions: ['projects.review'],
    } as never);
    vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'generatePreview').mockResolvedValue({
      previewId: 'prev-render',
      publicId: mockPublicId,
      createdAt: '2026-08-17T03:43:43.849Z',
      expiresAt: '2026-08-24T03:43:43.849Z',
    });

    const res = await previewPOST(createRequest(), {
      params: Promise.resolve({ publicId: mockPublicId }),
    });
    const json = await res.json();

    expect(json.previewUrl).toMatch(
      /^https:\/\/capstone-admin-cms-staging-v2\.onrender\.com\/participant-preview\/[0-9a-f]{64}$/,
    );
    expect(json.previewUrl).not.toContain('localhost');
  });

  it('11. Passes the same canonical URL to Generate + Send transport and response', async () => {
    const publicOrigin = 'https://capstone-admin-cms-staging-v2.onrender.com';
    vi.mocked(resolveCanonicalPublicOrigin).mockReturnValue(publicOrigin);
    vi.mocked(resolveParticipantPreviewEmailConfig).mockReturnValue({
      enabled: true,
      smtp: {
        host: 'smtp.example.test', port: 587, secure: false,
        auth: { user: 'username', password: 'password' }, from: 'noreply@example.test',
      },
    });
    vi.mocked(requireAdmin).mockResolvedValue({
      adminUserId: mockAdminId,
      permissions: ['projects.review'],
    } as never);
    vi.spyOn(
      SupabaseParticipantPreviewNotificationRepository.prototype,
      'generatePreviewWithNotification',
    ).mockResolvedValue({
      resultCode: 'SUCCESS',
      value: {
        previewId: 'prev-email', publicId: mockPublicId,
        createdAt: '2026-08-17T03:43:43.849Z', expiresAt: '2026-08-24T03:43:43.849Z',
        projectTitle: 'Project', notificationId: 'notification-1', executionToken: 'execution-1',
        recipient: 'participant@example.test', requestedAt: '2026-08-17T03:43:43.849Z',
      },
    });
    vi.mocked(executeParticipantPreviewNotification).mockResolvedValue({
      code: 'SENT', message: 'Sent.', failureCode: null,
    });

    const res = await previewPOST(createRequest({ body: { sendEmail: true } }), {
      params: Promise.resolve({ publicId: mockPublicId }),
    });
    const json = await res.json();
    const notificationInput = vi.mocked(executeParticipantPreviewNotification).mock.calls[0][1];

    expect(notificationInput).toMatchObject({ previewUrl: json.previewUrl });
    expect(json.previewUrl).toMatch(
      /^https:\/\/capstone-admin-cms-staging-v2\.onrender\.com\/participant-preview\/[0-9a-f]{64}$/,
    );
  });

  it('12. Fails closed before generation when no canonical public origin is available', async () => {
    vi.mocked(resolveCanonicalPublicOrigin).mockReturnValue(null);
    const generate = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'generatePreview');

    const res = await previewPOST(createRequest(), {
      params: Promise.resolve({ publicId: mockPublicId }),
    });

    expect(res.status).toBe(500);
    expect(generate).not.toHaveBeenCalled();
  });
});
