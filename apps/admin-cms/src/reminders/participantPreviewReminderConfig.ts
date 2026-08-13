export const PARTICIPANT_PREVIEW_REMINDERS_ENABLED_VAR =
  'PARTICIPANT_PREVIEW_REMINDERS_ENABLED';

export function isParticipantPreviewRemindersEnabledValue(
  value: string | undefined | null,
): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'true';
}
export function isParticipantPreviewRemindersEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isParticipantPreviewRemindersEnabledValue(
    env[PARTICIPANT_PREVIEW_REMINDERS_ENABLED_VAR],
  );
}
