import { describe, expect, it } from 'vitest';
import {
  isParticipantPreviewRemindersEnabled,
  isParticipantPreviewRemindersEnabledValue,
} from './participantPreviewReminderConfig';

describe('participant preview reminder enablement', () => {
  it.each([undefined, null, '', 'false', '1', 'yes'])('fails closed for %s', (value) => {
    expect(isParticipantPreviewRemindersEnabledValue(value)).toBe(false);
  });

  it('accepts only the explicit true value', () => {
    expect(isParticipantPreviewRemindersEnabledValue(' TRUE ')).toBe(true);
    expect(isParticipantPreviewRemindersEnabled({
      NODE_ENV: 'test',
      PARTICIPANT_PREVIEW_REMINDERS_ENABLED: 'true',
    } as NodeJS.ProcessEnv)).toBe(true);
  });
});
