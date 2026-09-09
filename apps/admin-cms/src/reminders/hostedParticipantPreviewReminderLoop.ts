import type { ParticipantPreviewReminderRunnerResult } from './participantPreviewReminderRunner';

export const MAX_HOSTED_PARTICIPANT_PREVIEW_REMINDER_LOOP_INTERVAL_MS = 900_000;

export type HostedParticipantPreviewReminderWait = (
  milliseconds: number,
  signal: AbortSignal,
) => Promise<void>;

export interface HostedParticipantPreviewReminderLoopInput {
  signal: AbortSignal;
  enabled: boolean;
  pollIntervalMs: number;
  runOnce?: () => Promise<ParticipantPreviewReminderRunnerResult>;
  wait?: HostedParticipantPreviewReminderWait;
  report?: (result: ParticipantPreviewReminderRunnerResult) => void;
}

function disabledResult(): ParticipantPreviewReminderRunnerResult {
  return {
    code: 'DISABLED',
    claimed: 0,
    skipped: 0,
    sent: 0,
    failed: 0,
    deliveryUnknown: 0,
    suppressedBeforeTransport: 0,
    reconciled: 0,
  };
}

function runnerFailedResult(): ParticipantPreviewReminderRunnerResult {
  return {
    code: 'RUNNER_FAILED',
    claimed: 0,
    skipped: 0,
    sent: 0,
    failed: 0,
    deliveryUnknown: 0,
    suppressedBeforeTransport: 0,
    reconciled: 0,
  };
}

export function waitForHostedParticipantPreviewReminderInterval(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, milliseconds);
    const onAbort = () => done();
    signal.addEventListener('abort', onAbort, { once: true });

    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
  });
}

/**
 * Runs one reminder pass at a time. A failed pass is reported and followed by the same bounded
 * delay; it never creates a second claim loop or changes the notification state machine.
 */
export async function runHostedParticipantPreviewReminderLoop(
  input: HostedParticipantPreviewReminderLoopInput,
): Promise<void> {
  if (
    !Number.isSafeInteger(input.pollIntervalMs) ||
    input.pollIntervalMs < 1 ||
    input.pollIntervalMs > MAX_HOSTED_PARTICIPANT_PREVIEW_REMINDER_LOOP_INTERVAL_MS
  ) {
    throw new Error('Hosted participant preview reminder polling interval is invalid.');
  }

  const wait = input.wait ?? waitForHostedParticipantPreviewReminderInterval;
  if (input.signal.aborted) return;

  if (!input.enabled) {
    input.report?.(disabledResult());
    while (!input.signal.aborted) {
      await wait(input.pollIntervalMs, input.signal);
    }
    return;
  }

  if (!input.runOnce) {
    throw new Error('Hosted participant preview reminder pass is not configured.');
  }

  while (!input.signal.aborted) {
    let result: ParticipantPreviewReminderRunnerResult;
    try {
      result = await input.runOnce();
    } catch {
      result = runnerFailedResult();
    }
    input.report?.(result);
    if (input.signal.aborted) break;
    await wait(input.pollIntervalMs, input.signal);
  }
}
