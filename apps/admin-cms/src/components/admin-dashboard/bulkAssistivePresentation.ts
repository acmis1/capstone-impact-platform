import type { BulkAssistiveOutcome } from '../../assistive-validation';

const UNKNOWN = 'Assistive result unavailable';

export function bulkAssistiveDispositionLabel(value: string): string {
  switch (value) {
    case 'eligible': return 'Ready to enqueue';
    case 'already_active_or_current': return 'Already active or current';
    case 'blocked': return 'Blocked';
    case 'invalid_stale': return 'Needs refresh or cannot continue';
    default: return UNKNOWN;
  }
}

export function bulkAssistiveOutcomeLabel(value: string): string {
  switch (value as BulkAssistiveOutcome) {
    case 'ENQUEUED': return 'Enqueued';
    case 'ALREADY_ACTIVE_OR_CURRENT': return 'Already active or current';
    case 'BLOCKED': return 'Blocked';
    case 'INVALID_STALE': return 'Invalid or stale selection';
    case 'FAILED': return 'Failed';
    default: return UNKNOWN;
  }
}

export function bulkAssistiveStatusLabel(value: string | null): string {
  if (!value) return 'No run';
  switch (value) {
    case 'QUEUED': return 'Queued';
    case 'RUNNING': return 'Running';
    case 'PARTIAL': return 'Partial';
    case 'COMPLETED': return 'Completed';
    case 'FAILED': return 'Failed';
    case 'CANCELLED': return 'Cancelled';
    case 'SUPERSEDED': return 'Superseded';
    default: return 'Status unavailable';
  }
}
