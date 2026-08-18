import type { WorkflowStatus } from '../../domain/workflowStatus';
import type { PublicationReadinessResult } from '../../domain/publicationReadiness';
import { getWorkflowStatusLabel } from './ProjectStatusBadge';

/**
 * Authoritative state this page has already loaded. Nothing here is re-derived from the
 * database, and nothing here decides what a transition does — `getAllowedReviewActions`,
 * the import readiness computation, and the publication readiness result stay the only
 * authorities. This module turns that already-decided state into staff-facing prose.
 */
export interface ProjectWorkflowContextInput {
  status: WorkflowStatus | string;
  /** Status-valid actions that the current staff member is permitted to perform. */
  allowedActions: readonly string[];
  /** Import submit-for-review readiness, or null when the project is not in a submitting state. */
  submitForReview: { ready: boolean; blockingReasons: string[] } | null;
  /** True when readiness could not be verified, which fails closed to "cannot submit". */
  submitForReviewUnavailable: boolean;
  canEditMetadata: boolean;
  /** `null` when the participant preview subsystem could not be read. */
  participantResponse: 'unresponded' | 'confirmed' | 'correction_requested' | null;
  hasActivePreview: boolean;
  /** `null` when readiness could not be read; otherwise the authoritative result. */
  publicationReadiness: PublicationReadinessResult | null;
  pendingRemovalFromPublic: boolean;
}

export interface ProjectWorkflowContext {
  /** Human stage name, e.g. "In review". Always the real status label. */
  stageLabel: string;
  /** One sentence stating where the project actually is. */
  summary: string;
  /**
   * What this page can currently offer. When the loaded state does not support a single
   * next action this states the situation rather than inventing one.
   */
  decision: string;
}

function normalize(status: WorkflowStatus | string): string {
  return (status || '').toLowerCase();
}

function isPublicationReadinessUnavailable(readiness: PublicationReadinessResult | null): boolean {
  return readiness === null || [
    'READINESS_PERMISSION_DENIED',
    'INVALID_SELECTION',
    'INVALID_PRIVATE_BUCKET',
    'READINESS_UNAVAILABLE',
  ].includes(readiness.resultCode);
}

/**
 * Describes the current workflow position for staff orientation.
 *
 * Deliberately conservative: it never claims a next step the loaded state does not already
 * support, and it never contradicts the canonical action controls. When no action is
 * available it says so plainly.
 */
export function deriveProjectWorkflowContext(input: ProjectWorkflowContextInput): ProjectWorkflowContext {
  const status = normalize(input.status);
  const stageLabel = getWorkflowStatusLabel(input.status);
  const canSubmit = input.submitForReview !== null && input.canEditMetadata;
  const submitBlocked = canSubmit && !input.submitForReview!.ready;
  const hasReviewActions = input.allowedActions.length > 0;

  if (status === 'draft' || status === 'changes_requested') {
    const summary = status === 'changes_requested'
      ? 'A reviewer asked for changes. The project is back with staff for editing before it returns to review.'
      : 'This project is being prepared. It is private and has not been sent for review.';

    let decision: string;
    if (input.submitForReviewUnavailable) {
      decision = 'Submission readiness could not be verified, so submit for review stays unavailable until it can be checked again.';
    } else if (!input.canEditMetadata) {
      decision = 'Your role can read this project but cannot edit it or submit it for review.';
    } else if (input.submitForReview === null) {
      decision = 'Submit for review is not offered for this project, because it has no completed import batch to submit from.';
    } else if (submitBlocked) {
      decision = 'Fix the listed blocking issues before this project can be submitted for review.';
    } else {
      decision = 'Project information can be edited, and the project can be submitted for review.';
    }

    return { stageLabel, summary, decision };
  }

  if (status === 'submitted' || status === 'in_review') {
    return {
      stageLabel,
      summary: 'This project is waiting on a review decision. Staff editing is closed while it is under review.',
      decision: hasReviewActions
        ? 'Read the project information and media, then approve it or request changes.'
        : 'Your role can read this project but cannot record a review decision.',
    };
  }

  if (status === 'approved') {
    let summary = 'Internal review is complete. The project is approved but is not published.';
    let decision: string;

    if (input.participantResponse === null) {
      decision = 'Participant confirmation state could not be read, so publication readiness cannot be confirmed here.';
    } else if (input.participantResponse === 'correction_requested') {
      summary = 'Internal review is complete, but the participant asked for a correction.';
      decision = 'Resolve the participant correction before publication can be prepared.';
    } else if (input.participantResponse === 'confirmed') {
      if (input.publicationReadiness?.ready && input.publicationReadiness.resultCode === 'READY') {
        decision = 'The participant has confirmed. Publication can be prepared.';
      } else if (isPublicationReadinessUnavailable(input.publicationReadiness)) {
        decision = 'The participant has confirmed, but publication readiness could not be verified. Publication preparation remains unavailable until it can be checked.';
      } else {
        decision = 'The participant has confirmed. Check the publication status below before preparing publication.';
      }
    } else if (input.hasActivePreview) {
      summary = 'Internal review is complete. A participant preview is active and awaiting a response.';
      decision = 'Wait for the participant to confirm, or manage the preview and reminders below.';
    } else {
      decision = 'Share a participant preview so the participant can confirm their project before publication.';
    }

    return { stageLabel, summary, decision };
  }

  if (status === 'published') {
    return {
      stageLabel,
      summary: input.pendingRemovalFromPublic
        ? 'This project is published and is marked for removal from the showcase.'
        : 'This project is published to the showcase.',
      decision: input.pendingRemovalFromPublic
        ? 'A showcase removal is pending for this project. Review the lifecycle section below.'
        : 'No review transition is available from this status. Lifecycle changes use the controlled archive workflow.',
    };
  }

  if (status === 'archived') {
    return {
      stageLabel,
      summary: 'This project is archived and is not part of the showcase.',
      decision: 'No review transition is available from this status.',
    };
  }

  return {
    stageLabel,
    summary: `This project is recorded with the status "${stageLabel}".`,
    decision: hasReviewActions
      ? 'Review decisions are available for this project.'
      : 'No review transition is available from this status.',
  };
}
