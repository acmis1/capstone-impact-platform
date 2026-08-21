import { formattingInformation } from '../deterministic/formatting';
import { extractionInformationalChecks } from '../deterministic/informational';
import { evaluateTitleConsistency } from '../deterministic/titleConsistency';
import {
  assistiveClaimSchema,
  assistiveMutationResponseSchema,
  type AssistiveClaim,
  type AssistiveJobFailureCode,
} from '../domain/jobContract';
import { toPersistedAssistiveFinding } from '../domain/persistenceContract';
import { toPersistedDuplicateShortlistFinding } from '../domain/persistenceContract';
import { rankDuplicateCandidates } from '../duplicate-detection/duplicateRanker';
import type { AssistiveJobGateway } from '../repositories/assistiveJobRepository';
import type { AssistiveInputGateway } from '../repositories/assistiveInputRepository';
import { loadAssistiveInput } from './assistiveInputService';
import { WorkerProcessError, type AssistiveWorkerRunner } from './pythonWorkerProcess';

const LEASE_SECONDS = 120;

export type CoordinatorResult =
  | { outcome: 'EMPTY' }
  | { outcome: 'FINALIZED' | 'PARTIAL' | 'FAILED' | 'RETRY_QUEUED' | 'CANCELLED' | 'SUPERSEDED' | 'CLAIM_LOST'; runId: string };

async function mutate(gateway: AssistiveJobGateway, operation: Promise<unknown>) {
  return assistiveMutationResponseSchema.parse(await operation);
}

async function failClaim(
  gateway: AssistiveJobGateway,
  claim: AssistiveClaim,
  code: AssistiveJobFailureCode,
): Promise<CoordinatorResult> {
  const result = await mutate(gateway, gateway.fail(claim.jobId, claim.claimToken, code));
  if (result.resultCode === 'CANCELLED') return { outcome: 'CANCELLED', runId: claim.runId };
  if (result.resultCode === 'CLAIM_LOST') return { outcome: 'CLAIM_LOST', runId: claim.runId };
  if (result.resultCode === 'RETRY_QUEUED') return { outcome: 'RETRY_QUEUED', runId: claim.runId };
  return { outcome: 'FAILED', runId: claim.runId };
}

function processFailureCode(error: unknown): AssistiveJobFailureCode | 'CLAIM_LOST' | 'CANCELLED' {
  if (!(error instanceof WorkerProcessError)) return 'INTERNAL_FAILURE';
  if (error.code === 'CLAIM_LOST') return 'CLAIM_LOST';
  if (error.code === 'CANCELLED') return 'CANCELLED';
  return error.code;
}

function supersededOutcome(resultCode: string, runId: string): CoordinatorResult {
  if (resultCode === 'CANCELLED') return { outcome: 'CANCELLED', runId };
  if (resultCode === 'CLAIM_LOST') return { outcome: 'CLAIM_LOST', runId };
  if (resultCode !== 'SUPERSEDED') throw new Error('ASSISTIVE_SUPERSEDE_FAILED');
  return { outcome: 'SUPERSEDED', runId };
}

export class AssistiveValidationCoordinator {
  constructor(
    private readonly jobs: AssistiveJobGateway,
    private readonly inputs: AssistiveInputGateway,
    private readonly privateBucket: string,
    private readonly worker: AssistiveWorkerRunner,
    private readonly workerId: string,
  ) {}

