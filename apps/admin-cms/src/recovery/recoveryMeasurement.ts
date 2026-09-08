import type { RecoveryClassification } from './zeroCostRecoveryContract';

export const SUPPORTED_RECOVERY_MEASUREMENT_SCENARIO =
  'STAGING_ORIGIN_TO_ISOLATED_TARGET' as const;

export type RecoveryMeasurementScenario =
  typeof SUPPORTED_RECOVERY_MEASUREMENT_SCENARIO;

export const RECOVERY_MEASUREMENT_AUTHORITIES = Object.freeze({
  incidentReference: 'INCIDENT_DECLARED_BY_SCENARIO_CONTROLLER',
  recoveryPoint: 'BOUNDED_RECOVERY_SET_WATERMARK',
  recoveryStarted: 'RECOVERY_ORCHESTRATOR_STARTED',
  serviceAcceptanceCompletion: 'RECOVERY_VERIFICATION_COMPLETED_AT',
  applicationSmoke: 'RECOVERY_APPLICATION_SMOKE_CONTRACT_MATCH',
} as const);

export interface RecoveryMeasurementEvidence {
  scenario: RecoveryMeasurementScenario;
  incidentReference: {
    at: string;
    authority: typeof RECOVERY_MEASUREMENT_AUTHORITIES.incidentReference;
  };
  recoveryPoint: {
    at: string;
    authority: typeof RECOVERY_MEASUREMENT_AUTHORITIES.recoveryPoint;
  };
  recoveryStarted: {
    at: string;
    authority: typeof RECOVERY_MEASUREMENT_AUTHORITIES.recoveryStarted;
  };
  serviceAcceptance: {
    completedAt: string;
    authority: typeof RECOVERY_MEASUREMENT_AUTHORITIES.serviceAcceptanceCompletion;
    applicationSmokeAttestation: typeof RECOVERY_MEASUREMENT_AUTHORITIES.applicationSmoke;
  };
  finalRehearsalClassification: RecoveryClassification;
}

export type RecoveryMeasurementNotProvenReason =
  | 'SCENARIO_MISSING'
  | 'SCENARIO_UNSUPPORTED'
  | 'PRODUCTION_OR_HOSTED_SCENARIO_NOT_SUPPORTED'
  | 'INCIDENT_REFERENCE_MISSING'
  | 'INCIDENT_REFERENCE_TIMESTAMP_INVALID'
  | 'INCIDENT_REFERENCE_AUTHORITY_INVALID'
  | 'RECOVERY_POINT_MISSING'
  | 'RECOVERY_POINT_TIMESTAMP_INVALID'
  | 'RECOVERY_POINT_AUTHORITY_INVALID'
  | 'RECOVERY_START_MISSING'
  | 'RECOVERY_START_TIMESTAMP_INVALID'
  | 'RECOVERY_START_AUTHORITY_INVALID'
  | 'ACCEPTANCE_COMPLETION_MISSING'
  | 'ACCEPTANCE_COMPLETION_TIMESTAMP_INVALID'
  | 'ACCEPTANCE_COMPLETION_AUTHORITY_INVALID'
  | 'APPLICATION_SMOKE_ATTESTATION_MISSING'
  | 'APPLICATION_SMOKE_ATTESTATION_INVALID'
  | 'FINAL_REHEARSAL_CLASSIFICATION_MISSING'
  | 'FINAL_REHEARSAL_NOT_VERIFIED'
  | 'RECOVERY_POINT_AFTER_INCIDENT_REFERENCE'
  | 'RECOVERY_START_BEFORE_INCIDENT_REFERENCE'
  | 'ACCEPTANCE_BEFORE_INCIDENT_REFERENCE'
  | 'ACCEPTANCE_BEFORE_RECOVERY_START';

export interface AchievedRecoveryMeasurement {
  /** Data-loss gap: incident reference minus newest authoritative restorable point. */
  achievedRpoMs: number;
  /** Service-recovery gap: recovery start through accepted application smoke completion. */
  achievedRtoMs: number;
  rpoBoundary: 'RECOVERY_POINT_TO_INCIDENT_REFERENCE';
  rtoBoundary: 'RECOVERY_START_TO_SERVICE_ACCEPTANCE_COMPLETION';
}

export type RecoveryMeasurementResult =
  | {
    status: 'MEASURED';
    scenario: RecoveryMeasurementScenario;
    finalRehearsalClassification: 'ZERO_COST_RECOVERY_REHEARSAL_VERIFIED';
    applicationSmokeAttestation: typeof RECOVERY_MEASUREMENT_AUTHORITIES.applicationSmoke;
    measurement: AchievedRecoveryMeasurement;
    organizationalObjectives: null;
  }
  | {
    status: 'NOT_PROVEN';
    scenario: RecoveryMeasurementScenario | null;
    reasons: readonly RecoveryMeasurementNotProvenReason[];
    organizationalObjectives: null;
  };

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function canonicalUtcMilliseconds(value: unknown): number | null {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return null;
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    return null;
  }
  return milliseconds;
}

