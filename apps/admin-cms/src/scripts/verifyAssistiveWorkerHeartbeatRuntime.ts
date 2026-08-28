import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync, execSync } from 'node:child_process';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

import { isLoopbackUrl, parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';

const DB_CONTAINER = 'supabase_db_capstone-impact-platform';
const PIPELINE = 'assistive-deterministic-checks/v3';
const OCR = 'paddle-title/pp-ocrv6-small@3.7.0';
const LANGUAGE = 'languagetool/en-au@6.6';
const DEPLOYMENT = 'a'.repeat(40);

async function main(): Promise<void> {
  console.log('=== Assistive Worker Heartbeat Local Runtime Verification ===');
  const root = path.resolve(__dirname, '../../../..');
  const cli = path.resolve(root, 'node_modules/.bin/supabase');
  const cliEnv = parseSupabaseCliEnv(execSync(
    `"${cli}" status --workdir "${path.resolve(root, 'infra')}" -o env`,
    { cwd: root, encoding: 'utf8', stdio: 'pipe' },
  ));
  assert(
    cliEnv.API_URL && cliEnv.ANON_KEY && cliEnv.SERVICE_ROLE_KEY && isLoopbackUrl(cliEnv.API_URL),
    'Verifier requires loopback Local Supabase.',
  );
  const psql = (sql: string): string => execFileSync(
    'docker',
    ['exec', '-i', DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
  const service = createClient(cliEnv.API_URL, cliEnv.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anonymous = createClient(cliEnv.API_URL, cliEnv.ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const rpc = async (name: string, parameters: Record<string, unknown>) => {
    const result = await service.rpc(name, parameters);
    assert.ifError(result.error);
    return result.data as Record<string, unknown>;
  };
  const availability = () => rpc('get_assistive_worker_availability', {
    p_environment: 'staging', p_pipeline_version: PIPELINE,
    p_deployment_version: DEPLOYMENT,
    p_ocr_capability: OCR, p_language_capability: LANGUAGE, p_freshness_seconds: 60,
  });
  const heartbeat = (worker: string, state: 'READY' | 'STOPPING' = 'READY') => rpc(
    'upsert_assistive_worker_heartbeat',
    {
      p_worker_instance_id: worker, p_environment: 'staging', p_pipeline_version: PIPELINE,
      p_deployment_version: DEPLOYMENT, p_ocr_capability: OCR,
      p_language_capability: LANGUAGE, p_health_state: state,
    },
  );

  const prefix = `runtime-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const workerOne = `${prefix}-1`;
  const workerTwo = `${prefix}-2`;
  let passed = 0;
  const scenario = async (name: string, body: () => Promise<void> | void) => {
    await body();
    passed += 1;
    console.log(`PASS: ${name}`);
  };
  const authorityBefore = psql(`SELECT pg_catalog.jsonb_build_object(
    'projects', (SELECT pg_catalog.count(*) FROM public.projects),
    'approvals', (SELECT pg_catalog.count(*) FROM public.approval_records),
    'flags', (SELECT pg_catalog.count(*) FROM public.validation_flags),
    'snapshots', (SELECT pg_catalog.count(*) FROM public.published_snapshots),
    'feedOperations', (SELECT pg_catalog.count(*) FROM public.public_feed_operations)
  )::text;`);

  let failure: unknown = null;
  try {
    psql(`DELETE FROM public.assistive_worker_heartbeats WHERE worker_instance_id LIKE 'runtime-%';`);

    await scenario('fresh schema contains exactly 45 migrations and the heartbeat relation', () => {
      assert.equal(psql('SELECT count(*) FROM supabase_migrations.schema_migrations;'), '45');
      assert.equal(psql("SELECT to_regclass('public.assistive_worker_heartbeats') IS NOT NULL;"), 't');
    });

    await scenario('RLS is forced and all direct application-role table privileges are absent', async () => {
      assert.equal(psql("SELECT relrowsecurity::text || ':' || relforcerowsecurity::text FROM pg_catalog.pg_class WHERE relname='assistive_worker_heartbeats';"), 'true:true');
      assert.equal(psql("SELECT count(*) FROM information_schema.role_table_grants WHERE table_name='assistive_worker_heartbeats' AND grantee IN ('PUBLIC','anon','authenticated','service_role');"), '0');
      assert((await service.from('assistive_worker_heartbeats').select('*')).error);
      assert((await anonymous.from('assistive_worker_heartbeats').select('*')).error);
    });

    await scenario('anonymous callers cannot publish or inspect worker liveness', async () => {
      assert((await anonymous.rpc('upsert_assistive_worker_heartbeat', {})).error);
      assert((await anonymous.rpc('get_assistive_worker_availability', {})).error);
    });

    await scenario('malformed identities, environments, versions, capabilities, states, and windows fail closed', async () => {
      const invalidHeartbeats = [
        { p_worker_instance_id: '../worker' },
        { p_environment: 'production' },
        { p_pipeline_version: 'assistive-deterministic-checks/v2' },
        { p_deployment_version: 'latest' },
        { p_ocr_capability: 'remote-ocr' },
        { p_language_capability: 'remote-language' },
        { p_health_state: 'HEALTHY' },
        { p_health_state: null },
      ];
      for (const override of invalidHeartbeats) {
        assert.equal((await rpc('upsert_assistive_worker_heartbeat', {
          p_worker_instance_id: workerOne, p_environment: 'staging', p_pipeline_version: PIPELINE,
          p_deployment_version: DEPLOYMENT, p_ocr_capability: OCR,
          p_language_capability: LANGUAGE, p_health_state: 'READY', ...override,
        })).resultCode, 'VALIDATION_FAILED');
      }
      assert.equal((await rpc('get_assistive_worker_availability', {
        p_environment: 'staging', p_pipeline_version: PIPELINE,
        p_deployment_version: DEPLOYMENT,
        p_ocr_capability: OCR, p_language_capability: LANGUAGE, p_freshness_seconds: 1,
      })).resultCode, 'VALIDATION_FAILED');
      assert.equal((await rpc('get_assistive_worker_availability', {
        p_environment: 'staging', p_pipeline_version: PIPELINE,
        p_deployment_version: DEPLOYMENT,
        p_ocr_capability: OCR, p_language_capability: LANGUAGE, p_freshness_seconds: null,
      })).resultCode, 'VALIDATION_FAILED');
    });

    await scenario('one compatible READY worker produces fresh availability evidence', async () => {
      assert.equal((await heartbeat(workerOne)).resultCode, 'HEARTBEAT_RECORDED');
      const result = await availability();
      assert.equal(result.resultCode, 'AVAILABLE');
      assert.equal(result.compatibleWorkerCount, 1);
      const latestHeartbeatAt = result.latestHeartbeatAt;
      assert(typeof latestHeartbeatAt === 'string');
      assert.match(latestHeartbeatAt, /^\d{4}-\d{2}-\d{2}T/);
    });

    await scenario('a different valid deployment commit is incompatible', async () => {
      assert.deepEqual(await rpc('get_assistive_worker_availability', {
        p_environment: 'staging', p_pipeline_version: PIPELINE,
        p_deployment_version: 'b'.repeat(40), p_ocr_capability: OCR,
        p_language_capability: LANGUAGE, p_freshness_seconds: 60,
      }), { resultCode: 'UNAVAILABLE', compatibleWorkerCount: 0, latestHeartbeatAt: null });
    });

    await scenario('multiple compatible workers are counted without exposing their identities', async () => {
      assert.equal((await heartbeat(workerTwo)).resultCode, 'HEARTBEAT_RECORDED');
      const result = await availability();
      assert.equal(result.resultCode, 'AVAILABLE');
      assert.equal(result.compatibleWorkerCount, 2);
      assert.deepEqual(Object.keys(result).sort(), ['compatibleWorkerCount', 'latestHeartbeatAt', 'resultCode']);
    });

    await scenario('STOPPING removes a worker from compatible availability immediately', async () => {
      assert.equal((await heartbeat(workerOne, 'STOPPING')).resultCode, 'HEARTBEAT_RECORDED');
      assert.equal((await availability()).compatibleWorkerCount, 1);
    });

    await scenario('a heartbeat just inside the fixed freshness window remains eligible', async () => {
      psql(`UPDATE public.assistive_worker_heartbeats SET heartbeat_at=pg_catalog.statement_timestamp()-interval '59 seconds' WHERE worker_instance_id='${workerTwo}';`);
      assert.equal((await availability()).compatibleWorkerCount, 1);
    });

    await scenario('a stale heartbeat fails unavailable after the fixed window', async () => {
      psql(`UPDATE public.assistive_worker_heartbeats SET heartbeat_at=pg_catalog.statement_timestamp()-interval '61 seconds' WHERE worker_instance_id='${workerTwo}';`);
      assert.deepEqual(await availability(), {
        resultCode: 'UNAVAILABLE', compatibleWorkerCount: 0, latestHeartbeatAt: null,
      });
    });

    await scenario('heartbeat operations create no authoritative or public-feed mutation', () => {
      assert.equal(psql(`SELECT pg_catalog.jsonb_build_object(
        'projects', (SELECT pg_catalog.count(*) FROM public.projects),
        'approvals', (SELECT pg_catalog.count(*) FROM public.approval_records),
        'flags', (SELECT pg_catalog.count(*) FROM public.validation_flags),
        'snapshots', (SELECT pg_catalog.count(*) FROM public.published_snapshots),
        'feedOperations', (SELECT pg_catalog.count(*) FROM public.public_feed_operations)
      )::text;`), authorityBefore);
    });
  } catch (error) {
    failure = error;
  } finally {
    psql(`DELETE FROM public.assistive_worker_heartbeats WHERE worker_instance_id LIKE 'runtime-%';`);
  }

  if (failure) throw failure;
  console.log(`PASS: Assistive worker heartbeat Local runtime verification complete (${passed} scenarios).`);
}

void main().catch((error) => {
  console.error('Assistive worker heartbeat runtime verification failed.');
  console.error(error);
  process.exitCode = 1;
});
