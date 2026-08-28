/**
 * Presentation-only derivation for the showcase publishing surfaces.
 *
 * Every non-terminal public-feed operation blocks the single canonical writer. Whether staff
 * should wait or may request recovery is determined by its durable lease and Storage uncertainty
 * fence, never by `updatedAt`. The recovery endpoint remains the final authority and rechecks the
 * same database contract before claiming anything.
 */

export const PUBLISHING_BLOCKING_STATES = [
  'RESERVED',
  'PREPARED',
  'WRITE_STARTED',
  'CANDIDATE_OBSERVED',
  'DB_FINALIZED',
  'RECOVERY_REQUIRED',
] as const;

export type PublishingActivity =
  | 'IDLE'
  | 'IN_PROGRESS'
  | 'RECOVERY_WAIT'
  | 'RECOVERY_AVAILABLE';

export interface BlockingOperationView {
  kind: string;
  state: string;
  failureCode: string | null;
  updatedAt: string;
  leaseExpiresAt: string;
  storageUncertaintyUntil: string | null;
}

export type PublishingAttentionReason =
  | 'SAFETY_WINDOW_ACTIVE'
  | 'UNKNOWN_BLOCKING_STATE'
  | 'TIMING_UNAVAILABLE';

interface PublishingActivityDerivation {
  activity: PublishingActivity;
  attentionReason: PublishingAttentionReason | null;
  retryAt: string | null;
}

function parseInstant(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function derivePublishingActivity(
  blockingOperation: Pick<BlockingOperationView, 'state' | 'leaseExpiresAt' | 'storageUncertaintyUntil'> | null | undefined,
  now: Date,
): PublishingActivityDerivation {
  if (!blockingOperation) {
    return { activity: 'IDLE', attentionReason: null, retryAt: null };
  }

  if (!(PUBLISHING_BLOCKING_STATES as readonly string[]).includes(blockingOperation.state)) {
    return { activity: 'RECOVERY_WAIT', attentionReason: 'UNKNOWN_BLOCKING_STATE', retryAt: null };
  }

  const nowMs = now.getTime();
  const leaseMs = parseInstant(blockingOperation.leaseExpiresAt);
  const fenceMs = blockingOperation.storageUncertaintyUntil === null
    ? null
    : parseInstant(blockingOperation.storageUncertaintyUntil);
  if (!Number.isFinite(nowMs) || leaseMs === null
      || (blockingOperation.storageUncertaintyUntil !== null && fenceMs === null)) {
    return { activity: 'RECOVERY_WAIT', attentionReason: 'TIMING_UNAVAILABLE', retryAt: null };
  }

  if (leaseMs > nowMs) {
    if (blockingOperation.state !== 'RECOVERY_REQUIRED') {
      return { activity: 'IN_PROGRESS', attentionReason: null, retryAt: blockingOperation.leaseExpiresAt };
    }
    const retryMs = Math.max(leaseMs, fenceMs ?? leaseMs);
    return {
      activity: 'RECOVERY_WAIT',
      attentionReason: 'SAFETY_WINDOW_ACTIVE',
      retryAt: new Date(retryMs).toISOString(),
    };
  }

  if (fenceMs !== null && fenceMs > nowMs) {
    return {
      activity: 'RECOVERY_WAIT',
      attentionReason: 'SAFETY_WINDOW_ACTIVE',
      retryAt: blockingOperation.storageUncertaintyUntil,
    };
  }

  return { activity: 'RECOVERY_AVAILABLE', attentionReason: null, retryAt: null };
}

export function classifyPublishingActivity(
  blockingOperation: Pick<BlockingOperationView, 'state' | 'leaseExpiresAt' | 'storageUncertaintyUntil'> | null | undefined,
  now: Date,
): PublishingActivity {
  return derivePublishingActivity(blockingOperation, now).activity;
}

export interface PublishingHealthInput {
  active: boolean;
  blockingOperation: Pick<BlockingOperationView, 'state' | 'leaseExpiresAt' | 'storageUncertaintyUntil'> | null | undefined;
  divergedProjectsCount: number;
  now: Date;
}

export interface PublishingHealthPresentation extends PublishingActivityDerivation {
  recoveryAvailable: boolean;
  recoveryWaiting: boolean;
  publishingInProgress: boolean;
  hasBlockingOperation: boolean;
  setupAvailable: boolean;
  repairAvailable: boolean;
  badgeLabel: string;
  badgeVariant: 'success' | 'warning' | 'information';
  summaryLabel: string;
  healthLabel: string;
}

export function derivePublishingHealth(input: PublishingHealthInput): PublishingHealthPresentation {
  const activity = derivePublishingActivity(input.blockingOperation, input.now);
  const recoveryAvailable = activity.activity === 'RECOVERY_AVAILABLE';
  const recoveryWaiting = activity.activity === 'RECOVERY_WAIT';
  const publishingInProgress = activity.activity === 'IN_PROGRESS';
  const hasBlockingOperation = activity.activity !== 'IDLE';
  const repairLabel = input.divergedProjectsCount === 1
    ? '1 project needs repair'
    : `${input.divergedProjectsCount} projects need repair`;

  if (recoveryAvailable || recoveryWaiting) {
    return {
      ...activity,
      recoveryAvailable,
      recoveryWaiting,
      publishingInProgress,
      hasBlockingOperation,
      setupAvailable: false,
      repairAvailable: false,
      badgeLabel: 'Needs attention',
      badgeVariant: 'warning',
      summaryLabel: 'Needs attention',
      healthLabel: 'Needs attention',
    };
  }

  if (publishingInProgress) {
    return {
      ...activity,
      recoveryAvailable,
      recoveryWaiting,
      publishingInProgress,
      hasBlockingOperation,
      setupAvailable: false,
      repairAvailable: false,
      badgeLabel: 'Publishing in progress',
      badgeVariant: 'information',
      summaryLabel: 'Publishing in progress',
      healthLabel: 'Publishing in progress',
    };
  }

  const healthLabel = input.divergedProjectsCount > 0 ? repairLabel : 'No issues';
  if (!input.active) {
    return {
      ...activity,
      recoveryAvailable,
      recoveryWaiting,
      publishingInProgress,
      hasBlockingOperation,
      setupAvailable: true,
      repairAvailable: false,
      badgeLabel: 'Setup required',
      badgeVariant: 'warning',
      summaryLabel: 'Setup required',
      healthLabel,
    };
  }

  return {
    ...activity,
    recoveryAvailable,
    recoveryWaiting,
    publishingInProgress,
    hasBlockingOperation,
    setupAvailable: false,
    repairAvailable: input.divergedProjectsCount > 0,
    badgeLabel: 'Publishing ready',
    badgeVariant: 'success',
    summaryLabel: 'Ready',
    healthLabel,
  };
}

export function publishingInProgressDescription(): string {
  return 'Another publishing action has a live lease and is still running. Wait for it to finish, then refresh before starting another publishing action.';
}
