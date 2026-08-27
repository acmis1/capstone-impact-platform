import type {
  AssistiveInspectionFinding,
  AssistiveInspectionView,
  AssistiveJobFailureCode,
  AssistiveJobStatus,
  AssistiveRunStatus,
  AssistiveStaleState,
} from '../../assistive-validation';
import { PROJECT_METADATA_LIMITS } from '../../projects/projectMetadata';

export interface AssistiveChecksUiState {
  inspection: AssistiveInspectionView | null;
  loading: boolean;
  error: string | null;
  actionInFlight: 'idle' | 'running' | 'cancelling' | 'dispositioning' | 'applying';
  feedback: { message: string; type: 'success' | 'warning' | 'info' } | null;
  copiedFindingId: string | null;
  copyStatus: 'copied' | 'failed' | null;
  readUnavailable: boolean;
}

export const initialAssistiveChecksUiState: AssistiveChecksUiState = {
  inspection: null,
  loading: false,
  error: null,
  actionInFlight: 'idle',
  feedback: null,
  copiedFindingId: null,
  copyStatus: null,
  readUnavailable: false,
};

export type AssistiveChecksAction =
  | { type: 'LOAD_STARTED' }
  | { type: 'LOAD_SUCCEEDED'; inspection: AssistiveInspectionView | null }
  | { type: 'LOAD_FAILED'; error: string }
  | { type: 'SYNC_SERVER_SNAPSHOT'; inspection: AssistiveInspectionView | null; readUnavailable: boolean }
  | { type: 'ACTIVE_RUN_NOT_FOUND'; runId: string }
  | { type: 'RUN_STARTED' }
  | { type: 'RUN_SUCCEEDED'; runId: string; status: string }
  | { type: 'RUN_FAILED'; error: string }
  | { type: 'CANCEL_STARTED' }
  | { type: 'CANCEL_SUCCEEDED' }
  | { type: 'CANCEL_FAILED'; error: string }
  | { type: 'DISPOSITION_STARTED' }
  | { type: 'DISPOSITION_SUCCEEDED'; findingId: string; disposition: 'REVIEWED' | 'IGNORED' }
  | { type: 'DISPOSITION_FAILED'; error: string }
  | { type: 'APPLY_STARTED' }
  | { type: 'APPLY_COMPLETED'; message: string; success: boolean }
  | { type: 'APPLY_FAILED'; error: string }
  | { type: 'COPY_FEEDBACK'; findingId: string | null; status: 'copied' | 'failed' | null }
  | { type: 'CLEAR_FEEDBACK' };

