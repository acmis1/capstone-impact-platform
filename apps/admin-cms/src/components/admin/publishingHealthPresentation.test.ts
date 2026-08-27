import { describe, expect, it } from 'vitest';
import {
  classifyPublishingActivity,
  derivePublishingHealth,
  PUBLISHING_IN_PROGRESS_STATES,
  PUBLISHING_RECOVERY_REQUIRED_STATE,
} from './publishingHealthPresentation';

const ACTIVE_AND_ALIGNED = { active: true, divergedProjectsCount: 0 };

describe('classifyPublishingActivity', () => {
  it('treats no blocking operation as idle', () => {
    expect(classifyPublishingActivity(null)).toBe('idle');
    expect(classifyPublishingActivity(undefined)).toBe('idle');
  });

  it('treats only RECOVERY_REQUIRED as recovery', () => {
    expect(classifyPublishingActivity({ state: PUBLISHING_RECOVERY_REQUIRED_STATE })).toBe('recovery_required');
  });

  it.each(PUBLISHING_IN_PROGRESS_STATES)('treats %s as a running publishing action, not recovery', (state) => {
    expect(classifyPublishingActivity({ state })).toBe('in_progress');
  });

  it('treats an unrecognized blocking state as in progress rather than claiming an unproven failure', () => {
    expect(classifyPublishingActivity({ state: 'SOME_FUTURE_STATE' })).toBe('in_progress');
  });
});

describe('derivePublishingHealth', () => {
  it('reports recovery presentation only for RECOVERY_REQUIRED', () => {
    const health = derivePublishingHealth({
      ...ACTIVE_AND_ALIGNED,
      blockingOperation: { state: PUBLISHING_RECOVERY_REQUIRED_STATE },
    });
    expect(health.recoveryRequired).toBe(true);
    expect(health.publishingInProgress).toBe(false);
    expect(health.badgeLabel).toBe('Needs attention');
    expect(health.summaryLabel).toBe('Needs attention');
    expect(health.healthLabel).toBe('Needs attention');
  });

  it.each(PUBLISHING_IN_PROGRESS_STATES)('reports %s as publishing in progress without offering recovery', (state) => {
    const health = derivePublishingHealth({ ...ACTIVE_AND_ALIGNED, blockingOperation: { state } });
    expect(health.recoveryRequired).toBe(false);
    expect(health.publishingInProgress).toBe(true);
    expect(health.badgeLabel).toBe('Publishing in progress');
    expect(health.summaryLabel).toBe('Publishing in progress');
    expect(health.healthLabel).toBe('Publishing in progress');
  });

  it('reports no issues when publishing is active, idle and aligned', () => {
    const health = derivePublishingHealth({ ...ACTIVE_AND_ALIGNED, blockingOperation: null });
    expect(health.badgeLabel).toBe('Publishing ready');
    expect(health.summaryLabel).toBe('Ready');
    expect(health.healthLabel).toBe('No issues');
  });

  it('counts projects needing repair in singular and plural', () => {
    expect(derivePublishingHealth({ active: true, blockingOperation: null, divergedProjectsCount: 1 }).healthLabel)
      .toBe('1 project needs repair');
    expect(derivePublishingHealth({ active: true, blockingOperation: null, divergedProjectsCount: 3 }).healthLabel)
      .toBe('3 projects need repair');
  });

  it('reports setup required when publishing is inactive and nothing is running', () => {
    const health = derivePublishingHealth({ active: false, blockingOperation: null, divergedProjectsCount: 0 });
    expect(health.badgeLabel).toBe('Setup required');
    expect(health.summaryLabel).toBe('Setup required');
    expect(health.recoveryRequired).toBe(false);
  });
});
