/**
 * Presentation-only derivation for the showcase publishing surfaces.
 *
 * `public_feed_operations` rows block a second concurrent publishing action in several states, but
 * only `RECOVERY_REQUIRED` proves that an earlier action failed and left publishing paused. Every
 * other blocking state describes a publishing action that is still running normally. The staff-
 * facing header badge, top summary, alerts, controls, and publishing-health card all read from this
 * single derivation so they cannot disagree.
 *
 * No backend state, contract, or semantics change here: `blockingOperation.state` remains the
 * source of truth and is only translated into staff-readable presentation.
 */

/** Blocking states that describe a publishing action that is still running. */
export const PUBLISHING_IN_PROGRESS_STATES = [
  'RESERVED',
  'PREPARED',
  'WRITE_STARTED',
  'CANDIDATE_OBSERVED',
  'DB_FINALIZED',
] as const;

/** The only blocking state that proves recovery is required. */
export const PUBLISHING_RECOVERY_REQUIRED_STATE = 'RECOVERY_REQUIRED';

export type PublishingActivity = 'idle' | 'in_progress' | 'recovery_required';

export interface BlockingOperationView {
  kind: string;
  state: string;
  failureCode: string | null;
  updatedAt: string;
}

/**
 * Classifies a blocking operation. An unrecognized state is treated as an in-flight operation
 * rather than as recovery: claiming a failure that has not been proven would be untruthful, and
 * the operation still blocks a concurrent publish either way.
 */
export function classifyPublishingActivity(
  blockingOperation: Pick<BlockingOperationView, 'state'> | null | undefined,
): PublishingActivity {
  if (!blockingOperation) return 'idle';
  return blockingOperation.state === PUBLISHING_RECOVERY_REQUIRED_STATE
    ? 'recovery_required'
    : 'in_progress';
}

export interface PublishingHealthInput {
  active: boolean;
  blockingOperation: Pick<BlockingOperationView, 'state'> | null | undefined;
  divergedProjectsCount: number;
}

export interface PublishingHealthPresentation {
  activity: PublishingActivity;
  /** True only for `RECOVERY_REQUIRED`; gates all recovery wording and the recovery control. */
  recoveryRequired: boolean;
  /** True while an ordinary publishing action is still running. */
  publishingInProgress: boolean;
  badgeLabel: string;
  badgeVariant: 'success' | 'warning' | 'information';
  /** "Publishing status" summary card value. */
  summaryLabel: string;
  /** "Publishing health" summary card value. */
  healthLabel: string;
}

export function derivePublishingHealth(input: PublishingHealthInput): PublishingHealthPresentation {
  const activity = classifyPublishingActivity(input.blockingOperation);
  const recoveryRequired = activity === 'recovery_required';
  const publishingInProgress = activity === 'in_progress';

  const repairLabel = input.divergedProjectsCount === 1
    ? '1 project needs repair'
    : `${input.divergedProjectsCount} projects need repair`;

  if (recoveryRequired) {
    return {
      activity,
      recoveryRequired,
      publishingInProgress,
      badgeLabel: 'Needs attention',
      badgeVariant: 'warning',
      summaryLabel: 'Needs attention',
      healthLabel: 'Needs attention',
    };
  }

  if (publishingInProgress) {
    return {
      activity,
      recoveryRequired,
      publishingInProgress,
      badgeLabel: 'Publishing in progress',
      badgeVariant: 'information',
      summaryLabel: 'Publishing in progress',
      healthLabel: 'Publishing in progress',
    };
  }

  const healthLabel = input.divergedProjectsCount > 0 ? repairLabel : 'No issues';

  if (!input.active) {
    return {
      activity,
      recoveryRequired,
      publishingInProgress,
      badgeLabel: 'Setup required',
      badgeVariant: 'warning',
      summaryLabel: 'Setup required',
      healthLabel,
    };
  }

  return {
    activity,
    recoveryRequired,
    publishingInProgress,
    badgeLabel: 'Publishing ready',
    badgeVariant: 'success',
    summaryLabel: 'Ready',
    healthLabel,
  };
}

/**
 * Staff-readable description of a still-running publishing action. The raw state stays available
 * under progressive disclosure rather than in the primary copy.
 */
export function publishingInProgressDescription(): string {
  return 'Another publishing action is currently running. Wait for it to finish before starting a new publish or removal.';
}
