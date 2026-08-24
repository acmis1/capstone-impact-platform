import { execSync } from 'node:child_process';
import path from 'node:path';
import { isLoopbackUrl, parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';
import {
  FUNCTIONAL_WORKFLOW_PROJECT_COUNT,
  runBulkProjectReviewFunctionalWorkflow,
  type FunctionalWorkflowReport,
} from '../benchmarks/bulkProjectReviewFunctionalWorkflow';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

/** Reported as an operating target for the Local stack only, never as a hosted SLO. */
const LOCAL_WORKFLOW_TARGET_MS = 60_000;

function localEnv(): { apiUrl: string; serviceRoleKey: string } {
  if (
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.SUPABASE_SERVICE_ROLE_KEY &&
    isLoopbackUrl(process.env.NEXT_PUBLIC_SUPABASE_URL)
  ) {
    return {
      apiUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    };
  }
  const cliPath = path.resolve(REPO_ROOT, 'node_modules/.bin/supabase');
  let output: string;
  try {
    output = execSync(`"${cliPath}" status --workdir "${path.resolve(REPO_ROOT, 'infra')}" -o env`, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch {
    throw new Error('A running loopback Local Supabase stack is required.');
  }
  const env = parseSupabaseCliEnv(output);
  if (!env.API_URL || !env.SERVICE_ROLE_KEY || !isLoopbackUrl(env.API_URL)) {
    throw new Error('A running loopback Local Supabase stack is required.');
  }
  return { apiUrl: env.API_URL, serviceRoleKey: env.SERVICE_ROLE_KEY };
}

function printReport(report: FunctionalWorkflowReport): void {
  console.log('=== Bulk Project Review 120-Project Functional Workflow (Local Supabase) ===');
  console.log(`seed=${report.seed} syntheticProjects=${report.syntheticProjects} importBatches=${report.importBatches}`);
  console.log(
    `pagination: pageSize=${report.pagination.pageSize} pagesWalked=${report.pagination.pagesWalked} ` +
      `indexTotal=${report.pagination.unfilteredTotal} selectedAcrossPages=${report.pagination.collectedAcrossPages}`,
  );
  console.log(
    `filtering: status=${report.pagination.filteredStatus} filteredTotal=${report.pagination.filteredTotal} ` +
      `filteredPagesWalked=${report.pagination.filteredPagesWalked} filteredSelected=${report.pagination.filteredCollected}`,
  );
  for (const phase of report.phases) {
    console.log(
      `${phase.phase}: action=${phase.action} cohorts=${phase.cohorts} requestedUnique=${phase.requestedUniqueProjects} ` +
        `resultRows=${phase.resultRows} duplicates=${phase.duplicateResultRows} missing=${phase.missingResultRows} ` +
        `successful=${phase.outcomes.successful} blocked=${phase.outcomes.blocked} ` +
        `alreadyComplete=${phase.outcomes.alreadyComplete} stale=${phase.outcomes.invalidOrStale} ` +
        `failed=${phase.outcomes.failed} durationMs=${phase.durationMs}`,
    );
  }
  console.log(`REQUESTED_UNIQUE_PROJECTS = ${report.phases[0]?.requestedUniqueProjects ?? 0}`);
  console.log(`RESULT_ROWS = ${report.phases[0]?.resultRows ?? 0}`);
  console.log(`AGGREGATE_REQUESTED_UNIQUE_PROJECTS = ${report.requestedUniqueProjects}`);
  console.log(`AGGREGATE_RESULT_ROWS = ${report.resultRows}`);
  console.log(`NO_SILENT_LOSS = ${report.silentlyLostProjects.length === 0 ? 'YES' : 'NO'}`);
  console.log(`NO_DUPLICATE_RESULTS = ${report.duplicateResultRows === 0 ? 'YES' : 'NO'}`);
  console.log(
    `reconciliation: reportedSuccessful=${report.reconciliation.reportedSuccessful} ` +
      `databaseTransitioned=${report.reconciliation.databaseTransitioned} ` +
      `auditRecords=${report.reconciliation.auditRecords} ` +
      `duplicateAudits=${report.reconciliation.duplicateAuditRecords} ` +
      `foreignActorAudits=${report.reconciliation.foreignActorAuditRecords} ` +
      `unmutatedBlocked=${report.reconciliation.unmutatedBlockedProjects} ` +
      `unmutatedStale=${report.reconciliation.unmutatedStaleProjects}`,
  );
  console.log(`WORKFLOW_ELAPSED_MS = ${report.workflowElapsedMs} (Local target ${LOCAL_WORKFLOW_TARGET_MS} ms)`);
  console.log(`referenceFixtures createdPrograms=${report.referenceFixtures.created.programIds.length} createdDisciplines=${report.referenceFixtures.created.disciplineIds.length} createdIndustryCategories=${report.referenceFixtures.created.industryIds.length}`);
  console.log(
    `cleanup=${report.cleanup.clean ? 'clean' : 'residue'} residualProjects=${report.cleanup.residualProjects} ` +
      `residualBatches=${report.cleanup.residualBatches} residualAudits=${report.cleanup.residualAudits} ` +
      `residualReferencePrograms=${report.cleanup.residualReferencePrograms} ` +
      `residualReferenceDisciplines=${report.cleanup.residualReferenceDisciplines} ` +
      `residualReferenceIndustryCategories=${report.cleanup.residualReferenceIndustryCategories}`,
  );
}

export async function verifyBulkProjectReviewFunctionalWorkflow(): Promise<void> {
  const env = localEnv();
  const report = await runBulkProjectReviewFunctionalWorkflow({
    apiUrl: env.apiUrl,
    serviceRoleKey: env.serviceRoleKey,
  });
  printReport(report);

  const failures: string[] = [];
  if (report.syntheticProjects !== FUNCTIONAL_WORKFLOW_PROJECT_COUNT) failures.push('cohort size');
  if (report.pagination.collectedAcrossPages !== FUNCTIONAL_WORKFLOW_PROJECT_COUNT) failures.push('selection across pages');
  if (report.pagination.pagesWalked < 2) failures.push('pagination coverage');
  if (report.pagination.filteredCollected >= report.pagination.unfilteredTotal) failures.push('filtering coverage');
  for (const phase of report.phases) {
    if (phase.requestedUniqueProjects !== FUNCTIONAL_WORKFLOW_PROJECT_COUNT) failures.push(`${phase.phase} requested count`);
    if (phase.resultRows !== FUNCTIONAL_WORKFLOW_PROJECT_COUNT) failures.push(`${phase.phase} result rows`);
    if (phase.duplicateResultRows !== 0) failures.push(`${phase.phase} duplicate results`);
    if (phase.missingResultRows !== 0) failures.push(`${phase.phase} missing results`);
    if (phase.outcomes.failed !== 0) failures.push(`${phase.phase} failures`);
  }
  if (report.silentlyLostProjects.length !== 0) failures.push('silent loss');
  if (report.duplicateResultRows !== 0) failures.push('duplicate results');
  if (report.reconciliation.duplicateAuditRecords !== 0) failures.push('duplicate audit records');
  if (report.reconciliation.foreignActorAuditRecords !== 0) failures.push('audit actor attribution');
  if (report.workflowElapsedMs >= LOCAL_WORKFLOW_TARGET_MS) failures.push('Local workflow duration target');
  if (!report.cleanup.clean) failures.push('fixture cleanup');

  if (failures.length > 0) {
    throw new Error(`Bulk project review functional workflow verification failed: ${failures.join('; ')}.`);
  }
}

if (require.main === module) {
  verifyBulkProjectReviewFunctionalWorkflow().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Bulk project review functional workflow failed.');
    process.exitCode = 1;
  });
}
