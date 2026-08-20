import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AdminAuthError } from '../../../../auth/authTypes';
import { requireAdmin } from '../../../../auth/requireAdmin';
import { getServerEnv } from '../../../../lib/env';
import { createSupabaseAdminClient } from '../../../../lib/supabase/admin';
import {
  cancelAssistiveValidation,
  enqueueAssistiveValidation,
  loadAssistiveInspection,
  recordAssistiveFindingDisposition,
} from '../../../../assistive-validation';
import {
  cancelAssistiveChecksAction,
  getAssistiveInspectionAction,
  recordAssistiveDispositionAction,
  runAssistiveChecksAction,
} from './assistiveActions';

vi.mock('server-only', () => ({}));

vi.mock('../../../../auth/requireAdmin', () => ({
  requireAdmin: vi.fn(),
}));

vi.mock('../../../../lib/supabase/admin', () => ({
  createSupabaseAdminClient: vi.fn(),
}));

vi.mock('../../../../lib/env', () => ({
  getServerEnv: vi.fn(),
}));

vi.mock('../../../../assistive-validation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../assistive-validation')>();
  return {
    ...actual,
    enqueueAssistiveValidation: vi.fn(),
    cancelAssistiveValidation: vi.fn(),
    recordAssistiveFindingDisposition: vi.fn(),
    loadAssistiveInspection: vi.fn(),
  };
});

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const FINDING_ID = '33333333-3333-4333-8333-333333333333';
const PUBLIC_ID = 'PRJ-101';
const ADMIN_ID = 'admin-user-123';

