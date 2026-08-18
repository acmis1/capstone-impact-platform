import { describe, expect, it } from 'vitest';
import { getPermissionsForRoles } from '../../auth/permissions';
import { getAllowedReviewActions } from '../../workflow/projectWorkflow';
import { getPermittedReviewActions } from './projectReviewActions';
import { deriveProjectWorkflowContext, ProjectWorkflowContextInput } from './projectWorkflowContext';

const baseInput: ProjectWorkflowContextInput = {
  status: 'draft',
  allowedActions: [],
  submitForReview: null,
  submitForReviewUnavailable: false,
  canEditMetadata: true,
  participantResponse: 'unresponded',
  hasActivePreview: false,
  publicationReadiness: null,
  pendingRemovalFromPublic: false,
};

const derive = (overrides: Partial<ProjectWorkflowContextInput> = {}) =>
  deriveProjectWorkflowContext({ ...baseInput, ...overrides });

describe('project workflow orientation context', () => {
  it('reports the human status label rather than the raw status value', () => {
    expect(derive({ status: 'changes_requested' }).stageLabel).toBe('Changes requested');
    expect(derive({ status: 'in_review' }).stageLabel).toBe('In review');
  });

  it('states that a draft is private and not yet sent for review', () => {
    const context = derive({ status: 'draft' });
    expect(context.summary).toMatch(/private/i);
    expect(context.summary).toMatch(/not been sent for review/i);
  });

  it('offers submission only when readiness is verified and ready', () => {
    const context = derive({ submitForReview: { ready: true, blockingReasons: [] } });
    expect(context.decision).toMatch(/can be submitted for review/i);
  });

  it('directs staff to the blocking issues when submission readiness is not satisfied', () => {
    const context = derive({
      submitForReview: { ready: false, blockingReasons: ['Poster full text is required.'] },
    });
    expect(context.decision).toMatch(/^Fix the listed blocking issues/);
  });

  it('fails closed when submission readiness could not be verified', () => {
    const context = derive({ submitForReviewUnavailable: true });
    expect(context.decision).toMatch(/could not be verified/i);
    expect(context.decision).toMatch(/unavailable/i);
  });

  it('states the permission limit instead of an action a reader cannot take', () => {
    const context = derive({ canEditMetadata: false, submitForReview: { ready: true, blockingReasons: [] } });
    expect(context.decision).toMatch(/cannot edit it or submit it for review/i);
  });

  it('explains that no import batch means submission is not offered', () => {
    const context = derive({ submitForReview: null });
    expect(context.decision).toMatch(/no completed import batch/i);
  });

  it('describes review decisions for a project under review', () => {
    const context = derive({ status: 'in_review', allowedActions: ['approve', 'request_changes', 'archive'] });
    expect(context.summary).toMatch(/waiting on a review decision/i);
    expect(context.decision).toMatch(/approve it or request changes/i);
  });

  it('states the permission limit when a reader cannot record a review decision', () => {
    const context = derive({ status: 'in_review', allowedActions: [] });
    expect(context.decision).toMatch(/cannot record a review decision/i);
  });

  it('never claims approval publishes a project', () => {
    const context = derive({ status: 'approved', allowedActions: ['request_changes', 'archive'] });
    expect(context.summary).toMatch(/approved but is not published/i);
  });

  it('asks for a participant preview when an approved project has none', () => {
    const context = derive({ status: 'approved', participantResponse: 'unresponded', hasActivePreview: false });
    expect(context.decision).toMatch(/share a participant preview/i);
  });

  it('waits for the participant while a preview is active and unanswered', () => {
    const context = derive({ status: 'approved', participantResponse: 'unresponded', hasActivePreview: true });
    expect(context.summary).toMatch(/awaiting a response/i);
    expect(context.decision).toMatch(/wait for the participant to confirm/i);
  });

  it('prioritises correction resolution over publication', () => {
    const context = derive({ status: 'approved', participantResponse: 'correction_requested' });
    expect(context.summary).toMatch(/asked for a correction/i);
    expect(context.decision).toMatch(/^Resolve the participant correction/);
  });

  it('distinguishes ready, verified blocked, and unavailable publication readiness', () => {
    const confirmedReady = derive({
      status: 'approved',
      participantResponse: 'confirmed',
      publicationReadiness: { ready: true, resultCode: 'READY', blockers: [] },
    });
    expect(confirmedReady.decision).toMatch(/publication can be prepared/i);

    const confirmedBlocked = derive({
      status: 'approved',
      participantResponse: 'confirmed',
      publicationReadiness: { ready: false, resultCode: 'PROJECT_SNAPSHOT_STALE', blockers: ['Snapshot stale'] },
    });
    expect(confirmedBlocked.decision).toMatch(/check the publication status below/i);
    expect(confirmedBlocked.decision).not.toMatch(/could not be verified/i);

    for (const publicationReadiness of [
      null,
      { ready: false, resultCode: 'READINESS_UNAVAILABLE' as const, blockers: ['Unavailable'] },
    ]) {
      expect(derive({ status: 'approved', participantResponse: 'confirmed', publicationReadiness }).decision)
        .toMatch(/could not be verified/i);
    }
  });

  it('does not assert a participant state when the preview subsystem is unavailable', () => {
    const context = derive({ status: 'approved', participantResponse: null });
    expect(context.decision).toMatch(/could not be read/i);
    expect(context.decision).not.toMatch(/share a participant preview/i);
  });

  it('surfaces a pending showcase removal for a published project', () => {
    const context = derive({ status: 'published', allowedActions: [], pendingRemovalFromPublic: true });
    expect(context.summary).toMatch(/marked for removal/i);
    expect(context.decision).toMatch(/removal is pending/i);
  });

  it('states plainly that a published project has no review transition', () => {
    const context = derive({ status: 'published', allowedActions: [] });
    expect(context.decision).toMatch(/no review transition is available/i);
  });

  it('states plainly that an archived project has no review transition', () => {
    const context = derive({ status: 'archived', allowedActions: [] });
    expect(context.summary).toMatch(/archived/i);
    expect(context.decision).toMatch(/no review transition is available/i);
  });

  it('degrades safely for an unrecognised status without inventing a next step', () => {
    const context = derive({ status: 'deleted', allowedActions: [] });
    expect(context.decision).toMatch(/no review transition is available/i);
    expect(context.summary).toContain('Deleted');
  });
});

describe('permission-filtered review actions', () => {
  const statusAllowedActions = getAllowedReviewActions('in_review');

  it.each([
    ['Editor', ['editor'], []],
    ['Reviewer', ['reviewer'], ['request_changes', 'approve']],
    ['Administrator', ['admin'], ['request_changes', 'approve', 'archive']],
    ['Reviewer + Editor', ['reviewer', 'editor'], ['request_changes', 'approve']],
  ] as const)('%s sees only its permitted review controls', (_role, roles, expectedActions) => {
    const permittedActions = getPermittedReviewActions(statusAllowedActions, getPermissionsForRoles(roles));
    expect(permittedActions).toEqual(expectedActions);
  });

  it('keeps orientation copy aligned with the permitted action list', () => {
    expect(derive({ status: 'in_review', allowedActions: [] }).decision).toMatch(/cannot record a review decision/i);
    expect(derive({ status: 'in_review', allowedActions: ['request_changes', 'approve'] }).decision)
      .toMatch(/approve it or request changes/i);
  });
});
