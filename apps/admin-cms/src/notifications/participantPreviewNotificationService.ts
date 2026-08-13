import {
  buildParticipantPreviewEmailSubject,
  buildParticipantPreviewMessageId,
  ParticipantPreviewEmailRenderError,
  renderParticipantPreviewEmailHtml,
  renderParticipantPreviewEmailText,
} from './participantPreviewEmailMessage';
import type { ParticipantPreviewEmailTransport } from './participantPreviewEmailTransport';
import {
  participantPreviewNotificationMessage,
  type ParticipantPreviewNotificationResultCode,
} from './participantPreviewNotification';

/**
 * Deterministic orchestration of the one externally observable step in this feature.
 *
 * The shape of this module is dictated by a single fact: PostgreSQL and SMTP cannot share a
 * transaction. Everything therefore happens in a fixed order — durably record that transport is
 * about to be entered, cross the boundary exactly once, then durably record a bounded outcome — and
 * every branch is written so that an interruption leaves a truthful state behind rather than an
 * optimistic one.
 *
 * Two invariants are load-bearing and are asserted directly by the unit tests:
 *
 *   1. `transport.send` is called at most once per invocation, and not at all on any path where the
 *      lifecycle was not exclusively claimed by this execution.
 *   2. No branch ever converts a post-transport ambiguity into either "sent" or "not sent". Once the
 *      boundary has been crossed, the only outcomes available are `sent` (reliably confirmed),
 *      `failed` (reliably refused), and `delivery_unknown`.
 *
 * There is deliberately no retry anywhere in this file. The raw preview credential exists only for
 * the lifetime of the request that generated it, so a later attempt could not reconstruct the same
 * secure link even if the workflow wanted to.
 */

export interface NotificationTransitionOutcome {
  resultCode: string;
  status?: string | null;
}

/** Durable lifecycle transitions. Each mutating call carries this execution's ownership token. */
export interface ParticipantPreviewNotificationGateway {
  beginTransport(
    notificationId: string,
    executionToken: string,
  ): Promise<NotificationTransitionOutcome>;
  finalize(
    notificationId: string,
    executionToken: string,
    outcome: 'sent' | 'failed' | 'delivery_unknown',
    transportReference: string | null,
    failureCode: string | null,
  ): Promise<NotificationTransitionOutcome>;
}

export interface ParticipantPreviewNotificationExecutionInput {
  notificationId: string;
  /** Server-generated ownership credential. Never persisted raw, never returned to a browser. */
  executionToken: string;
  recipient: string;
  projectTitle: string;
  /**
   * The freshly generated secure preview URL. It exists only in this process's memory and in the
   * outgoing message; it is never persisted, logged or returned from this module.
   */
  previewUrl: string;
  expiresAt: string;
  fromAddress: string;
}

export interface ParticipantPreviewNotificationExecutionContext {
  notifications: ParticipantPreviewNotificationGateway;
  transport: ParticipantPreviewEmailTransport;
}

export interface ParticipantPreviewNotificationExecutionResult {
  code: ParticipantPreviewNotificationResultCode;
  message: string;
  failureCode: string | null;
}

function outcome(
  code: ParticipantPreviewNotificationResultCode,
  failureCode: string | null = null,
): ParticipantPreviewNotificationExecutionResult {
  return { code, message: participantPreviewNotificationMessage(code), failureCode };
}

/** A lifecycle this execution no longer exclusively owns. Never a reason to send anything. */
function lostExecutionOwnership(resultCode: string): boolean {
  return (
    resultCode === 'EXECUTION_TOKEN_MISMATCH' ||
    resultCode === 'EXECUTION_LEASE_EXPIRED' ||
    resultCode === 'INVALID_STATE' ||
    resultCode === 'ALREADY_FINALIZED'
  );
}

