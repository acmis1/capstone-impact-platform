import 'server-only';

import { SupabaseClient } from '@supabase/supabase-js';
import { getStagingBuckets } from '../lib/supabase/buckets';
import { DatabaseProjectRow, SupabaseProjectRepositoryCore } from '../repositories/SupabaseProjectRepositoryCore';
import { computeReadinessForImportBatchRow } from '../import/importBatchReviewReadiness';
import type { ImportBatchReviewProjectRow } from '../repositories/ImportBatchRepositoryCore';
import {
  deriveApprovalMediaInput,
  ProjectMediaAssetPreviewRow,
  validateSubmissionSnapshotGallery,
} from './projectMediaPreview';
import { validateProjectForApproval } from '../validation/projectValidation';
import { getAllowedReviewActions } from '../workflow/projectWorkflow';
import {
  BulkProjectReviewGateway,
  BulkGatewayExecutionResult,
} from './bulkProjectReviewService';
import {
  BulkReviewAction,
  BulkReviewProjectState,
  BulkReviewReason,
} from './bulkProjectReview';

const BULK_PROJECT_SELECT = `
  id, public_id, title, summary, background, solution, year, program_name, program_id,
  study_program, discipline, industry, industry_partner, academic_supervisor, group_name,
  participant_contact_email, team_members, poster_url, poster_pdf_url, poster_text_public,
  accessibility_text_public, snapshots, video_url, demo_url, repository_url, external_links,
  citations, layout_config, status, import_batch_id, source_folder, internal_staff_notes,
  private_review_comments, validation_flags_cache, validation_errors, validation_warnings,
  pending_removal_from_public, public_removal_completed_at, archived_at, archived_from_status,
  archive_reason, created_at, updated_at,
  project_disciplines(discipline_id), project_industry_categories(industry_category_id)
`;

interface BulkProjectRow extends Omit<DatabaseProjectRow, 'import_batch_id' | 'media_assets'> {
  program_id?: string | null;
  project_disciplines?: Array<{ discipline_id?: string; disciplines?: { name?: string } }>;
  project_industry_categories?: Array<{ industry_category_id: string }>;
  import_batch_id?: string | null;
}

interface BulkMediaRow extends Partial<ProjectMediaAssetPreviewRow> {
  project_id: string;
}

interface BulkEvidenceRow {
  project_id: string;
  unresolved_error_count: number | string;
  active_preview_count: number | string;
  unresolved_correction_count: number | string;
}

interface ImportBatchStatusRow {
  id: string;
  status: string;
}

function reason(code: string, message: string): BulkReviewReason {
  return { code, message };
}

/**
 * Staff-facing text for the workflow authorities' own bounded rule codes. The codes come from
 * `perform_project_review_action` and `submit_import_projects_for_review`; anything outside this
 * vocabulary keeps the generic sentence, so an unrecognized code can never leak database detail.
 */
const BLOCKED_REASON_MESSAGES: Record<string, string> = {
  REVIEW_TRANSITION_INVALID: 'The project is no longer in a workflow state that allows this action.',
  REVIEW_PERMISSION_DENIED: 'Your account is not permitted to apply this action to this project.',
  REVIEW_PROJECT_NOT_FOUND: 'The project could not be found.',
  REVIEW_COMMENTS_TOO_LONG: 'The shared review comment is longer than the allowed limit.',
  PROJECT_STATE_CHANGED_CONCURRENTLY: 'The project changed while the action was being applied.',
  INVALID_PROJECT_STATE: 'The project is not in a valid workflow state for this action.',
  INVALID_BATCH_STATE: 'The project import batch is not in a submittable state.',
  PROJECT_NOT_IN_BATCH: 'The project is no longer part of its import batch.',
  PROJECT_NOT_FOUND: 'The project could not be found.',
  BATCH_NOT_FOUND: 'The project import batch could not be found.',
  READINESS_BLOCKED: 'The project has unresolved readiness blockers.',
  SUBMIT_PERMISSION_DENIED: 'Your account is not permitted to submit this project.',
  ACCESSIBILITY_CONTENT_REQUIRED: 'Required accessibility text is missing.',
  ACCESSIBILITY_CONTENT_INVALID: 'The accessibility text does not meet the required format.',
  MEDIA_ACCESSIBILITY_REQUIRED: 'Required image alternative text is missing.',
  MEDIA_ACCESSIBILITY_INVALID: 'The image alternative text does not meet the required format.',
  ACTIVE_PREVIEW_EXISTS: 'The project has an active participant preview.',
  AMBIGUOUS_ACTIVE_PREVIEW: 'The project has more than one active participant preview.',
  CORRECTION_RESOLUTION_REQUIRED: 'An outstanding participant correction must be resolved first.',
  CONTROLLED_PUBLIC_REMOVAL_REQUIRED: 'The project must complete controlled public removal first.',
};

