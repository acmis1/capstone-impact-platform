import type {
  ParticipantPreviewCorrectionResolutionStatus,
  ParticipantPreviewResponseState,
} from '../domain/participantPreview';
import type { PublicationReadinessResult } from '../domain/publicationReadiness';
import { ParticipantPreviewExecutionError } from '../repositories/ParticipantPreviewRepository';

export interface ProjectDetailPreviewState {
  activePreview: { createdAt: string; expiresAt: string } | null;
  responseState: ParticipantPreviewResponseState;
}

export interface ProjectDetailAuxiliaryData<TProject> {
  project: TProject;
  auditRecords: Array<Record<string, unknown>> | null;
  previewState: ProjectDetailPreviewState;
  previewStateAvailable: boolean;
  resolutionStatus: ParticipantPreviewCorrectionResolutionStatus | null;
  resolutionStatusAvailable: boolean;
  publicationReadiness: PublicationReadinessResult | null;
  publicationActionsAvailable: boolean;
}

export interface ProjectDetailAuxiliaryLoaders {
  loadAuditRecords(): Promise<Array<Record<string, unknown>>>;
  loadPreviewState(): Promise<ProjectDetailPreviewState>;
  loadResolutionStatus(): Promise<ParticipantPreviewCorrectionResolutionStatus | null>;
  loadPublicationReadiness(): Promise<PublicationReadinessResult>;
}

export type ProjectDetailSubsystem =
  | 'audit history'
  | 'participant preview'
  | 'correction resolution'
  | 'publication readiness';

export type ProjectDetailFailureLogger = (subsystem: ProjectDetailSubsystem, category: string) => void;

export class ProjectDetailAuxiliaryReadError extends Error {
  constructor(readonly category: 'PROJECT_ID_UNAVAILABLE' | 'QUERY_FAILED' | 'INVALID_RESPONSE') {
    super(category);
    this.name = 'ProjectDetailAuxiliaryReadError';
  }
}

export function projectDetailFailureCategory(error: unknown): string {
  if (error instanceof ParticipantPreviewExecutionError) return error.code;
  if (error instanceof ProjectDetailAuxiliaryReadError) return error.category;
  return 'UNEXPECTED_FAILURE';
}

const defaultLogger: ProjectDetailFailureLogger = (subsystem, category) => {
  console.error(`[Project detail: ${subsystem} load failure]`, category);
};

async function settle<T>(
  subsystem: ProjectDetailSubsystem,
  loader: () => Promise<T>,
  logFailure: ProjectDetailFailureLogger,
): Promise<{ available: true; value: T } | { available: false; value: null }> {
  try {
    return { available: true, value: await loader() };
  } catch (error: unknown) {
    logFailure(subsystem, projectDetailFailureCategory(error));
    return { available: false, value: null };
  }
}

/**
 * Loads project-detail secondary data independently. None of these reads may erase an already
 * authenticated, successfully loaded base project. Availability flags prevent valid empty
 * business states from being confused with infrastructure failures.
 */
export async function loadProjectDetailAuxiliaryData<TProject>(
  project: TProject,
  loaders: ProjectDetailAuxiliaryLoaders,
  logFailure: ProjectDetailFailureLogger = defaultLogger,
): Promise<ProjectDetailAuxiliaryData<TProject>> {
  const [audit, preview, resolution, readiness] = await Promise.all([
    settle('audit history', loaders.loadAuditRecords, logFailure),
    settle('participant preview', loaders.loadPreviewState, logFailure),
    settle('correction resolution', loaders.loadResolutionStatus, logFailure),
    settle('publication readiness', loaders.loadPublicationReadiness, logFailure),
  ]);

  if (readiness.available && readiness.value.resultCode === 'READINESS_UNAVAILABLE') {
    logFailure('publication readiness', 'READINESS_UNAVAILABLE');
  }

  const publicationReadiness = readiness.available ? readiness.value : null;
  const publicationActionsAvailable =
    preview.available &&
    resolution.available &&
    publicationReadiness?.ready === true &&
    publicationReadiness.resultCode === 'READY';
  const verifiedPublicationReadiness = preview.available && resolution.available
    ? publicationReadiness
    : null;

  return {
    project,
    auditRecords: audit.available ? audit.value : null,
    previewState: preview.available
      ? preview.value
      : { activePreview: null, responseState: { type: 'unresponded' } },
    previewStateAvailable: preview.available,
    resolutionStatus: resolution.available ? resolution.value : null,
    resolutionStatusAvailable: resolution.available,
    publicationReadiness: verifiedPublicationReadiness,
    publicationActionsAvailable,
  };
}
