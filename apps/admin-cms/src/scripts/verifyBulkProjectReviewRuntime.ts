import { execSync } from 'node:child_process';
import path from 'node:path';
import { parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';
import { isLoopbackUrl } from '../local-development/localEnvironmentFile';
import { runBulkProjectReviewRuntime } from '../benchmarks/bulkProjectReviewRuntime';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

function localEnv(): { apiUrl: string; serviceRoleKey: string } {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && isLoopbackUrl(process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    return { apiUrl: process.env.NEXT_PUBLIC_SUPABASE_URL, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY };
  }
  const cliPath = path.resolve(REPO_ROOT, 'node_modules/.bin/supabase');
  let output: string;
  try {
    output = execSync(`"${cliPath}" status --workdir "${path.resolve(REPO_ROOT, 'infra')}" -o env`, { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'pipe' });
  } catch {
    throw new Error('A running loopback Local Supabase stack is required.');
  }
  const env = parseSupabaseCliEnv(output);
  if (!env.API_URL || !env.SERVICE_ROLE_KEY || !isLoopbackUrl(env.API_URL)) throw new Error('A running loopback Local Supabase stack is required.');
  return { apiUrl: env.API_URL, serviceRoleKey: env.SERVICE_ROLE_KEY };
}

function printReport(report: Awaited<ReturnType<typeof runBulkProjectReviewRuntime>>): void {
  console.log('=== Bulk Project Review Local Runtime Verification ===');
  console.log(`seed=${report.seed}`);
  console.log(`cohort total=${report.total} selected=${report.selected} batches=${report.batchCount}`);
  console.log(`submit preflight: selected=${report.submit.preflight.total} eligible=${report.submit.preflight.eligible} blocked=${report.submit.preflight.blocked} alreadyComplete=${report.submit.preflight.alreadyComplete} invalidOrStale=${report.submit.preflight.invalidOrStale}`);
  console.log(`submit execution: selected=${report.submit.execution.total} successfulProjects=${report.submit.execution.successful} blocked=${report.submit.execution.blocked} alreadyComplete=${report.submit.execution.alreadyComplete} invalidOrStale=${report.submit.execution.invalidOrStale} failed=${report.submit.execution.failed}`);
  console.log(`approval preflight: selected=${report.approval.preflight.total} eligible=${report.approval.preflight.eligible} blocked=${report.approval.preflight.blocked} alreadyComplete=${report.approval.preflight.alreadyComplete} invalidOrStale=${report.approval.preflight.invalidOrStale}`);
  console.log(`approval execution: selected=${report.approval.execution.total} successfulProjects=${report.approval.execution.successful} blocked=${report.approval.execution.blocked} alreadyComplete=${report.approval.execution.alreadyComplete} stale=${report.approval.execution.invalidOrStale} failed=${report.approval.execution.failed}`);
  console.log(`request_changes execution: successfulProjects=${report.requestChanges.execution.successful} commentValidated=true`);
  console.log(`workflowTransitions=${report.workflowTransitions} uniqueProjectsTransitioned=${report.uniqueProjectsTransitioned} auditCount=${report.auditCount} duplicateAudits=${report.duplicateAudits}`);
  console.log(`staleProjectIds=${report.staleProjectIds.join(',')}`);
  console.log(`concurrency duplicate=${report.concurrency.duplicateExecution} sameActionOverlap=${report.concurrency.sameActionOverlap} conflictingOverlap=${report.concurrency.conflictingOverlap} stalePreflight=${report.concurrency.stalePreflight} deadlocks=${report.concurrency.deadlocks}`);
  for (const stage of report.stages) console.log(`${stage.stage}: selected=${stage.selected} eligible=${stage.eligible} blocked=${stage.blocked} alreadyComplete=${stage.alreadyComplete} invalidOrStale=${stage.invalidOrStale} successful=${stage.successful} failed=${stage.failed} durationMs=${stage.durationMs}`);
  console.log(`cleanup=${report.cleanup.clean ? 'clean' : 'residue'} ${Object.entries(report.cleanup.residue).map(([key, value]) => `residual${key[0].toUpperCase()}${key.slice(1)}=${value}`).join(' ')}`);
}

export async function verifyBulkProjectReviewRuntime(): Promise<void> {
  const env = localEnv();
  const report = await runBulkProjectReviewRuntime({ apiUrl: env.apiUrl, serviceRoleKey: env.serviceRoleKey, evidenceMode: process.argv.includes('--evidence') });
  printReport(report);
  if (!report.cleanup.clean || report.total !== 100 || report.selected !== 100 || report.submit.execution.successful !== 40 || report.approval.execution.successful !== 46 || report.approval.execution.invalidOrStale !== 4 || report.requestChanges.execution.successful !== 1 || report.workflowTransitions !== 89 || report.uniqueProjectsTransitioned !== 52 || report.duplicateAudits !== 0 || report.failed !== 0 || report.auditCount !== 89 || report.concurrency.deadlocks !== 0) {
    throw new Error('Bulk project review Local Supabase runtime verification failed.');
  }
}

if (require.main === module) {
  verifyBulkProjectReviewRuntime().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Bulk project review runtime failed.');
    process.exitCode = 1;
  });
}
