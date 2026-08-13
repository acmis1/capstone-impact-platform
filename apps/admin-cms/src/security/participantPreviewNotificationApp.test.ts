import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '../app/api/projects/[publicId]/participant-preview/route';
import { parseParticipantPreviewRequestBody } from '../auth/participantPreviewInput';
import { hashPreviewToken } from '../previews/participantPreviewToken';
import type { AuthenticatedAdminContext } from '../auth/authTypes';

vi.mock('server-only', () => ({}));
vi.mock('../lib/supabase/admin', () => ({ createSupabaseAdminClient: vi.fn() }));
vi.mock('../auth/csrf', () => ({
  validateSameOrigin: vi.fn((origin, reqOrigin) => origin === reqOrigin),
}));
vi.mock('../auth/requireAdmin', () => ({ requireAdmin: vi.fn() }));
vi.mock('../lib/env', () => ({
  getServerEnv: vi.fn(() => ({
    SUPABASE_DRAFT_BUCKET: 'project-drafts-private',
    SUPABASE_PUBLIC_ASSETS_BUCKET: 'project-public-assets',
    SUPABASE_PUBLIC_FEEDS_BUCKET: 'public-feeds',
    SUPABASE_PUBLIC_FEED_FILE: 'capstones-latest.json',
  })),
}));

const ADMIN_ID = '11111111-2222-3333-4444-555555555555';
const ORIGIN = 'http://localhost:3000';
const URL = `${ORIGIN}/api/projects/2026-proj1/participant-preview`;

function adminContext(): AuthenticatedAdminContext {
  return {
    authUserId: 'auth-uuid-1',
    adminUserId: ADMIN_ID,
    email: 'admin@capstone.test',
    fullName: 'Admin User',
    roles: ['admin'],
    permissions: ['projects.read', 'projects.review', 'projects.archive', 'projects.edit'],
  };
}