export function assistiveChecksReducer(
  state: AssistiveChecksUiState,
  action: AssistiveChecksAction,
): AssistiveChecksUiState {
  switch (action.type) {
    case 'LOAD_STARTED':
      return { ...state, loading: state.inspection === null, error: null };
    case 'LOAD_SUCCEEDED':
      return { ...state, loading: false, inspection: action.inspection, error: null, readUnavailable: false };
    case 'LOAD_FAILED':
      return { ...state, loading: false, error: action.error };
    case 'SYNC_SERVER_SNAPSHOT': {
      if (!action.inspection) {
        return { ...state, readUnavailable: action.readUnavailable };
      }

      const shouldUpdate =
        !state.inspection ||
        state.inspection.runId === action.inspection.runId ||
        new Date(action.inspection.createdAt).getTime() >= new Date(state.inspection.createdAt).getTime();

      return shouldUpdate
        ? { ...state, inspection: action.inspection, readUnavailable: action.readUnavailable, error: null }
        : { ...state, readUnavailable: action.readUnavailable };
    }
    case 'ACTIVE_RUN_NOT_FOUND':
      if (state.inspection?.runId !== action.runId) return state;
      return {
        ...state,
        inspection: null,
        readUnavailable: true,
        error: 'This assistive check run is no longer available. Refresh or run checks again.',
      };
    case 'RUN_STARTED':
      return { ...state, actionInFlight: 'running', error: null, feedback: null };
    case 'RUN_SUCCEEDED':
      return { ...state, actionInFlight: 'idle', error: null };
    case 'RUN_FAILED':
      return { ...state, actionInFlight: 'idle', error: action.error };
    case 'CANCEL_STARTED':
      return { ...state, actionInFlight: 'cancelling', error: null };
    case 'CANCEL_SUCCEEDED':
      return {
        ...state,
        actionInFlight: 'idle',
        feedback: { message: 'Cancellation requested.', type: 'info' },
      };
    case 'CANCEL_FAILED':
      return { ...state, actionInFlight: 'idle', error: action.error };
    case 'DISPOSITION_STARTED':
      return { ...state, actionInFlight: 'dispositioning', error: null };
    case 'DISPOSITION_SUCCEEDED': {
      if (!state.inspection) return { ...state, actionInFlight: 'idle' };
      const updatedFindings = state.inspection.findings.map((finding) => {
        if (finding.findingId === action.findingId) {
          return {
            ...finding,
            disposition: action.disposition,
          };
        }
        return finding;
      });
      return {
        ...state,
        actionInFlight: 'idle',
        inspection: { ...state.inspection, findings: updatedFindings },
        feedback: {
          message: action.disposition === 'REVIEWED' ? 'Marked as reviewed.' : 'Marked as ignored.',
          type: 'success',
        },
      };
    }
    case 'DISPOSITION_FAILED':
      return { ...state, actionInFlight: 'idle', error: action.error };
    case 'APPLY_STARTED':
      return { ...state, actionInFlight: 'applying' };
    case 'APPLY_COMPLETED':
      return {
        ...state,
        actionInFlight: 'idle',
        feedback: action.success ? { message: action.message, type: 'success' } : null,
      };
    case 'APPLY_FAILED':
      return { ...state, actionInFlight: 'idle', feedback: null, error: action.error };
    case 'COPY_FEEDBACK':
      return { ...state, copiedFindingId: action.findingId, copyStatus: action.status };
    case 'CLEAR_FEEDBACK':
      return { ...state, feedback: null, error: null };
  }
}

export function formatCheckType(checkType: string): string {
  switch (checkType) {
    case 'TITLE_CONSISTENCY':
      return 'Project title';
    case 'FORMATTING':
      return 'Document formatting';
    case 'EXTRACTION_INFORMATION':
      return 'Document extraction';
    case 'DUPLICATE_SHORTLIST':
      return 'Similar projects';
    default:
      return checkType.replace(/_/g, ' ').toLowerCase();
  }
}

export function formatOutcome(outcome: string): {
  label: string;
  variant: 'success' | 'warning' | 'destructive' | 'information' | 'neutral';
} {
  switch (outcome) {
    case 'AGREES':
      return { label: 'Title match', variant: 'success' };
    case 'REVIEW':
      return { label: 'Review suggested', variant: 'warning' };
    case 'MISMATCH':
      return { label: 'Possible title mismatch', variant: 'destructive' };
    case 'INFORMATION':
      return { label: 'Information', variant: 'information' };
    case 'NOT_EVALUATED':
      return { label: 'Could not evaluate', variant: 'neutral' };
    default:
      return { label: outcome, variant: 'neutral' };
  }
}

export function formatJobStatus(
  jobStatus: AssistiveJobStatus,
  runStatus: AssistiveRunStatus,
): {
  label: string;
  active: boolean;
  variant: 'success' | 'warning' | 'destructive' | 'information' | 'neutral';
} {
  if (runStatus === 'CANCELLED' || jobStatus === 'CANCELLED') {
    return { label: 'Cancelled', active: false, variant: 'neutral' };
  }
  if (runStatus === 'SUPERSEDED' || jobStatus === 'SUPERSEDED') {
    return { label: 'Superseded', active: false, variant: 'neutral' };
  }
  if (runStatus === 'FAILED' || jobStatus === 'FAILED') {
    return { label: 'Failed', active: false, variant: 'destructive' };
  }
  if (runStatus === 'PARTIAL' || jobStatus === 'PARTIAL') {
    return { label: 'Partially completed', active: false, variant: 'information' };
  }
  if (runStatus === 'COMPLETED' || jobStatus === 'COMPLETED') {
    return { label: 'Completed', active: false, variant: 'success' };
  }

  switch (jobStatus) {
    case 'QUEUED':
      return { label: 'Queued', active: true, variant: 'warning' };
    case 'EXTRACTING':
      return { label: 'Extracting document', active: true, variant: 'warning' };
    case 'CHECKING':
      return { label: 'Running checks', active: true, variant: 'warning' };
    default:
      return { label: 'Running checks', active: true, variant: 'warning' };
  }
}

