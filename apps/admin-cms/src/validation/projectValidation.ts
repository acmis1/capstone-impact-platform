import { Project } from '../domain/project';
import { isAccessibleContentPresent } from '../domain/accessibleContent';

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
export function validateProjectForApproval(project: Project): ValidationOutput {
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

  // Poster Image & PDF must be present before final approval
  if (!project.poster || project.poster.trim() === '') {
    errors.push(`${prefix} Missing public poster preview image URL. Approval blocked.`);
  }
  if (!project.posterPdf || project.posterPdf.trim() === '') {
    errors.push(`${prefix} Missing public poster PDF URL. Approval blocked.`);
  }

  // Accessible poster content blocks approval. The published page must carry a full text version
  // of its poster and a text alternative for the poster image; both are staff-authored or imported,
  // and the metadata editor is the correction path when a package arrived without them.
  if (!isAccessibleContentPresent(project.posterText)) {
    errors.push(`${prefix} Poster full text is missing. Approval blocked.`);
  }
  if (!isAccessibleContentPresent(project.accessibilityText)) {
    errors.push(`${prefix} Accessibility text is missing. Approval blocked.`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
