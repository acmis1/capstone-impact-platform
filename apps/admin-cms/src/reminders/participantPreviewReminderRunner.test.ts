import { describe, expect, it, vi } from 'vitest';
import type { ParticipantPreviewEmailTransport } from '../notifications/participantPreviewEmailTransport';
import type { NotificationTransitionOutcome } from '../notifications/participantPreviewNotificationService';
import type { ParticipantPreviewReminderRunnerGateway } from './participantPreviewReminderRunner';
import { runParticipantPreviewReminders } from './participantPreviewReminderRunner';

const ITEM = {
  notificationId: 'notification-1',
  executionToken: 'execution-1',
  recipient: 'participant@capstone.invalid',
  projectTitle: 'Reminder project',
  expiresAt: '2026-08-20T04:30:00.000Z',
};

const ITEM_B = {
  ...ITEM,
  notificationId: 'notification-2',
  executionToken: 'execution-2',
};

const ITEM_C = {
  ...ITEM,
  notificationId: 'notification-3',
  executionToken: 'execution-3',
};

function gateway(overrides: Partial<ParticipantPreviewReminderRunnerGateway> = {}) {
  return {
    claimDue: vi.fn()
      .mockResolvedValueOnce({ claimedCount: 1, skippedCount: 0, items: [ITEM] })
      .mockResolvedValue({ claimedCount: 0, skippedCount: 0, items: [] }),
    getStaleReminderNotificationIds: vi.fn().mockResolvedValue([]),
    reconcile: vi.fn().mockResolvedValue({ resultCode: 'NO_CHANGE', status: 'sent' }),
    beginTransport: vi.fn().mockResolvedValue({ resultCode: 'TRANSPORT_AUTHORIZED' }),
    finalize: vi.fn().mockResolvedValue({ resultCode: 'FINALIZED' }),
    ...overrides,
  } satisfies ParticipantPreviewReminderRunnerGateway;
}

function transport(outcome: 'accepted' | 'rejected' | 'unknown' = 'accepted') {
  return {
    send: vi.fn().mockResolvedValue(
      outcome === 'accepted'
        ? { outcome: 'accepted', transportReference: 'mail-reference' }
        : outcome === 'rejected'
          ? { outcome: 'rejected', failureCode: 'MESSAGE_REJECTED' }
          : { outcome: 'unknown' },
    ),
  } as ParticipantPreviewEmailTransport & { send: ReturnType<typeof vi.fn> };
}

