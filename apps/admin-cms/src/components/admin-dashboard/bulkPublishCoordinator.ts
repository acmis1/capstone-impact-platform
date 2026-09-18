import type { WorkflowStatus } from '../../domain/workflowStatus';

export const BULK_PUBLISH_MAX_PROJECTS = 50;
const MAX_RESPONSE_BYTES = 32 * 1024;

export type BulkPublishTarget = 'local' | 'staging' | 'production';

export type BulkPublishOutcome =
  | 'COMPLETED'
  | 'ALREADY_COMPLETED'
  | 'BLOCKED'
  | 'DENIED'
  | 'FAILURE'
  | 'NOT_ATTEMPTED'
  | 'UNKNOWN';

export type BulkPublishPreflightDisposition =
  | 'eligible'
  | 'blocked'
  | 'already_complete'
  | 'ineligible';

export interface BulkPublishCandidate {
  publicId?: string;
  title: string;
  status: WorkflowStatus;
}

export interface BulkPublishPreflightItem {
  publicId: string;
  title: string;
  status: WorkflowStatus;
  disposition: BulkPublishPreflightDisposition;
  detail: string;
  blockers?: string[];
  confirmedPreviewId?: string;
  confirmedAt?: string;
  recordCount?: number;
  feedHash?: string;
}

export interface BulkPublishPreflightSummary {
  total: number;
  eligible: number;
  blocked: number;
  alreadyComplete: number;
  ineligible: number;
}

export interface BulkPublishPreflightResult {
  items: BulkPublishPreflightItem[];
  summary: BulkPublishPreflightSummary;
}

export interface BulkPublishItemResult {
  publicId: string;
  title: string;
  outcome: BulkPublishOutcome;
  detail: string;
  snapshotId?: string | null;
  recordCount?: number;
  feedHash?: string;
}

export interface BulkPublishRunResult {
  target: BulkPublishTarget;
  items: BulkPublishItemResult[];
  stopped: boolean;
  stopReason: string | null;
}

export interface BulkPublishTransport {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

const SAFE_PUBLIC_ID = /^[a-zA-Z0-9_-]{1,100}$/;

export function prepareBulkPublishCandidates(candidates: BulkPublishCandidate[]): {
  valid: boolean;
  error: string | null;
  items: BulkPublishPreflightItem[];
} {
  if (candidates.length === 0) {
    return { valid: false, error: 'Select at least one project.', items: [] };
  }
  if (candidates.length > BULK_PUBLISH_MAX_PROJECTS) {
    return {
      valid: false,
      error: `Select no more than ${BULK_PUBLISH_MAX_PROJECTS} projects.`,
      items: [],
    };
  }

  const seen = new Set<string>();
  const items: BulkPublishPreflightItem[] = candidates.map((candidate, index) => {
    const publicId = typeof candidate.publicId === 'string' ? candidate.publicId.trim() : '';
    if (!SAFE_PUBLIC_ID.test(publicId)) {
      return {
        publicId: publicId || `invalid-selection-${index + 1}`,
        title: candidate.title,
        status: candidate.status,
        disposition: 'ineligible',
        detail: 'Invalid project public ID. No request will be made.',
      };
    }
    if (seen.has(publicId)) {
      return {
        publicId,
        title: candidate.title,
        status: candidate.status,
        disposition: 'ineligible',
        detail: 'Duplicate selection. No second request will be made.',
      };
    }
    seen.add(publicId);

    if (candidate.status === 'published') {
      return {
        publicId,
        title: candidate.title,
        status: candidate.status,
        disposition: 'ineligible',
        detail:
          'Dashboard published status is not authoritative evidence of completion on this target feed.',
      };
    }

    if (candidate.status !== 'approved') {
      return {
        publicId,
        title: candidate.title,
        status: candidate.status,
        disposition: 'ineligible',
        detail: `Dashboard status is ${candidate.status}; only approved projects qualify.`,
      };
    }

    return {
      publicId,
      title: candidate.title,
      status: candidate.status,
      disposition: 'eligible',
      detail: 'Awaiting preflight check.',
    };
  });

  return { valid: true, error: null, items };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength && Number(declaredLength) > MAX_RESPONSE_BYTES) {
    throw new Error('MALFORMED_RESPONSE');
  }
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
      throw new Error('MALFORMED_RESPONSE');
    }
    return JSON.parse(text);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('MALFORMED_RESPONSE');
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidReadyPlan(
  value: Record<string, unknown>,
  requestedPublicId: string,
): value is Record<string, unknown> & {
  resultCode: 'READY_TO_STAGE';
  publicId: string;
  confirmedPreviewId: string;
  confirmedAt: string;
  recordCount: number;
  feedHash: string;
} {
  return value.resultCode === 'READY_TO_STAGE'
    && value.publicId === requestedPublicId
    && typeof value.confirmedPreviewId === 'string'
    && value.confirmedPreviewId.trim().length > 0
    && typeof value.confirmedAt === 'string'
    && value.confirmedAt.trim().length > 0
    && Number.isFinite(Date.parse(value.confirmedAt))
    && Number.isSafeInteger(value.recordCount)
    && (value.recordCount as number) >= 0
    && typeof value.feedHash === 'string'
    && /^[a-f0-9]{64}$/.test(value.feedHash);
}

