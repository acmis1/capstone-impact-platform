import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());

import { createSupabaseAdminClientCore } from '../lib/supabase/adminCore';
import { getServerEnv } from '../lib/env';
import { validateStagingGuard } from '../security/stagingExecutionGuard';
import {
  checkHostedDeploymentReadinessWithClient,
  formatHostedReadinessReport,
  HostedReadinessEvaluation,
  HostedReadinessClient,
  evaluateHostedDeploymentReadiness,
  fetchPostgrestOpenApi,
} from '../deployment/hostedDeploymentReadiness';

function unavailableEvidence(targetIdentityMatch: boolean, inspectionBlocked = false) {
  return evaluateHostedDeploymentReadiness({
    targetIdentityMatch,
    inspectionBlocked,
    migrationHistoryReadable: false,
    recordedMigrationVersions: [],
    presentTables: [],
    rpcMetadataReadable: false,
    presentRpcNames: [],
    presentRpcSignatures: [],
    relationMetadataReadable: false,
    publicRelations: [],
    storageEvidenceReadable: false,
    presentBuckets: [],
    authUserIdColumnPresent: null,
    initialAdminLinkagePresent: null,
    recognizedRolesPresent: null,
  });
}

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
    const blockedEval = unavailableEvidence(false);

    console.log(formatHostedReadinessReport(blockedEval));
    return { evaluation: blockedEval, exitCode: 1 };
  }

  // 2. Initialize Supabase Admin Client Core
  let supabase: HostedReadinessClient;
  let openApiDocument: unknown;
  try {
    const serverEnv = getServerEnv();
    supabase = createSupabaseAdminClientCore() as unknown as HostedReadinessClient;
    try {
      openApiDocument = await fetchPostgrestOpenApi(
        serverEnv.supabaseUrl,
        serverEnv.supabaseDatabaseAdminKey
      );
    } catch {
      openApiDocument = undefined;
    }
  } catch {
    const errorEval = unavailableEvidence(true, true);

    console.log(formatHostedReadinessReport(errorEval));
    return { evaluation: errorEval, exitCode: 1 };
  }

  // 3. Delegate to pure, read-only client checker
  const evaluation = await checkHostedDeploymentReadinessWithClient(supabase, {
    targetIdentityMatch: guardPassed,
    openApiDocument,
  });

  console.log(formatHostedReadinessReport(evaluation));

  let exitCode: 0 | 1 | 2 = 0;
  if (evaluation.deploymentClassification === 'READY_FOR_MUTATION_DECISION') {
    exitCode = 0;
  } else if (
    evaluation.deploymentClassification === 'MANUAL_EVIDENCE_REQUIRED' ||
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
