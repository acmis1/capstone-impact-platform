import { describe, it, expect } from 'vitest';
import { getAllowedReviewActions, applyReviewActionTransition, ReviewAction } from './projectWorkflow';
import { WorkflowStatus } from '../domain/workflowStatus';

describe('projectWorkflow', () => {
  describe('getAllowedReviewActions', () => {
    it('returns actions for draft status (default)', () => {
      // Draft has no allowed review actions
      expect(getAllowedReviewActions('draft')).toEqual([]);
    });

    it('returns actions for submitted and in_review status', () => {
      const expectedActions: ReviewAction[] = ['request_changes', 'approve', 'archive'];
      expect(getAllowedReviewActions('submitted')).toEqual(expectedActions);
      expect(getAllowedReviewActions('in_review')).toEqual(expectedActions);
    });

    it('returns actions for changes_requested status', () => {
      expect(getAllowedReviewActions('changes_requested')).toEqual(['approve']);
    });

    it('returns actions for approved status', () => {
      expect(getAllowedReviewActions('approved')).toEqual(['request_changes', 'archive']);
    });

    it('returns actions for published status', () => {
      expect(getAllowedReviewActions('published')).toEqual(['archive']);
    });

    it('returns actions for archived status', () => {
      expect(getAllowedReviewActions('archived')).toEqual([]);
    });

    it('returns actions for deleted status', () => {
      expect(getAllowedReviewActions('deleted')).toEqual([]);
    });

    it('normalizes status string to lowercase', () => {
      expect(getAllowedReviewActions('IN_REVIEW' as WorkflowStatus)).toEqual(['request_changes', 'approve', 'archive']);
    });
  });

  describe('applyReviewActionTransition', () => {
    it('successfully transitions from in_review to approved', () => {
      const result = applyReviewActionTransition('in_review', 'approve');
      expect(result.allowed).toBe(true);
      expect(result.fromStatus).toBe('in_review');
      expect(result.toStatus).toBe('approved');
    });

    it('successfully transitions from in_review to changes_requested', () => {
      const result = applyReviewActionTransition('in_review', 'request_changes');
      expect(result.allowed).toBe(true);
      expect(result.fromStatus).toBe('in_review');
      expect(result.toStatus).toBe('changes_requested');
    });

    it('successfully transitions from in_review to archived', () => {
      const result = applyReviewActionTransition('in_review', 'archive');
      expect(result.allowed).toBe(true);
      expect(result.fromStatus).toBe('in_review');
      expect(result.toStatus).toBe('archived');
    });

    it('successfully transitions for defined valid workflow paths (table-driven)', () => {
      const transitions: Array<{ from: WorkflowStatus; action: ReviewAction; to: WorkflowStatus }> = [
        { from: 'submitted', action: 'approve', to: 'approved' },
        { from: 'submitted', action: 'request_changes', to: 'changes_requested' },
        { from: 'submitted', action: 'archive', to: 'archived' },
        { from: 'changes_requested', action: 'approve', to: 'approved' },
        { from: 'approved', action: 'request_changes', to: 'changes_requested' },
        { from: 'approved', action: 'archive', to: 'archived' },
        { from: 'published', action: 'archive', to: 'archived' },
      ];

      transitions.forEach(({ from, action, to }) => {
        const result = applyReviewActionTransition(from, action);
        expect(result.allowed).toBe(true);
        expect(result.fromStatus).toBe(from);
        expect(result.toStatus).toBe(to);
        expect(result.error).toBeUndefined();
      });
    });

    it('rejects invalid actions from draft state', () => {
      const result = applyReviewActionTransition('draft', 'approve');
      expect(result.allowed).toBe(false);
      expect(result.toStatus).toBeUndefined();
      expect(result.error).toContain('is not allowed from workflow state');
    });

    it('rejects unknown or unsupported actions', () => {
      const result = applyReviewActionTransition('in_review', 'unsupported_action' as ReviewAction);
      expect(result.allowed).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});