export async function executeParticipantPreviewNotification(
  context: ParticipantPreviewNotificationExecutionContext,
  input: ParticipantPreviewNotificationExecutionInput,
): Promise<ParticipantPreviewNotificationExecutionResult> {
  /**
   * Best-effort settlement used only on pre-transport failure paths. A failure to record the
   * failure is not itself escalated: the row remains `reserved` with a lease that will lapse, and
   * observer reconciliation settles it to failed/TRANSPORT_NOT_STARTED — the same truth, later.
   */
  const settleWithoutTransport = async (
    failureCode: string,
    code: ParticipantPreviewNotificationResultCode,
  ): Promise<ParticipantPreviewNotificationExecutionResult> => {
    try {
      await context.notifications.finalize(
        input.notificationId,
        input.executionToken,
        'failed',
        null,
        failureCode,
      );
    } catch {
      // Deliberately swallowed: see above. Nothing was sent either way.
    }
    return outcome(code, failureCode);
  };

  // Rendering happens before the boundary so a malformed project value can never produce a
  // half-composed message, and so the failure costs nothing externally.
  let subject: string;
  let text: string;
  let html: string;
  let messageId: string;
  try {
    subject = buildParticipantPreviewEmailSubject(input.projectTitle);
    text = renderParticipantPreviewEmailText(input);
    html = renderParticipantPreviewEmailHtml(input);
    messageId = buildParticipantPreviewMessageId(input.notificationId, input.fromAddress);
  } catch (error: unknown) {
    const failureCode =
      error instanceof ParticipantPreviewEmailRenderError && error.code === 'UNSAFE_PREVIEW_URL'
        ? 'UNSAFE_PREVIEW_URL'
        : 'MESSAGE_RENDER_FAILED';
    return settleWithoutTransport(failureCode, 'DELIVERY_FAILED');
  }

  // The durable transport-started boundary. It also revalidates that this exact preview is still
  // eligible, so a preview revoked, expired, superseded or confirmed since reservation sends
  // nothing at all.
  let authorization: NotificationTransitionOutcome;
  try {
    authorization = await context.notifications.beginTransport(
      input.notificationId,
      input.executionToken,
    );
  } catch {
    // The call may or may not have committed. Either way this execution never reached the
    // transport, so recording a truthful pre-transport failure is safe.
    return settleWithoutTransport('TRANSPORT_NOT_AUTHORIZED', 'NOTIFICATION_FAILED');
  }

  if (authorization.resultCode !== 'TRANSPORT_AUTHORIZED') {
    if (lostExecutionOwnership(authorization.resultCode)) {
      // Another execution owns or already settled this lifecycle. Reporting IN_PROGRESS without
      // touching the row is the whole point of the fence: two callers, one send.
      return outcome('IN_PROGRESS');
    }
    if (authorization.resultCode === 'ALREADY_CONFIRMED') {
      return settleWithoutTransport('ALREADY_CONFIRMED', 'ALREADY_CONFIRMED');
    }
    if (authorization.resultCode === 'PREVIEW_NOT_ELIGIBLE') {
      return settleWithoutTransport('PREVIEW_NOT_ELIGIBLE', 'PREVIEW_NOT_ELIGIBLE');
    }
    return settleWithoutTransport('TRANSPORT_NOT_AUTHORIZED', 'NOTIFICATION_FAILED');
  }

  // ---- the external side effect: exactly one invocation, and only from here ----
  let transportResult;
  try {
    transportResult = await context.transport.send({
      recipient: input.recipient,
      subject,
      text,
      html,
      messageId,
    });
  } catch {
    // A transport that throws instead of returning a classified result has told us nothing about
    // whether the message left. Treated as ambiguous, never as a failure.
    transportResult = { outcome: 'unknown' } as const;
  }

  /**
   * Post-transport settlement. If the database cannot be updated at all, the row truthfully remains
   * `transport_started` and observer reconciliation will settle it to `delivery_unknown` — so the
   * reported outcome here matches the state the ledger converges on. Under no circumstance does a
   * finalization problem downgrade a crossed boundary back to "not sent".
   */
  const settleAfterTransport = async (
    kind: 'sent' | 'failed' | 'delivery_unknown',
    transportReference: string | null,
    failureCode: string | null,
    code: ParticipantPreviewNotificationResultCode,
  ): Promise<ParticipantPreviewNotificationExecutionResult> => {
    let finalization: NotificationTransitionOutcome;
    try {
      finalization = await context.notifications.finalize(
        input.notificationId,
        input.executionToken,
        kind,
        transportReference,
        failureCode,
      );
    } catch {
      return outcome('DELIVERY_UNKNOWN');
    }

    if (finalization.resultCode === 'FINALIZED') {
      return outcome(code, failureCode);
    }
    if (finalization.resultCode === 'ALREADY_FINALIZED') {
      // Someone else already settled this row; report what the ledger actually says.
      if (finalization.status === 'sent') return outcome('SENT');
      if (finalization.status === 'failed') return outcome('DELIVERY_FAILED', failureCode);
      return outcome('DELIVERY_UNKNOWN');
    }

    // The outcome could not be recorded. The boundary was crossed, so ambiguity is the only honest
    // answer. A second attempt records that ambiguity durably where it still can.
    try {
      await context.notifications.finalize(
        input.notificationId,
        input.executionToken,
        'delivery_unknown',
        null,
        null,
      );
    } catch {
      // Left to observer reconciliation, which reaches the same delivery_unknown conclusion.
    }
    return outcome('DELIVERY_UNKNOWN');
  };

  if (transportResult.outcome === 'accepted') {
    return settleAfterTransport('sent', transportResult.transportReference ?? null, null, 'SENT');
  }
  if (transportResult.outcome === 'rejected') {
    return settleAfterTransport('failed', null, transportResult.failureCode, 'DELIVERY_FAILED');
  }
  return settleAfterTransport('delivery_unknown', null, null, 'DELIVERY_UNKNOWN');
}
