import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());

import { createSupabaseAdminClientCore } from '../lib/supabase/adminCore';
import { validateStagingGuard } from '../security/stagingExecutionGuard';
import {
  checkHostedDeploymentReadinessWithClient,
  formatHostedReadinessReport,
  HostedReadinessEvaluation,
  HostedReadinessClient,
  evaluateHostedDeploymentReadiness,
} from '../deployment/hostedDeploymentReadiness';

export interface RunCheckHostedDeploymentReadinessResult {
  evaluation: HostedReadinessEvaluation;
  exitCode: 0 | 1 | 2;
}

/**
 * Public CLI runner function.
 * Enforces staging guard validation before attempting client creation.
 * If guard fails, fails closed and outputs safe redacted report without leaking secrets or errors.
 */
export async function runCheckHostedDeploymentReadiness(
  args?: string[]
): Promise<RunCheckHostedDeploymentReadinessResult> {
  // 1. Validate staging target identity guard
  let guardPassed = false;
  try {
    validateStagingGuard({
      operationId: 'check-hosted-deployment-readiness',
      args,
    });
    guardPassed = true;
  } catch {
    const blockedEval = evaluateHostedDeploymentReadiness({
      targetIdentityMatch: false,
      migrationHistoryReadable: false,
      recordedMigrationVersions: [],
      presentTables: [],
      presentRpcs: [],
      presentBuckets: [],
      authUserIdColumnPresent: false,
      initialAdminLinkagePresent: false,
      recognizedRolesPresent: false,
    });

    console.log(formatHostedReadinessReport(blockedEval));
    return { evaluation: blockedEval, exitCode: 1 };
  }

  // 2. Initialize Supabase Admin Client Core
  let supabase: HostedReadinessClient;
  try {
    supabase = createSupabaseAdminClientCore() as unknown as HostedReadinessClient;
  } catch {
    const errorEval = evaluateHostedDeploymentReadiness({
      targetIdentityMatch: true,
      migrationHistoryReadable: false,
      recordedMigrationVersions: [],
      presentTables: [],
      presentRpcs: [],
      presentBuckets: [],
      authUserIdColumnPresent: false,
      initialAdminLinkagePresent: false,
      recognizedRolesPresent: false,
    });

    console.log(formatHostedReadinessReport(errorEval));
    return { evaluation: errorEval, exitCode: 1 };
  }

  // 3. Delegate to pure, read-only client checker
  const evaluation = await checkHostedDeploymentReadinessWithClient(supabase, {
    targetIdentityMatch: guardPassed,
  });

  console.log(formatHostedReadinessReport(evaluation));

  let exitCode: 0 | 1 | 2 = 0;
  if (evaluation.deploymentClassification === 'READY_FOR_MUTATION_DECISION') {
    exitCode = 0;
  } else if (
    evaluation.deploymentClassification === 'RECONCILIATION_REQUIRED' ||
    evaluation.deploymentClassification === 'DRIFT_REQUIRES_REVIEW'
  ) {
    exitCode = 2;
  } else {
    exitCode = 1;
  }

  return { evaluation, exitCode };
}

if (require.main === module) {
  runCheckHostedDeploymentReadiness()
    .then((res) => {
      process.exit(res.exitCode);
    })
    .catch(() => {
      process.exit(1);
    });
}
