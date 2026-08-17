import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ParticipantPreviewReminderScheduleStatus,
  ParticipantPreviewReminderSkipReason,
  ParticipantPreviewReminderView,
} from '../reminders/participantPreviewReminder';
import type { ParticipantPreviewNotificationStatus } from '../notifications/participantPreviewNotification';
import { SupabaseParticipantPreviewNotificationRepositoryCore } from './SupabaseParticipantPreviewNotificationRepositoryCore';
import { normalizeParticipantPreviewTimestamp } from './participantPreviewTimestamp';

const SCHEDULE_STATUSES = new Set(['scheduled', 'triggered', 'skipped', 'cancelled']);
const SKIP_REASONS = new Set([
  'INITIAL_DELIVERY_NOT_CONFIRMED', 'PREVIEW_CONFIRMED', 'CORRECTION_PENDING',
  'PREVIEW_REVOKED', 'PREVIEW_EXPIRED', 'PREVIEW_SUPERSEDED',
  'PROJECT_NOT_ELIGIBLE', 'CONTACT_CHANGED',
]);
const NOTIFICATION_STATUSES = new Set([
  'reserved', 'transport_started', 'sent', 'failed', 'delivery_unknown',
]);

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export class ParticipantPreviewReminderRepositoryError extends Error {
  constructor(readonly code: 'INPUT_INVALID' | 'RESPONSE_INVALID' | 'INTERNAL_FAILURE') {
    super(code);
    this.name = 'ParticipantPreviewReminderRepositoryError';
  }
}

function requireTimestamp(value: unknown): string {
  const timestamp = normalizeParticipantPreviewTimestamp(value);
  if (!timestamp) throw new ParticipantPreviewReminderRepositoryError('RESPONSE_INVALID');
  return timestamp;
}

function optionalTimestamp(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return requireTimestamp(value);
}

export interface ReminderScheduleMutationResult {
  resultCode: string;
  reference?: string;
  scheduledFor?: string;
  recipient?: string;
  status?: string;
  createdAt?: string;
  cancelledAt?: string;
}

export interface ClaimedParticipantPreviewReminder {
  notificationId: string;
  executionToken: string;
  recipient: string;
  projectTitle: string;
  expiresAt: string;
}

export interface ClaimDueParticipantPreviewRemindersResult {
  claimedCount: number;
  skippedCount: number;
  items: ClaimedParticipantPreviewReminder[];
}