export async function runBulkPublishPreflight(params: {
  candidates: BulkPublishCandidate[];
  fetchImpl?: BulkPublishTransport;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<BulkPublishPreflightResult> {
  const prepared = prepareBulkPublishCandidates(params.candidates);
  if (!prepared.valid) {
    throw new Error(prepared.error ?? 'Invalid selection.');
  }

  const fetchImpl = params.fetchImpl ?? fetch;
  const timeoutMs = params.timeoutMs ?? 30_000;
  const items: BulkPublishPreflightItem[] = prepared.items.map((item) => ({ ...item }));

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item.disposition !== 'eligible') {
      continue;
    }

    if (params.signal?.aborted) {
      throw new Error('Preflight check was cancelled.');
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    params.signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, timeoutMs);

    try {
      const response = await fetchImpl(
        `/api/projects/${encodeURIComponent(item.publicId)}/publication-plan`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
        },
      );

      if (controller.signal.aborted) {
        throw new Error('Preflight check was cancelled.');
      }

      let body: unknown;
      try {
        body = await readBoundedJson(response);
      } catch {
        items[i] = {
          ...item,
          disposition: 'blocked',
          detail: 'Preflight response was malformed or unreadable.',
        };
        continue;
      }

      if (controller.signal.aborted) {
        throw new Error('Preflight check was cancelled.');
      }

      if (!isRecord(body)) {
        items[i] = {
          ...item,
          disposition: 'blocked',
          detail: 'Unexpected preflight response format.',
        };
        continue;
      }

      if (response.ok && body.success === true && isRecord(body.result)) {
        const res = body.result;
        if (isValidReadyPlan(res, item.publicId)) {
          items[i] = {
            ...item,
            disposition: 'eligible',
            detail: 'Ready to publish.',
            confirmedPreviewId: res.confirmedPreviewId,
            confirmedAt: res.confirmedAt,
            recordCount: res.recordCount,
            feedHash: res.feedHash,
          };
          continue;
        }
      }

      if (response.status === 403) {
        items[i] = {
          ...item,
          disposition: 'blocked',
          detail: 'Publication permission denied.',
        };
        continue;
      }

      if (response.status === 409 && isRecord(body.result) && body.result.resultCode === 'NOT_READY') {
        const blockers = Array.isArray(body.result.blockers)
          ? (body.result.blockers.filter((b): b is string => typeof b === 'string'))
          : [];
        items[i] = {
          ...item,
          disposition: 'blocked',
          detail: blockers.length > 0 ? blockers.join('; ') : 'Publication readiness requirements not met.',
          blockers,
        };
        continue;
      }

      const errorMessage = typeof body.error === 'string' ? body.error : 'Preflight verification failed.';
      items[i] = {
        ...item,
        disposition: 'blocked',
        detail: errorMessage,
      };
    } catch {
      if (params.signal?.aborted) {
        throw new Error('Preflight check was cancelled.');
      }
      items[i] = {
        ...item,
        disposition: 'blocked',
        detail: 'Preflight check request failed or timed out.',
      };
    } finally {
      clearTimeout(timeout);
      params.signal?.removeEventListener('abort', abort);
    }
  }

  const summary: BulkPublishPreflightSummary = {
    total: items.length,
    eligible: items.filter((it) => it.disposition === 'eligible').length,
    blocked: items.filter((it) => it.disposition === 'blocked').length,
    alreadyComplete: items.filter((it) => it.disposition === 'already_complete').length,
    ineligible: items.filter((it) => it.disposition === 'ineligible').length,
  };

  return { items, summary };
}

