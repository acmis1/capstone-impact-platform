import { hasPermission } from '../../auth/permissions';
import {
  assistiveEnqueueResponseSchema,
  type AssistiveRunStatus,
} from '../domain/jobContract';
import {
  BULK_ASSISTIVE_MAX_SELECTION,
  type BulkAssistiveActor,
  type BulkAssistiveAvailability,
  type BulkAssistiveExecutionItem,
  type BulkAssistiveExecutionResponse,
  type BulkAssistiveItem,
  type BulkAssistiveOutcome,
  type BulkAssistivePreflightResponse,
  type BulkAssistiveReason,
  type BulkAssistivePreflightDisposition,
  isAssistiveInputHash,
  normalizeBulkAssistivePublicIds,
  normalizeBulkAssistiveReasons,
  sortBulkAssistiveItems,
  summarizeBulkAssistivePreflight,
  toSafeBulkAssistiveExecutionItem,
} from '../domain/bulkExecutionContract';
import type { StoredAssistiveInspectionRun } from '../domain/inspectionContract';
import type {
  BulkAssistiveExecutionGateway,
  BulkAssistiveInputInspection,
  BulkAssistiveProjectRecord,
} from '../repositories/bulkAssistiveExecutionRepository';

const REQUIRED_PERMISSION = 'projects.edit' as const;
const MAX_CONCURRENT_PROJECTS = 4;
const ACTIVE_STATUSES = new Set<AssistiveRunStatus>(['QUEUED', 'RUNNING']);

export class BulkAssistivePermissionError extends Error {
  constructor() {
    super('Bulk assistive execution permission denied.');
    this.name = 'BulkAssistivePermissionError';
  }
}

function reason(code: string, message: string): { reasons: BulkAssistiveReason[]; additionalReasonCount: number } {
  return normalizeBulkAssistiveReasons([{ code, message }]);
}

function emptyState(publicId: string): BulkAssistiveProjectRecord {
  return { projectId: '', publicId, title: 'Project unavailable' };
}

function baseItem(record: BulkAssistiveProjectRecord, currentRun: Pick<StoredAssistiveInspectionRun, 'runId' | 'runStatus' | 'inputHash'> | null, inputHash: string | null): Omit<BulkAssistiveItem, 'disposition' | 'reasons' | 'additionalReasonCount'> {
  return {
    publicId: record.publicId,
    title: record.title,
    runId: currentRun?.runId ?? null,
    status: currentRun?.runStatus ?? null,
    inputHash,
  };
}

function itemWith(
  record: BulkAssistiveProjectRecord,
  currentRun: { runId: string; runStatus: AssistiveRunStatus; inputHash: string } | null,
  inputHash: string | null,
  disposition: BulkAssistivePreflightDisposition,
  reasons: BulkAssistiveReason[] = [],
): BulkAssistiveItem {
  return {
    ...baseItem(record, currentRun, inputHash),
    disposition,
    ...normalizeBulkAssistiveReasons(reasons),
  };
}

function preflightDispositionForRun(
  currentRun: { runId: string; runStatus: AssistiveRunStatus; inputHash: string } | null,
  inputHash: string,
): BulkAssistivePreflightDisposition | null {
  if (!currentRun || currentRun.inputHash !== inputHash) return null;
  if (ACTIVE_STATUSES.has(currentRun.runStatus) || currentRun.runStatus === 'COMPLETED') {
    return 'already_active_or_current';
  }
  return null;
}

function availabilityReason(availability: BulkAssistiveAvailability): BulkAssistiveReason {
  return {
    code: availability.state === 'BUDGET_REACHED' ? 'EXECUTION_BUDGET_REACHED' : 'EXECUTION_UNAVAILABLE',
    message: availability.message
      || 'Assistive checks are temporarily unavailable. No project changes were made.',
  };
}

function inspectionFailureItem(record: BulkAssistiveProjectRecord): BulkAssistiveItem {
  return itemWith(record, null, null, 'blocked', [
    { code: 'INPUT_INSPECTION_FAILED', message: 'The current project input could not be verified.' },
  ]);
}