function scenarioLooksOverclaimed(value: string): boolean {
  return /(PRODUCTION|HOSTED[_-]?TO[_-]?HOSTED|MANAGED|PITR)/i.test(value);
}

function addReason(
  reasons: RecoveryMeasurementNotProvenReason[],
  reason: RecoveryMeasurementNotProvenReason,
): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

/** Validate untrusted rehearsal evidence without serializing unknown fields. */
export function measureBoundedRecovery(input: unknown): RecoveryMeasurementResult {
  const evidence = asRecord(input);
  const reasons: RecoveryMeasurementNotProvenReason[] = [];
  const scenario = evidence?.scenario;
  const supportedScenario = scenario === SUPPORTED_RECOVERY_MEASUREMENT_SCENARIO;

  if (scenario === undefined || scenario === null || scenario === '') {
    addReason(reasons, 'SCENARIO_MISSING');
  } else if (!supportedScenario) {
    addReason(
      reasons,
      typeof scenario === 'string' && scenarioLooksOverclaimed(scenario)
        ? 'PRODUCTION_OR_HOSTED_SCENARIO_NOT_SUPPORTED'
        : 'SCENARIO_UNSUPPORTED',
    );
  }

  const incident = asRecord(evidence?.incidentReference);
  const recoveryPoint = asRecord(evidence?.recoveryPoint);
  const recoveryStarted = asRecord(evidence?.recoveryStarted);
  const serviceAcceptance = asRecord(evidence?.serviceAcceptance);
  const finalRehearsalClassification = evidence?.finalRehearsalClassification;

  if (!incident) addReason(reasons, 'INCIDENT_REFERENCE_MISSING');
  if (!recoveryPoint) addReason(reasons, 'RECOVERY_POINT_MISSING');
  if (!recoveryStarted) addReason(reasons, 'RECOVERY_START_MISSING');
  if (!serviceAcceptance) addReason(reasons, 'ACCEPTANCE_COMPLETION_MISSING');

  if (finalRehearsalClassification === undefined
    || finalRehearsalClassification === null
    || finalRehearsalClassification === '') {
    addReason(reasons, 'FINAL_REHEARSAL_CLASSIFICATION_MISSING');
  } else if (finalRehearsalClassification !== 'ZERO_COST_RECOVERY_REHEARSAL_VERIFIED') {
    addReason(reasons, 'FINAL_REHEARSAL_NOT_VERIFIED');
  }

  const incidentMs = canonicalUtcMilliseconds(incident?.at);
  const recoveryPointMs = canonicalUtcMilliseconds(recoveryPoint?.at);
  const recoveryStartedMs = canonicalUtcMilliseconds(recoveryStarted?.at);
  const serviceAcceptanceMs = canonicalUtcMilliseconds(serviceAcceptance?.completedAt);

  if (incident && (incident.at === undefined || incident.at === null || incident.at === '')) {
    addReason(reasons, 'INCIDENT_REFERENCE_MISSING');
  } else if (incident && incidentMs === null) {
    addReason(reasons, 'INCIDENT_REFERENCE_TIMESTAMP_INVALID');
  }

  if (recoveryPoint
    && (recoveryPoint.at === undefined || recoveryPoint.at === null || recoveryPoint.at === '')) {
    addReason(reasons, 'RECOVERY_POINT_MISSING');
  } else if (recoveryPoint && recoveryPointMs === null) {
    addReason(reasons, 'RECOVERY_POINT_TIMESTAMP_INVALID');
  }

  if (recoveryStarted
    && (recoveryStarted.at === undefined || recoveryStarted.at === null || recoveryStarted.at === '')) {
    addReason(reasons, 'RECOVERY_START_MISSING');
  } else if (recoveryStarted && recoveryStartedMs === null) {
    addReason(reasons, 'RECOVERY_START_TIMESTAMP_INVALID');
  }

  if (serviceAcceptance
    && (serviceAcceptance.completedAt === undefined
      || serviceAcceptance.completedAt === null
      || serviceAcceptance.completedAt === '')) {
    addReason(reasons, 'ACCEPTANCE_COMPLETION_MISSING');
  } else if (serviceAcceptance && serviceAcceptanceMs === null) {
    addReason(reasons, 'ACCEPTANCE_COMPLETION_TIMESTAMP_INVALID');
  }

  if (incident && incident.authority !== RECOVERY_MEASUREMENT_AUTHORITIES.incidentReference) {
    addReason(reasons, 'INCIDENT_REFERENCE_AUTHORITY_INVALID');
  }
  if (recoveryPoint && recoveryPoint.authority !== RECOVERY_MEASUREMENT_AUTHORITIES.recoveryPoint) {
    addReason(reasons, 'RECOVERY_POINT_AUTHORITY_INVALID');
  }
  if (recoveryStarted && recoveryStarted.authority !== RECOVERY_MEASUREMENT_AUTHORITIES.recoveryStarted) {
    addReason(reasons, 'RECOVERY_START_AUTHORITY_INVALID');
  }
  if (serviceAcceptance
    && serviceAcceptance.authority !== RECOVERY_MEASUREMENT_AUTHORITIES.serviceAcceptanceCompletion) {
    addReason(reasons, 'ACCEPTANCE_COMPLETION_AUTHORITY_INVALID');
  }

  if (serviceAcceptance) {
    const smokeAttestation = serviceAcceptance.applicationSmokeAttestation;
    if (smokeAttestation === undefined || smokeAttestation === null || smokeAttestation === '') {
      addReason(reasons, 'APPLICATION_SMOKE_ATTESTATION_MISSING');
    } else if (smokeAttestation !== RECOVERY_MEASUREMENT_AUTHORITIES.applicationSmoke) {
      addReason(reasons, 'APPLICATION_SMOKE_ATTESTATION_INVALID');
    }
  }

  if (recoveryPointMs !== null && incidentMs !== null && recoveryPointMs > incidentMs) {
    addReason(reasons, 'RECOVERY_POINT_AFTER_INCIDENT_REFERENCE');
  }
  if (recoveryStartedMs !== null && incidentMs !== null && recoveryStartedMs < incidentMs) {
    addReason(reasons, 'RECOVERY_START_BEFORE_INCIDENT_REFERENCE');
  }
  if (serviceAcceptanceMs !== null && incidentMs !== null && serviceAcceptanceMs < incidentMs) {
    addReason(reasons, 'ACCEPTANCE_BEFORE_INCIDENT_REFERENCE');
  }
  if (serviceAcceptanceMs !== null
    && recoveryStartedMs !== null
    && serviceAcceptanceMs < recoveryStartedMs) {
    addReason(reasons, 'ACCEPTANCE_BEFORE_RECOVERY_START');
  }

  if (reasons.length > 0
    || !supportedScenario
    || incidentMs === null
    || recoveryPointMs === null
    || recoveryStartedMs === null
    || serviceAcceptanceMs === null
    || serviceAcceptance?.applicationSmokeAttestation
      !== RECOVERY_MEASUREMENT_AUTHORITIES.applicationSmoke
    || finalRehearsalClassification !== 'ZERO_COST_RECOVERY_REHEARSAL_VERIFIED') {
    return {
      status: 'NOT_PROVEN',
      scenario: supportedScenario ? SUPPORTED_RECOVERY_MEASUREMENT_SCENARIO : null,
      reasons,
      organizationalObjectives: null,
    };
  }

  return {
    status: 'MEASURED',
    scenario: SUPPORTED_RECOVERY_MEASUREMENT_SCENARIO,
    finalRehearsalClassification: 'ZERO_COST_RECOVERY_REHEARSAL_VERIFIED',
    applicationSmokeAttestation: RECOVERY_MEASUREMENT_AUTHORITIES.applicationSmoke,
    measurement: {
      achievedRpoMs: incidentMs - recoveryPointMs,
      achievedRtoMs: serviceAcceptanceMs - recoveryStartedMs,
      rpoBoundary: 'RECOVERY_POINT_TO_INCIDENT_REFERENCE',
      rtoBoundary: 'RECOVERY_START_TO_SERVICE_ACCEPTANCE_COMPLETION',
    },
    organizationalObjectives: null,
  };
}

