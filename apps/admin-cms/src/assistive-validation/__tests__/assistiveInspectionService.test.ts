import { describe, expect, it, vi } from 'vitest';

import {
  ASSISTIVE_PIPELINE_VERSION,
  type AssistiveValidationPersistenceGateway,
} from '../index';
import type { AssistiveInputGateway } from '../repositories/assistiveInputRepository';
import { loadAssistiveInspection } from '../services/assistiveInspectionService';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const INPUT_HASH = 'a'.repeat(64);
const BUCKET = 'test-bucket';

function mockPersistenceGateway(overrides: Partial<AssistiveValidationPersistenceGateway> = {}): AssistiveValidationPersistenceGateway {
  return {
    persistRun: vi.fn(),
    loadLatestRun: vi.fn(),
    recordDisposition: vi.fn(),
    loadInspection: vi.fn().mockResolvedValue({
      resultCode: 'FOUND',
      run: {
        runId: RUN_ID,
        projectId: PROJECT_ID,
        inputHash: INPUT_HASH,
        pipelineVersion: ASSISTIVE_PIPELINE_VERSION,
        runStatus: 'COMPLETED',
        jobStatus: 'COMPLETED',
        attemptCount: 1,
        failureCode: null,
        cancellationRequested: false,
        createdAt: '2026-08-21T09:00:00.000Z',
        startedAt: '2026-08-21T09:00:01.000Z',
        completedAt: '2026-08-21T09:00:05.000Z',
      },
      findings: [],
    }),
    ...overrides,
  };
}

const PDF_CONTENT = Buffer.from('%PDF-1.7 sample data with enough bytes');

function mockInputGateway(overrides: Partial<AssistiveInputGateway> = {}): AssistiveInputGateway {
  return {
    loadProject: vi.fn().mockResolvedValue({
      id: PROJECT_ID,
      public_id: 'PRJ-101',
      title: 'Current Project Title',
    }),
    loadPosterAssets: vi.fn().mockResolvedValue([
      {
        id: '44444444-4444-4444-8444-444444444444',
        asset_type: 'poster_pdf',
        file_name: 'poster.pdf',
        storage_bucket: BUCKET,
        storage_path: 'drafts/PRJ-101/poster_pdf/poster.pdf',
        mime_type: 'application/pdf',
        file_size_bytes: PDF_CONTENT.length,
        created_at: '2026-08-21T09:00:00.000Z',
      },
    ]),
    download: vi.fn().mockResolvedValue(PDF_CONTENT),
    ...overrides,
  };
}

describe('loadAssistiveInspection service', () => {
  it('returns found: false when database returns NOT_FOUND', async () => {
    const gateway = mockPersistenceGateway({
      loadInspection: vi.fn().mockResolvedValue({ resultCode: 'NOT_FOUND' }),
    });
    const result = await loadAssistiveInspection(gateway, mockInputGateway(), {
      projectId: PROJECT_ID,
      privateBucket: BUCKET,
    });
    expect(result).toEqual({ ok: true, found: false });
  });

  it('fails closed on invalid query parameters', async () => {
    const gateway = mockPersistenceGateway();
    const result = await loadAssistiveInspection(gateway, mockInputGateway(), {
      projectId: 'invalid-uuid',
      privateBucket: BUCKET,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('VALIDATION_FAILED');
    }
  });

  it('reports PERSISTENCE_FAILED when database gateway throws', async () => {
    const gateway = mockPersistenceGateway({
      loadInspection: vi.fn().mockRejectedValue(new Error('DB_CONN_TIMEOUT')),
    });
    const result = await loadAssistiveInspection(gateway, mockInputGateway(), {
      projectId: PROJECT_ID,
      privateBucket: BUCKET,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PERSISTENCE_FAILED');
    }
  });

  it('reports INTERNAL_FAILURE when database returns INVARIANT_VIOLATION', async () => {
    const gateway = mockPersistenceGateway({
      loadInspection: vi.fn().mockResolvedValue({ resultCode: 'INVARIANT_VIOLATION' }),
    });
    const result = await loadAssistiveInspection(gateway, mockInputGateway(), {
      projectId: PROJECT_ID,
      privateBucket: BUCKET,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INTERNAL_FAILURE');
      expect(result.message).toContain('data integrity bounds');
    }
  });

  it('keeps active in-flight jobs lightweight without downloading poster media', async () => {
    const gateway = mockPersistenceGateway({
      loadInspection: vi.fn().mockResolvedValue({
        resultCode: 'FOUND',
        run: {
          runId: RUN_ID,
          projectId: PROJECT_ID,
          inputHash: INPUT_HASH,
          pipelineVersion: ASSISTIVE_PIPELINE_VERSION,
          runStatus: 'RUNNING',
          jobStatus: 'EXTRACTING',
          attemptCount: 1,
          failureCode: null,
          cancellationRequested: false,
          createdAt: '2026-08-21T09:00:00.000Z',
          startedAt: '2026-08-21T09:00:01.000Z',
          completedAt: null,
        },
        findings: [],
      }),
    });
    const input = mockInputGateway();
    const result = await loadAssistiveInspection(gateway, input, {
      projectId: PROJECT_ID,
      privateBucket: BUCKET,
    });

    expect(result.ok).toBe(true);
    if (result.ok && result.found) {
      expect(result.inspection.jobStatus).toBe('EXTRACTING');
      expect(result.inspection.staleState).toBe('CURRENT');
      expect(input.download).not.toHaveBeenCalled();
    }
  });

  it('identifies a STALE run when current project/poster hash differs from run.inputHash', async () => {
    const gateway = mockPersistenceGateway(); // run.inputHash is 'a'.repeat(64)
    const input = mockInputGateway(); // produces hash of 'Current Project Title' + 'PDF_SAMPLE_BYTES'

    const result = await loadAssistiveInspection(gateway, input, {
      projectId: PROJECT_ID,
      privateBucket: BUCKET,
    });

    expect(result.ok).toBe(true);
    if (result.ok && result.found) {
      expect(result.inspection.staleState).toBe('STALE');
    }
  });

  it('identifies UNVERIFIABLE when poster asset cannot be loaded for a terminal run', async () => {
    const gateway = mockPersistenceGateway();
    const input = mockInputGateway({
      loadPosterAssets: vi.fn().mockResolvedValue([]), // No poster assets
    });

    const result = await loadAssistiveInspection(gateway, input, {
      projectId: PROJECT_ID,
      privateBucket: BUCKET,
    });

    expect(result.ok).toBe(true);
    if (result.ok && result.found) {
      expect(result.inspection.staleState).toBe('UNVERIFIABLE');
    }
  });
});