function classifyInputFailure(
  record: BulkAssistiveProjectRecord,
  currentRun: { runId: string; runStatus: AssistiveRunStatus; inputHash: string } | null,
  inspection: BulkAssistiveInputInspection,
): BulkAssistiveItem {
  if (inspection.kind === 'MEDIA_INVALID') {
    return itemWith(record, currentRun, null, 'blocked', [
      { code: 'MEDIA_INVALID', message: 'No valid poster PDF or image file was found for assistive checks.' },
    ]);
  }
  return inspectionFailureItem(record);
}

function mapOutcome(resultCode: string): BulkAssistiveOutcome {
  if (resultCode === 'ENQUEUED') return 'ENQUEUED';
  if (resultCode === 'ALREADY_QUEUED' || resultCode === 'ALREADY_COMPLETED') return 'ALREADY_ACTIVE_OR_CURRENT';
  if (resultCode === 'MEDIA_INVALID') return 'BLOCKED';
  if (resultCode === 'PROJECT_NOT_FOUND' || resultCode === 'INPUT_CHANGED') return 'INVALID_STALE';
  return 'FAILED';
}

function executionSummary(items: BulkAssistiveExecutionItem[]): BulkAssistiveExecutionResponse['summary'] {
  return items.reduce(
    (summary, item) => {
      summary.total += 1;
      if (item.outcome === 'ENQUEUED') summary.enqueued += 1;
      if (item.outcome === 'ALREADY_ACTIVE_OR_CURRENT') summary.alreadyActiveOrCurrent += 1;
      if (item.outcome === 'BLOCKED') summary.blocked += 1;
      if (item.outcome === 'INVALID_STALE') summary.invalidStale += 1;
      if (item.outcome === 'FAILED') summary.failed += 1;
      return summary;
    },
    { total: 0, enqueued: 0, alreadyActiveOrCurrent: 0, blocked: 0, invalidStale: 0, failed: 0 },
  );
}