describe('participant preview reminder runner', () => {
  it('does not inspect or claim work while disabled', async () => {
    const notifications = gateway();
    const mail = transport();
    const result = await runParticipantPreviewReminders({
      enabled: false, notifications, transport: mail, fromAddress: 'no-reply@capstone.invalid',
    });
    expect(result.code).toBe('DISABLED');
    expect(notifications.claimDue).not.toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('reconciles stale executions, claims a bounded batch, and sends one reminder', async () => {
    const notifications = gateway({
      getStaleReminderNotificationIds: vi.fn().mockResolvedValue(['stale-1']),
      reconcile: vi.fn().mockResolvedValue({ resultCode: 'RECONCILED', status: 'failed' }),
    });
    const mail = transport();
    const result = await runParticipantPreviewReminders({
      enabled: true, notifications, transport: mail, fromAddress: 'no-reply@capstone.invalid',
    });
    expect(notifications.claimDue).toHaveBeenCalledWith(1);
    expect(result).toMatchObject({ code: 'COMPLETED', claimed: 1, sent: 1, reconciled: 1 });
    expect(mail.send).toHaveBeenCalledTimes(1);
    expect(mail.send.mock.calls[0][0].text).not.toContain('/participant-preview/');
    expect(mail.send.mock.calls[0][0].html).not.toContain('<a ');
  });

  it.each([
    ['rejected', { failed: 1, deliveryUnknown: 0 }],
    ['unknown', { failed: 0, deliveryUnknown: 1 }],
  ] as const)('records %s transport without retry', async (outcome, expected) => {
    const notifications = gateway();
    const mail = transport(outcome);
    const first = await runParticipantPreviewReminders({
      enabled: true, notifications, transport: mail, fromAddress: 'no-reply@capstone.invalid',
    });
    expect(first).toMatchObject(expected);
    expect(mail.send).toHaveBeenCalledTimes(1);
    await runParticipantPreviewReminders({
      enabled: true, notifications, transport: mail, fromAddress: 'no-reply@capstone.invalid',
    });
    expect(mail.send).toHaveBeenCalledTimes(1);
  });

  it('records a due-time eligibility loss and never calls transport', async () => {
    const notifications = gateway({
      beginTransport: vi.fn().mockResolvedValue({
        resultCode: 'REMINDER_SKIPPED', skipReason: 'CONTACT_CHANGED',
      }),
    });
    const mail = transport();
    const result = await runParticipantPreviewReminders({
      enabled: true, notifications, transport: mail, fromAddress: 'no-reply@capstone.invalid',
    });
    expect(result.suppressedBeforeTransport).toBe(1);
    expect(mail.send).not.toHaveBeenCalled();
    expect(notifications.finalize).toHaveBeenCalledWith(
      ITEM.notificationId, ITEM.executionToken, 'failed', null, 'CONTACT_CHANGED',
    );
  });

  it('deterministically fences a concurrent runner after the first atomic claim', async () => {
    let claimed = false;
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const notifications = gateway({
      claimDue: vi.fn(async () => {
        if (claimed) return { claimedCount: 0, skippedCount: 0, items: [] };
        claimed = true;
        return { claimedCount: 1, skippedCount: 0, items: [ITEM] };
      }),
      beginTransport: vi.fn(async (): Promise<NotificationTransitionOutcome> => {
        entered();
        await releasePromise;
        return { resultCode: 'TRANSPORT_AUTHORIZED' };
      }),
    });
    const mail = transport();
    const first = runParticipantPreviewReminders({
      enabled: true, notifications, transport: mail, fromAddress: 'no-reply@capstone.invalid',
    });
    await enteredPromise;
    const second = await runParticipantPreviewReminders({
      enabled: true, notifications, transport: mail, fromAddress: 'no-reply@capstone.invalid',
    });
    expect(second.claimed).toBe(0);
    expect(mail.send).toHaveBeenCalledTimes(0);
    release();
    await first;
    expect(mail.send).toHaveBeenCalledTimes(1);
  });

  it('claims each lease only after the previous reminder finishes and respects the total bound', async () => {
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const firstEnteredPromise = new Promise<void>((resolve) => { firstEntered = resolve; });
    const releaseFirstPromise = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const notifications = gateway({
      claimDue: vi.fn()
        .mockResolvedValueOnce({ claimedCount: 1, skippedCount: 0, items: [ITEM] })
        .mockResolvedValueOnce({ claimedCount: 1, skippedCount: 0, items: [ITEM_B] })
        .mockResolvedValueOnce({ claimedCount: 1, skippedCount: 0, items: [ITEM_C] }),
      beginTransport: vi.fn(async (notificationId: string): Promise<NotificationTransitionOutcome> => {
        if (notificationId === ITEM.notificationId) {
          firstEntered();
          await releaseFirstPromise;
        }
        return { resultCode: 'TRANSPORT_AUTHORIZED' };
      }),
    });
    const mail = transport();
    const run = runParticipantPreviewReminders({
      enabled: true,
      notifications,
      transport: mail,
      fromAddress: 'no-reply@capstone.invalid',
      batchLimit: 2,
    });

    await firstEnteredPromise;
    expect(notifications.claimDue).toHaveBeenCalledTimes(1);
    expect(notifications.claimDue).toHaveBeenLastCalledWith(1);
    expect(notifications.beginTransport).toHaveBeenCalledTimes(1);
    expect(mail.send).not.toHaveBeenCalled();

    releaseFirst();
    const result = await run;
    expect(result).toMatchObject({ code: 'COMPLETED', claimed: 2, sent: 2 });
    expect(notifications.claimDue).toHaveBeenCalledTimes(2);
    expect(notifications.beginTransport).toHaveBeenCalledTimes(2);
    expect(notifications.beginTransport).not.toHaveBeenCalledWith(
      ITEM_C.notificationId,
      ITEM_C.executionToken,
    );
    expect(mail.send).toHaveBeenCalledTimes(2);
  });

  it('counts a skipped claim toward the bound and continues to later due work', async () => {
    const notifications = gateway({
      claimDue: vi.fn()
        .mockResolvedValueOnce({ claimedCount: 0, skippedCount: 1, items: [] })
        .mockResolvedValueOnce({ claimedCount: 1, skippedCount: 0, items: [ITEM_B] })
        .mockResolvedValue({ claimedCount: 0, skippedCount: 0, items: [] }),
    });
    const mail = transport();
    const result = await runParticipantPreviewReminders({
      enabled: true,
      notifications,
      transport: mail,
      fromAddress: 'no-reply@capstone.invalid',
      batchLimit: 3,
    });

    expect(result).toMatchObject({ code: 'COMPLETED', claimed: 1, skipped: 1, sent: 1 });
    expect(notifications.claimDue).toHaveBeenCalledTimes(3);
    expect(notifications.claimDue).toHaveBeenNthCalledWith(1, 1);
    expect(notifications.claimDue).toHaveBeenNthCalledWith(2, 1);
    expect(notifications.claimDue).toHaveBeenNthCalledWith(3, 1);
    expect(mail.send).toHaveBeenCalledTimes(1);
  });
});
