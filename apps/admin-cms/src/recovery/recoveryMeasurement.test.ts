import { describe, expect, it } from 'vitest';
import {
  RECOVERY_MEASUREMENT_AUTHORITIES,
  SUPPORTED_RECOVERY_MEASUREMENT_SCENARIO,
  formatRecoveryMeasurement,
  measureBoundedRecovery,
  type RecoveryMeasurementEvidence,
} from './recoveryMeasurement';

function completeEvidence(
  overrides: Partial<RecoveryMeasurementEvidence> = {},
): RecoveryMeasurementEvidence {
  return {
    scenario: SUPPORTED_RECOVERY_MEASUREMENT_SCENARIO,
    incidentReference: {
      at: '2026-09-08T12:00:00.000Z',
      authority: RECOVERY_MEASUREMENT_AUTHORITIES.incidentReference,
    },
    recoveryPoint: {
      at: '2026-09-08T11:55:00.000Z',
      authority: RECOVERY_MEASUREMENT_AUTHORITIES.recoveryPoint,
    },
    recoveryStarted: {
      at: '2026-09-08T12:02:00.000Z',
      authority: RECOVERY_MEASUREMENT_AUTHORITIES.recoveryStarted,
    },
    serviceAcceptance: {
      completedAt: '2026-09-08T12:12:00.000Z',
      authority: RECOVERY_MEASUREMENT_AUTHORITIES.serviceAcceptanceCompletion,
      applicationSmokeAttestation: RECOVERY_MEASUREMENT_AUTHORITIES.applicationSmoke,
    },
    finalRehearsalClassification: 'ZERO_COST_RECOVERY_REHEARSAL_VERIFIED',
    ...overrides,
  };
}

function reasonsFor(input: unknown): readonly string[] {
  const result = measureBoundedRecovery(input);
  expect(result.status).toBe('NOT_PROVEN');
  return result.status === 'NOT_PROVEN' ? result.reasons : [];
}

