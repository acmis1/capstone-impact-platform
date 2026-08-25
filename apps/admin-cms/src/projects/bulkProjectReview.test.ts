import { describe, expect, it } from 'vitest';
import {
  classifyBulkReviewState,
  normalizeBulkReasons,
  sortBulkReviewItems,
  summarizeBulkPreflight,
  type BulkReviewProjectState,
} from './bulkProjectReview';
import { validateBulkReviewExecuteInput, validateBulkReviewPreflightInput } from '../auth/bulkProjectReviewInput';

const eligibleState: BulkReviewProjectState = {
  publicId: 'synthetic-2026-0001',
  title: 'Synthetic project',
  status: 'draft',
  updatedAt: '2026-08-24T00:00:00.000Z',
  exists: true,
  submission: { eligible: true, alreadyComplete: false, reasons: [] },
  review: {
    approve: { allowed: false, reasons: [{ code: 'WORKFLOW_TRANSITION_INVALID', message: 'Not ready for approval.' }] },
    requestChanges: { allowed: false, reasons: [{ code: 'WORKFLOW_TRANSITION_INVALID', message: 'Not ready for changes.' }] },
  },
};

describe('bulk project review contracts', () => {
  it('accepts bounded unique IDs and rejects malformed, duplicate, and oversized requests', () => {
    expect(validateBulkReviewPreflightInput({ action: 'approve', publicIds: ['a-1'] }).valid).toBe(true);
    expect(validateBulkReviewPreflightInput({ action: 'approve', publicIds: ['a-1', 'a-1'] }).valid).toBe(false);
    expect(validateBulkReviewPreflightInput({ action: 'approve', publicIds: Array.from({ length: 51 }, (_, i) => `a-${i}`) }).valid).toBe(false);
    expect(validateBulkReviewPreflightInput([]).valid).toBe(false);
  });

  it('requires a version entry for every execute ID and preserves the existing 4000-character comment bound', () => {
    expect(validateBulkReviewExecuteInput({
      action: 'request_changes',
      publicIds: ['a-1'],
      expectedUpdatedAt: { 'a-1': '2026-08-24T00:00:00.000Z' },
      comments: '  Please revise the accessibility text.  ',
    })).toEqual({
      valid: true,
      data: {
        action: 'request_changes',
        publicIds: ['a-1'],
        expectedUpdatedAt: { 'a-1': '2026-08-24T00:00:00.000Z' },
        comments: 'Please revise the accessibility text.',
      },
    });
    expect(validateBulkReviewExecuteInput({
      action: 'approve', publicIds: ['a-1'], expectedUpdatedAt: { 'a-1': null },
    }).valid).toBe(true);
    expect(validateBulkReviewExecuteInput({
      action: 'approve', publicIds: ['a-1'], expectedUpdatedAt: {},
    }).valid).toBe(false);
    expect(validateBulkReviewExecuteInput({
      action: 'approve', publicIds: ['a-1'], expectedUpdatedAt: { 'a-1': 'v' }, comments: 'not allowed',
    }).valid).toBe(false);
    expect(validateBulkReviewExecuteInput({
      action: 'request_changes', publicIds: ['a-1'], expectedUpdatedAt: { 'a-1': 'v' }, comments: 'x'.repeat(4001),
    }).valid).toBe(false);
  });

  it('classifies eligible, complete, blocked, stale, and missing projects', () => {
    expect(classifyBulkReviewState('submit_for_review', eligibleState).disposition).toBe('eligible');
    expect(classifyBulkReviewState('submit_for_review', { ...eligibleState, status: 'submitted' }).disposition).toBe('already_complete');
    expect(classifyBulkReviewState('submit_for_review', {
      ...eligibleState,
      submission: { eligible: false, alreadyComplete: false, reasons: [{ code: 'READINESS_BLOCKED', message: 'Summary is missing.' }] },
    }).disposition).toBe('blocked');
    expect(classifyBulkReviewState('submit_for_review', eligibleState, 'different-version').disposition).toBe('invalid_or_stale');
    expect(classifyBulkReviewState('submit_for_review', null).disposition).toBe('invalid_or_stale');
  });

  it('bounds reasons, summaries, and ordering deterministically', () => {
    const normalized = normalizeBulkReasons(Array.from({ length: 7 }, (_, index) => ({ code: `CODE_${index}`, message: '  reason   text  ' })));
    expect(normalized.reasons).toHaveLength(5);
    expect(normalized.additionalReasonCount).toBe(2);
    const items = [
      classifyBulkReviewState('submit_for_review', { ...eligibleState, publicId: 'z-1' }),
      classifyBulkReviewState('submit_for_review', { ...eligibleState, publicId: 'a-1' }),
    ];
    expect(sortBulkReviewItems(items).map((item) => item.publicId)).toEqual(['a-1', 'z-1']);
    expect(summarizeBulkPreflight(items)).toMatchObject({ total: 2, eligible: 2 });
  });
});
