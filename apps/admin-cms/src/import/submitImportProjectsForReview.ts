import { createSupabaseAdminClientCore } from '../lib/supabase/adminCore';

export type SubmitForReviewErrorCode =
  | 'BATCH_NOT_FOUND'
  | 'INVALID_BATCH_STATE'
  | 'SUBMIT_PERMISSION_DENIED'
  | 'INVALID_SELECTION'
  | 'PROJECT_NOT_IN_BATCH'
  | 'INVALID_PROJECT_STATE'
  | 'READINESS_BLOCKED'
  | 'RESPONSE_INVALID'
  | 'INTERNAL_FAILURE';

const KNOWN_ERROR_CODES: SubmitForReviewErrorCode[] = [
  'BATCH_NOT_FOUND',
  'INVALID_BATCH_STATE',
  'SUBMIT_PERMISSION_DENIED',
  'INVALID_SELECTION',
  'PROJECT_NOT_IN_BATCH',
  'INVALID_PROJECT_STATE',
  'READINESS_BLOCKED',
];

export class SubmitForReviewExecutionError extends Error {
  readonly code: SubmitForReviewErrorCode;
  readonly publicId?: string;
  readonly blockingReasons?: string[];

  constructor(code: SubmitForReviewErrorCode, details?: { publicId?: string; blockingReasons?: string[] }) {
    super(`Submit for review execution failed: ${code}`);
    this.name = 'SubmitForReviewExecutionError';
    this.code = code;
    this.publicId = details?.publicId;
    this.blockingReasons = details?.blockingReasons;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface SubmitForReviewTransition {
  publicId: string;
  fromStatus: string;
  toStatus: string;
  auditRecordId: string;
}

export interface SubmitForReviewResult {
  batchId: string;
  submittedCount: number;
  alreadySubmittedPublicIds: string[];
  results: SubmitForReviewTransition[];
}

/**
 * Atomically submits one or more prepared imported projects from a completed import batch into
 * the administrative review workflow (draft/changes_requested -> submitted), via the
 * submit_import_projects_for_review RPC. The RPC is the sole authority for eligibility,
 * readiness, and idempotency — this function only maps its result/error contract into typed
 * TypeScript values; it never re-derives or trusts any caller-declared readiness state.
 */
export async function submitImportProjectsForReview(params: {
  batchId: string;
  projectPublicIds: string[];
  adminId: string;
  comments?: string;
}): Promise<SubmitForReviewResult> {
  const { batchId, projectPublicIds, adminId, comments } = params;

  if (!batchId || !adminId || !Array.isArray(projectPublicIds) || projectPublicIds.length === 0) {
    throw new SubmitForReviewExecutionError('INVALID_SELECTION');
  }

  const supabase = createSupabaseAdminClientCore();

  const { data, error } = await supabase.rpc('submit_import_projects_for_review', {
    p_batch_id: batchId,
    p_project_public_ids: projectPublicIds,
    p_admin_id: adminId,
    p_comments: comments || null,
  });

  if (error) {
    throw new SubmitForReviewExecutionError('INTERNAL_FAILURE');
  }

  if (!data || typeof data !== 'object') {
    throw new SubmitForReviewExecutionError('RESPONSE_INVALID');
  }

  const res = data as Record<string, unknown>;
  const resultCode = res.resultCode;

  if (resultCode !== 'SUCCESS') {
    const code = KNOWN_ERROR_CODES.includes(resultCode as SubmitForReviewErrorCode)
      ? (resultCode as SubmitForReviewErrorCode)
      : 'INTERNAL_FAILURE';

    const publicId = typeof res.publicId === 'string' ? res.publicId : undefined;
    const blockingReasons = Array.isArray(res.blockingReasons)
      ? res.blockingReasons.filter((r): r is string => typeof r === 'string')
      : undefined;

    throw new SubmitForReviewExecutionError(code, { publicId, blockingReasons });
  }

  const submittedCount = res.submittedCount;
  const alreadySubmittedPublicIds = res.alreadySubmittedPublicIds;
  const results = res.results;

  if (
    typeof submittedCount !== 'number' ||
    !Array.isArray(alreadySubmittedPublicIds) ||
    !Array.isArray(results)
  ) {
    throw new SubmitForReviewExecutionError('RESPONSE_INVALID');
  }

  const typedResults: SubmitForReviewTransition[] = [];
  for (const entry of results) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof (entry as Record<string, unknown>).publicId !== 'string' ||
      typeof (entry as Record<string, unknown>).fromStatus !== 'string' ||
      typeof (entry as Record<string, unknown>).toStatus !== 'string' ||
      typeof (entry as Record<string, unknown>).auditRecordId !== 'string'
    ) {
      throw new SubmitForReviewExecutionError('RESPONSE_INVALID');
    }
    const typedEntry = entry as Record<string, unknown>;
    typedResults.push({
      publicId: typedEntry.publicId as string,
      fromStatus: typedEntry.fromStatus as string,
      toStatus: typedEntry.toStatus as string,
      auditRecordId: typedEntry.auditRecordId as string,
    });
  }

  return {
    batchId,
    submittedCount,
    alreadySubmittedPublicIds: alreadySubmittedPublicIds.filter((id): id is string => typeof id === 'string'),
    results: typedResults,
  };
}
