import { describe, expect, it } from 'vitest';
import { SupabaseParticipantPreviewNotificationRepositoryCore } from './SupabaseParticipantPreviewNotificationRepositoryCore';
import { SupabaseParticipantPreviewReminderRepositoryCore } from './SupabaseParticipantPreviewReminderRepositoryCore';
import { SupabaseParticipantPreviewRepositoryCore } from './SupabaseParticipantPreviewRepositoryCore';
import { normalizeParticipantPreviewTimestamp } from './participantPreviewTimestamp';

const ISO = '2026-08-17T03:43:43.849Z';
const LEGACY = JSON.stringify('2026-08-17T03:43:43.849+00:00');

describe('participant-preview timestamp normalization', () => {
  it.each([
    ['normal ISO timestamp', ISO, ISO],
    ['legacy JSON-quoted timestamp', LEGACY, ISO],
    ['Postgres UTC offset', '2026-08-17T03:43:43+00:00', '2026-08-17T03:43:43.000Z'],
    ['Postgres text timestamp', '2026-08-17 03:43:43.849123+00', ISO],
    ['non-UTC offset', '2026-08-17T13:13:43.849+09:30', ISO],
    ['fractional seconds', '2026-08-17T03:43:43.849123Z', ISO],
  ])('normalizes %s', (_label, value, expected) => {
    expect(normalizeParticipantPreviewTimestamp(value)).toBe(expected);
  });

  it.each([
    ['invalid string', 'not-a-date'],
    ['blank', ''],
    ['whitespace', '   '],
    ['double nested JSON quoting', JSON.stringify(LEGACY)],
    ['number', 123],
    ['object', { timestamp: ISO }],
    ['array', [ISO]],
    ['null', null],
    ['invalid calendar date', '2026-02-30T03:43:43Z'],
    ['invalid hour', '2026-08-17T24:00:00Z'],
    ['invalid timezone', '2026-08-17T03:43:43+24:00'],
  ])('rejects %s', (_label, value) => {
    expect(normalizeParticipantPreviewTimestamp(value)).toBeNull();
  });
});

describe('participant-preview repository timestamp contracts', () => {
  it('canonicalizes legacy generate and revoke RPC timestamps', async () => {
    const responses = [
      {
        resultCode: 'SUCCESS', previewId: 'preview-1', publicId: 'project-1',
        createdAt: LEGACY, expiresAt: JSON.stringify('2026-08-24T03:43:43.849+00:00'),
      },
      { resultCode: 'SUCCESS', previewId: 'preview-1', publicId: 'project-1', revokedAt: LEGACY },
    ];
    const repository = new SupabaseParticipantPreviewRepositoryCore({
      rpc: async () => ({ data: responses.shift(), error: null }),
    } as never);

    await expect(repository.generatePreview({
      publicId: 'project-1', adminId: 'admin-1', tokenHash: 'a'.repeat(64), privateBucket: 'private',
    })).resolves.toMatchObject({
      createdAt: ISO,
      expiresAt: '2026-08-24T03:43:43.849Z',
    });
    await expect(repository.revokePreview({ publicId: 'project-1', adminId: 'admin-1' }))
      .resolves.toMatchObject({ revokedAt: ISO });
  });

  it('canonicalizes Generate + Send notification timestamps', async () => {
    const repository = new SupabaseParticipantPreviewNotificationRepositoryCore({
      rpc: async () => ({
        data: {
          resultCode: 'SUCCESS', previewId: 'preview-1', publicId: 'project-1',
          createdAt: ISO, expiresAt: '2026-08-24T03:43:43.849+00:00',
          projectTitle: 'Project', notificationId: 'notification-1', executionToken: 'execution-1',
          recipient: 'participant@example.test', requestedAt: LEGACY,
        },
        error: null,
      }),
    } as never);

    await expect(repository.generatePreviewWithNotification({
      publicId: 'project-1', adminId: 'admin-1', tokenHash: 'a'.repeat(64), privateBucket: 'private',
    })).resolves.toMatchObject({
      resultCode: 'SUCCESS',
      value: { createdAt: ISO, expiresAt: '2026-08-24T03:43:43.849Z', requestedAt: ISO },
    });
  });

  it('canonicalizes reminder mutation timestamps', async () => {
    const repository = new SupabaseParticipantPreviewReminderRepositoryCore({
      rpc: async () => ({
        data: {
          resultCode: 'SCHEDULED', reference: 'reminder-1', scheduledFor: LEGACY,
          createdAt: '2026-08-17T03:43:43.849+00:00',
        },
        error: null,
      }),
    } as never);

    await expect(repository.schedule({ publicId: 'project-1', adminId: 'admin-1', scheduledFor: ISO }))
      .resolves.toMatchObject({ scheduledFor: ISO, createdAt: ISO });
  });

  it('fails closed when an RPC returns a malformed timestamp', async () => {
    const repository = new SupabaseParticipantPreviewRepositoryCore({
      rpc: async () => ({
        data: {
          resultCode: 'SUCCESS', previewId: 'preview-1', publicId: 'project-1',
          createdAt: '2026-02-30T03:43:43Z', expiresAt: ISO,
        },
        error: null,
      }),
    } as never);

    await expect(repository.generatePreview({
      publicId: 'project-1', adminId: 'admin-1', tokenHash: 'a'.repeat(64), privateBucket: 'private',
    })).rejects.toMatchObject({ code: 'RESPONSE_INVALID' });
  });
});
