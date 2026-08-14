import { execSync } from 'node:child_process';
import path from 'node:path';
import { isLoopbackUrl, parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';
import { runLocalScalingVerification } from '../benchmarks/localScalingRunner';
import { formatReportTable } from '../benchmarks/scalingBenchmarkTypes';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

function resolveLocalSupabaseEnv(): { apiUrl: string; serviceRoleKey: string } {
  // 1. Try environment variables
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    if (isLoopbackUrl(process.env.NEXT_PUBLIC_SUPABASE_URL)) {
      return {
        apiUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
        serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      };
    }
  }

  // 2. Query Supabase CLI
  try {
    const cliPath = path.resolve(REPO_ROOT, 'node_modules/.bin/supabase');
    const output = execSync(`"${cliPath}" status --workdir "${path.resolve(REPO_ROOT, 'infra')}" -o env`, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    const parsed = parseSupabaseCliEnv(output);
    if (parsed.API_URL && parsed.SERVICE_ROLE_KEY && isLoopbackUrl(parsed.API_URL)) {
      return {
        apiUrl: parsed.API_URL,
        serviceRoleKey: parsed.SERVICE_ROLE_KEY,
      };
    }
  } catch {
    // Fall back
  }

  throw new Error(
    'Local Scaling Runtime Verification requires an active, loopback-only local Supabase stack.'
  );
}

export async function verifyLocalScalingRuntime(): Promise<void> {
  console.log('\n=== Capstone Impact Platform: Local Supabase Scaling & Bandwidth Verification ===\n');

  const { apiUrl, serviceRoleKey } = resolveLocalSupabaseEnv();
  console.log(`[✓] Loopback Supabase Endpoint Confirmed: ${apiUrl}`);

  console.log('[*] Running scaling verification with target volume of 100 projects...');

  const result = await runLocalScalingVerification({
    apiUrl,
    serviceRoleKey,
    datasetSize: 100,
    warmupIterations: 2,
    measuredIterations: 5,
  });

  const { report, success, errors } = result;

  console.log('\n' + formatReportTable(report) + '\n');

  if (!success || errors.length > 0) {
    console.error('❌ Scaling verification encountered errors:', errors);
    throw new Error(`Local Supabase scaling verification failed with ${errors.length} error(s).`);
  }

  // Correctness Assertions
  if (report.seeding.projectCount !== 100) {
    throw new Error(`Seeding assertion failed: expected 100 projects, got ${report.seeding.projectCount}`);
  }

  const pagination10 = report.database.find((d) => d.operation.includes('Page 1, Size 10'));
  if (!pagination10 || pagination10.resultCount !== 10) {
    throw new Error(`Pagination assertion failed: expected 10 results on page 1, got ${pagination10?.resultCount}`);
  }

  const pagination50 = report.database.find((d) => d.operation.includes('Page 1, Size 50'));
  if (!pagination50 || pagination50.resultCount !== 50) {
    throw new Error(`Pagination assertion failed: expected 50 results on page 1, got ${pagination50?.resultCount}`);
  }

  const allStorageValid = report.storage.every((s) => s.integrityVerified);
  if (!allStorageValid) {
    throw new Error('Storage bandwidth verification failed: SHA-256 byte integrity mismatch detected.');
  }

  if (!report.cleanup.clean) {
    throw new Error(
      `Cleanup isolation assertion failed: ${report.cleanup.residualVerifierProjects} residual projects and ${report.cleanup.residualVerifierStorageObjects} residual storage files found.`
    );
  }

  console.log('✅ Local Supabase Performance & Scaling Verification PASSED (100 Projects Target).\n');
}

if (require.main === module) {
  verifyLocalScalingRuntime().catch((err) => {
    console.error('Execution failure:', err);
    process.exit(1);
  });
}
