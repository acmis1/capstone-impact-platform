import { WorkflowStatus } from '../domain/workflowStatus';
import { getSubmissionEligibility, SubmissionEligibility } from '../workflow/importBatchSubmission';
import { ImportBatchReviewProjectRow } from '../repositories/ImportBatchRepositoryCore';
import { isAccessibleContentPresent } from '../domain/accessibleContent';

export interface ImportBatchReviewMediaAssetInput {
  assetType: string;
  isPublicApproved: boolean | null;
  publicUrl: string | null;
}

export interface ImportBatchReviewValidationFlagInput {
  severity: string;
  resolved: boolean | null;
  message: string;
}

export interface ImportBatchReviewProjectInput {
  publicId: string;
  title: string | null;
  summary: string | null;
  programId: string | null;
  programName: string | null;
  studyProgram: string | null;
  discipline: string | null;
  groupName: string | null;
  teamMembers: string[] | null;
  posterText: string | null;
  accessibilityText: string | null;
  snapshots: string[] | null;
  validationErrors: string[] | null;
  validationWarnings: string[] | null;
  validationFlags: ImportBatchReviewValidationFlagInput[];
  status: WorkflowStatus | string;
  disciplineMappingCount: number;
  industryMappingCount: number;
  mediaAssets: ImportBatchReviewMediaAssetInput[];
}

export interface ProjectReviewReadiness {
  publicId: string;
  status: WorkflowStatus;
  eligibility: SubmissionEligibility;
  ready: boolean;
  blockingReasons: string[];
  warnings: string[];
}

/**
 * Mirrors the SQL-side check in submit_import_projects_for_review exactly:
 * `ma.public_url IS NULL AND ma.is_public_approved = false`. In SQL, a NULL
 * is_public_approved makes the comparison NULL (not TRUE), so it is treated as
 * NOT proven private — fail closed. isPublicApproved must be strictly `false`, not just "not true".
 */
export function isPrivateAssetPresent(assets: ImportBatchReviewMediaAssetInput[], assetType: string): boolean {
  return assets.some(
    (asset) => asset.assetType === assetType && asset.publicUrl === null && asset.isPublicApproved === false
  );
}

/**
 * Server-authoritative readiness derivation for submitting an imported project into the
 * administrative review workflow. Mirrors the blocking checks re-derived inside the
 * submit_import_projects_for_review RPC (defense-in-depth, not the sole authority) — this
 * function exists so the UI can display readiness without an extra round trip, and so the
 * API route can reject an unready selection before ever calling the database.
 *
 * Reuses the existing required-field set from validateProjectForApproval (title, summary,
 * program, studyProgram, discipline, groupName, teamMembers) but checks staged private media
 * presence (media_assets) instead of public poster URLs, since imported drafts intentionally
 * never populate the public poster columns before publication.
 */
export function computeProjectReviewReadiness(input: ImportBatchReviewProjectInput): ProjectReviewReadiness {
  const status = (input.status ? input.status.toString().toLowerCase() : 'draft') as WorkflowStatus;
  const eligibility = getSubmissionEligibility(status);

  const blockingReasons: string[] = [];
  const warnings: string[] = [];

  if (!input.title || input.title.trim() === '') blockingReasons.push('Title is missing.');
  if (!input.summary || input.summary.trim() === '') blockingReasons.push('Summary is missing.');
  if (!input.programId || !input.programName || input.programName.trim() === '') {
    blockingReasons.push('Program is not mapped to a valid program record.');
  }
  if (!input.studyProgram || input.studyProgram.trim() === '') blockingReasons.push('Study program is missing.');
  if (!input.discipline || input.discipline.trim() === '') blockingReasons.push('Discipline is missing.');
  if (!input.groupName || input.groupName.trim() === '') blockingReasons.push('Group name is missing.');
  if (!input.teamMembers || input.teamMembers.length === 0) blockingReasons.push('Team member roster is empty.');

  // Accessible poster content. Mirrors MISSING_POSTER_TEXT / MISSING_ACCESSIBILITY_TEXT in
  // submit_import_projects_for_review. These are blockers, not acknowledgeable warnings: a public
  // project page must carry a full text version of its poster and a text alternative for the image.
  if (!isAccessibleContentPresent(input.posterText)) blockingReasons.push('Poster full text is missing.');
  if (!isAccessibleContentPresent(input.accessibilityText)) blockingReasons.push('Accessibility text is missing.');

  if (input.validationErrors && input.validationErrors.length > 0) {
    blockingReasons.push(`Blocking ingestion validation error(s) present: ${input.validationErrors.join('; ')}`);
  }

  // Authoritative validation_flags: mirrors the SQL-side check in submit_import_projects_for_review
  // exactly — only a flag with resolved === false (not null, not true) is unresolved. An unresolved
  // error-severity flag blocks; unresolved warning/info flags surface as non-blocking warnings.
  // Resolved flags are never presented as active blockers or warnings.
  for (const flag of input.validationFlags || []) {
    if (flag.resolved !== false) continue;
    if (flag.severity === 'error') {
      blockingReasons.push(`Unresolved validation error: ${flag.message}`);
    } else {
      warnings.push(flag.message);
    }
  }

  if (input.disciplineMappingCount === 0) blockingReasons.push('No discipline mapping is registered for this project.');
  if (input.industryMappingCount === 0) blockingReasons.push('No industry category mapping is registered for this project.');

  if (!isPrivateAssetPresent(input.mediaAssets, 'poster_image')) {
    blockingReasons.push('Poster image is missing or is not registered as private staged media.');
  }
  if (!isPrivateAssetPresent(input.mediaAssets, 'poster_pdf')) {
    blockingReasons.push('Poster PDF is missing or is not registered as private staged media.');
  }

  if (!input.snapshots || input.snapshots.length === 0) {
    warnings.push('Snapshot gallery is empty.');
  }
  if (input.validationWarnings) {
    warnings.push(...input.validationWarnings);
  }

  const ready = eligibility === 'eligible' && blockingReasons.length === 0;

  return {
    publicId: input.publicId,
    status,
    eligibility,
    ready,
    blockingReasons,
    warnings,
  };
}

/**
 * Maps a raw ImportBatchReviewProjectRow (as fetched by
 * ImportBatchRepositoryCore.getImportBatchReviewData) into the shape computeProjectReviewReadiness
 * expects, then computes readiness in a single step.
 */
export function computeReadinessForImportBatchRow(row: ImportBatchReviewProjectRow): ProjectReviewReadiness {
  return computeProjectReviewReadiness({
    publicId: row.public_id,
    title: row.title,
    summary: row.summary,
    programId: row.program_id,
    programName: row.program_name,
    studyProgram: row.study_program,
    discipline: row.discipline,
    groupName: row.group_name,
    teamMembers: row.team_members,
    posterText: row.poster_text_public,
    accessibilityText: row.accessibility_text_public,
    snapshots: row.snapshots,
    validationErrors: row.validation_errors,
    validationWarnings: row.validation_warnings,
    validationFlags: (row.validation_flags || []).map((flag) => ({
      severity: flag.severity,
      resolved: flag.resolved,
      message: flag.message,
    })),
    status: row.status,
    disciplineMappingCount: row.project_disciplines?.length ?? 0,
    industryMappingCount: row.project_industry_categories?.length ?? 0,
    mediaAssets: (row.media_assets || []).map((asset) => ({
      assetType: asset.asset_type,
      isPublicApproved: asset.is_public_approved,
      publicUrl: asset.public_url,
    })),
  });
}
