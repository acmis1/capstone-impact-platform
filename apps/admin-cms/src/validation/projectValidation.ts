import { Project } from '../domain/project';
import {
  describeAccessibleContentProblem,
  getAccessibleContentProblem,
  getSnapshotAltTextProblem,
  isAccessibleContentPresent,
} from '../domain/accessibleContent';

export interface ValidationOutput {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validates intermediate project folders during review ingestion.
 * Focuses on initial structural warnings and blocking format issues.
 */
export function validateProjectForReview(project: Project): ValidationOutput {
  const errors: string[] = [];
  const warnings: string[] = [];

  const prefix = `[Ingestion Review: ${project.groupName || 'Project'}]`;

  // Required properties for review stage
  if (!project.title || project.title.trim() === '') {
    warnings.push(`${prefix} Title is missing or empty.`);
  }

  // Asset validation check (image files & PDFs)
  if (!project.poster || project.poster.trim() === '') {
    // Marked as warning/pending stakeholder check
    warnings.push(`${prefix} Missing poster preview image. Pending stakeholder validation confirmation.`);
  }

  if (!project.posterPdf || project.posterPdf.trim() === '') {
    warnings.push(`${prefix} Missing poster.pdf file. Pending stakeholder validation confirmation.`);
  }

  // Accessible poster content. Surfaced early as warnings at ingestion so staff can correct the
  // source package; both become hard blockers at review submission and approval.
  if (!isAccessibleContentPresent(project.posterText)) {
    warnings.push(`${prefix} Missing poster full text. Required before this project can be submitted for review.`);
  }
  if (!isAccessibleContentPresent(project.accessibilityText)) {
    warnings.push(`${prefix} Missing poster accessibility text description. Required before this project can be submitted for review.`);
  }

  if (!project.snapshots || project.snapshots.length === 0) {
    warnings.push(`${prefix} Snapshots gallery folder is missing or has zero files.`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validates a CMS record prior to transition to the 'Approved' state.
 * Required fields are strictly blocking for showcase compiling.
 */
/**
 * The staged snapshot media an approval decision must account for, supplied alongside the project
 * because it lives on `media_assets` rather than on the project row.
 *
 * `null` (and an omitted option) means "this project has no snapshot image", which is a perfectly
 * valid state and adds no blocker. This mirrors the authoritative gate inside
 * perform_project_review_action; that gate remains the sole authority, and this exists so the CMS
 * can show staff the blocker before they attempt the action.
 */
export interface ApprovalMediaAssetEvidence {
  rowCount: number;
  validPrivateCount: number;
}

export interface ApprovalSnapshotMediaInput extends ApprovalMediaAssetEvidence {
  altText: string | null;
}

/**
 * Server-derived evidence for the authoritative media rows used by approval. Counts are retained
 * instead of flattened booleans so duplicate or contradictory rows fail closed as invalid rather
 * than being mistaken for one usable asset.
 */
export interface ApprovalMediaInput {
  posterImage: ApprovalMediaAssetEvidence;
  posterPdf: ApprovalMediaAssetEvidence;
  snapshotMedia: ApprovalSnapshotMediaInput | null;
}

export function validateProjectForApproval(
  project: Project,
  media: ApprovalMediaInput | null,
): ValidationOutput {
  const errors: string[] = [];
  const warnings: string[] = [];

  const prefix = `[Approval Gate: ${project.groupName || 'Project'}]`;

  // Blocking required public-facing metadata fields
  const requiredPublicKeys: (keyof Project)[] = [
    'title', 'summary', 'year', 'program', 'studyProgram', 'discipline', 'groupName'
  ];

  requiredPublicKeys.forEach((key) => {
    const val = project[key];
    if (val === undefined || val === null || String(val).trim() === '') {
      errors.push(`${prefix} Required field "${key}" is empty. Approval blocked.`);
    }
  });

  if (!Array.isArray(project.teamMembers) || project.teamMembers.length === 0) {
    errors.push(`${prefix} Roster of team members ("teamMembers") is empty. Approval blocked.`);
  }

  // Approval is a pre-publication decision. Required poster evidence comes from the authoritative
  // private media rows, never from project.poster/project.posterPdf public URL projections.
  if (media === null) {
    errors.push(`${prefix} Project media could not be verified. Approval blocked.`);
  } else {
    if (media.posterImage.rowCount === 0) {
      errors.push(`${prefix} Poster image is missing from staged project media. Approval blocked.`);
    } else if (media.posterImage.rowCount !== 1 || media.posterImage.validPrivateCount !== 1) {
      errors.push(`${prefix} Poster image in staged project media is invalid. Approval blocked.`);
    }

    if (media.posterPdf.rowCount === 0) {
      errors.push(`${prefix} Poster PDF is missing from staged project media. Approval blocked.`);
    } else if (media.posterPdf.rowCount !== 1 || media.posterPdf.validPrivateCount !== 1) {
      errors.push(`${prefix} Poster PDF in staged project media is invalid. Approval blocked.`);
    }
  }

  // Accessible poster content blocks approval, whether it is absent or beyond its bounded ceiling.
  // The published page must carry a full text version of its poster and a text alternative for the
  // poster image; both are staff-authored or imported, and the metadata editor is the correction
  // path in either direction. Oversized content is never downgraded to a warning.
  for (const field of ['posterText', 'accessibilityText'] as const) {
    const problem = getAccessibleContentProblem(project[field], field);
    if (problem) {
      errors.push(`${prefix} ${describeAccessibleContentProblem(problem, field)} Approval blocked.`);
    }
  }

  // Snapshot media accessibility. Only evaluated when a snapshot image actually exists, because
  // the image itself is optional and nobody should be asked to describe one that is not there.
  if (media?.snapshotMedia) {
    if (media.snapshotMedia.rowCount !== 1 || media.snapshotMedia.validPrivateCount !== 1) {
      errors.push(`${prefix} Snapshot image in staged project media is invalid. Approval blocked.`);
    }
    const problem = getSnapshotAltTextProblem(media.snapshotMedia.altText, { snapshotPresent: true });
    if (problem) {
      errors.push(`${prefix} ${describeAccessibleContentProblem(problem, 'snapshotAltText')} Approval blocked.`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
