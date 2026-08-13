/**
 * The narrow boundary between participant preview notification orchestration and whatever actually
 * carries an email. Orchestration depends on this interface only — never on nodemailer, on SMTP
 * details, or on any mailbox-inspection API. The Local email sink's HTTP API belongs exclusively to
 * runtime verification, so swapping in an institutional provider later touches one implementation
 * file and no business logic.
 */

export interface ParticipantPreviewEmailMessage {
  /** Already-normalized authoritative recipient, resolved server-side from project data. */
  recipient: string;
  subject: string;
  text: string;
  html: string;
  /**
   * A bounded, deterministic Message-ID. Useful for diagnostics and for correlating a ledger row
   * with a message; it is emphatically NOT evidence of exactly-once delivery.
   */
  messageId: string;
}

/**
 * Bounded failure classification. Raw provider text never travels with these — a code is all the
 * ledger stores, all the browser sees, and all that is ever logged.
 */
export type ParticipantPreviewEmailFailureCode =
  /** The transport could not be reached, or the connection/handshake failed. */
  | 'TRANSPORT_UNAVAILABLE'
  /** The server explicitly refused the recipient address. */
  | 'RECIPIENT_REJECTED'
  /** The server accepted the session but refused this message. */
  | 'MESSAGE_REJECTED';

export type ParticipantPreviewEmailTransportResult =
  | {
      /** The transport reported a reliable acceptance. */
      outcome: 'accepted';
      /** Bounded, printable-ASCII provider reference; omitted when the provider gives none. */
      transportReference?: string;
    }
  | {
      /** Reliable evidence that the message was not accepted. */
      outcome: 'rejected';
      failureCode: ParticipantPreviewEmailFailureCode;
    }
  | {
      /**
       * The transport neither confirmed nor denied acceptance — a timeout, a dropped connection
       * after DATA, or any response the implementation cannot classify. The message may well have
       * been sent, so this must never be reported as a failure or retried automatically.
       */
      outcome: 'unknown';
    };

export interface ParticipantPreviewEmailTransport {
  send(message: ParticipantPreviewEmailMessage): Promise<ParticipantPreviewEmailTransportResult>;
}
