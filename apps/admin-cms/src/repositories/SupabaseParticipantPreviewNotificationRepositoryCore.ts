import { SupabaseClient } from '@supabase/supabase-js';
import { ParticipantPreviewExecutionError } from './ParticipantPreviewRepository';
import type {
  ParticipantPreviewNotificationKind,
  ParticipantPreviewNotificationStatus,
  ParticipantPreviewNotificationView,
} from '../notifications/participantPreviewNotification';
import type { NotificationTransitionOutcome } from '../notifications/participantPreviewNotificationService';

/**
 * Service-role access to the participant preview delivery ledger.
 *
 * Every mutation goes through a SECURITY DEFINER RPC from Migration 0023 — the service role holds
 * only SELECT on the table itself, so even this trusted server path cannot insert a row, re-address
 * a delivery, re-attribute an actor or mark something sent by writing to the table directly.
 *
 * Reads use an explicit column projection. `execution_token_hash` and `lease_expires_at` are never
 * selected: they are execution-control internals with no staff-facing meaning, and the surest way to
 * keep them out of a response is to never load them.
 */

/** Explicit projection. Deliberately omits every execution-control and internal-identifier column. */
const NOTIFICATION_VIEW_SELECT =
  'id, notification_kind, recipient_email_snapshot, status, requested_at, sent_at, failure_code, lease_expires_at';

const NOTIFICATION_STATUSES: ReadonlySet<string> = new Set([
  'reserved',
  'transport_started',
  'sent',
  'failed',
  'delivery_unknown',
]);

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['sent', 'failed', 'delivery_unknown']);

export interface GeneratePreviewWithNotificationResult {
  previewId: string;
  publicId: string;
  createdAt: string;
  expiresAt: string;
  /** Server-derived project title used to compose the participant-facing message. */
  projectTitle: string;
  notificationId: string;
  /** Server-generated execution ownership credential. Held in memory only, never surfaced. */
  executionToken: string;
  recipient: string;
  requestedAt: string;
}

/**
 * Domain outcomes of the atomic Generate + Send transaction. `SUCCESS` is the only case that yields
 * an execution token; every other case created nothing at all.
 */
