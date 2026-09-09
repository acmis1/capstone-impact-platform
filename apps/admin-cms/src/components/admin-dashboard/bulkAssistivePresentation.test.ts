import { describe, expect, it } from 'vitest';

import {
  bulkAssistiveDispositionLabel,
  bulkAssistiveOutcomeLabel,
  bulkAssistiveStatusLabel,
} from './bulkAssistivePresentation';

describe('bulkAssistivePresentation', () => {
  it('keeps all execution outcomes readable without color-only meaning', () => {
    expect(bulkAssistiveOutcomeLabel('ENQUEUED')).toBe('Enqueued');
    expect(bulkAssistiveOutcomeLabel('ALREADY_ACTIVE_OR_CURRENT')).toBe('Already active or current');
    expect(bulkAssistiveOutcomeLabel('BLOCKED')).toBe('Blocked');
    expect(bulkAssistiveOutcomeLabel('INVALID_STALE')).toBe('Invalid or stale selection');
    expect(bulkAssistiveOutcomeLabel('FAILED')).toBe('Failed');
    expect(bulkAssistiveDispositionLabel('eligible')).toBe('Ready to enqueue');
    expect(bulkAssistiveStatusLabel('RUNNING')).toBe('Running');
  });
});
