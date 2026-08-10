import { describe, expect, it } from 'vitest';
import { validateSubmitForReviewInput } from './submitForReviewInput';

const batchId = 'a0000000-0000-4000-8000-000000000001';

describe('validateSubmitForReviewInput', () => {
  it('accepts a valid single-project payload', () => {
    const result = validateSubmitForReviewInput({ projectPublicIds: ['proj-1'] }, batchId);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.projectPublicIds).toEqual(['proj-1']);
    }
  });

  it('rejects duplicate project public IDs', () => {
    const result = validateSubmitForReviewInput({ projectPublicIds: ['proj-1', 'proj-2', 'proj-1'] }, batchId);
    expect(result.valid).toBe(false);
  });

  it('rejects duplicates that only differ by surrounding whitespace after trimming', () => {
    const result = validateSubmitForReviewInput({ projectPublicIds: ['proj-1', ' proj-1 '] }, batchId);
    expect(result.valid).toBe(false);
  });

  it('accepts distinct project public IDs without rejecting the request', () => {
    const result = validateSubmitForReviewInput({ projectPublicIds: ['proj-1', 'proj-2'] }, batchId);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.projectPublicIds).toEqual(['proj-1', 'proj-2']);
    }
  });
});
