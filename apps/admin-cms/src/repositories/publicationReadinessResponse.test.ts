import { describe, expect, it } from 'vitest';
import { SupabaseParticipantPreviewRepositoryCore } from './SupabaseParticipantPreviewRepositoryCore';

const params = { publicId: 'project-1', adminId: '00000000-0000-4000-8000-000000000001', privateBucket: 'project-drafts-private' };

function repositoryResponse(data: unknown) {
  return new SupabaseParticipantPreviewRepositoryCore({
    rpc: async () => ({ data, error: null }),
  } as never).getPublicationReadiness(params);
}

describe('publication readiness RPC response boundary', () => {
  it('fails closed for unknown, malformed, and internally inconsistent RPC results', async () => {
    for (const data of [
      { ready: false, resultCode: 'FUTURE_CODE', blockers: [] },
      { ready: false, resultCode: 'NO_ACTIVE_PREVIEW', blockers: [42] },
      { ready: true, resultCode: 'NO_ACTIVE_PREVIEW', blockers: [] },
      { ready: true, resultCode: 'READY', blockers: [] },
      { ready: true, resultCode: 'READY', blockers: [], confirmedPreviewId: 'preview-1', confirmedAt: 'not-a-timestamp' },
    ]) {
      await expect(repositoryResponse(data)).resolves.toMatchObject({ ready: false, resultCode: 'READINESS_UNAVAILABLE' });
    }
  });

  it('accepts a complete READY response with an ISO confirmation timestamp', async () => {
    await expect(repositoryResponse({
      ready: true, resultCode: 'READY', blockers: [], confirmedPreviewId: 'preview-1', confirmedAt: '2026-08-11T08:00:00.000Z',
    })).resolves.toMatchObject({ ready: true, resultCode: 'READY', confirmedPreviewId: 'preview-1' });
  });
});
