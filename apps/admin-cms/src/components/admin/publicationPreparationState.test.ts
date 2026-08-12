import { describe, expect, it } from 'vitest';
import {
  canExecuteLocalPublication,
  initialPublicationPreparationState,
  publicationPreparationReducer,
  shouldShowLocalExecution,
} from './publicationPreparationState';

const plan = {
  publicId: 'project_2026',
  confirmedPreviewId: 'preview-id',
  confirmedAt: '2026-08-12T03:04:05.000Z',
  recordCount: 2,
  feedHash: 'a'.repeat(64),
};
const planned = publicationPreparationReducer(initialPublicationPreparationState, { type: 'PLAN_SUCCEEDED', plan });

describe('publication preparation local execution state', () => {
  it('does not show execution without local availability', () => {
    expect(shouldShowLocalExecution(true, false, planned)).toBe(false);
  });

  it('does not show execution without projects.publish authority', () => {
    expect(shouldShowLocalExecution(false, true, planned)).toBe(false);
  });

  it('does not show execution before a plan is generated', () => {
    expect(shouldShowLocalExecution(true, true, initialPublicationPreparationState)).toBe(false);
  });

  it('reveals local execution acknowledgement after a successful plan', () => {
    expect(shouldShowLocalExecution(true, true, planned)).toBe(true);
  });

  it('requires explicit acknowledgement before execution', () => {
    expect(canExecuteLocalPublication(true, true, planned)).toBe(false);
    const acknowledged = publicationPreparationReducer(planned, { type: 'ACKNOWLEDGEMENT_CHANGED', acknowledged: true });
    expect(canExecuteLocalPublication(true, true, acknowledged)).toBe(true);
  });

  it('prevents duplicate execution while pending', () => {
    const acknowledged = publicationPreparationReducer(planned, { type: 'ACKNOWLEDGEMENT_CHANGED', acknowledged: true });
    const pending = publicationPreparationReducer(acknowledged, { type: 'EXECUTION_STARTED' });
    expect(canExecuteLocalPublication(true, true, pending)).toBe(false);
  });

  it('clears stale plan and acknowledgement after NOT_READY or another bounded execution error', () => {
    const acknowledged = publicationPreparationReducer(planned, { type: 'ACKNOWLEDGEMENT_CHANGED', acknowledged: true });
    const failed = publicationPreparationReducer(acknowledged, { type: 'EXECUTION_FAILED', error: 'Readiness changed.' });
    expect(failed).toMatchObject({ plan: null, acknowledged: false, error: 'Readiness changed.' });
  });

  it.each(['COMPLETED', 'ALREADY_COMPLETED'] as const)('records %s as successful evidence', (resultCode) => {
    const success = publicationPreparationReducer(planned, {
      type: 'EXECUTION_SUCCEEDED',
      result: { resultCode, publicId: plan.publicId, snapshotId: 'snapshot-id', recordCount: 2, feedHash: plan.feedHash },
    });
    expect(success.success?.resultCode).toBe(resultCode);
    expect(success.error).toBeNull();
    expect(canExecuteLocalPublication(true, true, success)).toBe(false);
  });

  it('never enables execution in a hosted environment even with a plan and acknowledgement', () => {
    const acknowledged = publicationPreparationReducer(planned, { type: 'ACKNOWLEDGEMENT_CHANGED', acknowledged: true });
    expect(canExecuteLocalPublication(true, false, acknowledged)).toBe(false);
  });
});