describe('bounded staging recovery measurement', () => {
  it('measures the canonical bounded scenario with RTO from recovery start', () => {
    expect(measureBoundedRecovery(completeEvidence())).toEqual({
      status: 'MEASURED',
      scenario: SUPPORTED_RECOVERY_MEASUREMENT_SCENARIO,
      finalRehearsalClassification: 'ZERO_COST_RECOVERY_REHEARSAL_VERIFIED',
      applicationSmokeAttestation: RECOVERY_MEASUREMENT_AUTHORITIES.applicationSmoke,
      measurement: {
        achievedRpoMs: 300_000,
        achievedRtoMs: 600_000,
        rpoBoundary: 'RECOVERY_POINT_TO_INCIDENT_REFERENCE',
        rtoBoundary: 'RECOVERY_START_TO_SERVICE_ACCEPTANCE_COMPLETION',
      },
      organizationalObjectives: null,
    });
  });

  it('requires an incident reference and validates its timestamp and authority', () => {
    const missing: Partial<RecoveryMeasurementEvidence> = { ...completeEvidence() };
    delete missing.incidentReference;
    expect(reasonsFor(missing)).toContain('INCIDENT_REFERENCE_MISSING');

    expect(reasonsFor(completeEvidence({
      incidentReference: { at: 'not-a-time', authority: RECOVERY_MEASUREMENT_AUTHORITIES.incidentReference },
    }))).toContain('INCIDENT_REFERENCE_TIMESTAMP_INVALID');

    expect(reasonsFor(completeEvidence({
      incidentReference: { at: '2026-09-08T12:00:00.000Z', authority: 'capture-start' as never },
    }))).toContain('INCIDENT_REFERENCE_AUTHORITY_INVALID');
  });

  it('requires an authoritative recovery point', () => {
    const missing: Partial<RecoveryMeasurementEvidence> = { ...completeEvidence() };
    delete missing.recoveryPoint;
    expect(reasonsFor(missing)).toContain('RECOVERY_POINT_MISSING');
    expect(reasonsFor(completeEvidence({
      recoveryPoint: { at: '2026-09-08T11:55:00Z', authority: RECOVERY_MEASUREMENT_AUTHORITIES.recoveryPoint },
    }))).toContain('RECOVERY_POINT_TIMESTAMP_INVALID');
    expect(reasonsFor(completeEvidence({
      recoveryPoint: { at: '2026-09-08T11:55:00.000Z', authority: 'capture-complete' as never },
    }))).toContain('RECOVERY_POINT_AUTHORITY_INVALID');
  });

  it('requires an authoritative recovery start', () => {
    const missing: Partial<RecoveryMeasurementEvidence> = { ...completeEvidence() };
    delete missing.recoveryStarted;
    expect(reasonsFor(missing)).toContain('RECOVERY_START_MISSING');
    expect(reasonsFor(completeEvidence({
      recoveryStarted: { at: 'bad-time', authority: RECOVERY_MEASUREMENT_AUTHORITIES.recoveryStarted },
    }))).toContain('RECOVERY_START_TIMESTAMP_INVALID');
    expect(reasonsFor(completeEvidence({
      recoveryStarted: { at: '2026-09-08T12:02:00.000Z', authority: 'restore-start' as never },
    }))).toContain('RECOVERY_START_AUTHORITY_INVALID');
  });

  it('requires authoritative service acceptance', () => {
    const missing: Partial<RecoveryMeasurementEvidence> = { ...completeEvidence() };
    delete missing.serviceAcceptance;
    expect(reasonsFor(missing)).toContain('ACCEPTANCE_COMPLETION_MISSING');
    expect(reasonsFor(completeEvidence({
      serviceAcceptance: {
        ...completeEvidence().serviceAcceptance,
        completedAt: '2026-09-08T12:12:00Z',
      },
    }))).toContain('ACCEPTANCE_COMPLETION_TIMESTAMP_INVALID');
    expect(reasonsFor(completeEvidence({
      serviceAcceptance: {
        ...completeEvidence().serviceAcceptance,
        authority: 'restore-complete' as never,
      },
    }))).toContain('ACCEPTANCE_COMPLETION_AUTHORITY_INVALID');
  });

  it('rejects recovery points after the incident', () => {
    expect(reasonsFor(completeEvidence({
      recoveryPoint: {
        ...completeEvidence().recoveryPoint,
        at: '2026-09-08T12:00:00.001Z',
      },
    }))).toContain('RECOVERY_POINT_AFTER_INCIDENT_REFERENCE');
  });

  it('rejects recovery start before the incident', () => {
    expect(reasonsFor(completeEvidence({
      recoveryStarted: {
        ...completeEvidence().recoveryStarted,
        at: '2026-09-08T11:59:59.999Z',
      },
    }))).toContain('RECOVERY_START_BEFORE_INCIDENT_REFERENCE');
  });

  it('rejects service acceptance before recovery start', () => {
    expect(reasonsFor(completeEvidence({
      serviceAcceptance: {
        ...completeEvidence().serviceAcceptance,
        completedAt: '2026-09-08T12:01:59.999Z',
      },
    }))).toContain('ACCEPTANCE_BEFORE_RECOVERY_START');
  });

  it('permits a zero-duration boundary when chronology is consistent', () => {
    const at = '2026-09-08T12:00:00.000Z';
    const result = measureBoundedRecovery(completeEvidence({
      incidentReference: { ...completeEvidence().incidentReference, at },
      recoveryPoint: { ...completeEvidence().recoveryPoint, at },
      recoveryStarted: { ...completeEvidence().recoveryStarted, at },
      serviceAcceptance: { ...completeEvidence().serviceAcceptance, completedAt: at },
    }));
    expect(result.status === 'MEASURED' && result.measurement).toMatchObject({
      achievedRpoMs: 0,
      achievedRtoMs: 0,
    });
  });

  it('rejects unsupported and production/hosted overclaim scenarios', () => {
    expect(reasonsFor({ ...completeEvidence(), scenario: 'LOCAL_TO_LOCAL' }))
      .toContain('SCENARIO_UNSUPPORTED');
    expect(reasonsFor({ ...completeEvidence(), scenario: 'PRODUCTION_HOSTED_TO_HOSTED' }))
      .toContain('PRODUCTION_OR_HOSTED_SCENARIO_NOT_SUPPORTED');
    expect(reasonsFor({ ...completeEvidence(), scenario: 'MANAGED_SUPABASE_PITR' }))
      .toContain('PRODUCTION_OR_HOSTED_SCENARIO_NOT_SUPPORTED');
  });

  it('requires the final rehearsal classification', () => {
    const input: Partial<RecoveryMeasurementEvidence> = { ...completeEvidence() };
    delete input.finalRehearsalClassification;
    expect(reasonsFor(input)).toContain('FINAL_REHEARSAL_CLASSIFICATION_MISSING');
  });

  it('rejects non-success and cleanup-failed final classifications', () => {
    expect(reasonsFor(completeEvidence({
      finalRehearsalClassification: 'RESTORE_INTEGRITY_DRIFT',
    }))).toContain('FINAL_REHEARSAL_NOT_VERIFIED');
    expect(reasonsFor(completeEvidence({
      finalRehearsalClassification: 'CLEANUP_FAILED',
    }))).toContain('FINAL_REHEARSAL_NOT_VERIFIED');
  });

  it('requires explicit application-smoke attestation even when final classification is VERIFIED', () => {
    const input = completeEvidence() as unknown as Record<string, unknown>;
    input.serviceAcceptance = {
      completedAt: '2026-09-08T12:12:00.000Z',
      authority: RECOVERY_MEASUREMENT_AUTHORITIES.serviceAcceptanceCompletion,
    };
    expect(reasonsFor(input)).toContain('APPLICATION_SMOKE_ATTESTATION_MISSING');
  });

  it('rejects skipped, failed, or arbitrary application-smoke evidence', () => {
    for (const applicationSmokeAttestation of ['NOT_RUN', 'FAILED', 'anything-else']) {
      expect(reasonsFor(completeEvidence({
        serviceAcceptance: {
          ...completeEvidence().serviceAcceptance,
          applicationSmokeAttestation: applicationSmokeAttestation as never,
        },
      }))).toContain('APPLICATION_SMOKE_ATTESTATION_INVALID');
    }
  });

  it('accepts the fixed application-smoke contract match attestation', () => {
    const result = measureBoundedRecovery(completeEvidence());
    expect(result.status).toBe('MEASURED');
  });

  it('does not add cleanup time to RTO', () => {
    const result = measureBoundedRecovery({
      ...completeEvidence(),
      cleanupCompletedAt: '2026-09-08T12:45:00.000Z',
    });
    expect(result.status === 'MEASURED' && result.measurement.achievedRtoMs).toBe(600_000);
  });

  it('does not accept caller-provided target-looking fields as objectives', () => {
    const result = measureBoundedRecovery({
      ...completeEvidence(),
      rpoTargetMs: 1,
      rtoTargetMs: 2,
    });
    expect(result.status).toBe('MEASURED');
    expect(result.organizationalObjectives).toBeNull();
    const output = formatRecoveryMeasurement(result);
    expect(output).toContain('RPO_TARGET_MS = NOT_PROVIDED');
    expect(output).toContain('RTO_TARGET_MS = NOT_PROVIDED');
  });

  it('does not reinterpret historical duration and backup-age fields as formal metrics', () => {
    const historicalTimingEvidence = {
      scenario: SUPPORTED_RECOVERY_MEASUREMENT_SCENARIO,
      backupDurationMs: 174_381,
      backupAgeAtRestoreStartMs: 2_631_409,
      restoreDurationMs: 44_699,
      verificationDurationMs: 69_212,
    };
    expect(reasonsFor(historicalTimingEvidence)).toEqual(expect.arrayContaining([
      'INCIDENT_REFERENCE_MISSING',
      'RECOVERY_POINT_MISSING',
      'RECOVERY_START_MISSING',
      'ACCEPTANCE_COMPLETION_MISSING',
      'FINAL_REHEARSAL_CLASSIFICATION_MISSING',
    ]));
  });

  it('formats sanitized output without echoing unknown private input fields', () => {
    const sensitiveValues = [
      'C:\\private\\recovery-bundle',
      'participant/private-object-key.png',
      'postgresql://user:password@private.example/database',
      'sb_secret_example',
    ];
    const result = measureBoundedRecovery({
      ...completeEvidence(),
      privateBundlePath: sensitiveValues[0],
      objectKey: sensitiveValues[1],
      connectionString: sensitiveValues[2],
      token: sensitiveValues[3],
    });
    const output = formatRecoveryMeasurement(result);
    for (const sensitiveValue of sensitiveValues) expect(output).not.toContain(sensitiveValue);
    expect(output).toContain('ACHIEVED_RPO_MS = 300000');
    expect(output).toContain('ACHIEVED_RTO_MS = 600000');
    expect(output).toContain(
      `APPLICATION_SMOKE_ATTESTATION = ${RECOVERY_MEASUREMENT_AUTHORITIES.applicationSmoke}`,
    );
  });
});
