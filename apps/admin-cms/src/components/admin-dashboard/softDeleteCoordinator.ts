import type { SoftDeletePreflightItem } from '../../projects/projectSoftDelete';

const MAX_RESPONSE_BYTES = 32 * 1024;

export type SoftDeleteBatchOutcome =
  | 'DELETED'
  | 'ALREADY_DELETED'
  | 'INELIGIBLE'
  | 'STALE'
  | 'DENIED'
  | 'FAILED'
  | 'UNKNOWN'
  | 'NOT_ATTEMPTED';

export interface SoftDeleteBatchItemResult extends SoftDeletePreflightItem {
  outcome: SoftDeleteBatchOutcome;
  detail: string;
  auditRecorded: boolean;
}

export interface SoftDeleteBatchRunResult {
  items: SoftDeleteBatchItemResult[];
  stopped: boolean;
  stopReason: string | null;
}

export interface SoftDeleteTransport {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

function prepare(items: SoftDeletePreflightItem[]): SoftDeleteBatchItemResult[] {
  return items.map((item) => {
    if (item.disposition === 'already_deleted') {
      return { ...item, outcome: 'ALREADY_DELETED', detail: item.reason, auditRecorded: false };
    }
    if (item.disposition !== 'eligible' || !item.updatedAt) {
      return { ...item, outcome: 'INELIGIBLE', detail: item.reason, auditRecorded: false };
    }
    return { ...item, outcome: 'NOT_ATTEMPTED', detail: 'Awaiting confirmed execution.', auditRecorded: false };
  });
}

export async function readBoundedSoftDeleteJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength && Number(declaredLength) > MAX_RESPONSE_BYTES) throw new Error('MALFORMED_RESPONSE');
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new Error('MALFORMED_RESPONSE');
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

function classifyResponse(response: Response, body: unknown, item: SoftDeleteBatchItemResult): {
  outcome: Exclude<SoftDeleteBatchOutcome, 'NOT_ATTEMPTED'>;
  detail: string;
  auditRecorded: boolean;
  stop: boolean;
} {
  if (!isRecord(body) || typeof body.success !== 'boolean') {
    return { outcome: 'UNKNOWN', detail: 'Unexpected response. Inspect the retained project and audit state before any retry.', auditRecorded: false, stop: true };
  }
  if (response.ok) {
    if (body.success !== true || !isRecord(body.result) || body.result.publicId !== item.publicId) {
      return { outcome: 'UNKNOWN', detail: 'HTTP success did not contain matching deletion evidence. Inspect state before any retry.', auditRecorded: false, stop: true };
    }
    if (body.result.resultCode === 'ALREADY_DELETED' && body.result.status === 'deleted') {
      return { outcome: 'ALREADY_DELETED', detail: 'Already soft-deleted; no duplicate audit event was created.', auditRecorded: false, stop: false };
    }
    if (
      body.result.resultCode === 'DELETED'
      && body.result.status === 'deleted'
      && typeof body.result.deletedAt === 'string'
      && Number.isFinite(Date.parse(body.result.deletedAt))
      && typeof body.result.auditRecordId === 'string'
      && /^[0-9a-fA-F-]{36}$/.test(body.result.auditRecordId)
    ) {
      return { outcome: 'DELETED', detail: 'Soft-deleted. The project row, assets, evidence, publication history, and audits were retained.', auditRecorded: true, stop: false };
    }
    return { outcome: 'UNKNOWN', detail: 'Completion evidence was incomplete. Inspect state before any retry.', auditRecorded: false, stop: true };
  }

  if (body.success !== false) {
    return { outcome: 'UNKNOWN', detail: 'Contradictory response. Inspect state before any retry.', auditRecorded: false, stop: true };
  }
  const code = typeof body.code === 'string' ? body.code : '';
  const detail = typeof body.error === 'string' && body.error.length <= 240
    ? body.error
    : 'The server refused this deletion.';
  if (response.status === 401 || response.status === 403) {
    return { outcome: 'DENIED', detail: 'Administrator authority was denied. Sign in and run a new preflight.', auditRecorded: false, stop: true };
  }
  if (response.status === 400 || response.status === 413) {
    return { outcome: 'FAILED', detail, auditRecorded: false, stop: false };
  }
  if (code === 'STALE_VERSION' && response.status === 409) {
    return { outcome: 'STALE', detail: 'The project changed after preflight. It was not deleted.', auditRecorded: false, stop: false };
  }
  if (
    response.status === 404
    || [
      'PROJECT_NOT_FOUND', 'DELETE_STATE_AMBIGUOUS', 'PUBLISHED_REQUIRES_ARCHIVE',
      'REMOVAL_PENDING', 'STATUS_INELIGIBLE', 'PUBLICATION_OR_REMOVAL_PENDING',
      'CURRENTLY_PUBLIC', 'CANONICAL_FEED_UNAVAILABLE', 'REMOVAL_EVIDENCE_REQUIRED',
      'REMOVAL_EVIDENCE_AMBIGUOUS',
    ].includes(code)
  ) {
    return { outcome: 'INELIGIBLE', detail, auditRecorded: false, stop: false };
  }
  return { outcome: 'UNKNOWN', detail: 'The request result is unknown and may have committed. Inspect state before any retry.', auditRecorded: false, stop: true };
}

