import { Project } from '../../domain/project';

/**
 * Returns a valid URI-encoded project detail URL for non-empty public IDs, or null if missing/blank.
 */
export function getProjectDetailHref(publicId?: string | null): string | null {
  if (!publicId || !publicId.trim()) {
    return null;
  }
  return `/admin/projects/${encodeURIComponent(publicId.trim())}`;
}

export interface ValidationStatusOutcome {
  label: string;
  variant: 'destructive' | 'warning' | 'success';
}

/**
 * Interprets validation error and warning counts/flags into strongly-typed status outcome.
 * Blocking errors take precedence over warnings.
 */
export function getValidationOutcome(project: Partial<Project>): ValidationStatusOutcome {
  const flags = project.validationFlags;
  const errorsCount = project.validationErrors?.length || 0;
  const warningsCount = project.validationWarnings?.length || 0;

  if (errorsCount > 0 || flags?.hasErrors) {
    return {
      label: errorsCount > 0 ? `${errorsCount} Error${errorsCount > 1 ? 's' : ''}` : 'Needs attention',
      variant: 'destructive',
    };
  }

  if (warningsCount > 0 || flags?.hasWarnings) {
    return {
      label: warningsCount > 0 ? `${warningsCount} Warning${warningsCount > 1 ? 's' : ''}` : 'Warnings',
      variant: 'warning',
    };
  }

  return {
    label: 'Ready',
    variant: 'success',
  };
}