/**
 * Single source of truth for "this run is still being worked on".
 *
 * Polling scheduling, the cancel/re-run control, and every empty/terminal branch all ask this same
 * question, so they derive it from `formatJobStatus`, which already resolves job and run status
 * together. Restating the status lists at each call site is how a terminal state ends up polled
 * forever, or an active run rendered as history.
 */
export function isAssistiveRunActive(
  inspection: Pick<AssistiveInspectionView, 'jobStatus' | 'runStatus'> | null | undefined,
): boolean {
  if (!inspection) return false;
  return formatJobStatus(inspection.jobStatus, inspection.runStatus).active;
}

export function formatDisposition(disposition: string): {
  label: string;
  variant: 'success' | 'warning' | 'destructive' | 'information' | 'neutral';
} {
  switch (disposition) {
    case 'REVIEWED':
      return { label: 'Reviewed', variant: 'success' };
    case 'IGNORED':
      return { label: 'Ignored', variant: 'neutral' };
    case 'UNREVIEWED':
    default:
      return { label: 'Unreviewed', variant: 'neutral' };
  }
}

export function formatFailureCode(code: AssistiveJobFailureCode | string | null): string {
  switch (code) {
    case 'MEDIA_INVALID':
      return 'The uploaded poster file is missing or contains invalid data.';
    case 'INPUT_UNAVAILABLE':
      return 'Project content or poster document could not be loaded.';
    case 'WORKER_UNAVAILABLE':
      return 'The assistive worker process was unavailable.';
    case 'WORKER_TIMEOUT':
      return 'Document extraction exceeded the maximum execution time.';
    case 'WORKER_CRASHED':
      return 'The assistive worker process exited unexpectedly.';
    case 'EXTRACTION_CONTRACT_REJECTED':
      return 'Document extraction output did not satisfy the bounded schema.';
    case 'EXTRACTION_FAILED':
      return 'The document could not be extracted (file may be password-protected or corrupt).';
    case 'DETERMINISTIC_CONTRACT_REJECTED':
      return 'The check calculation output did not satisfy the bounded schema.';
    case 'OCR_REQUIRED':
      return 'OCR text extraction is required for this scanned document or image, but OCR has not run.';
    case 'OCR_PROVIDER_UNAVAILABLE':
      return 'OCR text extraction is required, but no OCR provider is configured in this environment.';
    case 'IDENTITY_CONFLICT':
      return 'A result conflict occurred during job processing.';
    case 'INTERNAL_FAILURE':
    default:
      return 'An unexpected error occurred during check execution.';
  }
}

export function formatPartialNoticeDescription(failureCode: AssistiveJobFailureCode | string | null): string {
  if (failureCode === 'OCR_REQUIRED') {
    return 'Some document content could not be evaluated because OCR has not run. Native text, when available, was checked.';
  }
  if (failureCode === 'OCR_PROVIDER_UNAVAILABLE') {
    return 'Some document content could not be evaluated because the configured OCR capability is unavailable. Native text, when available, was checked.';
  }
  return 'Some document content could not be evaluated in this environment. Native text, when available, was checked.';
}

export function isFindingEligibleToApply(
  finding: AssistiveInspectionFinding,
  staleState: AssistiveStaleState,
  canEditMetadata: boolean,
  canApplyHandler: boolean,
): boolean {
  if (!canEditMetadata || !canApplyHandler) return false;
  if (staleState !== 'CURRENT') return false;
  if (finding.checkType !== 'TITLE_CONSISTENCY') return false;
  if (finding.outcome === 'AGREES') return false;
  const candidate = finding.evidence.candidateValue;
  if (!candidate || candidate.trim().length === 0) return false;
  if (candidate.length > PROJECT_METADATA_LIMITS.title) return false;
  return true;
}
