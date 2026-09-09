import type {
  HostedParticipantPreviewReminderDisabledReason,
  HostedParticipantPreviewReminderInvalidReason,
} from './hostedParticipantPreviewReminderConfig';
import type { ParticipantPreviewReminderRunnerResult } from './participantPreviewReminderRunner';

type HostedParticipantPreviewReminderLogEvent =
  | { state: 'DISABLED'; reason: HostedParticipantPreviewReminderDisabledReason }
  | { state: 'CONFIGURATION_INVALID'; reason: HostedParticipantPreviewReminderInvalidReason }
  | { state: 'STARTED'; pollIntervalMs: number; batchLimit: number }
  | { state: 'RESULT'; result: ParticipantPreviewReminderRunnerResult }
  | { state: 'STOPPED' }
  | { state: 'LOOP_FAILED' };

/**
 * Formats only bounded enums, counters, and operator-selected numeric limits. Callers cannot pass
 * errors, URLs, credentials, recipients, preview tokens, or message content to this formatter.
 */
export function formatHostedParticipantPreviewReminderLog(
  event: HostedParticipantPreviewReminderLogEvent,
): string {
  const base = {
    schemaVersion: 'participant-preview-reminder-runner/v1',
    event: 'participant_preview_reminder_runner',
    state: event.state,
  };
  if (event.state === 'RESULT') {
    return JSON.stringify({ ...base, ...event.result });
  }
  if (event.state === 'STARTED') {
    return JSON.stringify({
      ...base,
      pollIntervalMs: event.pollIntervalMs,
      batchLimit: event.batchLimit,
    });
  }
  if (event.state === 'DISABLED' || event.state === 'CONFIGURATION_INVALID') {
    return JSON.stringify({ ...base, reason: event.reason });
  }
  return JSON.stringify(base);
}