function classifyExecutionResponse(
  response: Response,
  body: unknown,
  requestedPublicId: string,
): {
  outcome: Exclude<BulkPublishOutcome, 'NOT_ATTEMPTED'>;
  detail: string;
  stop: boolean;
  snapshotId?: string | null;
  recordCount?: number;
  feedHash?: string;
} {
  if (!isRecord(body) || typeof body.success !== 'boolean') {
    return {
      outcome: 'UNKNOWN',
      detail: 'Unexpected response. Inspect project and feed state before any retry.',
      stop: true,
    };
  }

  if (response.ok) {
    if (
      body.success !== true ||
      !isRecord(body.result) ||
      body.result.publicId !== requestedPublicId ||
      !['COMPLETED', 'ALREADY_COMPLETED'].includes(String(body.result.resultCode)) ||
      !Number.isSafeInteger(body.result.recordCount) ||
      (body.result.recordCount as number) < 0 ||
      typeof body.result.feedHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(body.result.feedHash)
    ) {
      return {
        outcome: 'UNKNOWN',
        detail: 'HTTP success did not contain matching completion evidence. Inspect state before any retry.',
        stop: true,
      };
    }

    if (body.result.resultCode === 'ALREADY_COMPLETED') {
      return {
        outcome: 'ALREADY_COMPLETED',
        detail: 'Already published on this target feed; no new change was required.',
        stop: false,
        snapshotId: typeof body.result.snapshotId === 'string' ? body.result.snapshotId : null,
        recordCount: body.result.recordCount as number,
        feedHash: body.result.feedHash,
      };
    }

    return {
      outcome: 'COMPLETED',
      detail: 'Published and live on the target feed.',
      stop: false,
      snapshotId: typeof body.result.snapshotId === 'string' ? body.result.snapshotId : null,
      recordCount: body.result.recordCount as number,
      feedHash: body.result.feedHash,
    };
  }

  if (body.success !== false) {
    return {
      outcome: 'UNKNOWN',
      detail: 'Contradictory response from publication endpoint. Inspect state before retry.',
      stop: true,
    };
  }

  const code = typeof body.code === 'string' ? body.code : '';
  if (response.status === 401 || response.status === 403) {
    return {
      outcome: 'DENIED',
      detail: 'Session or publication permission was denied. Sign in and revalidate before retrying.',
      stop: true,
    };
  }

  if (response.status === 409) {
    if (isRecord(body.result) && body.result.resultCode === 'NOT_READY') {
      const blockers = Array.isArray(body.result.blockers)
        ? (body.result.blockers.filter((b): b is string => typeof b === 'string'))
        : [];
      return {
        outcome: 'BLOCKED',
        detail: blockers.length > 0
          ? `Readiness changed: ${blockers.join('; ')}`
          : 'Readiness changed since preflight. Project not published.',
        stop: false,
      };
    }
    if (code === 'PUBLICATION_IN_PROGRESS') {
      return {
        outcome: 'FAILURE',
        detail: 'A public-feed writer operation is already in progress. Refresh and revalidate later.',
        stop: true,
      };
    }
    if (code === 'RECOVERY_REQUIRED') {
      return {
        outcome: 'FAILURE',
        detail: 'Public-feed recovery is incomplete. Stop and inspect recovery workflow.',
        stop: true,
      };
    }
  }

  if (
    [
      'LOCAL_PUBLICATION_UNAVAILABLE',
      'STAGING_PUBLICATION_UNAVAILABLE',
      'PRODUCTION_PUBLICATION_UNAVAILABLE',
    ].includes(code) ||
    response.status === 404
  ) {
    return {
      outcome: 'FAILURE',
      detail: 'The server-verified publication target is unavailable. No further requests were made.',
      stop: true,
    };
  }

  if (response.status >= 500 && typeof body.error === 'string') {
    return {
      outcome: 'UNKNOWN',
      detail:
        'The server returned an indeterminate failure after publication began. It may have committed; inspect state before any retry.',
      stop: true,
    };
  }

  return {
    outcome: 'UNKNOWN',
    detail: 'Unexpected publication response. Inspect project and feed state before any retry.',
    stop: true,
  };
}