export async function runSoftDeleteBatch(params: {
  preflightItems: SoftDeletePreflightItem[];
  fetchImpl?: SoftDeleteTransport;
  signal?: AbortSignal;
  timeoutMs?: number;
  isActive?: () => boolean;
  onUpdate?: (result: SoftDeleteBatchRunResult) => void;
}): Promise<SoftDeleteBatchRunResult> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const timeoutMs = params.timeoutMs ?? 30_000;
  const isActive = params.isActive ?? (() => true);
  const items = prepare(params.preflightItems);
  let stopped = false;
  let stopReason: string | null = null;
  const snapshot = (): SoftDeleteBatchRunResult => ({
    items: items.map((item) => ({ ...item })), stopped, stopReason,
  });
  const update = () => { if (isActive()) params.onUpdate?.(snapshot()); };
  update();

  for (let index = 0; index < items.length; index += 1) {
    if (items[index].outcome !== 'NOT_ATTEMPTED') continue;
    if (!isActive() || params.signal?.aborted) {
      stopped = true;
      stopReason = 'Batch stopped before another request was scheduled.';
      break;
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    params.signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, timeoutMs);
    try {
      const response = await fetchImpl(`/api/projects/${encodeURIComponent(items[index].publicId)}/soft-delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedUpdatedAt: items[index].updatedAt }),
        signal: controller.signal,
      });
      if (!isActive() || controller.signal.aborted) throw new Error('REQUEST_RESULT_UNOBSERVED');
      let body: unknown;
      try {
        body = await readBoundedSoftDeleteJson(response);
      } catch {
        items[index] = {
          ...items[index], outcome: 'UNKNOWN', auditRecorded: false,
          detail: 'Malformed or oversized response. Inspect state before any retry.',
        };
        stopped = true;
        stopReason = items[index].detail;
        update();
        break;
      }
      if (!isActive() || controller.signal.aborted) throw new Error('REQUEST_RESULT_UNOBSERVED');
      const classified = classifyResponse(response, body, items[index]);
      items[index] = {
        ...items[index], outcome: classified.outcome, detail: classified.detail,
        auditRecorded: classified.auditRecorded,
      };
      stopped = classified.stop;
      stopReason = classified.stop ? classified.detail : null;
      update();
      if (classified.stop) break;
    } catch {
      items[index] = {
        ...items[index], outcome: 'UNKNOWN', auditRecorded: false,
        detail: 'The request was interrupted or its result is unknown. It may have committed; inspect state before any retry.',
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

export const SOFT_DELETE_OUTCOME_LABELS: Record<SoftDeleteBatchOutcome, string> = {
  DELETED: 'Soft-deleted',
  ALREADY_DELETED: 'Already soft-deleted / no change',
  INELIGIBLE: 'Ineligible',
  STALE: 'Changed after preflight',
  DENIED: 'Denied',
  FAILED: 'Failed before mutation',
  UNKNOWN: 'Unknown - inspect before retry',
  NOT_ATTEMPTED: 'Not attempted',
};
