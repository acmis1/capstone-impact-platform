import { describe, expect, it } from 'vitest';
import { canSubmitForReview } from './submitForReviewButtonState';

describe('canSubmitForReview', () => {
  it('allows submission when idle, not yet submitted, and clean', () => {
    expect(canSubmitForReview(false, false, false)).toBe(true);
  });

  it('blocks submission while metadata is dirty, even when otherwise idle', () => {
    expect(canSubmitForReview(false, false, true)).toBe(false);
  });

  it('blocks submission while a request is pending', () => {
    expect(canSubmitForReview(true, false, false)).toBe(false);
  });

  it('blocks re-submission after a successful submit', () => {
    expect(canSubmitForReview(false, true, false)).toBe(false);
  });
});