describe('Assistive Validation Server Actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getServerEnv).mockReturnValue({
      SUPABASE_DRAFT_BUCKET: 'capstone-drafts',
    } as unknown as ReturnType<typeof getServerEnv>);

    vi.mocked(requireAdmin).mockResolvedValue({
      adminUserId: ADMIN_ID,
      role: 'admin',
      permissions: ['projects.read', 'projects.edit', 'projects.review'],
    } as unknown as Awaited<ReturnType<typeof requireAdmin>>);

    const mockAdminClient = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: { id: PROJECT_ID }, error: null }),
          }),
        }),
      }),
      rpc: vi.fn().mockResolvedValue({
        data: {
          resultCode: 'FOUND',
          run: { runId: RUN_ID },
          findings: [{ findingId: FINDING_ID }],
        },
        error: null,
      }),
    };
    vi.mocked(createSupabaseAdminClient).mockReturnValue(mockAdminClient as unknown as ReturnType<typeof createSupabaseAdminClient>);
  });

  describe('runAssistiveChecksAction', () => {
    it('rejects unauthenticated staff with PERMISSION_DENIED', async () => {
      vi.mocked(requireAdmin).mockRejectedValueOnce(new AdminAuthError('UNAUTHENTICATED', 'Not logged in'));
      const result = await runAssistiveChecksAction(PUBLIC_ID);
      expect(result).toEqual({ ok: false, code: 'PERMISSION_DENIED', message: 'Authentication required.' });
    });

    it('rejects staff without projects.read permission', async () => {
      vi.mocked(requireAdmin).mockResolvedValueOnce({
        adminUserId: ADMIN_ID,
        role: 'guest',
        permissions: [],
      } as unknown as Awaited<ReturnType<typeof requireAdmin>>);

      const result = await runAssistiveChecksAction(PUBLIC_ID);
      expect(result).toEqual({
        ok: false,
        code: 'PERMISSION_DENIED',
        message: 'You do not have permission to view this project.',
      });
    });

    it('enqueues validation and returns runId and status on success', async () => {
      vi.mocked(enqueueAssistiveValidation).mockResolvedValueOnce({
        resultCode: 'ENQUEUED',
        runId: RUN_ID,
        status: 'QUEUED',
      });

      const result = await runAssistiveChecksAction(PUBLIC_ID);
      expect(result).toEqual({ ok: true, runId: RUN_ID, status: 'QUEUED' });
    });

    it('maps MEDIA_INVALID to a clear staff message', async () => {
      vi.mocked(enqueueAssistiveValidation).mockResolvedValueOnce({
        resultCode: 'MEDIA_INVALID',
      });

      const result = await runAssistiveChecksAction(PUBLIC_ID);
      expect(result).toEqual({
        ok: false,
        code: 'MEDIA_INVALID',
        message: 'No valid poster PDF or image file found for assistive checks.',
      });
    });
  });

  describe('cancelAssistiveChecksAction', () => {
    it('cancels active job and returns ok: true', async () => {
      vi.mocked(cancelAssistiveValidation).mockResolvedValueOnce({
        resultCode: 'CANCELLED',
      });

      const result = await cancelAssistiveChecksAction(PUBLIC_ID, RUN_ID);
      expect(result).toEqual({ ok: true });
    });

    it('fails closed when run does not belong to project', async () => {
      const mockAdminClient = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: { id: PROJECT_ID }, error: null }),
            }),
          }),
        }),
        rpc: vi.fn().mockResolvedValue({
          data: { resultCode: 'NOT_FOUND' },
          error: null,
        }),
      };
      vi.mocked(createSupabaseAdminClient).mockReturnValue(mockAdminClient as unknown as ReturnType<typeof createSupabaseAdminClient>);

      const result = await cancelAssistiveChecksAction(PUBLIC_ID, RUN_ID);
      expect(result).toEqual({ ok: false, code: 'NOT_FOUND', message: 'Assistive run not found for this project.' });
    });
  });

  describe('recordAssistiveDispositionAction', () => {
    it('rejects staff lacking projects.review permission', async () => {
      vi.mocked(requireAdmin).mockResolvedValueOnce({
        adminUserId: ADMIN_ID,
        role: 'editor',
        permissions: ['projects.read', 'projects.edit'], // No projects.review
      } as unknown as Awaited<ReturnType<typeof requireAdmin>>);

      const result = await recordAssistiveDispositionAction(PUBLIC_ID, RUN_ID, FINDING_ID, 'REVIEWED');
      expect(result).toEqual({
        ok: false,
        code: 'PERMISSION_DENIED',
        message: 'Your role cannot record reviewer dispositions.',
      });
    });

    it('rejects when finding is not associated with the project run', async () => {
      const mockAdminClient = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: { id: PROJECT_ID }, error: null }),
            }),
          }),
        }),
        rpc: vi.fn().mockResolvedValue({
          data: {
            resultCode: 'FOUND',
            run: { runId: RUN_ID },
            findings: [{ findingId: 'other-finding-id' }], // Does not contain FINDING_ID
          },
          error: null,
        }),
      };
      vi.mocked(createSupabaseAdminClient).mockReturnValue(mockAdminClient as unknown as ReturnType<typeof createSupabaseAdminClient>);

      const result = await recordAssistiveDispositionAction(PUBLIC_ID, RUN_ID, FINDING_ID, 'REVIEWED');
      expect(result).toEqual({
        ok: false,
        code: 'FINDING_NOT_FOUND',
        message: 'Finding not found for this project run.',
      });
    });

    it('successfully records disposition for authorized reviewer', async () => {
      vi.mocked(recordAssistiveFindingDisposition).mockResolvedValueOnce({
        ok: true,
        findingId: FINDING_ID,
        disposition: 'REVIEWED',
        reviewedAt: '2026-08-21T09:10:00.000Z',
        reviewedBy: ADMIN_ID,
        changed: true,
      });

      const result = await recordAssistiveDispositionAction(PUBLIC_ID, RUN_ID, FINDING_ID, 'REVIEWED');
      expect(result).toEqual({
        ok: true,
        findingId: FINDING_ID,
        disposition: 'REVIEWED',
        reviewedAt: '2026-08-21T09:10:00.000Z',
        reviewedBy: ADMIN_ID,
      });
    });
  });

  describe('getAssistiveInspectionAction', () => {
    it('returns inspection data for authorized staff', async () => {
      vi.mocked(loadAssistiveInspection).mockResolvedValueOnce({
        ok: true,
        found: true,
        inspection: {
          runId: RUN_ID,
          runStatus: 'COMPLETED',
          jobStatus: 'COMPLETED',
          attemptCount: 1,
          failureCode: null,
          cancellationRequested: false,
          createdAt: '2026-08-21T09:00:00.000Z',
          startedAt: '2026-08-21T09:00:01.000Z',
          completedAt: '2026-08-21T09:00:05.000Z',
          findings: [],
          staleState: 'CURRENT',
        },
      });

      const result = await getAssistiveInspectionAction(PUBLIC_ID);
      expect(result.ok).toBe(true);
      if (result.ok && result.found) {
        expect(result.inspection.runId).toBe(RUN_ID);
        expect(result.inspection.staleState).toBe('CURRENT');
      }
    });

    it('returns found: false when no run exists', async () => {
      vi.mocked(loadAssistiveInspection).mockResolvedValueOnce({
        ok: true,
        found: false,
      });

      const result = await getAssistiveInspectionAction(PUBLIC_ID);
      expect(result).toEqual({ ok: true, found: false });
    });
  });
});
