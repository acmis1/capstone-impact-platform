/**
 * Bounded domain vocabulary for participant preview email notification.
 *
 * Every value here is safe to show a staff member and safe to put in an HTTP response. Nothing in
 * this module can carry a raw preview credential, an SMTP error string, a provider response body or
 * an execution ownership token.
 */

/** Durable ledger states, mirroring `check_participant_preview_notification_state` in Migration 0023. */
export type ParticipantPreviewNotificationStatus =
  | 'reserved'
  | 'transport_started'
  | 'sent'
  | 'failed'
  | 'delivery_unknown';

export type ParticipantPreviewNotificationKind = 'initial';

export type ParticipantPreviewNotificationResultCode =
  /** The transport reliably accepted the message and that outcome was persisted. */
  | 'SENT'
  /**
   * The message may or may not have gone out. Reported truthfully rather than guessed, and never
   * retried automatically — the one-time preview credential no longer exists to retry with.
   */
  | 'DELIVERY_UNKNOWN'
  /** Reliable evidence the message was not accepted, or that transport never began. */
  | 'DELIVERY_FAILED'
  /** Email delivery is not enabled on this server. Nothing was generated and nothing was sent. */
  | 'EMAIL_DELIVERY_DISABLED'
  /** The project has no authoritative participant/group contact address. */
  | 'PARTICIPANT_EMAIL_MISSING'
  /** The stored authoritative contact address is not a usable single address. */
  | 'PARTICIPANT_EMAIL_INVALID'
  /** Another execution already owns this notification lifecycle. Nothing was sent by this caller. */
  | 'IN_PROGRESS'
  /** This exact preview has already had its initial notification delivered. */
  | 'ALREADY_SENT'
  /** The participant already confirmed this exact preview, so no initial notification is due. */
  | 'ALREADY_CONFIRMED'
  /** The exact preview was revoked, expired or superseded before transport could begin. */
  | 'PREVIEW_NOT_ELIGIBLE'
  /** A bounded catch-all. No raw backend detail ever reaches the caller. */
  | 'NOTIFICATION_FAILED';

const MESSAGES: Record<ParticipantPreviewNotificationResultCode, string> = {
  SENT: 'The preview link was emailed to the project contact.',
  DELIVERY_UNKNOWN:
    'Delivery status is unknown. The message may or may not have been sent, so it has not been sent again automatically.',
  DELIVERY_FAILED: 'The preview email could not be delivered.',
  EMAIL_DELIVERY_DISABLED:
    'Email delivery is not enabled on this server, so no preview was generated and no email was sent.',
  PARTICIPANT_EMAIL_MISSING:
    'This project has no participant contact email, so the preview link cannot be emailed.',
  PARTICIPANT_EMAIL_INVALID:
    'The participant contact email recorded for this project is not a valid address.',
  IN_PROGRESS: 'A preview email for this project is already being sent.',
  ALREADY_SENT: 'This preview link has already been emailed to the project contact.',
  ALREADY_CONFIRMED:
    'The participant has already confirmed this preview, so no further preview email is due.',
  PREVIEW_NOT_ELIGIBLE:
    'This preview is no longer eligible for a participant email, so nothing was sent.',
  NOTIFICATION_FAILED: 'The preview email could not be requested.',
};

export function participantPreviewNotificationMessage(
  code: ParticipantPreviewNotificationResultCode,
): string {
  return MESSAGES[code];
}

/**
 * The staff-facing projection of a delivery ledger row. Explicitly excludes the execution ownership
 * token hash, the lease, the preview credential, the secure URL and every provider secret — those
 * are either non-existent by design or confined to the database.
 */
export interface ParticipantPreviewNotificationView {
  kind: ParticipantPreviewNotificationKind;
  recipient: string;
  status: ParticipantPreviewNotificationStatus;
  requestedAt: string;
  sentAt: string | null;
  failureCode: string | null;
}

/** Staff-facing wording for a ledger state. Colour is never the only signal in the UI. */
export function participantPreviewNotificationStatusLabel(
  status: ParticipantPreviewNotificationStatus,
): string {
  switch (status) {
    case 'sent':
      return 'Sent';
    case 'reserved':
    case 'transport_started':
      return 'Sending';
    case 'failed':
      return 'Delivery failed';
    case 'delivery_unknown':
      return 'Delivery status unknown';
  }
}
