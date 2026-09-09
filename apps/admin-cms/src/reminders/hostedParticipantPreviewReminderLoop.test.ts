import { describe, expect, it, vi } from 'vitest';
import {
  runHostedParticipantPreviewReminderLoop,
  type HostedParticipantPreviewReminderWait,
} from './hostedParticipantPreviewReminderLoop';
import type { ParticipantPreviewReminderRunnerResult } from './participantPreviewReminderRunner';

const COMPLETED: ParticipantPreviewReminderRunnerResult = {
  code: 'COMPLETED',
  claimed: 1,
  skipped: 0,
  sent: 1,
  failed: 0,
  deliveryUnknown: 0,
  suppressedBeforeTransport: 0,
  reconciled: 0,
};

describe('hosted participant preview reminder loop', () => {
  it('polls sequentially at the bounded interval and stops before another pass after shutdown', async () => {
    const controller = new AbortController();
    const runOnce = vi.fn().mockResolvedValue(COMPLETED);
    let waits = 0;
    const wait: HostedParticipantPreviewReminderWait = vi.fn(async (milliseconds, signal) => {
      expect(milliseconds).toBe(7_500);
      expect(signal).toBe(controller.signal);
      waits += 1;
      if (waits === 2) controller.abort();
    });
    const report = vi.fn();

    await runHostedParticipantPreviewReminderLoop({
      signal: controller.signal,
      enabled: true,
      pollIntervalMs: 7_500,
      runOnce,
      wait,
      report,
    });

    expect(runOnce).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledTimes(2);
  });

  it('turns an unexpected pass failure into a bounded failed result and waits before retrying', async () => {
    const controller = new AbortController();
    const runOnce = vi.fn().mockRejectedValue(new Error(
      'private-password recipient@example.invalid https://private.example.invalid/token',
    ));
    const wait: HostedParticipantPreviewReminderWait = vi.fn(async () => controller.abort());
    const report = vi.fn();

    await runHostedParticipantPreviewReminderLoop({
      signal: controller.signal,
      enabled: true,
      pollIntervalMs: 5_000,
      runOnce,
      wait,
      report,
    });

    expect(runOnce).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith({
      code: 'RUNNER_FAILED',
      claimed: 0,
      skipped: 0,
      sent: 0,
      failed: 0,
      deliveryUnknown: 0,
      suppressedBeforeTransport: 0,
      reconciled: 0,
    });
  });

  it('does not call a pass or mutate state while disabled, but remains available for graceful stop', async () => {
    const controller = new AbortController();
    const runOnce = vi.fn();
    const wait: HostedParticipantPreviewReminderWait = vi.fn(async () => controller.abort());
    const report = vi.fn();

    await runHostedParticipantPreviewReminderLoop({
      signal: controller.signal,
      enabled: false,
      pollIntervalMs: 5_000,
      runOnce,
      wait,
      report,
    });

    expect(runOnce).not.toHaveBeenCalled();
    expect(wait).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ code: 'DISABLED', sent: 0 }));
  });

  it('finishes the current pass after shutdown and never waits or claims another pass', async () => {
    const controller = new AbortController();
    const runOnce = vi.fn(async () => {
      controller.abort();
      return COMPLETED;
    });
    const wait = vi.fn();

    await runHostedParticipantPreviewReminderLoop({
      signal: controller.signal,
      enabled: true,
      pollIntervalMs: 5_000,
      runOnce,
      wait,
    });

    expect(runOnce).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });

  it('refuses an invalid interval or missing enabled pass', async () => {
    await expect(runHostedParticipantPreviewReminderLoop({
      signal: new AbortController().signal,
      enabled: true,
      pollIntervalMs: 900_001,
      runOnce: vi.fn(),
    })).rejects.toThrow('polling interval is invalid');

    await expect(runHostedParticipantPreviewReminderLoop({
      signal: new AbortController().signal,
      enabled: true,
      pollIntervalMs: 5_000,
    })).rejects.toThrow('pass is not configured');
  });
});