function blockedReasonMessage(code: string): string {
  return BLOCKED_REASON_MESSAGES[code] ?? 'The project did not pass the current workflow checks.';
}

function readinessReasons(readiness: ReturnType<typeof computeReadinessForImportBatchRow>): BulkReviewReason[] {
  const reasons = readiness.blockingReasons.map((message) => reason('READINESS_BLOCKED', message));
  if (readiness.eligibility === 'ineligible') {
    reasons.unshift(reason('INVALID_PROJECT_STATE', 'The project is not in a submittable workflow state.'));
  }
  return reasons;
}

function mediaRows(rows: BulkMediaRow[]): ProjectMediaAssetPreviewRow[] {
  return rows.map((asset, index) => ({
    id: typeof asset.id === 'string' ? asset.id : `bulk-media-${index}`,
    asset_type: asset.asset_type || '',
    gallery_position: asset.gallery_position ?? null,
    file_name: asset.file_name || '',
    storage_bucket: asset.storage_bucket || '',
    storage_path: asset.storage_path || '',
    public_url: asset.public_url ?? null,
    public_storage_bucket: asset.public_storage_bucket ?? null,
    public_storage_path: asset.public_storage_path ?? null,
    mime_type: asset.mime_type ?? null,
    file_size_bytes: asset.file_size_bytes ?? null,
    is_public_approved: asset.is_public_approved ?? null,
    alt_text_public: asset.alt_text_public ?? null,
  }));
}

export class SupabaseBulkProjectReviewGateway implements BulkProjectReviewGateway {
  private readonly projectMapper;
  private readonly privateBucket: string;

  constructor(
    private readonly supabase: SupabaseClient,
    private readonly configuredPrivateBucket: string = getStagingBuckets().DRAFT_PRIVATE,
  ) {
    this.projectMapper = new SupabaseProjectRepositoryCore(supabase);
    this.privateBucket = configuredPrivateBucket;
  }

