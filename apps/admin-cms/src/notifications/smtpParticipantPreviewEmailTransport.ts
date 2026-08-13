import nodemailer, { type Transporter } from 'nodemailer';
import type { ParticipantPreviewEmailSmtpConfig } from './participantPreviewEmailConfig';
import type {
  ParticipantPreviewEmailMessage,
  ParticipantPreviewEmailTransport,
  ParticipantPreviewEmailTransportResult,
} from './participantPreviewEmailTransport';

/**
 * SMTP implementation of the participant preview email boundary.
 *
 * nodemailer is used rather than a hand-rolled SMTP client: correct SMTP is a security-sensitive
 * protocol (TLS negotiation, authentication, header encoding, dot-stuffing) and the mature,
 * widely-audited implementation is the smaller risk by a wide margin. It is confined to this one
 * file so that adopting an HTTP provider API later replaces a single class.
 *
 * The three transport outcomes are deliberately asymmetric:
 *
 *   accepted — the server acknowledged the message and named it in `accepted`.
 *   rejected — the server gave a reliable permanent refusal, classified into a bounded code.
 *   unknown  — anything else. A timeout, a socket dropped after DATA, or a response this code
 *              cannot confidently classify all land here, because the message may in fact have gone
 *              out. Calling that a failure would let the workflow claim something false, and would
 *              invite a resend that could duplicate real mail.
 *
 * No provider response body, SMTP conversation transcript or credential is returned, thrown onward,
 * or logged from here.
 */

/** SMTP permanent-failure classes that identify the recipient specifically. */
const RECIPIENT_REJECTION_CODES = new Set(['EENVELOPE', 'ERECIPIENTS', 'EADDRESS']);
/** Connection-level classes: the conversation never got far enough to hand over a message. */
const TRANSPORT_UNAVAILABLE_CODES = new Set([
  'ECONNECTION',
  'ECONNREFUSED',
  'EDNS',
  'EAUTH',
  'ETLS',
  'ESOCKET',
  'EHOSTUNREACH',
  'ENOTFOUND',
]);
/** Classes that leave acceptance genuinely undecided. */
const AMBIGUOUS_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'EPIPE']);

function classify(error: unknown): ParticipantPreviewEmailTransportResult {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code ?? '').toUpperCase()
      : '';
  const responseCode =
    typeof error === 'object' && error !== null && 'responseCode' in error
      ? Number((error as { responseCode?: unknown }).responseCode)
      : Number.NaN;

  if (AMBIGUOUS_CODES.has(code)) {
    return { outcome: 'unknown' };
  }
  if (RECIPIENT_REJECTION_CODES.has(code)) {
    return { outcome: 'rejected', failureCode: 'RECIPIENT_REJECTED' };
  }
  if (TRANSPORT_UNAVAILABLE_CODES.has(code)) {
    return { outcome: 'rejected', failureCode: 'TRANSPORT_UNAVAILABLE' };
  }
  // A 5xx reply is a reliable permanent refusal of this specific message. A 4xx is a temporary
  // condition whose eventual outcome this request cannot observe, so it stays undecided.
  if (Number.isFinite(responseCode) && responseCode >= 500 && responseCode < 600) {
    return { outcome: 'rejected', failureCode: 'MESSAGE_REJECTED' };
  }
  if (Number.isFinite(responseCode) && responseCode >= 400 && responseCode < 500) {
    return { outcome: 'unknown' };
  }
  return { outcome: 'unknown' };
}

/** Only a short, printable-ASCII reference is ever surfaced; anything else is dropped. */
function boundedReference(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 200 || !/^[!-~]+$/.test(trimmed)) return undefined;
  return trimmed;
}

export class SmtpParticipantPreviewEmailTransport implements ParticipantPreviewEmailTransport {
  private readonly transporter: Transporter;

  constructor(
    private readonly config: ParticipantPreviewEmailSmtpConfig,
    transporter?: Transporter,
  ) {
    this.transporter =
      transporter ??
      nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: config.auth ? { user: config.auth.user, pass: config.auth.password } : undefined,
        // Bounded so a hung server cannot hold a staff request open indefinitely. A timeout
        // classifies as `unknown`, never as a failure.
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
      });
  }

  async send(
    message: ParticipantPreviewEmailMessage,
  ): Promise<ParticipantPreviewEmailTransportResult> {
    try {
      const info = await this.transporter.sendMail({
        from: this.config.from,
        to: message.recipient,
        subject: message.subject,
        text: message.text,
        html: message.html,
        messageId: message.messageId,
      });

      const accepted = Array.isArray(info?.accepted) ? info.accepted : [];
      const rejected = Array.isArray(info?.rejected) ? info.rejected : [];

      if (rejected.length > 0 && accepted.length === 0) {
        return { outcome: 'rejected', failureCode: 'RECIPIENT_REJECTED' };
      }
      if (accepted.length === 0) {
        // The call resolved without an error but without naming an accepted recipient either.
        // Acceptance cannot be asserted from that.
        return { outcome: 'unknown' };
      }

      return {
        outcome: 'accepted',
        transportReference: boundedReference(info?.messageId) ?? boundedReference(message.messageId),
      };
    } catch (error: unknown) {
      return classify(error);
    }
  }
}