function request(body?: unknown, origin = ORIGIN): NextRequest {
  return new NextRequest(URL, {
    method: 'POST',
    headers: body === undefined ? { origin } : { origin, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function post(body?: unknown, origin = ORIGIN) {
  const response = await POST(request(body, origin), {
    params: Promise.resolve({ publicId: '2026-proj1' }),
  });
  return { response, json: await response.json() };
}

/** Enables delivery for one test only; the shipped default must stay disabled. */
function enableEmailDelivery() {
  process.env.PARTICIPANT_PREVIEW_EMAIL_ENABLED = 'true';
  process.env.PARTICIPANT_PREVIEW_EMAIL_SMTP_HOST = '127.0.0.1';
  process.env.PARTICIPANT_PREVIEW_EMAIL_SMTP_PORT = '54325';
  process.env.PARTICIPANT_PREVIEW_EMAIL_FROM = 'no-reply@capstone.invalid';
}

function clearEmailDelivery() {
  delete process.env.PARTICIPANT_PREVIEW_EMAIL_ENABLED;
  delete process.env.PARTICIPANT_PREVIEW_EMAIL_SMTP_HOST;
  delete process.env.PARTICIPANT_PREVIEW_EMAIL_SMTP_PORT;
  delete process.env.PARTICIPANT_PREVIEW_EMAIL_FROM;
}

beforeEach(() => {
  clearEmailDelivery();
});

afterEach(() => {
  clearEmailDelivery();
  vi.restoreAllMocks();
});

describe('participant preview request body contract', () => {
  it('accepts an absent body as ordinary Generate Without Email', () => {
    expect(parseParticipantPreviewRequestBody(undefined)).toEqual({
      valid: true,
      isCorrectionReissue: false,
      sendEmail: false,
    });
    expect(parseParticipantPreviewRequestBody({})).toEqual({
      valid: true,
      isCorrectionReissue: false,
      sendEmail: false,
    });
  });

  it('accepts only the two intent flags, and only as booleans', () => {
    expect(parseParticipantPreviewRequestBody({ isCorrectionReissue: true, sendEmail: true })).toEqual({
      valid: true,
      isCorrectionReissue: true,
      sendEmail: true,
    });
    expect(parseParticipantPreviewRequestBody({ sendEmail: 'true' })).toEqual({ valid: false });
    expect(parseParticipantPreviewRequestBody({ sendEmail: 1 })).toEqual({ valid: false });
    expect(parseParticipantPreviewRequestBody([])).toEqual({ valid: false });
    expect(parseParticipantPreviewRequestBody('sendEmail')).toEqual({ valid: false });
  });

  it.each([
    ['recipientEmail'],
    ['recipient'],
    ['participantContactEmail'],
    ['to'],
    ['cc'],
    ['bcc'],
    ['email'],
  ])('rejects a browser-supplied destination field (%s)', (field) => {
    expect(parseParticipantPreviewRequestBody({ sendEmail: true, [field]: 'attacker@evil.test' })).toEqual({
      valid: false,
    });
  });

  it.each([['adminId'], ['actorId'], ['requestedBy'], ['role'], ['permissions']])(
    'rejects a browser-supplied actor field (%s)',
    (field) => {
      expect(parseParticipantPreviewRequestBody({ sendEmail: true, [field]: 'someone-else' })).toEqual({
        valid: false,
      });
    },
  );

  it.each([
    ['previewToken'],
    ['token'],
    ['tokenHash'],
    ['previewUrl'],
    ['previewId'],
    ['notificationId'],
    ['executionToken'],
  ])('rejects a browser-supplied credential or identifier field (%s)', (field) => {
    expect(parseParticipantPreviewRequestBody({ sendEmail: true, [field]: 'x'.repeat(64) })).toEqual({
      valid: false,
    });
  });
});

describe('Generate + Send route behaviour', () => {
  it('rejects cross-origin Generate + Send before any notification side effect', async () => {
    enableEmailDelivery();
    const { SupabaseParticipantPreviewNotificationRepository } = await import(
      '../repositories/SupabaseParticipantPreviewNotificationRepository'
    );
    const generate = vi.spyOn(
      SupabaseParticipantPreviewNotificationRepository.prototype,
      'generatePreviewWithNotification',
    );

    const { response } = await post({ sendEmail: true }, 'http://malicious.test');

    expect(response.status).toBe(403);
    expect(generate).not.toHaveBeenCalled();
  });

  it('rejects a body carrying an authoritative field before generating anything', async () => {
    enableEmailDelivery();
    const { requireAdmin } = await import('../auth/requireAdmin');
    vi.mocked(requireAdmin).mockResolvedValueOnce(adminContext());

    const { SupabaseParticipantPreviewNotificationRepository } = await import(
      '../repositories/SupabaseParticipantPreviewNotificationRepository'
    );
    const generate = vi.spyOn(
      SupabaseParticipantPreviewNotificationRepository.prototype,
      'generatePreviewWithNotification',
    );

    const { response, json } = await post({ sendEmail: true, recipientEmail: 'attacker@evil.test' });

    expect(response.status).toBe(400);
    expect(json.success).toBe(false);
    expect(generate).not.toHaveBeenCalled();
  });

  it('fails closed with EMAIL_DELIVERY_DISABLED and generates no preview at all', async () => {
    const { requireAdmin } = await import('../auth/requireAdmin');
    vi.mocked(requireAdmin).mockResolvedValueOnce(adminContext());

    const { SupabaseParticipantPreviewRepository } = await import(
      '../repositories/SupabaseParticipantPreviewRepository'
    );
    const { SupabaseParticipantPreviewNotificationRepository } = await import(
      '../repositories/SupabaseParticipantPreviewNotificationRepository'
    );
    const ordinaryGenerate = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'generatePreview');
    const notifyGenerate = vi.spyOn(
      SupabaseParticipantPreviewNotificationRepository.prototype,
      'generatePreviewWithNotification',
    );

    const { response, json } = await post({ sendEmail: true });

    expect(response.status).toBe(409);
    expect(json.code).toBe('EMAIL_DELIVERY_DISABLED');
    // No preview credential may be burned discovering that delivery is switched off.
    expect(ordinaryGenerate).not.toHaveBeenCalled();
    expect(notifyGenerate).not.toHaveBeenCalled();
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('leaves Generate Without Email on the ordinary path with zero notification work', async () => {
    enableEmailDelivery();
    const { requireAdmin } = await import('../auth/requireAdmin');
    vi.mocked(requireAdmin).mockResolvedValueOnce(adminContext());

    const { SupabaseParticipantPreviewRepository } = await import(
      '../repositories/SupabaseParticipantPreviewRepository'
    );
    const { SupabaseParticipantPreviewNotificationRepository } = await import(
      '../repositories/SupabaseParticipantPreviewNotificationRepository'
    );
    const ordinaryGenerate = vi
      .spyOn(SupabaseParticipantPreviewRepository.prototype, 'generatePreview')
      .mockResolvedValueOnce({
        previewId: 'p1',
        publicId: '2026-proj1',
        createdAt: '2026-08-13T00:00:00.000Z',
        expiresAt: '2026-08-20T00:00:00.000Z',
      });
    const notifyGenerate = vi.spyOn(
      SupabaseParticipantPreviewNotificationRepository.prototype,
      'generatePreviewWithNotification',
    );

    const { response, json } = await post({ isCorrectionReissue: false, sendEmail: false });

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.previewToken).toMatch(/^[0-9a-f]{64}$/);
    expect(json.previewUrl).toContain(json.previewToken);
    expect(json.notification).toBeUndefined();
    expect(ordinaryGenerate).toHaveBeenCalledTimes(1);
    expect(notifyGenerate).not.toHaveBeenCalled();
  });

  it('returns a bounded PARTICIPANT_EMAIL_MISSING result without creating a preview', async () => {
    enableEmailDelivery();
    const { requireAdmin } = await import('../auth/requireAdmin');
    vi.mocked(requireAdmin).mockResolvedValueOnce(adminContext());

    const { SupabaseParticipantPreviewNotificationRepository } = await import(
      '../repositories/SupabaseParticipantPreviewNotificationRepository'
    );
    vi.spyOn(
      SupabaseParticipantPreviewNotificationRepository.prototype,
      'generatePreviewWithNotification',
    ).mockResolvedValueOnce({ resultCode: 'PARTICIPANT_EMAIL_MISSING' });
    const beginTransport = vi.spyOn(
      SupabaseParticipantPreviewNotificationRepository.prototype,
      'beginTransport',
    );

    const { response, json } = await post({ sendEmail: true });

    expect(response.status).toBe(409);
    expect(json.code).toBe('PARTICIPANT_EMAIL_MISSING');
    expect(json.previewToken).toBeUndefined();
    expect(beginTransport).not.toHaveBeenCalled();
  });

  it('returns a bounded PARTICIPANT_EMAIL_INVALID result without creating a preview', async () => {
    enableEmailDelivery();
    const { requireAdmin } = await import('../auth/requireAdmin');
    vi.mocked(requireAdmin).mockResolvedValueOnce(adminContext());

    const { SupabaseParticipantPreviewNotificationRepository } = await import(
      '../repositories/SupabaseParticipantPreviewNotificationRepository'
    );
    vi.spyOn(
      SupabaseParticipantPreviewNotificationRepository.prototype,
      'generatePreviewWithNotification',
    ).mockResolvedValueOnce({ resultCode: 'PARTICIPANT_EMAIL_INVALID' });

    const { response, json } = await post({ sendEmail: true });

    expect(response.status).toBe(409);
    expect(json.code).toBe('PARTICIPANT_EMAIL_INVALID');
    expect(json.previewToken).toBeUndefined();
  });

  it('derives the recipient and actor from server state, never from the request', async () => {
    enableEmailDelivery();
    const { requireAdmin } = await import('../auth/requireAdmin');
    vi.mocked(requireAdmin).mockResolvedValueOnce(adminContext());

    const { SupabaseParticipantPreviewNotificationRepository } = await import(
      '../repositories/SupabaseParticipantPreviewNotificationRepository'
    );
    const generate = vi
      .spyOn(SupabaseParticipantPreviewNotificationRepository.prototype, 'generatePreviewWithNotification')
      .mockResolvedValueOnce({
        resultCode: 'SUCCESS',
        value: {
          previewId: 'p1',
          publicId: '2026-proj1',
          createdAt: '2026-08-13T00:00:00.000Z',
          expiresAt: '2026-08-20T00:00:00.000Z',
          projectTitle: 'Smart Traffic Analysis',
          notificationId: 'n1',
          executionToken: 'exec-1',
          recipient: 'authoritative.group@example.invalid',
          requestedAt: '2026-08-13T00:00:00.000Z',
        },
      });
    vi.spyOn(SupabaseParticipantPreviewNotificationRepository.prototype, 'beginTransport').mockResolvedValue({
      resultCode: 'TRANSPORT_AUTHORIZED',
    });
    vi.spyOn(SupabaseParticipantPreviewNotificationRepository.prototype, 'finalize').mockResolvedValue({
      resultCode: 'FINALIZED',
    });

    const { SmtpParticipantPreviewEmailTransport } = await import(
      '../notifications/smtpParticipantPreviewEmailTransport'
    );
    const send = vi
      .spyOn(SmtpParticipantPreviewEmailTransport.prototype, 'send')
      .mockResolvedValue({ outcome: 'accepted', transportReference: '<ref@local>' });

    const { response, json } = await post({ sendEmail: true });

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.notification.status).toBe('SENT');
    expect(json.notification.recipient).toBe('authoritative.group@example.invalid');

    // The server hashed its own freshly generated token and attributed its own authenticated actor.
    const args = generate.mock.calls[0][0];
    expect(args.tokenHash).toBe(hashPreviewToken(json.previewToken));
    expect(args.adminId).toBe(ADMIN_ID);

    // The message went to the authoritative address, carrying the exact freshly generated link.
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].recipient).toBe('authoritative.group@example.invalid');
    expect(send.mock.calls[0][0].text).toContain(json.previewUrl);
  });

  it('never returns the execution ownership token or any internal notification identifier', async () => {
    enableEmailDelivery();
    const { requireAdmin } = await import('../auth/requireAdmin');
    vi.mocked(requireAdmin).mockResolvedValueOnce(adminContext());

    const { SupabaseParticipantPreviewNotificationRepository } = await import(
      '../repositories/SupabaseParticipantPreviewNotificationRepository'
    );
    vi.spyOn(
      SupabaseParticipantPreviewNotificationRepository.prototype,
      'generatePreviewWithNotification',
    ).mockResolvedValueOnce({
      resultCode: 'SUCCESS',
      value: {
        previewId: 'preview-internal-id',
        publicId: '2026-proj1',
        createdAt: '2026-08-13T00:00:00.000Z',
        expiresAt: '2026-08-20T00:00:00.000Z',
        projectTitle: 'Smart Traffic Analysis',
        notificationId: 'notification-internal-id',
        executionToken: 'execution-secret-token',
        recipient: 'authoritative.group@example.invalid',
        requestedAt: '2026-08-13T00:00:00.000Z',
      },
    });
    vi.spyOn(SupabaseParticipantPreviewNotificationRepository.prototype, 'beginTransport').mockResolvedValue({
      resultCode: 'TRANSPORT_AUTHORIZED',
    });
    vi.spyOn(SupabaseParticipantPreviewNotificationRepository.prototype, 'finalize').mockResolvedValue({
      resultCode: 'FINALIZED',
    });

    const { SmtpParticipantPreviewEmailTransport } = await import(
      '../notifications/smtpParticipantPreviewEmailTransport'
    );
    vi.spyOn(SmtpParticipantPreviewEmailTransport.prototype, 'send').mockResolvedValue({
      outcome: 'accepted',
    });

    const { json } = await post({ sendEmail: true });
    const serialized = JSON.stringify(json);

    expect(serialized).not.toContain('execution-secret-token');
    expect(serialized).not.toContain('notification-internal-id');
    expect(serialized).not.toContain('preview-internal-id');
    expect(serialized).not.toContain('PARTICIPANT_PREVIEW_EMAIL_SMTP');
  });

  it('still returns the one-time link when delivery ends ambiguously, and says so plainly', async () => {
    enableEmailDelivery();
    const { requireAdmin } = await import('../auth/requireAdmin');
    vi.mocked(requireAdmin).mockResolvedValueOnce(adminContext());

    const { SupabaseParticipantPreviewNotificationRepository } = await import(
      '../repositories/SupabaseParticipantPreviewNotificationRepository'
    );
    vi.spyOn(
      SupabaseParticipantPreviewNotificationRepository.prototype,
      'generatePreviewWithNotification',
    ).mockResolvedValueOnce({
      resultCode: 'SUCCESS',
      value: {
        previewId: 'p1',
        publicId: '2026-proj1',
        createdAt: '2026-08-13T00:00:00.000Z',
        expiresAt: '2026-08-20T00:00:00.000Z',
        projectTitle: 'Smart Traffic Analysis',
        notificationId: 'n1',
        executionToken: 'exec-1',
        recipient: 'authoritative.group@example.invalid',
        requestedAt: '2026-08-13T00:00:00.000Z',
      },
    });
    vi.spyOn(SupabaseParticipantPreviewNotificationRepository.prototype, 'beginTransport').mockResolvedValue({
      resultCode: 'TRANSPORT_AUTHORIZED',
    });
    vi.spyOn(SupabaseParticipantPreviewNotificationRepository.prototype, 'finalize').mockResolvedValue({
      resultCode: 'FINALIZED',
    });

    const { SmtpParticipantPreviewEmailTransport } = await import(
      '../notifications/smtpParticipantPreviewEmailTransport'
    );
    const send = vi
      .spyOn(SmtpParticipantPreviewEmailTransport.prototype, 'send')
      .mockResolvedValue({ outcome: 'unknown' });

    const { response, json } = await post({ sendEmail: true });

    expect(response.status).toBe(200);
    expect(json.previewToken).toMatch(/^[0-9a-f]{64}$/);
    expect(json.notification.status).toBe('DELIVERY_UNKNOWN');
    expect(json.notification.message).toContain('may or may not');
    expect(send).toHaveBeenCalledTimes(1);
  });
});