/** Produces only fixed labels, reason codes, classifications, and calculated values. */
export function formatRecoveryMeasurement(result: RecoveryMeasurementResult): string {
  const lines = [
    `RECOVERY_MEASUREMENT_STATUS = ${result.status}`,
    `RECOVERY_MEASUREMENT_SCENARIO = ${result.scenario ?? 'UNPROVEN'}`,
    'RPO_TARGET_MS = NOT_PROVIDED',
    'RTO_TARGET_MS = NOT_PROVIDED',
  ];

  if (result.status === 'MEASURED') {
    lines.push(`FINAL_REHEARSAL_CLASSIFICATION = ${result.finalRehearsalClassification}`);
    lines.push(`APPLICATION_SMOKE_ATTESTATION = ${result.applicationSmokeAttestation}`);
    lines.push(`ACHIEVED_RPO_MS = ${result.measurement.achievedRpoMs}`);
    lines.push(`ACHIEVED_RTO_MS = ${result.measurement.achievedRtoMs}`);
    lines.push(`RPO_BOUNDARY = ${result.measurement.rpoBoundary}`);
    lines.push(`RTO_BOUNDARY = ${result.measurement.rtoBoundary}`);
  } else {
    for (const reason of result.reasons) {
      lines.push(`NOT_PROVEN_REASON = ${reason}`);
    }
  }

  return lines.join('\n');
}
