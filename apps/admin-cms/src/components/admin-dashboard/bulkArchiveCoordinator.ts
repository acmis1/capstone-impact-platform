import type { WorkflowStatus } from '../../domain/workflowStatus';

export const BULK_ARCHIVE_MAX_PROJECTS = 50;
export const BULK_ARCHIVE_REASON_MAX_LENGTH = 4000;
const MAX_RESPONSE_BYTES = 32 * 1024;

export type BulkArchiveTarget = 'local' | 'staging' | 'production';
export type BulkArchiveOutcome =
  | 'COMPLETED'
  | 'ALREADY_COMPLETED'
  | 'INVALID_OR_INELIGIBLE'
  | 'DENIED'
  | 'FAILURE'
  | 'NOT_ATTEMPTED'
  | 'UNKNOWN';

export interface BulkArchiveCandidate {
  publicId?: string;
  title: string;
  status: WorkflowStatus;
}

export interface BulkArchiveItemResult {
  publicId: string;
  title: string;
  outcome: BulkArchiveOutcome;
  detail: string;
}

export interface BulkArchiveRunResult {
  target: BulkArchiveTarget;
  items: BulkArchiveItemResult[];
  stopped: boolean;
  stopReason: string | null;
}

export interface BulkArchiveTransport {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

const SAFE_PUBLIC_ID = /^[a-zA-Z0-9_-]{1,100}$/;

export function validateBulkArchiveReason(reason: string): string | null {
  const trimmed = reason.trim();
  return trimmed.length > 0 && trimmed.length <= BULK_ARCHIVE_REASON_MAX_LENGTH ? trimmed : null;
}

export function prepareBulkArchiveItems(candidates: BulkArchiveCandidate[]): {
  valid: boolean;
  error: string | null;
  items: BulkArchiveItemResult[];
} {
  if (candidates.length === 0) return { valid: false, error: 'Select at least one project.', items: [] };
  if (candidates.length > BULK_ARCHIVE_MAX_PROJECTS) {
    return { valid: false, error: `Select no more than ${BULK_ARCHIVE_MAX_PROJECTS} projects.`, items: [] };
  }

  const seen = new Set<string>();
  const items = candidates.map((candidate, index): BulkArchiveItemResult => {
    const publicId = typeof candidate.publicId === 'string' ? candidate.publicId.trim() : '';
    if (!SAFE_PUBLIC_ID.test(publicId)) {
      return {
        publicId: publicId || `invalid-selection-${index + 1}`,
        title: candidate.title,
        outcome: 'INVALID_OR_INELIGIBLE',
        detail: 'Invalid project public ID. No request will be made.',
      };
    }
    if (seen.has(publicId)) {
      return {
        publicId,
        title: candidate.title,
        outcome: 'INVALID_OR_INELIGIBLE',
        detail: 'Duplicate selection. No second request will be made.',
      };
    }
    seen.add(publicId);
    if (candidate.status !== 'published') {
      return {
        publicId,
        title: candidate.title,
        outcome: 'INVALID_OR_INELIGIBLE',
        detail: `Dashboard status is ${candidate.status}; only published projects qualify.`,
      };
    }
    return { publicId, title: candidate.title, outcome: 'NOT_ATTEMPTED', detail: 'Awaiting confirmation.' };
  });
  return { valid: true, error: null, items };
}

async function readBoundedJson(response: Response): Promise<unknown> {
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
    // Stop downloading an invalid/oversized stream rather than merely abandoning its reader.
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function classifyResponse(response: Response, body: unknown, requestedPublicId: string): {
  outcome: Exclude<BulkArchiveOutcome, 'NOT_ATTEMPTED'>;
  detail: string;
  stop: boolean;
} {
  if (!isRecord(body) || typeof body.success !== 'boolean') {
    return { outcome: 'UNKNOWN', detail: 'Unexpected response. Inspect project and feed recovery state before any retry.', stop: true };
  }
  if (response.ok) {
    if (body.success !== true || !isRecord(body.result)
      || body.result.publicId !== requestedPublicId
      || !['COMPLETED', 'ALREADY_COMPLETED'].includes(String(body.result.resultCode))
      || !Number.isSafeInteger(body.result.recordCount)
      || (body.result.recordCount as number) < 0
      || typeof body.result.feedHash !== 'string'
      || !/^[a-f0-9]{64}$/.test(body.result.feedHash)) {
      return { outcome: 'UNKNOWN', detail: 'HTTP success did not contain matching completion evidence. Inspect state before any retry.', stop: true };
    }
    if (body.result.resultCode === 'ALREADY_COMPLETED') {
      return { outcome: 'ALREADY_COMPLETED', detail: 'Already archived and absent from this target; no new change was required.', stop: false };
    }
    return { outcome: 'COMPLETED', detail: 'Archived and removed from this target feed.', stop: false };
  }

  if (body.success !== false) {
    return { outcome: 'UNKNOWN', detail: 'Contradictory response. Inspect state before any retry.', stop: true };
  }
  const code = typeof body.code === 'string' ? body.code : '';
  if (response.status === 401 || response.status === 403) {
    return { outcome: 'DENIED', detail: 'Session or archive permission was denied. Sign in and revalidate before retrying.', stop: true };
  }
  if (code === 'NOT_PUBLISHED' && response.status === 409) {
    return { outcome: 'INVALID_OR_INELIGIBLE', detail: 'The server reports that this project is not currently published.', stop: false };
  }
  if (code === 'RECOVERY_REQUIRED') {
    return { outcome: 'FAILURE', detail: 'Recovery is required. Stop and inspect the public-feed recovery workflow.', stop: true };
  }
  if (code === 'PUBLICATION_IN_PROGRESS') {
    return { outcome: 'FAILURE', detail: 'A public-feed writer conflict is in progress. Refresh and revalidate later.', stop: true };
  }
  if (code === 'CURRENT_FEED_DIVERGED') {
    return { outcome: 'FAILURE', detail: 'The canonical feed has diverged. Stop and repair the publishing state.', stop: true };
  }
  if (['LOCAL_ARCHIVE_UNAVAILABLE', 'STAGING_ARCHIVE_UNAVAILABLE', 'PRODUCTION_ARCHIVE_UNAVAILABLE'].includes(code)) {
    return { outcome: 'FAILURE', detail: 'The server-verified archive target is unavailable. No further requests were made.', stop: true };
  }
  if (['STAGING_ARCHIVE_FAILED', 'PRODUCTION_ARCHIVE_FAILED'].includes(code)
    || (!response.ok && response.status >= 500 && typeof body.error === 'string')) {
    return { outcome: 'FAILURE', detail: 'The server reported that archive did not complete. Inspect current state before retrying.', stop: true };
  }
  return { outcome: 'UNKNOWN', detail: 'Unexpected archive response. Inspect project and feed state before any retry.', stop: true };
}

export async function runBulkArchive(params: {
  candidates: BulkArchiveCandidate[];
  reason: string;
  target: BulkArchiveTarget;
  fetchImpl?: BulkArchiveTransport;
  signal?: AbortSignal;
  timeoutMs?: number;
  isActive?: () => boolean;
  onUpdate?: (result: BulkArchiveRunResult) => void;
}): Promise<BulkArchiveRunResult> {
  if (!['local', 'staging', 'production'].includes(params.target)) throw new Error('Unavailable archive target.');
  const target = params.target;
  const prepared = prepareBulkArchiveItems(params.candidates);
  const reason = validateBulkArchiveReason(params.reason);
  if (!prepared.valid || !reason) {
    throw new Error(prepared.error ?? 'A removal reason is required and must be at most 4,000 characters.');
  }
  const fetchImpl = params.fetchImpl ?? fetch;
  const timeoutMs = params.timeoutMs ?? 30_000;
  const isActive = params.isActive ?? (() => true);
  const items = prepared.items.map((item) => ({ ...item }));
  let stopped = false;
  let stopReason: string | null = null;
  const snapshot = (): BulkArchiveRunResult => ({ target, items: items.map((item) => ({ ...item })), stopped, stopReason });
  const update = () => { if (isActive()) params.onUpdate?.(snapshot()); };
  update();

  for (let index = 0; index < items.length; index += 1) {
    if (items[index].outcome !== 'NOT_ATTEMPTED') continue;
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
      const endpoint = `${target}-archive`;
      const response = await fetchImpl(`/api/projects/${encodeURIComponent(items[index].publicId)}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archiveReason: reason }),
        signal: controller.signal,
      });
      if (!isActive() || controller.signal.aborted) throw new Error('REQUEST_RESULT_UNOBSERVED');
      let body: unknown;
      try {
        body = await readBoundedJson(response);
      } catch {
        items[index] = { ...items[index], outcome: 'UNKNOWN', detail: 'Malformed or oversized response. Inspect state before any retry.' };
        stopped = true;
        stopReason = items[index].detail;
        update();
        break;
      }
      if (!isActive() || controller.signal.aborted) throw new Error('REQUEST_RESULT_UNOBSERVED');
      const classified = classifyResponse(response, body, items[index].publicId);
      items[index] = { ...items[index], outcome: classified.outcome, detail: classified.detail };
      stopped = classified.stop;
      stopReason = classified.stop ? classified.detail : null;
      update();
      if (classified.stop) break;
    } catch {
      items[index] = {
        ...items[index],
        outcome: 'UNKNOWN',
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

export const BULK_ARCHIVE_OUTCOME_LABELS: Record<BulkArchiveOutcome, string> = {
  COMPLETED: 'Completed',
  ALREADY_COMPLETED: 'Already completed / no change',
  INVALID_OR_INELIGIBLE: 'Invalid or ineligible',
  DENIED: 'Denied',
  FAILURE: 'Failed',
  NOT_ATTEMPTED: 'Not attempted',
  UNKNOWN: 'Unknown - inspect before retry',
};
