import { AdminPermission } from '../auth/authTypes';
import { Project } from '../domain/project';
import { WorkflowStatus } from '../domain/workflowStatus';

export const BULK_REVIEW_MAX_SELECTION = 50;
export const BULK_REVIEW_MAX_PUBLIC_ID_LENGTH = 100;
export const BULK_REVIEW_MAX_REASON_LENGTH = 200;
export const BULK_REVIEW_MAX_REASONS = 5;
export const BULK_REVIEW_MAX_COMMENT_LENGTH = 4000;

export const BULK_REVIEW_ACTIONS = ['submit_for_review', 'approve', 'request_changes'] as const;
export type BulkReviewAction = (typeof BULK_REVIEW_ACTIONS)[number];

export const BULK_REVIEW_DISPOSITIONS = [
  'eligible',
  'blocked',
  'already_complete',
  'invalid_or_stale',
] as const;
export type BulkReviewDisposition = (typeof BULK_REVIEW_DISPOSITIONS)[number];

export const BULK_REVIEW_OUTCOMES = [
  'successful',
  'blocked',
  'already_complete',
  'invalid_or_stale',
  'failed',
] as const;
export type BulkReviewOutcome = (typeof BULK_REVIEW_OUTCOMES)[number];

export interface BulkReviewReason {
  code: string;
  message: string;
}

export interface BulkReviewItem {
  publicId: string;
  title: string;
  status: WorkflowStatus | null;
  updatedAt: string | null;
  disposition: BulkReviewDisposition;
  reasons: BulkReviewReason[];
  additionalReasonCount: number;
}

export interface BulkReviewSummary {
  total: number;
  eligible: number;
  blocked: number;
  alreadyComplete: number;
  invalidOrStale: number;
}

export interface BulkReviewPreflightResponse {
  action: BulkReviewAction;
  summary: BulkReviewSummary;
  items: BulkReviewItem[];
}

export interface BulkReviewExecutionItem extends BulkReviewItem {
  outcome: BulkReviewOutcome;
  auditRecorded: boolean;
}

export interface BulkReviewExecutionSummary {
  total: number;
  successful: number;
  blocked: number;
  alreadyComplete: number;
  invalidOrStale: number;
  failed: number;
}

export interface BulkReviewExecutionResponse {
  action: BulkReviewAction;
  summary: BulkReviewExecutionSummary;
  items: BulkReviewExecutionItem[];
}

export interface BulkReviewProjectState {
  publicId: string;
  title: string;
  status: WorkflowStatus | null;
  updatedAt: string | null;
  exists: boolean;
  submission: {
    eligible: boolean;
    alreadyComplete: boolean;
    reasons: BulkReviewReason[];
  } | null;
  review: {
    approve: { allowed: boolean; reasons: BulkReviewReason[] };
    requestChanges: { allowed: boolean; reasons: BulkReviewReason[] };
  } | null;
}

export interface BulkReviewExecutionRequest {
  action: BulkReviewAction;
  publicIds: string[];
  expectedUpdatedAt: Record<string, string | null>;
  comments?: string;
}

export interface BulkReviewActor {
  adminId: string;
  permissions: AdminPermission[];
}

export function isBulkReviewAction(value: unknown): value is BulkReviewAction {
  return typeof value === 'string' && BULK_REVIEW_ACTIONS.includes(value as BulkReviewAction);
}

export function isSafeBulkPublicId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= BULK_REVIEW_MAX_PUBLIC_ID_LENGTH &&
    /^[a-zA-Z0-9_-]+$/.test(value)
  );
}

export function sanitizeBulkReason(reason: BulkReviewReason): BulkReviewReason {
  return {
    code: reason.code.replace(/[^A-Z0-9_:-]/g, '').slice(0, 80) || 'WORKFLOW_BLOCKED',
    message: reason.message.replace(/\s+/g, ' ').trim().slice(0, BULK_REVIEW_MAX_REASON_LENGTH),
  };
}

