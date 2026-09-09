import type { AssistiveRunStatus } from './jobContract';
import { assistiveInputHashSchema } from './persistenceContract';
import type { AdminPermission } from '../../auth/authTypes';

export const BULK_ASSISTIVE_MAX_SELECTION = 50;
export const BULK_ASSISTIVE_MAX_PUBLIC_ID_LENGTH = 100;
export const BULK_ASSISTIVE_MAX_REASON_LENGTH = 200;
export const BULK_ASSISTIVE_MAX_REASONS = 5;
export const BULK_ASSISTIVE_MAX_REQUEST_BYTES = 64 * 1024;

export const BULK_ASSISTIVE_PREFLIGHT_DISPOSITIONS = [
  'eligible',
  'already_active_or_current',
  'blocked',
  'invalid_stale',
] as const;
export type BulkAssistivePreflightDisposition = (typeof BULK_ASSISTIVE_PREFLIGHT_DISPOSITIONS)[number];

export const BULK_ASSISTIVE_OUTCOMES = [
  'ENQUEUED',
  'ALREADY_ACTIVE_OR_CURRENT',
  'BLOCKED',
  'INVALID_STALE',
  'FAILED',
] as const;
export type BulkAssistiveOutcome = (typeof BULK_ASSISTIVE_OUTCOMES)[number];

export interface BulkAssistiveReason {
  code: string;
  message: string;
}

export interface BulkAssistiveItem {
  publicId: string;
  title: string;
  runId: string | null;
  status: AssistiveRunStatus | null;
  inputHash: string | null;
  disposition: BulkAssistivePreflightDisposition;
  reasons: BulkAssistiveReason[];
  additionalReasonCount: number;
}

export interface BulkAssistivePreflightSummary {
  total: number;
  eligible: number;
  alreadyActiveOrCurrent: number;
  blocked: number;
  invalidStale: number;
}

export interface BulkAssistivePreflightResponse {
  summary: BulkAssistivePreflightSummary;
  items: BulkAssistiveItem[];
}

export interface BulkAssistiveExecutionItem extends BulkAssistiveItem {
  outcome: BulkAssistiveOutcome;
}

export interface BulkAssistiveExecutionSummary {
  total: number;
  enqueued: number;
  alreadyActiveOrCurrent: number;
  blocked: number;
  invalidStale: number;
  failed: number;
}

export interface BulkAssistiveExecutionResponse {
  summary: BulkAssistiveExecutionSummary;
  items: BulkAssistiveExecutionItem[];
}

export interface BulkAssistivePreflightInput {
  publicIds: string[];
}

export interface BulkAssistiveExecutionInput extends BulkAssistivePreflightInput {
  expectedInputHashes: Record<string, string | null>;
}

export interface BulkAssistiveActor {
  adminId: string;
  permissions: AdminPermission[];
}

export interface BulkAssistiveAvailability {
  canEnqueue: boolean;
  state: string;
  message: string | null;
}

export function isSafeBulkAssistivePublicId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= BULK_ASSISTIVE_MAX_PUBLIC_ID_LENGTH
    && /^[A-Za-z0-9_-]+$/.test(value);
}

export function normalizeBulkAssistivePublicIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > BULK_ASSISTIVE_MAX_SELECTION) return null;
  if (!value.every((id) => isSafeBulkAssistivePublicId(id))) return null;
  return [...new Set(value)];
}

export function sanitizeBulkAssistiveReason(reason: BulkAssistiveReason): BulkAssistiveReason {
  return {
    code: reason.code.replace(/[^A-Z0-9_:-]/g, '').slice(0, 80) || 'ASSISTIVE_BULK_FAILED',
    message: reason.message.replace(/\s+/g, ' ').trim().slice(0, BULK_ASSISTIVE_MAX_REASON_LENGTH),
  };
}

export function normalizeBulkAssistiveReasons(reasons: BulkAssistiveReason[]): {
  reasons: BulkAssistiveReason[];
  additionalReasonCount: number;
} {
  const normalized = reasons.map(sanitizeBulkAssistiveReason)
    .filter((reason) => reason.message.length > 0);
  return {
    reasons: normalized.slice(0, BULK_ASSISTIVE_MAX_REASONS),
    additionalReasonCount: Math.max(0, normalized.length - BULK_ASSISTIVE_MAX_REASONS),
  };
}

export function summarizeBulkAssistivePreflight(items: BulkAssistiveItem[]): BulkAssistivePreflightSummary {
  return items.reduce(
    (summary, item) => {
      summary.total += 1;
      if (item.disposition === 'eligible') summary.eligible += 1;
      if (item.disposition === 'already_active_or_current') summary.alreadyActiveOrCurrent += 1;
      if (item.disposition === 'blocked') summary.blocked += 1;
      if (item.disposition === 'invalid_stale') summary.invalidStale += 1;
      return summary;
    },
    { total: 0, eligible: 0, alreadyActiveOrCurrent: 0, blocked: 0, invalidStale: 0 },
  );
}

export function sortBulkAssistiveItems<T extends { publicId: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.publicId.localeCompare(b.publicId));
}

export function toSafeBulkAssistiveExecutionItem(
  preflightItem: BulkAssistiveItem,
  outcome: BulkAssistiveOutcome,
): BulkAssistiveExecutionItem {
  return { ...preflightItem, outcome };
}

export function isAssistiveInputHash(value: unknown): value is string {
  return assistiveInputHashSchema.safeParse(value).success;
}

export function bulkAssistiveRequestSizeRejection(
  contentLength: string | null,
): 'MISSING_CONTENT_LENGTH' | 'INVALID_CONTENT_LENGTH' | 'REQUEST_TOO_LARGE' | null {
  if (contentLength === null || contentLength === '') return 'MISSING_CONTENT_LENGTH';
  if (!/^(0|[1-9][0-9]*)$/.test(contentLength)) return 'INVALID_CONTENT_LENGTH';
  const bytes = Number(contentLength);
  if (!Number.isSafeInteger(bytes)) return 'INVALID_CONTENT_LENGTH';
  return bytes > BULK_ASSISTIVE_MAX_REQUEST_BYTES ? 'REQUEST_TOO_LARGE' : null;
}
