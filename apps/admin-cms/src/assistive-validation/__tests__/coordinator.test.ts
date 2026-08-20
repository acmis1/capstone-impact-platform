import nativeFixture from '../../../../assistive-worker/tests/fixtures/phase-2-consumer-native-pdf.json';
import { describe, expect, it, vi } from 'vitest';

import { hashAssistiveInput } from '../domain/inputIdentity';
import type { AssistiveJobGateway } from '../repositories/assistiveJobRepository';
import type { AssistiveInputGateway } from '../repositories/assistiveInputRepository';
import { AssistiveValidationCoordinator } from '../services/assistiveCoordinator';
import type { AssistiveWorkerRunner } from '../services/pythonWorkerProcess';
import { WorkerProcessError } from '../services/pythonWorkerProcess';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const JOB_ID = '33333333-3333-4333-8333-333333333333';
const RUN_ID = '44444444-4444-4444-8444-444444444444';
const TOKEN = '55555555-5555-4555-8555-555555555555';
const WORKER_ID = '66666666-6666-4666-8666-666666666666';
const TITLE = 'AI-Enabled Flood Warning System';
const PDF = Buffer.from('%PDF-1.4\n', 'ascii');

function inputGateway(contents: Buffer[]): AssistiveInputGateway {
  let read = 0;
  return {
    loadProject: vi.fn().mockResolvedValue({ id: PROJECT_ID, public_id: 'P-1', title: TITLE }),
    loadPosterAssets: vi.fn().mockImplementation(async () => [{
      id: '77777777-7777-4777-8777-777777777777',
      asset_type: 'poster_pdf', file_name: 'poster.pdf', storage_bucket: 'private',
      storage_path: 'drafts/P-1/poster_pdf/poster.pdf', mime_type: 'application/pdf',
      file_size_bytes: contents[Math.min(read, contents.length - 1)].length,
      created_at: '2026-08-20T00:00:00Z',
    }]),
    download: vi.fn().mockImplementation(async () => contents[Math.min(read++, contents.length - 1)]),
  };
}

function jobGateway(inputHash: string): AssistiveJobGateway & { finalize: ReturnType<typeof vi.fn>; fail: ReturnType<typeof vi.fn>; supersede: ReturnType<typeof vi.fn> } {
  return {
    enqueue: vi.fn(), status: vi.fn(), cancel: vi.fn(), health: vi.fn(),
    claim: vi.fn().mockResolvedValue({
      resultCode: 'CLAIMED', jobId: JOB_ID, runId: RUN_ID, projectId: PROJECT_ID,
      requestedBy: ACTOR_ID, inputHash, pipelineVersion: 'assistive-deterministic-checks/v1',
      attemptCount: 1, claimToken: TOKEN, leaseUntil: '2026-08-20T00:02:00Z',
    }),
    heartbeat: vi.fn().mockResolvedValue({ resultCode: 'HEARTBEAT', leaseUntil: '2026-08-20T00:03:00Z' }),
    advance: vi.fn().mockResolvedValue({ resultCode: 'ADVANCED', jobStatus: 'CHECKING' }),
    supersede: vi.fn().mockResolvedValue({ resultCode: 'SUPERSEDED' }),
    fail: vi.fn().mockResolvedValue({ resultCode: 'FAILED', failureCode: 'INTERNAL_FAILURE' }),
    finalize: vi.fn().mockResolvedValue({ resultCode: 'FINALIZED', runId: RUN_ID, status: 'COMPLETED', findingCount: 1 }),
  };
}

function worker(result = nativeFixture): AssistiveWorkerRunner {
  return {
    run: vi.fn().mockResolvedValue({
      schema_version: 'assistive-worker-task-result/v1',
      task_id: '88888888-8888-4888-8888-888888888888',
      extraction: result,
      error: null,
      duration_ms: 10,
    }),
  };
}