export function normalizeBulkReasons(reasons: BulkReviewReason[]): {
  reasons: BulkReviewReason[];
  additionalReasonCount: number;
} {
  const normalized = reasons.map(sanitizeBulkReason).filter((reason) => reason.message.length > 0);
  return {
    reasons: normalized.slice(0, BULK_REVIEW_MAX_REASONS),
    additionalReasonCount: Math.max(0, normalized.length - BULK_REVIEW_MAX_REASONS),
  };
}

export function requiredPermissionForBulkAction(action: BulkReviewAction): AdminPermission {
  return action === 'submit_for_review' ? 'projects.edit' : 'projects.review';
}

function getStatusLabel(status: WorkflowStatus | null): string {
  return status ? status.replace(/_/g, ' ') : 'an unavailable status';
}

export function classifyBulkReviewState(
  action: BulkReviewAction,
  state: BulkReviewProjectState | null,
  expectedUpdatedAt?: string | null,
): BulkReviewItem {
  const fallbackId = state?.publicId || '';
  const base = {
    publicId: fallbackId,
    title: state?.title || 'Project unavailable',
    status: state?.status ?? null,
    updatedAt: state?.updatedAt ?? null,
  } satisfies Pick<BulkReviewItem, 'publicId' | 'title' | 'status' | 'updatedAt'>;

  if (!state || !state.exists || !isSafeBulkPublicId(state.publicId) || !state.updatedAt) {
    const reason = normalizeBulkReasons([
      { code: 'PROJECT_NOT_FOUND_OR_VERSION_MISSING', message: 'The project or its current version could not be verified.' },
    ]);
    return { ...base, disposition: 'invalid_or_stale', ...reason };
  }

  const targetStatus: Record<BulkReviewAction, WorkflowStatus> = {
    submit_for_review: 'submitted',
    approve: 'approved',
    request_changes: 'changes_requested',
  };

  if (state.status === targetStatus[action]) {
    return { ...base, disposition: 'already_complete', reasons: [], additionalReasonCount: 0 };
  }

  if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== state.updatedAt) {
    const reason = normalizeBulkReasons([
      { code: 'STALE_VERSION', message: 'The project changed after the review snapshot was loaded.' },
    ]);
    return { ...base, disposition: 'invalid_or_stale', ...reason };
  }

  const reviewRule = action === 'approve' ? state.review?.approve : state.review?.requestChanges;
  const stateReasons = action === 'submit_for_review'
    ? state.submission?.reasons || []
    : reviewRule?.reasons || [];
  const actionAllowed = action === 'submit_for_review' ? state.submission?.eligible : reviewRule?.allowed;
  if (!actionAllowed) {
    const reason = normalizeBulkReasons(
      stateReasons.length
        ? stateReasons
        : [{ code: 'WORKFLOW_TRANSITION_INVALID', message: `The project cannot ${action.replace(/_/g, ' ')} from ${getStatusLabel(state.status)}.` }],
    );
    return { ...base, disposition: 'blocked', ...reason };
  }

  return { ...base, disposition: 'eligible', reasons: [], additionalReasonCount: 0 };
}

export function summarizeBulkPreflight(items: BulkReviewItem[]): BulkReviewSummary {
  return items.reduce(
    (summary, item) => {
      summary.total += 1;
      if (item.disposition === 'eligible') summary.eligible += 1;
      if (item.disposition === 'blocked') summary.blocked += 1;
      if (item.disposition === 'already_complete') summary.alreadyComplete += 1;
      if (item.disposition === 'invalid_or_stale') summary.invalidOrStale += 1;
      return summary;
    },
    { total: 0, eligible: 0, blocked: 0, alreadyComplete: 0, invalidOrStale: 0 },
  );
}

export function toSafeExecutionItem(
  preflightItem: BulkReviewItem,
  outcome: BulkReviewOutcome,
  auditRecorded = false,
): BulkReviewExecutionItem {
  return { ...preflightItem, outcome, auditRecorded };
}

export function sortBulkReviewItems<T extends { publicId: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.publicId.localeCompare(b.publicId));
}

export function projectStateFromDomain(project: Project): BulkReviewProjectState {
  return {
    publicId: project.publicId || '',
    title: project.title || 'Untitled project',
    status: project.status,
    updatedAt: project.updated_at || null,
    exists: true,
    submission: null,
    review: null,
  };
}
