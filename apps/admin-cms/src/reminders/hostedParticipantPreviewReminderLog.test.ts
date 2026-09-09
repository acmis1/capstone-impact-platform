import { describe, expect, it } from 'vitest';
import { formatHostedParticipantPreviewReminderLog } from './hostedParticipantPreviewReminderLog';

describe('hosted participant preview reminder log safety', () => {
  it('serializes only safe runner state and counters', () => {
    const secret = 'private-password';
    const recipient = 'recipient@example.invalid';
    const privateUrl = 'https://private.example.invalid/token';
    const line = formatHostedParticipantPreviewReminderLog({
      state: 'RESULT',
      result: {
        code: 'COMPLETED',
        claimed: 1,
        skipped: 0,
        sent: 1,
        failed: 0,
        deliveryUnknown: 0,
        suppressedBeforeTransport: 0,
        reconciled: 0,
      },
    });

    expect(line).not.toContain(secret);
    expect(line).not.toContain(recipient);
    expect(line).not.toContain(privateUrl);
    expect(JSON.parse(line)).toEqual({
      schemaVersion: 'participant-preview-reminder-runner/v1',
      event: 'participant_preview_reminder_runner',
      state: 'RESULT',
      code: 'COMPLETED',
      claimed: 1,
      skipped: 0,
      sent: 1,
      failed: 0,
      deliveryUnknown: 0,
      suppressedBeforeTransport: 0,
      reconciled: 0,
    });
  });

  it('uses bounded configuration and failure codes rather than error text', () => {
    const line = formatHostedParticipantPreviewReminderLog({
      state: 'CONFIGURATION_INVALID',
      reason: 'TARGET_IDENTITY_INVALID',
    });
    expect(line).toBe(JSON.stringify({
      schemaVersion: 'participant-preview-reminder-runner/v1',
      event: 'participant_preview_reminder_runner',
      state: 'CONFIGURATION_INVALID',
      reason: 'TARGET_IDENTITY_INVALID',
    }));
  });
});