export async function runBulkPublish(params: {
  preflight: BulkPublishPreflightResult;
  target: BulkPublishTarget;
  fetchImpl?: BulkPublishTransport;
  signal?: AbortSignal;
  timeoutMs?: number;
  isActive?: () => boolean;
  onUpdate?: (result: BulkPublishRunResult) => void;
}): Promise<BulkPublishRunResult> {
  if (!['local', 'staging', 'production'].includes(params.target)) {
    throw new Error('Unavailable publication target.');
  }

  const target = params.target;
  const fetchImpl = params.fetchImpl ?? fetch;
  const timeoutMs = params.timeoutMs ?? 45_000;
  const isActive = params.isActive ?? (() => true);

  const items: BulkPublishItemResult[] = params.preflight.items.map((item) => {
    if (item.disposition === 'already_complete') {
      return {
        publicId: item.publicId,
        title: item.title,
        outcome: 'ALREADY_COMPLETED',
        detail: 'Already published on this target feed; no new change was required.',
      };
    }
    if (item.disposition === 'ineligible' || item.disposition === 'blocked') {
      return {
        publicId: item.publicId,
        title: item.title,
        outcome: 'BLOCKED',
        detail: item.detail,
      };
    }
    return {
      publicId: item.publicId,
      title: item.title,
      outcome: 'NOT_ATTEMPTED',
      detail: 'Awaiting execution.',
    };
  });

  let stopped = false;
  let stopReason: string | null = null;

  const snapshot = (): BulkPublishRunResult => ({
    target,
    items: items.map((it) => ({ ...it })),
    stopped,
    stopReason,
  });

  const update = () => {
    if (isActive()) params.onUpdate?.(snapshot());
  };

  update();

  for (let index = 0; index < items.length; index += 1) {
    if (items[index].outcome !== 'NOT_ATTEMPTED') {
      continue;
    }

    if (!isActive() || params.signal?.aborted) {
      stopped = true;
      stopReason = 'Batch stopped before scheduling another request.';
      break;
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    params.signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, timeoutMs);

    try {
      const endpoint = `${target}-publication`;
      const response = await fetchImpl(
        `/api/projects/${encodeURIComponent(items[index].publicId)}/${endpoint}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
        },
      );

      if (!isActive() || controller.signal.aborted) {
        throw new Error('REQUEST_RESULT_UNOBSERVED');
      }

      let body: unknown;
      try {
        body = await readBoundedJson(response);
      } catch {
        items[index] = {
          ...items[index],
          outcome: 'UNKNOWN',
          detail: 'Malformed or oversized response. Inspect state before any retry.',
        };
        stopped = true;
        stopReason = items[index].detail;
        update();
        break;
      }

      if (!isActive() || controller.signal.aborted) {
        throw new Error('REQUEST_RESULT_UNOBSERVED');
      }

      const classified = classifyExecutionResponse(response, body, items[index].publicId);
      items[index] = {
        ...items[index],
        outcome: classified.outcome,
        detail: classified.detail,
        snapshotId: classified.snapshotId,
        recordCount: classified.recordCount,
        feedHash: classified.feedHash,
      };
      stopped = classified.stop;
      stopReason = classified.stop ? classified.detail : null;
      update();

      if (classified.stop) {
        break;
      }
    } catch {
      items[index] = {
        ...items[index],
        outcome: 'UNKNOWN',
        detail:
          'The request was interrupted or its result is unknown. It may have committed; inspect state before any retry.',
      };
      stopped = true;
      stopReason = items[index].detail;
      update();
      break;
    } finally {
      clearTimeout(timeout);
      params.signal?.removeEventListener('abort', abort);
    }
  }

  return snapshot();
}

export const BULK_PUBLISH_OUTCOME_LABELS: Record<BulkPublishOutcome, string> = {
  COMPLETED: 'Completed',
  ALREADY_COMPLETED: 'Already completed / no change',
  BLOCKED: 'Blocked / not ready',
  DENIED: 'Denied',
  FAILURE: 'Failed',
  NOT_ATTEMPTED: 'Not attempted',
  UNKNOWN: 'Unknown - inspect before retry',
};
