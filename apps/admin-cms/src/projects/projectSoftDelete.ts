import type { WorkflowStatus } from '../domain/workflowStatus';
import { BULK_REVIEW_MAX_REQUEST_BYTES, BULK_REVIEW_MAX_SELECTION } from './bulkProjectReview';

export const SOFT_DELETE_MAX_SELECTION = BULK_REVIEW_MAX_SELECTION;
export const SOFT_DELETE_MAX_REQUEST_BYTES = BULK_REVIEW_MAX_REQUEST_BYTES;

export const SOFT_DELETE_DECISION_CODES = [
  'ELIGIBLE',
  'ALREADY_DELETED',
  'PROJECT_NOT_FOUND',
  'DELETE_STATE_AMBIGUOUS',
  'PUBLISHED_REQUIRES_ARCHIVE',
  'REMOVAL_PENDING',
  'STATUS_INELIGIBLE',
  'PUBLICATION_OR_REMOVAL_PENDING',
  'CURRENTLY_PUBLIC',
  'CANONICAL_FEED_UNAVAILABLE',
  'REMOVAL_EVIDENCE_REQUIRED',
  'REMOVAL_EVIDENCE_AMBIGUOUS',
] as const;

export type SoftDeleteDecisionCode = (typeof SOFT_DELETE_DECISION_CODES)[number];
export type SoftDeleteDisposition = 'eligible' | 'blocked' | 'already_deleted';

export interface SoftDeletePreflightItem {
  publicId: string;
  title: string;
  status: WorkflowStatus | null;
  updatedAt: string | null;
  disposition: SoftDeleteDisposition;
  reasonCode: SoftDeleteDecisionCode;
  reason: string;
  previouslyPublished: boolean;
}

export interface SoftDeletePreflightResponse {
  summary: {
    total: number;
    eligible: number;
    blocked: number;
    alreadyDeleted: number;
  };
  items: SoftDeletePreflightItem[];
}

export type SoftDeleteExecutionResult =
  | {
      resultCode: 'DELETED';
      publicId: string;
      status: 'deleted';
      fromStatus: WorkflowStatus;
      deletedAt: string;
      auditRecordId: string;
    }
  | {
      resultCode: 'ALREADY_DELETED';
      publicId: string;
      status: 'deleted';
      deletedAt: string;
    }
  | {
      resultCode: 'STALE_VERSION' | 'PROJECT_NOT_FOUND' | Exclude<SoftDeleteDecisionCode, 'ELIGIBLE' | 'ALREADY_DELETED'>;
      publicId?: string;
      status?: WorkflowStatus | null;
      reason?: string;
      previouslyPublished?: boolean;
    };

export function softDeleteRequestSizeRejection(
  contentLength: string | null,
): 'MISSING_CONTENT_LENGTH' | 'INVALID_CONTENT_LENGTH' | 'REQUEST_TOO_LARGE' | null {
  if (contentLength === null || contentLength === '') return 'MISSING_CONTENT_LENGTH';
  if (!/^(0|[1-9][0-9]*)$/.test(contentLength)) return 'INVALID_CONTENT_LENGTH';
  const bytes = Number(contentLength);
  if (!Number.isSafeInteger(bytes)) return 'INVALID_CONTENT_LENGTH';
  return bytes > SOFT_DELETE_MAX_REQUEST_BYTES ? 'REQUEST_TOO_LARGE' : null;
}

export function summarizeSoftDeletePreflight(items: SoftDeletePreflightItem[]): SoftDeletePreflightResponse['summary'] {
  return items.reduce(
    (summary, item) => {
      summary.total += 1;
      if (item.disposition === 'eligible') summary.eligible += 1;
      if (item.disposition === 'blocked') summary.blocked += 1;
      if (item.disposition === 'already_deleted') summary.alreadyDeleted += 1;
      return summary;
    },
    { total: 0, eligible: 0, blocked: 0, alreadyDeleted: 0 },
  );
}