describe('assistive coordinator', () => {
  it('runs extraction and deterministic checks, rechecks identity, and finalizes atomically', async () => {
    const inputHash = hashAssistiveInput({ title: TITLE, documentType: 'PDF', content: PDF }).inputHash;
    const jobs = jobGateway(inputHash);
    const coordinator = new AssistiveValidationCoordinator(
      jobs, inputGateway([PDF, PDF]), 'private', worker(), WORKER_ID,
    );
    await expect(coordinator.runOnce()).resolves.toEqual({ outcome: 'FINALIZED', runId: RUN_ID });
    expect(jobs.advance).toHaveBeenCalledWith(JOB_ID, TOKEN);
    expect(jobs.finalize).toHaveBeenCalledOnce();
    const submitted = vi.mocked(jobs.finalize).mock.calls[0][0];
    expect(submitted.inputHash).toBe(inputHash);
    expect(submitted.status).toBe('COMPLETED');
    expect(submitted.completionCode).toBeNull();
    expect(submitted.findings).toHaveLength(1);
    expect(submitted.findings[0].classification).toBe('NON_BLOCKING');
  });

  it('supersedes instead of finalizing when authoritative input changes during work', async () => {
    const changed = Buffer.from('%PDF-1.5\n', 'ascii');
    const inputHash = hashAssistiveInput({ title: TITLE, documentType: 'PDF', content: PDF }).inputHash;
    const jobs = jobGateway(inputHash);
    const coordinator = new AssistiveValidationCoordinator(
      jobs, inputGateway([PDF, changed]), 'private', worker(), WORKER_ID,
    );
    await expect(coordinator.runOnce()).resolves.toEqual({ outcome: 'SUPERSEDED', runId: RUN_ID });
    expect(jobs.supersede).toHaveBeenCalledWith(JOB_ID, TOKEN);
    expect(jobs.finalize).not.toHaveBeenCalled();
  });

  it('records a bounded failure when the worker task contract rejects', async () => {
    const inputHash = hashAssistiveInput({ title: TITLE, documentType: 'PDF', content: PDF }).inputHash;
    const jobs = jobGateway(inputHash);
    const rejected: AssistiveWorkerRunner = {
      run: vi.fn().mockResolvedValue({
        schema_version: 'assistive-worker-task-result/v1', task_id: null, extraction: null,
        error: { code: 'TASK_CONTRACT_REJECTED', message: 'Rejected.' }, duration_ms: 1,
      }),
    };
    const coordinator = new AssistiveValidationCoordinator(
      jobs, inputGateway([PDF]), 'private', rejected, WORKER_ID,
    );
    await expect(coordinator.runOnce()).resolves.toEqual({ outcome: 'FAILED', runId: RUN_ID });
    expect(jobs.fail).toHaveBeenCalledWith(JOB_ID, TOKEN, 'EXTRACTION_CONTRACT_REJECTED');
  });

  it('keeps a structured task execution failure in the retryable worker-crash class', async () => {
    const inputHash = hashAssistiveInput({ title: TITLE, documentType: 'PDF', content: PDF }).inputHash;
    const jobs = jobGateway(inputHash);
    const failed: AssistiveWorkerRunner = {
      run: vi.fn().mockResolvedValue({
        schema_version: 'assistive-worker-task-result/v1',
        task_id: '88888888-8888-4888-8888-888888888888',
        extraction: null,
        error: { code: 'TASK_EXECUTION_FAILED', message: 'Failed safely.' },
        duration_ms: 1,
      }),
    };
    const coordinator = new AssistiveValidationCoordinator(
      jobs, inputGateway([PDF]), 'private', failed, WORKER_ID,
    );

    await expect(coordinator.runOnce()).resolves.toEqual({ outcome: 'FAILED', runId: RUN_ID });
    expect(jobs.fail).toHaveBeenCalledWith(JOB_ID, TOKEN, 'WORKER_CRASHED');
  });

  it('reports cancellation distinctly when a heartbeat cancels the running child', async () => {
    const inputHash = hashAssistiveInput({ title: TITLE, documentType: 'PDF', content: PDF }).inputHash;
    const jobs = jobGateway(inputHash);
    const cancelled: AssistiveWorkerRunner = {
      run: vi.fn().mockRejectedValue(new WorkerProcessError('CANCELLED')),
    };
    const coordinator = new AssistiveValidationCoordinator(
      jobs, inputGateway([PDF]), 'private', cancelled, WORKER_ID,
    );
    await expect(coordinator.runOnce()).resolves.toEqual({ outcome: 'CANCELLED', runId: RUN_ID });
    expect(jobs.fail).not.toHaveBeenCalled();
  });
});