export type GenerateWithNotificationResultCode =
  | 'SUCCESS'
  | 'PARTICIPANT_EMAIL_MISSING'
  | 'PARTICIPANT_EMAIL_INVALID';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export class SupabaseParticipantPreviewNotificationRepositoryCore {
  constructor(protected supabase: SupabaseClient) {}

  /**
   * One transaction: validate the authoritative recipient, create the preview from the supplied
   * hash, and reserve the delivery lifecycle bound to that exact preview. Either all three exist
   * afterwards or none does, so an active preview whose one-time credential has already evaporated
   * can never be left without a delivery lifecycle.
   *
   * Non-participant-email failures are re-thrown as ordinary `ParticipantPreviewExecutionError`s so
   * the route's existing preview error handling applies unchanged to Generate + Send.
   */
  async generatePreviewWithNotification(params: {
    publicId: string;
    adminId: string;
    tokenHash: string;
    privateBucket: string;
    expiresInSeconds?: number;
    isCorrectionReissue?: boolean;
  }): Promise<
    | { resultCode: 'SUCCESS'; value: GeneratePreviewWithNotificationResult }
    | { resultCode: 'PARTICIPANT_EMAIL_MISSING' | 'PARTICIPANT_EMAIL_INVALID' }
  > {
    const { publicId, adminId, tokenHash, privateBucket, expiresInSeconds, isCorrectionReissue } =
      params;

    if (
      !isNonEmptyString(publicId) ||
      !isNonEmptyString(adminId) ||
      !isNonEmptyString(tokenHash) ||
      !isNonEmptyString(privateBucket)
    ) {
      throw new ParticipantPreviewExecutionError('INPUT_INVALID');
    }

    const { data, error } = await this.supabase.rpc(
      'generate_participant_preview_with_notification',
      {
        p_public_id: publicId,
        p_admin_id: adminId,
        p_token_hash: tokenHash,
        p_expires_in_seconds: expiresInSeconds ?? null,
        p_private_bucket: privateBucket,
        p_is_correction_reissue: isCorrectionReissue ?? false,
      },
    );

    if (error) {
      if ((error.message || '').includes('PUBLICATION_IN_PROGRESS')) {
        throw new ParticipantPreviewExecutionError('PUBLICATION_IN_PROGRESS');
      }
      throw new ParticipantPreviewExecutionError('INTERNAL_FAILURE');
    }

    if (!data || typeof data !== 'object') {
      throw new ParticipantPreviewExecutionError('RESPONSE_INVALID');
    }

    const res = data as Record<string, unknown>;

    switch (res.resultCode) {
      case 'SUCCESS':
        break;
      case 'PARTICIPANT_EMAIL_MISSING':
        return { resultCode: 'PARTICIPANT_EMAIL_MISSING' };
      case 'PARTICIPANT_EMAIL_INVALID':
        return { resultCode: 'PARTICIPANT_EMAIL_INVALID' };
      case 'PROJECT_NOT_FOUND':
        throw new ParticipantPreviewExecutionError('PROJECT_NOT_FOUND');
      case 'INVALID_PROJECT_STATE':
        throw new ParticipantPreviewExecutionError('INVALID_PROJECT_STATE');
      case 'PREVIEW_PERMISSION_DENIED':
        throw new ParticipantPreviewExecutionError('PERMISSION_DENIED');
      case 'ACTIVE_PREVIEW_EXISTS':
        throw new ParticipantPreviewExecutionError('ACTIVE_PREVIEW_EXISTS');
      case 'CORRECTION_RESOLUTION_REQUIRED':
        throw new ParticipantPreviewExecutionError('CORRECTION_RESOLUTION_REQUIRED');
      case 'NO_CORRECTION_IN_PROGRESS':
        throw new ParticipantPreviewExecutionError('NO_CORRECTION_IN_PROGRESS');
      case 'AMBIGUOUS_CORRECTION_REQUEST':
        throw new ParticipantPreviewExecutionError('AMBIGUOUS_CORRECTION_REQUEST');
      // The notification generator composes the ordinary preview generator, so it inherits the
      // snapshot-alt gate rather than reimplementing it; this only surfaces the same outcome.
      case 'MEDIA_ACCESSIBILITY_REQUIRED':
        throw new ParticipantPreviewExecutionError('MEDIA_ACCESSIBILITY_REQUIRED');
      default:
        throw new ParticipantPreviewExecutionError('INPUT_INVALID');
    }

    if (
      !isNonEmptyString(res.previewId) ||
      !isNonEmptyString(res.publicId) ||
      !isNonEmptyString(res.createdAt) ||
      !isNonEmptyString(res.expiresAt) ||
      typeof res.projectTitle !== 'string' ||
      !isNonEmptyString(res.notificationId) ||
      !isNonEmptyString(res.executionToken) ||
      !isNonEmptyString(res.recipient) ||
      !isNonEmptyString(res.requestedAt)
    ) {
      throw new ParticipantPreviewExecutionError('RESPONSE_INVALID');
    }

    return {
      resultCode: 'SUCCESS',
      value: {
        previewId: res.previewId,
        publicId: res.publicId,
        createdAt: res.createdAt,
        expiresAt: res.expiresAt,
        projectTitle: res.projectTitle,
        notificationId: res.notificationId,
        executionToken: res.executionToken,
        recipient: res.recipient,
        requestedAt: res.requestedAt,
      },
    };
  }

  /** Durably records that execution is about to cross into SMTP, after rechecking eligibility. */
  async beginTransport(
    notificationId: string,
    executionToken: string,
  ): Promise<NotificationTransitionOutcome> {
    const { data, error } = await this.supabase.rpc(
      'begin_participant_preview_notification_transport',
      { p_notification_id: notificationId, p_execution_token: executionToken },
    );
    if (error || !data || typeof data !== 'object') {
      throw new ParticipantPreviewExecutionError('INTERNAL_FAILURE');
    }
    const res = data as Record<string, unknown>;
    return {
      resultCode: typeof res.resultCode === 'string' ? res.resultCode : 'INTERNAL_FAILURE',
      status: typeof res.status === 'string' ? res.status : null,
      skipReason: typeof res.skipReason === 'string' ? res.skipReason : null,
    };
  }

  async finalize(
    notificationId: string,
    executionToken: string,
    outcome: 'sent' | 'failed' | 'delivery_unknown',
    transportReference: string | null,
    failureCode: string | null,
  ): Promise<NotificationTransitionOutcome> {
    const { data, error } = await this.supabase.rpc(
      'finalize_participant_preview_notification',
      {
        p_notification_id: notificationId,
        p_execution_token: executionToken,
        p_outcome: outcome,
        p_transport_reference: transportReference,
        p_failure_code: failureCode,
      },
    );
    if (error || !data || typeof data !== 'object') {
      throw new ParticipantPreviewExecutionError('INTERNAL_FAILURE');
    }
    const res = data as Record<string, unknown>;
    return {
      resultCode: typeof res.resultCode === 'string' ? res.resultCode : 'INTERNAL_FAILURE',
      status: typeof res.status === 'string' ? res.status : null,
    };
  }

  /**
   * Settles a lifecycle whose owning execution died. Takes no execution token by design — it is the
   * recovery path — and the RPC itself refuses to act while a lease is still live.
   */
  async reconcile(notificationId: string): Promise<NotificationTransitionOutcome> {
    const { data, error } = await this.supabase.rpc(
      'reconcile_participant_preview_notification',
      { p_notification_id: notificationId },
    );
    if (error || !data || typeof data !== 'object') {
      throw new ParticipantPreviewExecutionError('INTERNAL_FAILURE');
    }
    const res = data as Record<string, unknown>;
    return {
      resultCode: typeof res.resultCode === 'string' ? res.resultCode : 'INTERNAL_FAILURE',
      status: typeof res.status === 'string' ? res.status : null,
    };
  }

  /**
   * Staff-facing delivery history for one exact preview.
   *
   * Reconciles first when a non-terminal row's lease has lapsed, so the page never shows a
   * perpetual "Sending" for an execution that died. Reconciliation is idempotent, performs no
   * external side effect, and can only move a row toward the truth — it never resends.
   *
   * Fails closed on a genuine query failure rather than returning null: null is reserved for the one
   * legitimate "no notification was ever requested for this preview" state, mirroring how
   * getConfirmationStatus already distinguishes absence from breakage.
   */
  async getNotificationForPreview(
    participantPreviewId: string,
  ): Promise<ParticipantPreviewNotificationView | null> {
    if (!isNonEmptyString(participantPreviewId)) {
      return null;
    }

    let row = await this.readNotificationRow(participantPreviewId);
    if (!row) return null;

    if (!TERMINAL_STATUSES.has(row.status) && Date.parse(row.leaseExpiresAt) <= Date.now()) {
      await this.reconcile(row.id);
      row = await this.readNotificationRow(participantPreviewId);
      if (!row) {
        throw new ParticipantPreviewExecutionError('RESPONSE_INVALID');
      }
    }

    return {
      kind: row.kind,
      recipient: row.recipient,
      status: row.status,
      requestedAt: row.requestedAt,
      sentAt: row.sentAt,
      failureCode: row.failureCode,
    };
  }

  private async readNotificationRow(participantPreviewId: string): Promise<{
    id: string;
    kind: ParticipantPreviewNotificationKind;
    recipient: string;
    status: ParticipantPreviewNotificationStatus;
    requestedAt: string;
    sentAt: string | null;
    failureCode: string | null;
    leaseExpiresAt: string;
  } | null> {
    const { data, error } = await this.supabase
      .from('participant_preview_notifications')
      .select(NOTIFICATION_VIEW_SELECT)
      .eq('participant_preview_id', participantPreviewId)
      .eq('notification_kind', 'initial')
      .maybeSingle();

    if (error) {
      throw new ParticipantPreviewExecutionError('INTERNAL_FAILURE');
    }
    if (!data) {
      return null;
    }

    const row = data as unknown as Record<string, unknown>;
    if (
      !isNonEmptyString(row.id) ||
      row.notification_kind !== 'initial' ||
      !isNonEmptyString(row.recipient_email_snapshot) ||
      typeof row.status !== 'string' ||
      !NOTIFICATION_STATUSES.has(row.status) ||
      !isNonEmptyString(row.requested_at) ||
      !isNonEmptyString(row.lease_expires_at) ||
      (row.sent_at !== null && !isNonEmptyString(row.sent_at)) ||
      (row.failure_code !== null && !isNonEmptyString(row.failure_code))
    ) {
      throw new ParticipantPreviewExecutionError('RESPONSE_INVALID');
    }

    return {
      id: row.id,
      kind: 'initial',
      recipient: row.recipient_email_snapshot,
      status: row.status as ParticipantPreviewNotificationStatus,
      requestedAt: row.requested_at,
      sentAt: (row.sent_at as string | null) ?? null,
      failureCode: (row.failure_code as string | null) ?? null,
      leaseExpiresAt: row.lease_expires_at,
    };
  }
}
