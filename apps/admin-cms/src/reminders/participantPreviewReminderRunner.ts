import type { ParticipantPreviewEmailTransport } from '../notifications/participantPreviewEmailTransport';
import {
  executeParticipantPreviewNotification,
  type NotificationTransitionOutcome,
  type ParticipantPreviewNotificationGateway,
} from '../notifications/participantPreviewNotificationService';
import type {
  ClaimDueParticipantPreviewRemindersResult,
} from '../repositories/SupabaseParticipantPreviewReminderRepositoryCore';

export const DEFAULT_PARTICIPANT_PREVIEW_REMINDER_BATCH_LIMIT = 20;

export interface ParticipantPreviewReminderRunnerGateway
  extends ParticipantPreviewNotificationGateway {
  claimDue(batchLimit: number): Promise<ClaimDueParticipantPreviewRemindersResult>;
  getStaleReminderNotificationIds(batchLimit: number): Promise<string[]>;
  reconcile(notificationId: string): Promise<NotificationTransitionOutcome>;
}
export interface ParticipantPreviewReminderRunnerResult {
  code: 'DISABLED' | 'COMPLETED' | 'RUNNER_FAILED';
  claimed: number;
  skipped: number;
  sent: number;
  failed: number;
  deliveryUnknown: number;
  suppressedBeforeTransport: number;
  reconciled: number;
}

function emptyResult(code: ParticipantPreviewReminderRunnerResult['code']) {
  return {
    code,
    claimed: 0,
    skipped: 0,
    sent: 0,
    failed: 0,
    deliveryUnknown: 0,
    suppressedBeforeTransport: 0,
    reconciled: 0,
  } satisfies ParticipantPreviewReminderRunnerResult;
}

export async function runParticipantPreviewReminders(context: {
  enabled: boolean;
  notifications: ParticipantPreviewReminderRunnerGateway;
  transport: ParticipantPreviewEmailTransport;
  fromAddress: string;
  batchLimit?: number;
}): Promise<ParticipantPreviewReminderRunnerResult> {
  if (!context.enabled) return emptyResult('DISABLED');
  const batchLimit = context.batchLimit ?? DEFAULT_PARTICIPANT_PREVIEW_REMINDER_BATCH_LIMIT;
  if (!Number.isInteger(batchLimit) || batchLimit < 1 || batchLimit > 50) {
    return emptyResult('RUNNER_FAILED');
  }

  const summary = emptyResult('COMPLETED');
  try {
    const staleIds = await context.notifications.getStaleReminderNotificationIds(batchLimit);
    for (const notificationId of staleIds) {
      const result = await context.notifications.reconcile(notificationId);
      if (result.resultCode === 'RECONCILED' || result.resultCode === 'NO_CHANGE') {
        summary.reconciled += 1;
      }
    }

    let processed = 0;
    while (processed < batchLimit) {
      // Claim only the reminder that is about to execute. The notification lease begins inside
      // claimDue, so preclaiming a batch would burn later reminders' short leases while they wait
      // behind earlier SMTP work.
      const claimed = await context.notifications.claimDue(1);
      const handled = claimed.claimedCount + claimed.skippedCount;
      if (claimed.claimedCount < 0 || claimed.skippedCount < 0 || handled > 1) {
        throw new Error('Single-item reminder claim exceeded its bound.');
      }
      if (handled === 0) break;

      processed += handled;
      summary.claimed += claimed.claimedCount;
      summary.skipped += claimed.skippedCount;

      const reminder = claimed.items[0];
      if (!reminder) continue;
      const result = await executeParticipantPreviewNotification(
        { notifications: context.notifications, transport: context.transport },
        {
          kind: 'reminder',
          notificationId: reminder.notificationId,
          executionToken: reminder.executionToken,
          recipient: reminder.recipient,
          projectTitle: reminder.projectTitle,
          expiresAt: reminder.expiresAt,
          fromAddress: context.fromAddress,
        },
      );
      if (result.code === 'SENT') summary.sent += 1;
      else if (result.code === 'DELIVERY_UNKNOWN') summary.deliveryUnknown += 1;
      else if (result.code === 'REMINDER_SKIPPED') summary.suppressedBeforeTransport += 1;
      else summary.failed += 1;
    }
    return summary;
  } catch {
    return { ...summary, code: 'RUNNER_FAILED' };
  }
}