export class SupabaseParticipantPreviewReminderRepositoryCore
  extends SupabaseParticipantPreviewNotificationRepositoryCore {
  constructor(supabase: SupabaseClient) {
    super(supabase);
  }

  async schedule(params: {
    publicId: string;
    adminId: string;
    scheduledFor: string;
  }): Promise<ReminderScheduleMutationResult> {
    const scheduledFor = normalizeParticipantPreviewTimestamp(params.scheduledFor);
    if (!nonEmpty(params.publicId) || !nonEmpty(params.adminId) || !scheduledFor) {
      throw new ParticipantPreviewReminderRepositoryError('INPUT_INVALID');
    }
    const { data, error } = await this.supabase.rpc('schedule_participant_preview_reminder', {
      p_public_id: params.publicId,
      p_admin_id: params.adminId,
      p_scheduled_for: scheduledFor,
    });
    if (error || !data || typeof data !== 'object') {
      throw new ParticipantPreviewReminderRepositoryError('INTERNAL_FAILURE');
    }
    return this.parseMutation(data);
  }

  async cancel(params: {
    publicId: string;
    adminId: string;
    reference: string;
  }): Promise<ReminderScheduleMutationResult> {
    if (!nonEmpty(params.publicId) || !nonEmpty(params.adminId) || !nonEmpty(params.reference)) {
      throw new ParticipantPreviewReminderRepositoryError('INPUT_INVALID');
    }
    const { data, error } = await this.supabase.rpc('cancel_participant_preview_reminder', {
      p_public_id: params.publicId,
      p_admin_id: params.adminId,
      p_reference: params.reference,
    });
    if (error || !data || typeof data !== 'object') {
      throw new ParticipantPreviewReminderRepositoryError('INTERNAL_FAILURE');
    }
    return this.parseMutation(data);
  }

  private parseMutation(data: object): ReminderScheduleMutationResult {
    const row = data as Record<string, unknown>;
    if (!nonEmpty(row.resultCode)) {
      throw new ParticipantPreviewReminderRepositoryError('RESPONSE_INVALID');
    }
    return {
      resultCode: row.resultCode,
      reference: nonEmpty(row.reference) ? row.reference : undefined,
      scheduledFor: optionalTimestamp(row.scheduledFor),
      recipient: nonEmpty(row.recipient) ? row.recipient : undefined,
      status: nonEmpty(row.status) ? row.status : undefined,
      createdAt: optionalTimestamp(row.createdAt),
      cancelledAt: optionalTimestamp(row.cancelledAt),
    };
  }

  async claimDue(batchLimit: number): Promise<ClaimDueParticipantPreviewRemindersResult> {
    if (!Number.isInteger(batchLimit) || batchLimit < 1 || batchLimit > 50) {
      throw new ParticipantPreviewReminderRepositoryError('INPUT_INVALID');
    }
    const { data, error } = await this.supabase.rpc('claim_due_participant_preview_reminders', {
      p_batch_limit: batchLimit,
    });
    if (error || !data || typeof data !== 'object') {
      throw new ParticipantPreviewReminderRepositoryError('INTERNAL_FAILURE');
    }
    const result = data as Record<string, unknown>;
    if (
      result.resultCode !== 'CLAIMED' || !Number.isInteger(result.claimedCount) ||
      !Number.isInteger(result.skippedCount) || !Array.isArray(result.items)
    ) {
      throw new ParticipantPreviewReminderRepositoryError('RESPONSE_INVALID');
    }
    const items = result.items.map((item) => {
      const row = item as Record<string, unknown>;
      const expiresAt = normalizeParticipantPreviewTimestamp(row.expiresAt);
      if (
        !nonEmpty(row.notificationId) || !nonEmpty(row.executionToken) ||
        !nonEmpty(row.recipient) || typeof row.projectTitle !== 'string' || !expiresAt
      ) {
        throw new ParticipantPreviewReminderRepositoryError('RESPONSE_INVALID');
      }
      return {
        notificationId: row.notificationId,
        executionToken: row.executionToken,
        recipient: row.recipient,
        projectTitle: row.projectTitle,
        expiresAt,
      };
    });
    if (items.length !== result.claimedCount) {
      throw new ParticipantPreviewReminderRepositoryError('RESPONSE_INVALID');
    }
    return {
      claimedCount: result.claimedCount as number,
      skippedCount: result.skippedCount as number,
      items,
    };
  }

  async getStaleReminderNotificationIds(batchLimit: number): Promise<string[]> {
    if (!Number.isInteger(batchLimit) || batchLimit < 1 || batchLimit > 50) {
      throw new ParticipantPreviewReminderRepositoryError('INPUT_INVALID');
    }
    const { data, error } = await this.supabase
      .from('participant_preview_notifications')
      .select('id')
      .eq('notification_kind', 'reminder')
      .in('status', ['reserved', 'transport_started'])
      .lte('lease_expires_at', new Date().toISOString())
      .order('lease_expires_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(batchLimit);
    if (error || !Array.isArray(data)) {
      throw new ParticipantPreviewReminderRepositoryError('INTERNAL_FAILURE');
    }
    const ids = data.map((row) => row.id);
    if (!ids.every(nonEmpty)) {
      throw new ParticipantPreviewReminderRepositoryError('RESPONSE_INVALID');
    }
    return ids;
  }

  async getReminderHistoryForProject(
    projectId: string,
    currentPreviewId: string | null,
  ): Promise<ParticipantPreviewReminderView[]> {
    if (!nonEmpty(projectId)) return [];
    const { data, error } = await this.supabase
      .from('participant_preview_reminder_schedules')
      .select(
        'id,staff_reference,participant_preview_id,recipient_email_snapshot,scheduled_for,scheduled_by_admin_id,status,skip_reason,triggered_at,cancelled_at,created_at',
      )
      .eq('project_id', projectId)
      .order('scheduled_for', { ascending: false })
      .order('id', { ascending: false });
    if (error || !Array.isArray(data)) {
      throw new ParticipantPreviewReminderRepositoryError('INTERNAL_FAILURE');
    }
    if (data.length === 0) return [];

    const internalScheduleIds = data.map((row) => row.id).filter(nonEmpty);
    const previewIds = [...new Set(data.map((row) => row.participant_preview_id).filter(nonEmpty))];
    const actorIds = [...new Set(data.map((row) => row.scheduled_by_admin_id).filter(nonEmpty))];

    const loadNotifications = () => this.supabase
      .from('participant_preview_notifications')
      .select('id,reminder_schedule_id,status,requested_at,sent_at,failure_code,lease_expires_at')
      .in('reminder_schedule_id', internalScheduleIds);

    const [previewResponse, initialNotificationResponse, actorResponse] = await Promise.all([
      this.supabase.from('participant_previews').select('id,created_at,expires_at').in('id', previewIds),
      loadNotifications(),
      actorIds.length > 0
        ? this.supabase.from('admin_users').select('id,full_name').in('id', actorIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (previewResponse.error || initialNotificationResponse.error || actorResponse.error) {
      throw new ParticipantPreviewReminderRepositoryError('INTERNAL_FAILURE');
    }

    let notificationRows = initialNotificationResponse.data ?? [];
    const staleIds = notificationRows
      .filter((row) => {
        if (!['reserved', 'transport_started'].includes(row.status)) return false;
        return Date.parse(requireTimestamp(row.lease_expires_at)) <= Date.now();
      })
      .map((row) => row.id)
      .filter(nonEmpty);
    if (staleIds.length > 0) {
      await Promise.all(staleIds.map((notificationId) => this.reconcile(notificationId)));
      const refreshed = await loadNotifications();
      if (refreshed.error) {
        throw new ParticipantPreviewReminderRepositoryError('INTERNAL_FAILURE');
      }
      notificationRows = refreshed.data ?? [];
    }

    const previews = new Map(
      (previewResponse.data ?? []).map((row) => [row.id, row] as const),
    );
    const notifications = new Map(
      notificationRows.map((row) => [row.reminder_schedule_id, row] as const),
    );
    const actors = new Map(
      (actorResponse.data ?? []).map((row) => [row.id, row.full_name] as const),
    );

    return data.map((raw) => {
      const row = raw as Record<string, unknown>;
      const preview = previews.get(String(row.participant_preview_id));
      const notification = notifications.get(String(row.id));
      const previewCreatedAt = preview
        ? normalizeParticipantPreviewTimestamp(preview.created_at)
        : null;
      const previewExpiresAt = preview
        ? normalizeParticipantPreviewTimestamp(preview.expires_at)
        : null;
      const scheduledFor = normalizeParticipantPreviewTimestamp(row.scheduled_for);
      const triggeredAt = row.triggered_at === null
        ? null
        : normalizeParticipantPreviewTimestamp(row.triggered_at);
      const cancelledAt = row.cancelled_at === null
        ? null
        : normalizeParticipantPreviewTimestamp(row.cancelled_at);
      const deliveryRequestedAt = notification
        ? normalizeParticipantPreviewTimestamp(notification.requested_at)
        : null;
      const deliverySentAt = notification?.sent_at === null || notification?.sent_at === undefined
        ? null
        : normalizeParticipantPreviewTimestamp(notification.sent_at);
      if (
        !nonEmpty(row.staff_reference) || !nonEmpty(row.participant_preview_id) ||
        !nonEmpty(row.recipient_email_snapshot) || !scheduledFor ||
        !nonEmpty(row.status) || !SCHEDULE_STATUSES.has(row.status) ||
        !preview || !previewCreatedAt || !previewExpiresAt ||
        (row.triggered_at !== null && !triggeredAt) ||
        (row.cancelled_at !== null && !cancelledAt) ||
        (row.skip_reason !== null && (!nonEmpty(row.skip_reason) || !SKIP_REASONS.has(row.skip_reason)))
      ) {
        throw new ParticipantPreviewReminderRepositoryError('RESPONSE_INVALID');
      }
      if (
        notification &&
        (!nonEmpty(notification.status) || !NOTIFICATION_STATUSES.has(notification.status) ||
          !deliveryRequestedAt ||
          (notification.sent_at !== null && !deliverySentAt))
      ) {
        throw new ParticipantPreviewReminderRepositoryError('RESPONSE_INVALID');
      }
      const actorName = nonEmpty(row.scheduled_by_admin_id)
        ? actors.get(row.scheduled_by_admin_id)?.trim()
        : null;
      return {
        reference: row.staff_reference,
        previewCreatedAt,
        previewExpiresAt,
        currentPreview: row.participant_preview_id === currentPreviewId,
        recipient: row.recipient_email_snapshot,
        scheduledFor,
        scheduledBy: actorName || 'Unknown staff member',
        status: row.status as ParticipantPreviewReminderScheduleStatus,
        skipReason: (row.skip_reason as ParticipantPreviewReminderSkipReason | null) ?? null,
        triggeredAt,
        cancelledAt,
        delivery: notification ? {
          status: notification.status as ParticipantPreviewNotificationStatus,
          requestedAt: deliveryRequestedAt!,
          sentAt: deliverySentAt,
          failureCode: nonEmpty(notification.failure_code) ? notification.failure_code : null,
        } : null,
      };
    });
  }
}
