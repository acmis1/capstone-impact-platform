import { describe, expect, it } from 'vitest';
import {
  BULK_REVIEW_DISPOSITIONS,
  BULK_REVIEW_OUTCOMES,
} from '../../projects/bulkProjectReview';
import { WORKFLOW_STATUSES } from '../../domain/workflowStatus';
import {
  bulkDispositionLabel,
  bulkOutcomeLabel,
  bulkStatusLabel,
  UNKNOWN_RESULT_LABEL,
} from './bulkReviewPresentation';

describe('bulkReviewPresentation', () => {
  it.each(BULK_REVIEW_DISPOSITIONS)('gives %s a human label without leaking the raw token', (disposition) => {
    const label = bulkDispositionLabel(disposition);
    expect(label).not.toBe(UNKNOWN_RESULT_LABEL);
    expect(label).not.toContain('_');
    expect(label).not.toBe(disposition.replace(/_/g, ' '));
  });

  it.each(BULK_REVIEW_OUTCOMES)('gives %s a human label without leaking the raw token', (outcome) => {
    const label = bulkOutcomeLabel(outcome);
    expect(label).not.toBe(UNKNOWN_RESULT_LABEL);
    expect(label).not.toContain('_');
    expect(label).not.toBe(outcome.replace(/_/g, ' '));
  });

  it('translates invalid_or_stale into staff-readable wording rather than underscore replacement', () => {
    expect(bulkDispositionLabel('invalid_or_stale')).toBe('Needs refresh or cannot continue');
    expect(bulkOutcomeLabel('invalid_or_stale')).toBe('Needs refresh or cannot continue');
  });

  it.each(WORKFLOW_STATUSES)('gives %s the shared human workflow label', (status) => {
    const label = bulkStatusLabel(status);
    expect(label).not.toContain('_');
    expect(label).not.toBe('Status unavailable');
  });

  it('falls back to a safe generic label for values it has no wording for', () => {
    expect(bulkDispositionLabel('some_future_disposition')).toBe(UNKNOWN_RESULT_LABEL);
    expect(bulkOutcomeLabel('some_future_outcome')).toBe(UNKNOWN_RESULT_LABEL);
    expect(bulkStatusLabel('some_future_status')).toBe('Status unavailable');
    expect(bulkStatusLabel(null)).toBe('Status unavailable');
  });
});
