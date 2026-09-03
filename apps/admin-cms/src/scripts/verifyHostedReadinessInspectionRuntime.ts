import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import {
  ALL_REQUIRED_TABLES,
  REQUIRED_RPC_NAMES,
  REQUIRED_STORAGE_BUCKETS,
  checkHostedDeploymentReadinessWithClient,
  fetchPostgrestOpenApi,
  type HostedReadinessClient,
} from '../deployment/hostedDeploymentReadiness';
import { isLoopbackUrl, parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';

const repoRoot = path.resolve(__dirname, '../../../..');

const EXPECTED_PRIVILEGE_HIDDEN_TABLES = [
  'public_feed_activation_authority',
  'public_feed_project_projection_authority',
  'public_feed_discipline_projection_authority',
  'password_recovery_sessions',
  'assistive_validation_runs',
  'assistive_validation_findings',
  'assistive_validation_jobs',
  'assistive_worker_heartbeats',
] as const;

async function main(): Promise<void> {
  const cli = path.resolve(repoRoot, 'node_modules/.bin/supabase');
  const workdir = path.resolve(repoRoot, 'infra');
  const raw = execSync(`"${cli}" status --workdir "${workdir}" -o env`, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const local = parseSupabaseCliEnv(raw);
  const apiUrl = local.API_URL ?? '';
  const serviceRoleKey = local.SERVICE_ROLE_KEY ?? '';
  assert.equal(isLoopbackUrl(apiUrl), true, 'Readiness runtime verifier requires a proven loopback endpoint.');
  assert.notEqual(serviceRoleKey, '', 'Local service-role credential is unavailable.');

  const observedRequests: Array<{ method: string; pathname: string; hasBody: boolean }> = [];
  const auditedFetch: typeof fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    assert.equal(isLoopbackUrl(url.origin), true, 'A request attempted to leave loopback.');
    const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    assert.ok(method === 'GET' || method === 'HEAD', `Non-read-only HTTP method rejected: ${method}`);
    assert.equal(url.pathname.includes('/rpc/'), false, 'RPC execution is forbidden during discovery.');
    assert.equal(init.body == null, true, 'Readiness inspection requests must not have a body.');
    observedRequests.push({ method, pathname: url.pathname, hasBody: init.body != null });
    return await fetch(input, init);
  };

  const client = createClient(apiUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: auditedFetch },
  }) as unknown as HostedReadinessClient;
  const openApiDocument = await fetchPostgrestOpenApi(apiUrl, serviceRoleKey, auditedFetch);
  const evaluation = await checkHostedDeploymentReadinessWithClient(client, { openApiDocument });

  assert.equal(ALL_REQUIRED_TABLES.length, 41);
  assert.equal(ALL_REQUIRED_TABLES.includes('publication_attempts'), true);
  assert.equal(ALL_REQUIRED_TABLES.includes('participant_preview_tokens' as never), false);
  assert.equal(
    evaluation.requiredTableSet,
    'UNVERIFIED',
    `Table evidence changed unexpectedly (missing=${evaluation.missingTables.join(',') || 'none'}; unverified=${evaluation.unverifiedTables.join(',') || 'none'}).`
  );
  assert.equal(evaluation.missingTables.length, 0);
  // Every table whose privileges are fully revoked is invisible to PostgREST by design, so the
  // Activation authority, recovery provenance, and assistive tables require manual evidence.
  assert.deepEqual(evaluation.unverifiedTables, EXPECTED_PRIVILEGE_HIDDEN_TABLES);
  assert.equal(
    evaluation.requiredRpcNames,
    'PRESENT',
    `RPC name evidence incomplete (missing=${evaluation.missingRpcNames.join(',') || 'none'}).`
  );
  assert.equal(evaluation.missingRpcNames.length, 0);
  assert.equal(REQUIRED_RPC_NAMES.length, 82);
  assert.equal(
    evaluation.requiredStorageBuckets,
    'PRESENT',
    `Storage evidence incomplete (missing=${evaluation.missingBuckets.join(',') || 'none'}).`
  );
  assert.deepEqual(evaluation.missingBuckets, []);
  assert.equal(evaluation.authFoundation, 'READY');
  assert.equal(evaluation.migrationHistoryReadable, false);
  assert.equal(evaluation.hostedRecordedMigrations, 'UNKNOWN');
  assert.equal(evaluation.deploymentClassification, 'MANUAL_EVIDENCE_REQUIRED');
  assert.ok(REQUIRED_STORAGE_BUCKETS.every((bucket) => !evaluation.missingBuckets.includes(bucket)));
  assert.ok(observedRequests.length > 0);
  assert.ok(
    observedRequests.every(
      ({ method, pathname, hasBody }) =>
        (method === 'GET' || method === 'HEAD') && !pathname.includes('/rpc/') && !hasBody
    )
  );

  console.log('Hosted readiness inspection verified against disposable loopback Supabase.');
  console.log(
    `${ALL_REQUIRED_TABLES.length - EXPECTED_PRIVILEGE_HIDDEN_TABLES.length} application tables directly inspected; ${EXPECTED_PRIVILEGE_HIDDEN_TABLES.length} privilege-hidden tables require manual schema evidence.`
  );
  console.log(`${REQUIRED_RPC_NAMES.length} RPC names recognized; exact overload evidence remains manual.`);
  console.log('Migration history truthfully reported unavailable through the configured Data API.');
  console.log('Zero RPC executions, mutations, identifying rows, or temporary verifier records.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Hosted readiness runtime verification failed.');
  process.exit(1);
});
