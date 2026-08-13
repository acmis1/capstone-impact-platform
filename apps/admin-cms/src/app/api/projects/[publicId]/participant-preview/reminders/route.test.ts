import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { AuthenticatedAdminContext } from '../../../../../../auth/authTypes';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  schedule: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('../../../../../../auth/requireAdmin', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('../../../../../../repositories/SupabaseParticipantPreviewReminderRepository', () => ({
  SupabaseParticipantPreviewReminderRepository: class {
    schedule = mocks.schedule;
    cancel = mocks.cancel;
  },
}));

import { DELETE, POST } from './route';

const ORIGIN = 'http://app.test';
const URL = `${ORIGIN}/api/projects/project_2026/participant-preview/reminders`;

function context(permissions: AuthenticatedAdminContext['permissions'] = ['projects.review']) {
  return {
    authUserId: 'auth-user', adminUserId: 'admin-user', email: 'staff@capstone.invalid',
    fullName: 'Staff User', roles: ['reviewer'], permissions,
  } as AuthenticatedAdminContext;
}

function request(method: 'POST' | 'DELETE', body: unknown, origin = ORIGIN) {
  return new NextRequest(URL, {
    method,
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function invoke(method: 'POST' | 'DELETE', body: unknown, origin = ORIGIN) {
  const handler = method === 'POST' ? POST : DELETE;
  const response = await handler(request(method, body, origin), {
    params: Promise.resolve({ publicId: 'project_2026' }),
  }) as Response;
  return { response, json: await response.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PARTICIPANT_PREVIEW_REMINDERS_ENABLED = 'true';
  process.env.PARTICIPANT_PREVIEW_EMAIL_ENABLED = 'true';
  process.env.PARTICIPANT_PREVIEW_EMAIL_SMTP_HOST = '127.0.0.1';
  process.env.PARTICIPANT_PREVIEW_EMAIL_SMTP_PORT = '54325';
  process.env.PARTICIPANT_PREVIEW_EMAIL_FROM = 'no-reply@capstone.invalid';
  mocks.requireAdmin.mockResolvedValue(context());
  mocks.schedule.mockResolvedValue({
    resultCode: 'SCHEDULED', reference: '123e4567-e89b-42d3-a456-426614174000',
    scheduledFor: '2026-08-14T02:30:00.000Z', recipient: 'participant@capstone.invalid',
    status: 'scheduled', createdAt: '2026-08-13T02:30:00.000Z',
  });
  mocks.cancel.mockResolvedValue({
    resultCode: 'CANCELLED', reference: '123e4567-e89b-42d3-a456-426614174000',
    status: 'cancelled', cancelledAt: '2026-08-13T03:30:00.000Z',
  });
});

describe('participant preview reminder route', () => {
  it.each(['POST', 'DELETE'] as const)('rejects cross-origin %s before authentication', async (method) => {
    const body = method === 'POST'
      ? { scheduledFor: '2026-08-14T02:30:00.000Z' }
      : { reference: '123e4567-e89b-42d3-a456-426614174000' };
    const { response } = await invoke(method, body, 'http://evil.test');
    expect(response.status).toBe(403);
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
  });

  it('allows participant-preview staff authority and derives the actor server-side', async () => {
    const { response, json } = await invoke('POST', {
      scheduledFor: '2026-08-14T09:30:00+07:00',
    });
    expect(response.status).toBe(200);
    expect(json.code).toBe('SCHEDULED');
    expect(mocks.schedule).toHaveBeenCalledWith({
      publicId: 'project_2026', adminId: 'admin-user',
      scheduledFor: '2026-08-14T02:30:00.000Z',
    });
    expect(JSON.stringify(json)).not.toContain('participantPreviewId');
    expect(JSON.stringify(json)).not.toContain('notificationId');
  });

  it('denies editor-only authority before repository mutation', async () => {
    mocks.requireAdmin.mockResolvedValue(context(['projects.read', 'projects.edit']));
    const { response } = await invoke('POST', { scheduledFor: '2026-08-14T02:30:00Z' });
    expect(response.status).toBe(403);
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('fails closed when either reminder or email execution is disabled', async () => {
    delete process.env.PARTICIPANT_PREVIEW_REMINDERS_ENABLED;
    const { response, json } = await invoke('POST', { scheduledFor: '2026-08-14T02:30:00Z' });
    expect(response.status).toBe(409);
    expect(json.code).toBe('REMINDERS_DISABLED');
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it.each([
    { scheduledFor: 'invalid' },
    { scheduledFor: '2026-08-14T02:30:00Z', recipient: 'chosen@capstone.invalid' },
    { scheduledFor: '2026-08-14T02:30:00Z', previewId: 'chosen' },
    { scheduledFor: '2026-08-14T02:30:00Z', actorId: 'chosen' },
  ])('rejects malformed or authority-bearing schedule bodies', async (body) => {
    const { response } = await invoke('POST', body);
    expect(response.status).toBe(400);
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it.each([
    ['INITIAL_NOTIFICATION_REQUIRED', 409],
    ['INITIAL_DELIVERY_NOT_CONFIRMED', 409],
    ['PREVIEW_CONFIRMED', 409],
    ['CORRECTION_PENDING', 409],
    ['CONTACT_CHANGED', 409],
    ['SCHEDULE_NOT_FUTURE', 400],
    ['SCHEDULE_AFTER_EXPIRY', 400],
  ] as const)('maps %s to a bounded response', async (code, status) => {
    mocks.schedule.mockResolvedValue({ resultCode: code });
    const result = await invoke('POST', { scheduledFor: '2026-08-14T02:30:00Z' });
    expect(result.response.status).toBe(status);
    expect(result.json.code).toBe(code);
    expect(JSON.stringify(result.json)).not.toMatch(/token|smtp|database/i);
  });

  it('cancels by opaque reference while deriving project and actor server-side', async () => {
    const reference = '123e4567-e89b-42d3-a456-426614174000';
    const { response, json } = await invoke('DELETE', { reference });
    expect(response.status).toBe(200);
    expect(json.code).toBe('CANCELLED');
    expect(mocks.cancel).toHaveBeenCalledWith({
      publicId: 'project_2026', adminId: 'admin-user', reference,
    });
  });

  it('rejects actor spoofing on cancellation', async () => {
    const { response } = await invoke('DELETE', {
      reference: '123e4567-e89b-42d3-a456-426614174000', adminId: 'spoofed',
    });
    expect(response.status).toBe(400);
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
});