  async loadProjectStates(publicIds: string[]): Promise<Map<string, BulkReviewProjectState>> {
    const states = new Map<string, BulkReviewProjectState>();
    if (publicIds.length === 0) return states;

    const { data, error } = await this.supabase
      .from('projects')
      .select(BULK_PROJECT_SELECT)
      .in('public_id', publicIds)
      .is('deleted_at', null);
    if (error) throw new Error('Bulk project review data could not be loaded.');

    const rows = (data || []) as unknown as BulkProjectRow[];
    const batchIds = [...new Set(rows.map((row) => row.import_batch_id).filter((id): id is string => Boolean(id)))];
    const batchStatuses = new Map<string, string>();
    if (batchIds.length > 0) {
      const batchResult = await this.supabase.from('import_batches').select('id,status').in('id', batchIds);
      if (batchResult.error) throw new Error('Bulk project review batch data could not be loaded.');
      for (const batch of (batchResult.data || []) as ImportBatchStatusRow[]) batchStatuses.set(batch.id, batch.status);
    }

    const projectIds = rows.map((row) => row.id).filter(Boolean);
    const evidenceByProject = new Map<string, BulkEvidenceRow>();
    const mediaByProject = new Map<string, BulkMediaRow[]>();
    if (projectIds.length > 0) {
      const [evidenceResult, mediaResult] = await Promise.all([
        this.supabase.rpc('get_bulk_project_review_evidence', { p_project_ids: projectIds }),
        this.supabase
          .from('media_assets')
          .select('project_id,id,asset_type,gallery_position,file_name,storage_bucket,storage_path,public_url,public_storage_bucket,public_storage_path,mime_type,file_size_bytes,is_public_approved,alt_text_public')
          .in('project_id', projectIds)
          .in('asset_type', ['poster_image', 'poster_pdf', 'snapshot_image']),
      ]);
      if (evidenceResult.error) throw new Error('Bulk project review evidence could not be loaded.');
      if (mediaResult.error) throw new Error('Bulk project review media data could not be loaded.');
      for (const evidence of (evidenceResult.data || []) as BulkEvidenceRow[]) evidenceByProject.set(evidence.project_id, evidence);
      for (const media of (mediaResult.data || []) as BulkMediaRow[]) {
        const projectMedia = mediaByProject.get(media.project_id) || [];
        projectMedia.push(media);
        mediaByProject.set(media.project_id, projectMedia);
      }
    }

    for (const row of rows) {
      const project = this.projectMapper.mapDbToDomain(row as DatabaseProjectRow);
      const evidence = evidenceByProject.get(row.id);
      const reviewData = {
        ...row,
        validation_flags: Number(evidence?.unresolved_error_count || 0) > 0
          ? [{ severity: 'error', resolved: false, message: 'Unresolved validation error(s) present.' }]
          : [],
        media_assets: (mediaByProject.get(row.id) || []).map((asset) => ({
          asset_type: asset.asset_type || '',
          is_public_approved: asset.is_public_approved ?? null,
          public_url: asset.public_url ?? null,
          alt_text_public: asset.alt_text_public ?? null,
        })),
      } as unknown as ImportBatchReviewProjectRow;
      const readiness = computeReadinessForImportBatchRow(reviewData);
      const batchStatus = row.import_batch_id ? batchStatuses.get(row.import_batch_id) : undefined;
      const submissionReasons = [
        ...readinessReasons(readiness),
        ...validateSubmissionSnapshotGallery(mediaRows(mediaByProject.get(row.id) || []), {
          projectPublicId: project.publicId || row.public_id,
          privateBucket: this.privateBucket,
        }).map((message) => reason('READINESS_BLOCKED', message)),
      ];
      if (row.import_batch_id && batchStatus !== 'completed') {
        submissionReasons.unshift(reason('IMPORT_BATCH_NOT_COMPLETED', 'The project import batch is not complete.'));
      }
      if (!row.import_batch_id) {
        submissionReasons.unshift(reason('IMPORT_BATCH_MISSING', 'The project is not linked to an import batch.'));
      }

      const activePreviewCount = Number(evidence?.active_preview_count || 0);
      const unresolvedCorrectionCount = Number(evidence?.unresolved_correction_count || 0);
      const allowedActions = getAllowedReviewActions(project.status);
      const approvalValidation = validateProjectForApproval(
        project,
        deriveApprovalMediaInput(mediaRows(mediaByProject.get(row.id) || []), {
          projectPublicId: project.publicId || row.public_id,
          privateBucket: this.privateBucket,
        }),
      );
      const approveReasons = approvalValidation.errors.map((message) => reason('APPROVAL_BLOCKED', message));
      if (!allowedActions.includes('approve')) {
        approveReasons.unshift(reason('INVALID_PROJECT_STATE', 'The project is not in an approvable workflow state.'));
      }

      const requestReasons: BulkReviewReason[] = [];
      if (!allowedActions.includes('request_changes')) {
        requestReasons.push(reason('INVALID_PROJECT_STATE', 'The project is not in a request-changes workflow state.'));
      }
      if (project.status === 'approved' && unresolvedCorrectionCount > 0) {
        requestReasons.push(reason('CORRECTION_RESOLUTION_REQUIRED', 'Resolve the participant correction before requesting changes.'));
      }
      if (project.status === 'approved' && activePreviewCount > 1) {
        requestReasons.push(reason('AMBIGUOUS_ACTIVE_PREVIEW', 'The project has more than one active participant preview.'));
      }

      states.set(row.public_id, {
        publicId: row.public_id,
        title: project.title || 'Untitled project',
        status: project.status,
        updatedAt: row.updated_at || null,
        exists: true,
        submission: {
          eligible: submissionReasons.length === 0 && batchStatus === 'completed' && Boolean(row.import_batch_id),
          alreadyComplete: readiness.eligibility === 'already_submitted',
          reasons: submissionReasons,
        },
        review: {
          approve: { allowed: allowedActions.includes('approve') && approveReasons.length === 0, reasons: approveReasons },
          requestChanges: { allowed: allowedActions.includes('request_changes') && requestReasons.length === 0, reasons: requestReasons },
        },
      });
    }

    return states;
  }

  async executeAction(params: {
    action: BulkReviewAction;
    publicId: string;
    expectedUpdatedAt: string;
    comments?: string;
    adminId: string;
  }): Promise<BulkGatewayExecutionResult> {
    const { data, error } = await this.supabase.rpc('perform_project_workflow_action_if_current', {
      p_public_id: params.publicId,
      p_action: params.action,
      p_comments: params.comments || null,
      p_admin_id: params.adminId,
      p_expected_updated_at: params.expectedUpdatedAt,
    });
    if (error || !data || typeof data !== 'object') {
      return {
        resultCode: 'FAILED',
        status: null,
        auditRecorded: false,
        reason: reason('WORKFLOW_EXECUTION_FAILED', 'The workflow action could not be completed.'),
      };
    }

    const result = data as Record<string, unknown>;
    const status = typeof result.status === 'string' ? result.status as BulkReviewProjectState['status'] : null;
    const resultCode = result.resultCode;
    if (resultCode === 'ALREADY_COMPLETE') return { resultCode, status, auditRecorded: false };
    if (resultCode === 'STALE_VERSION') {
      return { resultCode, status, auditRecorded: false, reason: reason('STALE_VERSION', 'The project changed before the action could be applied.') };
    }
    if (resultCode !== 'SUCCESS' || typeof result.auditRecordId !== 'string') {
      const code = typeof result.resultCode === 'string' ? result.resultCode : 'WORKFLOW_BLOCKED';
      const reasonCode = typeof result.reasonCode === 'string' ? result.reasonCode : code;
      return { resultCode: 'BLOCKED', status, auditRecorded: false, reason: reason(reasonCode, blockedReasonMessage(reasonCode)) };
    }
    return { resultCode: 'SUCCESS', status, auditRecorded: true };
  }
}