async function mapBounded<T, R>(values: T[], concurrency: number, task: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await task(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

export class BulkAssistiveExecutionService {
  constructor(private readonly gateway: BulkAssistiveExecutionGateway) {}

  private authorize(actor: BulkAssistiveActor): void {
    if (!hasPermission(actor.permissions, REQUIRED_PERMISSION)) throw new BulkAssistivePermissionError();
  }

  private parseSelection(publicIds: string[]): string[] {
    const normalized = normalizeBulkAssistivePublicIds(publicIds);
    if (!normalized || normalized.length < 1 || normalized.length > BULK_ASSISTIVE_MAX_SELECTION) {
      throw new Error('Bulk assistive selection is out of bounds.');
    }
    return normalized;
  }

  private async loadRecords(publicIds: string[]): Promise<Map<string, BulkAssistiveProjectRecord>> {
    return this.gateway.loadProjects(publicIds);
  }

  private async preflightOne(
    publicId: string,
    records: Map<string, BulkAssistiveProjectRecord>,
    availability: BulkAssistiveAvailability,
  ): Promise<BulkAssistiveItem> {
    const record = records.get(publicId) || emptyState(publicId);
    if (!record.projectId) {
      return itemWith(record, null, null, 'invalid_stale', [
        { code: 'PROJECT_NOT_FOUND', message: 'The project could not be verified and may have changed.' },
      ]);
    }
    if (!availability.canEnqueue) {
      return itemWith(record, null, null, 'blocked', [availabilityReason(availability)]);
    }

    try {
      const [inspection, currentRun] = await Promise.all([
        this.gateway.inspectInput(record.projectId),
        this.gateway.loadCurrentRun(record.projectId),
      ]);
      if (inspection.kind !== 'VALID') return classifyInputFailure(record, currentRun && {
        runId: currentRun.runId, runStatus: currentRun.runStatus, inputHash: currentRun.inputHash,
      }, inspection);
      const run = currentRun && {
        runId: currentRun.runId, runStatus: currentRun.runStatus, inputHash: currentRun.inputHash,
      };
      const existing = preflightDispositionForRun(run, inspection.inputHash);
      if (existing === 'already_active_or_current') {
        return itemWith(record, run, inspection.inputHash, existing);
      }
      return itemWith(record, run, inspection.inputHash, 'eligible');
    } catch {
      return inspectionFailureItem(record);
    }
  }

  async preflight(params: {
    publicIds: string[];
    actor: BulkAssistiveActor;
    availability: BulkAssistiveAvailability;
  }): Promise<BulkAssistivePreflightResponse> {
    this.authorize(params.actor);
    const publicIds = this.parseSelection(params.publicIds);
    const records = await this.loadRecords(publicIds);
    const items = await mapBounded(publicIds, MAX_CONCURRENT_PROJECTS, (publicId) => this.preflightOne(publicId, records, params.availability));
    return { summary: summarizeBulkAssistivePreflight(items), items: sortBulkAssistiveItems(items) };
  }

  private async executeOne(
    publicId: string,
    records: Map<string, BulkAssistiveProjectRecord>,
    expectedInputHashes: Record<string, string | null>,
    actor: BulkAssistiveActor,
    availability: BulkAssistiveAvailability,
  ): Promise<BulkAssistiveExecutionItem> {
    const record = records.get(publicId) || emptyState(publicId);
    if (!record.projectId) {
      return toSafeBulkAssistiveExecutionItem(
        itemWith(record, null, null, 'invalid_stale', [{ code: 'PROJECT_NOT_FOUND', message: 'The project could not be verified and may have changed.' }]),
        'INVALID_STALE',
      );
    }
    if (!availability.canEnqueue) {
      return toSafeBulkAssistiveExecutionItem(itemWith(record, null, null, 'blocked', [availabilityReason(availability)]), 'BLOCKED');
    }

    const expected = expectedInputHashes[publicId];
    if (!isAssistiveInputHash(expected)) {
      const refreshed = await this.preflightOne(publicId, records, availability);
      if (refreshed.disposition === 'blocked') {
        return toSafeBulkAssistiveExecutionItem(refreshed, 'BLOCKED');
      }
      if (refreshed.disposition === 'already_active_or_current') {
        return toSafeBulkAssistiveExecutionItem(refreshed, 'ALREADY_ACTIVE_OR_CURRENT');
      }
      if (refreshed.disposition === 'invalid_stale') {
        return toSafeBulkAssistiveExecutionItem(refreshed, 'INVALID_STALE');
      }
      return toSafeBulkAssistiveExecutionItem(
        itemWith(record, null, null, 'invalid_stale', [{ code: 'PREFLIGHT_REQUIRED', message: 'Refresh the preflight before confirming this action.' }]),
        'INVALID_STALE',
      );
    }

    try {
      const [inspection, currentRun] = await Promise.all([
        this.gateway.inspectInput(record.projectId),
        this.gateway.loadCurrentRun(record.projectId),
      ]);
      const run = currentRun && {
        runId: currentRun.runId, runStatus: currentRun.runStatus, inputHash: currentRun.inputHash,
      };
      if (inspection.kind !== 'VALID') {
        const preflightItem = classifyInputFailure(record, run, inspection);
        const outcome: BulkAssistiveOutcome = inspection.kind === 'MEDIA_INVALID' ? 'BLOCKED' : 'FAILED';
        if (outcome === 'FAILED') {
          preflightItem.disposition = 'blocked';
          preflightItem.reasons = reason('INPUT_INSPECTION_FAILED', 'The current project input could not be verified.').reasons;
        }
        return toSafeBulkAssistiveExecutionItem(preflightItem, outcome);
      }
      if (inspection.inputHash !== expected) {
        return toSafeBulkAssistiveExecutionItem(
          itemWith(record, run, inspection.inputHash, 'invalid_stale', [{ code: 'INPUT_CHANGED', message: 'The project input changed after preflight. Refresh and check again.' }]),
          'INVALID_STALE',
        );
      }
      const existing = preflightDispositionForRun(run, inspection.inputHash);
      if (existing === 'already_active_or_current') {
        return toSafeBulkAssistiveExecutionItem(itemWith(record, run, inspection.inputHash, existing), 'ALREADY_ACTIVE_OR_CURRENT');
      }

      const rawEnqueueResult = await this.gateway.enqueueProject(
        record.projectId,
        actor.adminId,
        expected,
        record.publicId,
      );
      if (
        rawEnqueueResult !== null
        && typeof rawEnqueueResult === 'object'
        && 'resultCode' in rawEnqueueResult
        && rawEnqueueResult.resultCode === 'MEDIA_INVALID'
      ) {
        return toSafeBulkAssistiveExecutionItem(
          itemWith(record, run, inspection.inputHash, 'blocked', [{
            code: 'MEDIA_INVALID',
            message: 'No valid poster PDF or image file was found for assistive checks.',
          }]),
          'BLOCKED',
        );
      }
      const enqueueResult = assistiveEnqueueResponseSchema.safeParse(rawEnqueueResult);
      if (!enqueueResult.success) {
        return toSafeBulkAssistiveExecutionItem(
          itemWith(record, run, inspection.inputHash, 'blocked', [{ code: 'ENQUEUE_RESPONSE_INVALID', message: 'The assistive queue response could not be verified.' }]),
          'FAILED',
        );
      }
      const enqueueData = enqueueResult.data;
      if (enqueueData.resultCode === 'INPUT_CHANGED') {
        return toSafeBulkAssistiveExecutionItem(
          itemWith(record, run, null, 'invalid_stale', [{
            code: 'INPUT_CHANGED',
            message: 'The project input changed during confirmation. Refresh and check again.',
          }]),
          'INVALID_STALE',
        );
      }
      const outcome = mapOutcome(enqueueData.resultCode);
      const item = itemWith(
        record,
        'runId' in enqueueData
          ? {
            runId: enqueueData.runId,
            runStatus: enqueueData.status as AssistiveRunStatus,
            inputHash: inspection.inputHash,
          }
          : run,
        inspection.inputHash,
        outcome === 'ENQUEUED'
          ? 'eligible'
          : outcome === 'ALREADY_ACTIVE_OR_CURRENT'
            ? 'already_active_or_current'
            : outcome === 'INVALID_STALE'
              ? 'invalid_stale'
              : 'blocked',
        outcome === 'INVALID_STALE'
            ? [{ code: 'PROJECT_NOT_FOUND', message: 'The project could not be verified and may have changed.' }]
            : outcome === 'FAILED'
              ? [{ code: 'ENQUEUE_FAILED', message: 'The assistive job could not be queued.' }]
              : [],
      );
      return toSafeBulkAssistiveExecutionItem(item, outcome);
    } catch {
      return toSafeBulkAssistiveExecutionItem(
        itemWith(record, null, null, 'blocked', [{ code: 'ENQUEUE_FAILED', message: 'The assistive job could not be queued.' }]),
        'FAILED',
      );
    }
  }

  async execute(params: {
    publicIds: string[];
    expectedInputHashes: Record<string, string | null>;
    actor: BulkAssistiveActor;
    availability: BulkAssistiveAvailability;
  }): Promise<BulkAssistiveExecutionResponse> {
    this.authorize(params.actor);
    const publicIds = this.parseSelection(params.publicIds);
    const records = await this.loadRecords(publicIds);
    // This is deliberately a bounded queueing fan-out. It creates at most one database job per
    // selected project; it never starts a worker. The existing dispatcher/worker drains the queue.
    const items = await mapBounded(publicIds, MAX_CONCURRENT_PROJECTS, (publicId) => this.executeOne(
      publicId, records, params.expectedInputHashes, params.actor, params.availability,
    ));
    const sorted = sortBulkAssistiveItems(items);
    return { summary: executionSummary(sorted), items: sorted };
  }
}
