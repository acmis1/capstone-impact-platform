import { describe, expect, it } from 'vitest';
import {
  parseCancelParticipantPreviewReminderInput,
  parseScheduleParticipantPreviewReminderInput,
} from './participantPreviewReminderInput';

describe('participant preview reminder input', () => {
  it('normalizes an unambiguous scheduled instant', () => {
    expect(parseScheduleParticipantPreviewReminderInput({
      scheduledFor: '2026-08-14T09:30:00+07:00',
    })).toEqual({ valid: true, scheduledFor: '2026-08-14T02:30:00.000Z' });
  });

  it.each([
    null, [], {}, { scheduledFor: 'tomorrow' }, { scheduledFor: 1 },
    { scheduledFor: '2026-08-14T09:30' }, { scheduledFor: '2026-08-14' },
    { scheduledFor: '2026-08-14T00:00:00Z', recipient: 'chosen@capstone.invalid' },
    { scheduledFor: '2026-08-14T00:00:00Z', participantPreviewId: 'chosen' },
    { scheduledFor: '2026-08-14T00:00:00Z', actorId: 'chosen' },
    { scheduledFor: '2026-08-14T00:00:00Z', extra: true },
  ])('rejects malformed or authority-bearing schedule input %#', (input) => {
    expect(parseScheduleParticipantPreviewReminderInput(input)).toEqual({ valid: false });
  });

  it('accepts only an opaque UUID cancellation reference', () => {
    expect(parseCancelParticipantPreviewReminderInput({
      reference: '123e4567-e89b-42d3-a456-426614174000',
    })).toEqual({ valid: true, reference: '123e4567-e89b-42d3-a456-426614174000' });
  });

  it.each([
    {}, { reference: 'schedule-id' }, { reference: 1 },
    { reference: '123e4567-e89b-42d3-a456-426614174000', adminId: 'spoofed' },
  ])('rejects malformed or authority-bearing cancellation input %#', (input) => {
    expect(parseCancelParticipantPreviewReminderInput(input)).toEqual({ valid: false });
  });
});
