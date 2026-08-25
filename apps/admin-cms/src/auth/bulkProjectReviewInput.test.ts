import { describe, expect, it } from 'vitest';
import { validateBulkReviewExecuteInput, validateBulkReviewPreflightInput } from './bulkProjectReviewInput';

describe('bulk project review input boundary', () => {
  it('accepts only the three bounded actions', () => {
    for (const action of ['submit_for_review', 'approve', 'request_changes']) {
      expect(validateBulkReviewPreflightInput({ action, publicIds: ['synthetic-2026-0001'] }).valid).toBe(true);
    }
    expect(validateBulkReviewPreflightInput({ action: 'archive', publicIds: ['synthetic-2026-0001'] }).valid).toBe(false);
    expect(validateBulkReviewPreflightInput({ action: 'approve', publicIds: ['bad/id'] }).valid).toBe(false);
  });

  it('rejects missing versions, duplicate IDs, and comments on unrelated actions', () => {
    expect(validateBulkReviewExecuteInput({ action: 'approve', publicIds: ['a-1', 'a-1'], expectedUpdatedAt: { 'a-1': 'v' } }).valid).toBe(false);
    expect(validateBulkReviewExecuteInput({ action: 'approve', publicIds: ['a-1'], expectedUpdatedAt: {} }).valid).toBe(false);
    expect(validateBulkReviewExecuteInput({ action: 'approve', publicIds: ['a-1'], expectedUpdatedAt: { 'a-1': 'v' }, comments: 'not allowed' }).valid).toBe(false);
  });

  it('requires a bounded non-empty shared comment for request changes', () => {
    expect(validateBulkReviewExecuteInput({ action: 'request_changes', publicIds: ['a-1'], expectedUpdatedAt: { 'a-1': 'v' } }).valid).toBe(false);
    expect(validateBulkReviewExecuteInput({ action: 'request_changes', publicIds: ['a-1'], expectedUpdatedAt: { 'a-1': 'v' }, comments: '   ' }).valid).toBe(false);
    expect(validateBulkReviewExecuteInput({ action: 'request_changes', publicIds: ['a-1'], expectedUpdatedAt: { 'a-1': 'v' }, comments: 'Needs revision.' }).valid).toBe(true);
    expect(validateBulkReviewExecuteInput({ action: 'request_changes', publicIds: ['a-1'], expectedUpdatedAt: { 'a-1': 'v' }, comments: 'x'.repeat(4001) }).valid).toBe(false);
  });
});
