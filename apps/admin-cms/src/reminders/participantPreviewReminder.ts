import type { ParticipantPreviewNotificationStatus } from '../notifications/participantPreviewNotification';

export type ParticipantPreviewReminderScheduleStatus =
  | 'scheduled'
  | 'triggered'
  | 'skipped'
  | 'cancelled';

export type ParticipantPreviewReminderSkipReason =
  | 'INITIAL_DELIVERY_NOT_CONFIRMED'
  | 'PREVIEW_CONFIRMED'
  | 'CORRECTION_PENDING'
  | 'PREVIEW_REVOKED'
  | 'PREVIEW_EXPIRED'
  | 'PREVIEW_SUPERSEDED'
  | 'PROJECT_NOT_ELIGIBLE'
  | 'CONTACT_CHANGED';

export type ParticipantPreviewReminderResultCode =
  | 'SCHEDULED'
  | 'ALREADY_SCHEDULED'
  | 'CANCELLED'
  | 'ALREADY_CANCELLED'
  | 'REMINDER_NOT_CANCELLABLE'
  | 'REMINDER_NOT_FOUND'
  | 'REMINDERS_DISABLED'
  | 'INITIAL_NOTIFICATION_REQUIRED'
  | 'INITIAL_DELIVERY_NOT_CONFIRMED'
  | 'PREVIEW_CONFIRMED'
  | 'CORRECTION_PENDING'
  | 'PREVIEW_NOT_ELIGIBLE'
  | 'CONTACT_CHANGED'
  | 'SCHEDULE_NOT_FUTURE'
  | 'SCHEDULE_AFTER_EXPIRY'
  | 'PERMISSION_DENIED'
  | 'PROJECT_NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'REMINDER_FAILED';

const MESSAGES: Record<ParticipantPreviewReminderResultCode, string> = {
  SCHEDULED: 'The participant preview reminder was scheduled.',
  ALREADY_SCHEDULED: 'That reminder is already scheduled.',
  CANCELLED: 'The participant preview reminder was cancelled.',
  ALREADY_CANCELLED: 'That reminder was already cancelled.',
  REMINDER_NOT_CANCELLABLE: 'That reminder can no longer be cancelled.',
  REMINDER_NOT_FOUND: 'The reminder could not be found for this project.',
  REMINDERS_DISABLED: 'Participant preview reminders are not enabled on this server.',
  INITIAL_NOTIFICATION_REQUIRED:
    'A successful original preview email is required before a reminder can be scheduled.',
  INITIAL_DELIVERY_NOT_CONFIRMED:
    'The original preview email delivery was not confirmed, so a reminder cannot be scheduled.',
  PREVIEW_CONFIRMED: 'The participant has already confirmed this preview.',
  CORRECTION_PENDING: 'A participant correction request blocks reminders for this preview.',
  PREVIEW_NOT_ELIGIBLE: 'This preview is no longer eligible for reminders.',
  CONTACT_CHANGED:
    'The participant contact no longer matches the original preview email recipient.',
  SCHEDULE_NOT_FUTURE: 'Choose a reminder time in the future.',
  SCHEDULE_AFTER_EXPIRY: 'Choose a reminder time before the participant preview expires.',
  PERMISSION_DENIED: 'Access denied.',
  PROJECT_NOT_FOUND: 'Project not found.',
  VALIDATION_FAILED: 'Validation failed.',
  REMINDER_FAILED: 'The participant preview reminder request could not be completed.',
};

export function participantPreviewReminderMessage(
  code: ParticipantPreviewReminderResultCode,
): string {
  return MESSAGES[code];
}
export interface ParticipantPreviewReminderView {
  /** Opaque staff-safe reference used only to request cancellation. Never a database primary key. */
  reference: string;
  previewCreatedAt: string;
  previewExpiresAt: string;
  currentPreview: boolean;
  recipient: string;
  scheduledFor: string;
  scheduledBy: string;
  status: ParticipantPreviewReminderScheduleStatus;
  skipReason: ParticipantPreviewReminderSkipReason | null;
  triggeredAt: string | null;
  cancelledAt: string | null;
  delivery: {
    status: ParticipantPreviewNotificationStatus;
    requestedAt: string;
    sentAt: string | null;
    failureCode: string | null;
  } | null;
}

export function participantPreviewReminderStatusLabel(
  status: ParticipantPreviewReminderScheduleStatus,
): string {
  switch (status) {
    case 'scheduled': return 'Scheduled';
    case 'triggered': return 'Triggered';
    case 'skipped': return 'Skipped';
    case 'cancelled': return 'Cancelled';
  }
}
