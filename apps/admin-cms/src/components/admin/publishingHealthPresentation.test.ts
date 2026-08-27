import { describe, expect, it } from 'vitest';
import {
  classifyPublishingActivity,
  derivePublishingHealth,
  PUBLISHING_BLOCKING_STATES,
} from './publishingHealthPresentation';

const NOW = new Date('2026-08-27T12:00:00.000Z');
const LIVE = '2026-08-27T12:02:00.000Z';
const EXPIRED = '2026-08-27T11:59:59.000Z';
const LIVE_FENCE = '2026-08-27T12:01:00.000Z';
const EXPIRED_FENCE = '2026-08-27T11:59:00.000Z';

function operation(
  state: string,
  leaseExpiresAt = LIVE,
  storageUncertaintyUntil: string | null = null,
) {
  return { state, leaseExpiresAt, storageUncertaintyUntil };
}

const ACTIVE_AND_ALIGNED = { active: true, divergedProjectsCount: 0, now: NOW };

describe('classifyPublishingActivity', () => {
  it('treats no blocking operation as idle at a fixed reference time', () => {
    expect(classifyPublishingActivity(null, NOW)).toBe('IDLE');
    expect(classifyPublishingActivity(undefined, NOW)).toBe('IDLE');
  });

  it.each(PUBLISHING_BLOCKING_STATES)(
    'treats %s with a future lease as in progress, except explicit recovery attention',
    (state) => {
      expect(classifyPublishingActivity(operation(state), NOW)).toBe(
        state === 'RECOVERY_REQUIRED' ? 'RECOVERY_WAIT' : 'IN_PROGRESS',
      );
    },
  );

  it.each(PUBLISHING_BLOCKING_STATES)(
    'treats expired %s as recoverable when no Storage fence is active',
    (state) => {
      expect(classifyPublishingActivity(operation(state, EXPIRED, EXPIRED_FENCE), NOW))
        .toBe('RECOVERY_AVAILABLE');
    },
  );

  it.each(PUBLISHING_BLOCKING_STATES)(
    'waits for the Storage uncertainty fence after an expired %s lease',
    (state) => {
      expect(classifyPublishingActivity(operation(state, EXPIRED, LIVE_FENCE), NOW))
        .toBe('RECOVERY_WAIT');
    },
  );

  it('keeps RECOVERY_REQUIRED unavailable while either its lease or fence is live', () => {
    expect(classifyPublishingActivity(operation('RECOVERY_REQUIRED', LIVE, EXPIRED_FENCE), NOW))
      .toBe('RECOVERY_WAIT');
    expect(classifyPublishingActivity(operation('RECOVERY_REQUIRED', EXPIRED, LIVE_FENCE), NOW))
      .toBe('RECOVERY_WAIT');
    expect(classifyPublishingActivity(operation('RECOVERY_REQUIRED', EXPIRED, EXPIRED_FENCE), NOW))
      .toBe('RECOVERY_AVAILABLE');
  });

  it('fails safe for unknown states and malformed timing without offering recovery', () => {
    expect(classifyPublishingActivity(operation('SOME_FUTURE_STATE', EXPIRED), NOW)).toBe('RECOVERY_WAIT');
    expect(classifyPublishingActivity(operation('PREPARED', 'not-a-time'), NOW)).toBe('RECOVERY_WAIT');
    expect(classifyPublishingActivity(operation('WRITE_STARTED', EXPIRED, 'not-a-time'), NOW))
      .toBe('RECOVERY_WAIT');
  });
});

describe('derivePublishingHealth', () => {
  it('allows setup only when publishing history is inactive and there is no blocker', () => {
    const idle = derivePublishingHealth({ ...ACTIVE_AND_ALIGNED, active: false, blockingOperation: null });
    expect(idle.activity).toBe('IDLE');
    expect(idle.setupAvailable).toBe(true);
    expect(idle.badgeLabel).toBe('Setup required');
  });

  it.each([
    operation('RESERVED', LIVE),
    operation('RESERVED', EXPIRED),
    operation('RECOVERY_REQUIRED', LIVE),
    operation('RECOVERY_REQUIRED', EXPIRED),
  ])('suppresses setup for inactive history with blocker %#', (blockingOperation) => {
    const health = derivePublishingHealth({
      ...ACTIVE_AND_ALIGNED,
      active: false,
      blockingOperation,
    });
    expect(health.hasBlockingOperation).toBe(true);
    expect(health.setupAvailable).toBe(false);
    expect(health.badgeLabel).not.toBe('Setup required');
  });

  it('allows repair for divergence only while the writer is idle', () => {
    expect(derivePublishingHealth({
      ...ACTIVE_AND_ALIGNED,
      divergedProjectsCount: 1,
      blockingOperation: null,
    }).repairAvailable).toBe(true);
    expect(derivePublishingHealth({
      ...ACTIVE_AND_ALIGNED,
      divergedProjectsCount: 1,
      blockingOperation: operation('WRITE_STARTED', LIVE),
    }).repairAvailable).toBe(false);
    expect(derivePublishingHealth({
      ...ACTIVE_AND_ALIGNED,
      divergedProjectsCount: 1,
      blockingOperation: operation('PREPARED', EXPIRED),
    }).repairAvailable).toBe(false);
  });

  it('reports no issues when publishing is active, idle and aligned', () => {
    const health = derivePublishingHealth({ ...ACTIVE_AND_ALIGNED, blockingOperation: null });
    expect(health.badgeLabel).toBe('Publishing ready');
    expect(health.summaryLabel).toBe('Ready');
    expect(health.healthLabel).toBe('No issues');
  });

  it('counts projects needing repair in singular and plural', () => {
    expect(derivePublishingHealth({
      ...ACTIVE_AND_ALIGNED, blockingOperation: null, divergedProjectsCount: 1,
    }).healthLabel).toBe('1 project needs repair');
    expect(derivePublishingHealth({
      ...ACTIVE_AND_ALIGNED, blockingOperation: null, divergedProjectsCount: 3,
    }).healthLabel).toBe('3 projects need repair');
  });
});
