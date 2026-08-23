import { describe, expect, it } from 'vitest';
import {
  canExecutePublication,
  initialPublicationPreparationState,
  publicationPreparationReducer,
  shouldShowPublicationExecution,
} from './publicationPreparationState';

const plan = {
  publicId: 'project_2026',
  confirmedPreviewId: 'preview-id',
  confirmedAt: '2026-08-12T03:04:05.000Z',
  recordCount: 2,
  feedHash: 'a'.repeat(64),
};
const planned = publicationPreparationReducer(initialPublicationPreparationState, { type: 'PLAN_SUCCEEDED', plan });

describe('publication preparation execution state', () => {
  it('does not show execution without an available target', () => {
    expect(shouldShowPublicationExecution(true, null, planned)).toBe(false);
  });

  it('does not show execution without projects.publish authority', () => {
    expect(shouldShowPublicationExecution(false, 'local', planned)).toBe(false);
  });

  it('does not show execution before a plan is generated', () => {
    expect(shouldShowPublicationExecution(true, 'local', initialPublicationPreparationState)).toBe(false);
  });

  it('reveals local execution acknowledgement after a successful plan', () => {
    expect(shouldShowPublicationExecution(true, 'local', planned)).toBe(true);
    expect(shouldShowPublicationExecution(true, 'staging', planned)).toBe(true);
  });

  it('requires explicit acknowledgement before execution', () => {
    expect(canExecutePublication(true, 'local', planned)).toBe(false);
    const acknowledged = publicationPreparationReducer(planned, { type: 'ACKNOWLEDGEMENT_CHANGED', acknowledged: true });
    expect(canExecutePublication(true, 'local', acknowledged)).toBe(true);
    expect(canExecutePublication(true, 'staging', acknowledged)).toBe(true);
  });

  it('prevents duplicate execution while pending', () => {
    const acknowledged = publicationPreparationReducer(planned, { type: 'ACKNOWLEDGEMENT_CHANGED', acknowledged: true });
    const pending = publicationPreparationReducer(acknowledged, { type: 'EXECUTION_STARTED' });
    expect(canExecutePublication(true, 'local', pending)).toBe(false);
  });

  it('clears stale plan and acknowledgement after NOT_READY or another bounded execution error', () => {
    const acknowledged = publicationPreparationReducer(planned, { type: 'ACKNOWLEDGEMENT_CHANGED', acknowledged: true });
    const failed = publicationPreparationReducer(acknowledged, { type: 'EXECUTION_FAILED', error: 'Readiness changed.' });
    expect(failed).toMatchObject({ plan: null, acknowledged: false, error: 'Readiness changed.' });
  });

  it.each(['COMPLETED', 'ALREADY_COMPLETED'] as const)('records %s as successful evidence', (resultCode) => {
    const success = publicationPreparationReducer(planned, {
      type: 'EXECUTION_SUCCEEDED',
      result: { resultCode, publicId: plan.publicId, snapshotId: 'snapshot-id', recordCount: 2, feedHash: plan.feedHash, feedPublicUrl: 'https://feed.example/capstones-latest.json' },
    });
    expect(success.success?.resultCode).toBe(resultCode);
    expect(success.error).toBeNull();
    expect(canExecutePublication(true, 'local', success)).toBe(false);
  });

  it('never enables execution in a hosted environment even with a plan and acknowledgement', () => {
    const acknowledged = publicationPreparationReducer(planned, { type: 'ACKNOWLEDGEMENT_CHANGED', acknowledged: true });
    expect(canExecutePublication(true, null, acknowledged)).toBe(false);
  });
});