  async runOnce(): Promise<CoordinatorResult> {
    const claimed = assistiveClaimSchema.parse(await this.jobs.claim(this.workerId, LEASE_SECONDS));
    if (claimed.resultCode === 'EMPTY') return { outcome: 'EMPTY' };
    if (claimed.resultCode === 'VALIDATION_FAILED') throw new Error('ASSISTIVE_CLAIM_CONFIGURATION_INVALID');
    const claim = claimed;

    let initial;
    try {
      initial = await loadAssistiveInput(this.inputs, claim.projectId, this.privateBucket);
    } catch {
      return failClaim(this.jobs, claim, 'INPUT_UNAVAILABLE');
    }
    if (!initial) return failClaim(this.jobs, claim, 'MEDIA_INVALID');
    if (initial.inputHash !== claim.inputHash) {
      const result = await mutate(this.jobs, this.jobs.supersede(claim.jobId, claim.claimToken));
      return supersededOutcome(result.resultCode, claim.runId);
    }

    let task;
    try {
      task = await this.worker.run({
        content: initial.content,
        documentType: initial.documentType,
        ocrProvider: 'NONE',
        onPulse: async () => {
          const pulse = await mutate(this.jobs, this.jobs.heartbeat(
            claim.jobId,
            claim.claimToken,
            LEASE_SECONDS,
          ));
          if (pulse.resultCode === 'CANCELLED') return 'CANCEL';
          if (pulse.resultCode === 'CLAIM_LOST') return 'CLAIM_LOST';
          return 'CONTINUE';
        },
      });
    } catch (error) {
      const code = processFailureCode(error);
      if (code === 'CLAIM_LOST') return { outcome: 'CLAIM_LOST', runId: claim.runId };
      if (code === 'CANCELLED') return { outcome: 'CANCELLED', runId: claim.runId };
      return failClaim(this.jobs, claim, code);
    }

    if (task.error) {
      return failClaim(
        this.jobs,
        claim,
        task.error.code === 'TASK_CONTRACT_REJECTED'
          ? 'EXTRACTION_CONTRACT_REJECTED'
          : 'WORKER_CRASHED',
      );
    }
    const extraction = task.extraction;
    if (!extraction) return failClaim(this.jobs, claim, 'EXTRACTION_CONTRACT_REJECTED');
    if (extraction.status === 'FAILED') return failClaim(this.jobs, claim, 'EXTRACTION_FAILED');

    const advanced = await mutate(this.jobs, this.jobs.advance(claim.jobId, claim.claimToken));
    if (advanced.resultCode === 'CANCELLED') return { outcome: 'CANCELLED', runId: claim.runId };
    if (advanced.resultCode !== 'ADVANCED') return { outcome: 'CLAIM_LOST', runId: claim.runId };

    let findings;
    try {
      findings = [
        evaluateTitleConsistency(extraction, initial.title),
        ...formattingInformation(extraction.text),
        ...extractionInformationalChecks(extraction),
      ].map(toPersistedAssistiveFinding);
      const duplicateFinding = toPersistedDuplicateShortlistFinding(
        rankDuplicateCandidates(initial.currentProject, initial.duplicateCandidates),
      );
      if (duplicateFinding) findings.push(duplicateFinding);
    } catch {
      return failClaim(this.jobs, claim, 'DETERMINISTIC_CONTRACT_REJECTED');
    }

    let current;
    try {
      current = await loadAssistiveInput(this.inputs, claim.projectId, this.privateBucket);
    } catch {
      current = null;
    }
    if (!current || current.inputHash !== claim.inputHash) {
      const result = await mutate(this.jobs, this.jobs.supersede(claim.jobId, claim.claimToken));
      return supersededOutcome(result.resultCode, claim.runId);
    }

    const partialCode = extraction.status === 'OCR_REQUIRED'
      ? (extraction.ocr_state === 'UNAVAILABLE' ? 'OCR_PROVIDER_UNAVAILABLE' : 'OCR_REQUIRED')
      : null;
    const finalized = await mutate(this.jobs, this.jobs.finalize({
      jobId: claim.jobId,
      claimToken: claim.claimToken,
      inputHash: current.inputHash,
      status: partialCode === null ? 'COMPLETED' : 'PARTIAL',
      completionCode: partialCode,
      findings,
    }));
    if (finalized.resultCode === 'CANCELLED') return { outcome: 'CANCELLED', runId: claim.runId };
    if (finalized.resultCode === 'CLAIM_LOST') return { outcome: 'CLAIM_LOST', runId: claim.runId };
    if (finalized.resultCode === 'INPUT_CHANGED') {
      const result = await mutate(this.jobs, this.jobs.supersede(claim.jobId, claim.claimToken));
      return supersededOutcome(result.resultCode, claim.runId);
    }
    if (finalized.resultCode === 'FINALIZED' || finalized.resultCode === 'ALREADY_COMPLETED') {
      return { outcome: partialCode === null ? 'FINALIZED' : 'PARTIAL', runId: claim.runId };
    }
    if (finalized.resultCode === 'VALIDATION_FAILED') {
      return failClaim(this.jobs, claim, 'DETERMINISTIC_CONTRACT_REJECTED');
    }
    return { outcome: 'FAILED', runId: claim.runId };
  }
}
