import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {
  dockerProxyCustomHeaders,
  startDockerLoopbackProxy,
  stopDockerLoopbackProxy,
} from '../local-development/safeSupabaseCli';
import { RELEASE_CAPABILITY_SENTINEL } from '../deployment/hostedDeploymentReadiness';
import { cleanupDisposableLedgerRuntime } from './disposableLedgerCleanup';

/**
 * Provisions a throwaway Supabase stack that the public deployment ledger runtime owns outright,
 * runs the runtime against it, and removes everything it created.
 *
 * The ledger runtime activates the singleton public feed head and drives irreversible forward-only
 * operations, so it must never run against a developer's canonical stack. Isolating it behind a
 * verifier-only project id, its own port block, its own Docker network and a temporary workdir is
 * what lets this production-critical writer be exercised on every CI run rather than by hand.
 */

interface RuntimeScript {
  file: string;
  environment?: Record<string, string>;
  timeoutMs?: number;
}

const RUNTIME_SCRIPTS: Record<string, RuntimeScript> = {
  ledger: { file: 'verifyPublicFeedLedgerRuntime.ts' },
  'ledger-stale-discipline-relevance': {
    file: 'verifyPublicFeedLedgerRuntime.ts',
    environment: { CAPSTONE_VERIFY_LEDGER_FOCUS: 'stale-discipline-relevance' },
  },
  publication: { file: 'verifyControlledPublicationRuntime.ts' },
  'annual-publication': { file: 'verifyAnnualPublicationEvidenceRuntime.ts' },
  'integrated-cohort': { file: 'verifyIntegratedCohortRuntime.ts', timeoutMs: 1_200_000 },
  removal: { file: 'verifyControlledPublicRemovalRuntime.ts' },
  'preview-access': { file: 'verifyParticipantPreviewAccessRuntime.ts' },
  'browser-media': { file: 'verifyBrowserImportMediaStageRuntime.ts' },
  'worker-heartbeat': { file: 'verifyAssistiveWorkerHeartbeatRuntime.ts' },
};
const DEFAULT_RUNTIME_NAMES = ['ledger', 'publication', 'removal'];
const DOCKER_COMMAND_TIMEOUT_MS = 30_000;
const PSQL_COMMAND_TIMEOUT_MS = 45_000;
const RUNTIME_TIMEOUT_MS = 600_000;

/**
 * Removing the release tail reproduces the exact pre-correction state;
 * restoring it proves the supported forward-only upgrade back to the full set.
 */
const CORRECTION_MIGRATIONS = [
  '20260906120000_public_removal_completion_reconciliation.sql',
  '20260909120000_staff_lifecycle_readiness.sql',
  '20260910120000_public_feed_rollback_capability.sql',
  '20260910120100_participant_preview_access_observations.sql',
  '20260910120200_assistive_worker_production_identity.sql',
  '20260911120000_gallery_full_text_equivalents.sql',
];

const PRE_CORRECTION_MIGRATION_COUNT = 51;
const CURRENT_MAIN_MIGRATION_COUNT = 57;
const UPGRADE_MODE = 'upgrade';

const repositoryRoot = path.resolve(__dirname, '../../../..');
const portBase = Number.parseInt(process.env.CAPSTONE_LEDGER_RUNTIME_PORT_BASE ?? '54520', 10);
const suffix = randomBytes(4).toString('hex');
const projectId = `capstone-pp1-ledger-${suffix}`;
const networkName = `${projectId}-loopback`;
const requested = process.argv.slice(2).filter((argument) => !argument.startsWith('-'));
const selected = requested.length > 0 ? requested : DEFAULT_RUNTIME_NAMES;

function docker(args: string[]): string {
  return execFileSync('docker', args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: DOCKER_COMMAND_TIMEOUT_MS,
  }).trim();
}

function configurePorts(config: string): string {
  const ports: Array<[RegExp, number]> = [
    [/^port = 54321$/m, portBase + 1],
    [/^port = 54322$/m, portBase + 2],
    [/^shadow_port = 54320$/m, portBase],
    [/^port = 54323$/m, portBase + 3],
    [/^port = 54324$/m, portBase + 4],
    [/^smtp_port = 54325$/m, portBase + 5],
    [/^pop3_port = 54326$/m, portBase + 6],
  ];
  let updated = config.replace(/^project_id = .*$/m, `project_id = "${projectId}"`);
  for (const [pattern, port] of ports) {
    const key = pattern.source.replace(/^\^/, '').split(' = ')[0];
    updated = updated.replace(pattern, `${key} = ${port}`);
  }
  return `${updated}\n[analytics]\nenabled = true\nport = ${portBase + 7}\n`;
}

async function assertPortBlockAvailable(): Promise<void> {
  const listeners: net.Server[] = [];
  try {
    for (let port = portBase; port < portBase + 8; port += 1) {
      const listener = net.createServer();
      listeners.push(listener);
      await new Promise<void>((resolve, reject) => {
        listener.once('error', reject);
        listener.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
      });
    }
  } catch {
    throw new Error(`Disposable runtime port block ${portBase}-${portBase + 7} is unavailable.`);
  } finally {
    await Promise.all(listeners.map((listener) => new Promise<void>((resolve) => {
      if (!listener.listening) resolve();
      else listener.close(() => resolve());
    })));
  }
  console.log(`PASS: disposable loopback port block ${portBase}-${portBase + 7} is available`);
}

function createWorkdir(
  excludeMigrations: readonly string[] = [],
  annualPublicationMode = false,
): string {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'capstone-ledger-runtime-'));
  const source = path.join(repositoryRoot, 'infra', 'supabase');
  const destination = path.join(workdir, 'supabase');
  fs.cpSync(source, destination, { recursive: true });
  for (const migration of excludeMigrations) {
    fs.rmSync(path.join(destination, 'migrations', migration), { force: true });
  }
  const configPath = path.join(destination, 'config.toml');
  let config = configurePorts(fs.readFileSync(configPath, 'utf8'));
  if (annualPublicationMode) {
    // The repository seed contains one published demonstration project. The annual verifier owns
    // an empty disposable publication universe so its 120-record head cannot include unrelated
    // seed membership; all default ledger/publication/removal modes retain the normal seed.
    config = config.replace(/^seed = .*$/m, 'seed = { sql_paths = [] }');
  }
  fs.writeFileSync(configPath, config, 'utf8');
  return workdir;
}

function restoreMigrations(workdir: string, migrations: readonly string[]): void {
  for (const migration of migrations) {
    fs.copyFileSync(
      path.join(repositoryRoot, 'infra', 'supabase', 'migrations', migration),
      path.join(workdir, 'supabase', 'migrations', migration),
    );
  }
}

function psql(sql: string): string {
  return execFileSync(
    'docker',
    [
      'exec', '-i', '-e', 'PGOPTIONS=-c statement_timeout=30000 -c lock_timeout=10000',
      `supabase_db_${projectId}`, 'psql', '-U', 'postgres', '-d', 'postgres',
      '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql,
    ],
    {
      cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: PSQL_COMMAND_TIMEOUT_MS,
    },
  ).trim();
}

function applyMigrationDirect(file: string): void {
  execFileSync(
    'docker',
    [
      'exec', '-i', '-e', 'PGOPTIONS=-c statement_timeout=30000 -c lock_timeout=10000',
      `supabase_db_${projectId}`, 'psql', '-X', '-U', 'postgres', '-d', 'postgres',
      '-v', 'ON_ERROR_STOP=1',
    ],
    {
      cwd: repositoryRoot,
      input: fs.readFileSync(path.join(repositoryRoot, 'infra', 'supabase', 'migrations', file)),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: PSQL_COMMAND_TIMEOUT_MS,
    },
  );
}

function routineCount(name: string): string {
  return psql(
    'SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace'
    + ` WHERE n.nspname = 'public' AND p.proname = '${name}';`,
  );
}

function routineDefinition(name: string): string {
  return psql(
    'SELECT pg_catalog.pg_get_functiondef(p.oid) FROM pg_catalog.pg_proc p'
    + ' JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace'
    + ` WHERE n.nspname = 'public' AND p.proname = '${name}';`,
  );
}

/** Proves the exact historical repair and its idempotency on the 51 -> 52 upgrade. */
function verifyCorrectionUpgrade(workdir: string): void {
  const appliedCount = () => psql('SELECT count(*) FROM supabase_migrations.schema_migrations;');
  const baselineFiles = fs.readdirSync(path.join(workdir, 'supabase', 'migrations'))
    .filter((name) => name.endsWith('.sql'));
  const hash = (content: string) => createHash('sha256').update(content).digest('hex');
  const exactContent = '[{"publicId":"268-exact"}]';
  const emptyContent = '[]';
  const ambiguousContent = '[{"publicId":"268-ambiguous"}]';
  const exactHash = hash(exactContent);
  const emptyHash = hash(emptyContent);
  const ambiguousHash = hash(ambiguousContent);
  const adminId = '26800000-0000-4000-8000-000000000001';
  const exactProjectId = '26800000-0000-4000-8000-000000000002';
  const ambiguousProjectId = '26800000-0000-4000-8000-000000000003';
  const incompleteProjectId = '26800000-0000-4000-8000-000000000004';
  const failedProjectId = '26800000-0000-4000-8000-000000000005';
  const noOperationProjectId = '26800000-0000-4000-8000-000000000006';
  const reconciledProjectId = '26800000-0000-4000-8000-000000000007';
  const baselineOperationId = '26800000-0000-4000-8000-000000000011';
  const exactRemovalOperationId = '26800000-0000-4000-8000-000000000012';
  const ambiguousRemovalOperationId = '26800000-0000-4000-8000-000000000013';
  const laterPublicationOperationId = '26800000-0000-4000-8000-000000000014';
  const incompleteOperationId = '26800000-0000-4000-8000-000000000015';
  const failedOperationId = '26800000-0000-4000-8000-000000000016';
  const baselineVersionId = '26800000-0000-4000-8000-000000000021';
  const exactRemovalVersionId = '26800000-0000-4000-8000-000000000022';
  const laterPublicationVersionId = '26800000-0000-4000-8000-000000000023';
  const exactCompletedAt = '2026-09-01T01:02:03+00:00';
  const alreadyReconciledAt = '2026-08-01T01:02:03+00:00';

  assert.equal(
    baselineFiles.length,
    PRE_CORRECTION_MIGRATION_COUNT,
    `The pre-correction baseline is not exactly ${PRE_CORRECTION_MIGRATION_COUNT} files.`,
  );
  assert.equal(
    appliedCount(),
    String(PRE_CORRECTION_MIGRATION_COUNT),
    'The provisioned baseline is not exactly the pre-correction migration head.',
  );
  assert.equal(routineCount('complete_public_feed_operation'), '1');

  psql(`
    INSERT INTO public.admin_users(id,email,full_name)
      VALUES ('${adminId}'::uuid,'issue-268-upgrade@capstone.test','Issue 268 Upgrade');
    INSERT INTO public.user_roles(user_id,role) VALUES ('${adminId}'::uuid,'admin');

    INSERT INTO public.projects(
      id,public_id,title,slug,year,status,archived_at,archived_from_status,archive_reason,
      pending_removal_from_public,public_removal_completed_at
    ) VALUES
      ('${exactProjectId}'::uuid,'268-exact','Exact repair','268-exact',2026,'archived',
        '2026-09-01T01:00:00+00:00','published','exact repair',true,NULL),
      ('${ambiguousProjectId}'::uuid,'268-ambiguous','Later republished','268-ambiguous',2026,'archived',
        '2026-09-01T02:00:00+00:00','published','later republished',true,NULL),
      ('${incompleteProjectId}'::uuid,'268-incomplete','Incomplete removal','268-incomplete',2026,'archived',
        '2026-09-01T03:00:00+00:00','published','incomplete removal',true,NULL),
      ('${failedProjectId}'::uuid,'268-failed','Failed removal','268-failed',2026,'archived',
        '2026-09-01T04:00:00+00:00','published','failed removal',true,NULL),
      ('${noOperationProjectId}'::uuid,'268-no-operation','No operation','268-no-operation',2026,'archived',
        '2026-09-01T05:00:00+00:00','published','no operation',true,NULL),
      ('${reconciledProjectId}'::uuid,'268-reconciled','Already reconciled','268-reconciled',2026,'archived',
        '2026-08-01T01:00:00+00:00','published','already reconciled',false,'${alreadyReconciledAt}');

    INSERT INTO public.public_feed_operations(
      id,operation_key,kind,publication_mode,authorizing_actor_id,completion_actor_id,
      project_id,public_id,baseline_storage_existed,candidate_feed_hash,candidate_record_count,
      candidate_byte_count,candidate_feed_content,candidate_members,storage_bucket,storage_path,
      feed_public_url,media_manifest,rollback_capability_requested,state,owner_epoch,
      owner_token_hash,lease_expires_at,observed_storage_hash,observed_storage_record_count,
      created_at,updated_at,finalized_at,completed_at,failure_code,failed_at
    ) VALUES
      ('${baselineOperationId}'::uuid,gen_random_uuid(),'activation',NULL,'${adminId}'::uuid,'${adminId}'::uuid,
        NULL,NULL,false,'${exactHash}',1,${Buffer.byteLength(exactContent)},'${exactContent}','[]'::jsonb,
        'public-feeds','projects.json','https://assets.invalid/projects.json','[]'::jsonb,true,
        'COMPLETED',1,'${'0'.repeat(64)}','2026-09-01T00:10:00+00:00','${exactHash}',1,
        '2026-09-01T00:00:00+00:00','2026-09-01T00:05:00+00:00','2026-09-01T00:04:00+00:00','2026-09-01T00:05:00+00:00',NULL,NULL),
      ('${exactRemovalOperationId}'::uuid,gen_random_uuid(),'removal',NULL,'${adminId}'::uuid,'${adminId}'::uuid,
        '${exactProjectId}'::uuid,'268-exact',false,'${emptyHash}',0,${Buffer.byteLength(emptyContent)},'${emptyContent}','[]'::jsonb,
        'public-feeds','projects.json','https://assets.invalid/projects.json','[]'::jsonb,true,
        'COMPLETED',1,'${'1'.repeat(64)}','${exactCompletedAt}','${emptyHash}',0,
        '2026-09-01T01:00:00+00:00','${exactCompletedAt}','2026-09-01T01:01:00+00:00','${exactCompletedAt}',NULL,NULL),
      ('${ambiguousRemovalOperationId}'::uuid,gen_random_uuid(),'removal',NULL,'${adminId}'::uuid,'${adminId}'::uuid,
        '${ambiguousProjectId}'::uuid,'268-ambiguous',false,'${emptyHash}',0,${Buffer.byteLength(emptyContent)},'${emptyContent}','[]'::jsonb,
        'public-feeds','projects.json','https://assets.invalid/projects.json','[]'::jsonb,true,
        'COMPLETED',1,'${'2'.repeat(64)}','2026-09-01T02:03:00+00:00','${emptyHash}',0,
        '2026-09-01T02:00:00+00:00','2026-09-01T02:02:00+00:00','2026-09-01T02:01:00+00:00','2026-09-01T02:02:00+00:00',NULL,NULL),
      ('${laterPublicationOperationId}'::uuid,gen_random_uuid(),'publication','normal','${adminId}'::uuid,'${adminId}'::uuid,
        '${ambiguousProjectId}'::uuid,'268-ambiguous',false,'${ambiguousHash}',1,${Buffer.byteLength(ambiguousContent)},'${ambiguousContent}','[]'::jsonb,
        'public-feeds','projects.json','https://assets.invalid/projects.json','[]'::jsonb,true,
        'COMPLETED',1,'${'3'.repeat(64)}','2026-09-01T02:13:00+00:00','${ambiguousHash}',1,
        '2026-09-01T02:10:00+00:00','2026-09-01T02:12:00+00:00','2026-09-01T02:11:00+00:00','2026-09-01T02:12:00+00:00',NULL,NULL),
      ('${incompleteOperationId}'::uuid,gen_random_uuid(),'removal',NULL,'${adminId}'::uuid,NULL,
        '${incompleteProjectId}'::uuid,'268-incomplete',false,'${ambiguousHash}',1,${Buffer.byteLength(ambiguousContent)},'${ambiguousContent}','[]'::jsonb,
        'public-feeds','projects.json','https://assets.invalid/projects.json','[]'::jsonb,true,
        'DB_FINALIZED',1,'${'4'.repeat(64)}','2026-09-01T03:05:00+00:00','${ambiguousHash}',1,
        '2026-09-01T03:00:00+00:00','2026-09-01T03:02:00+00:00','2026-09-01T03:02:00+00:00',NULL,NULL,NULL),
      ('${failedOperationId}'::uuid,gen_random_uuid(),'removal',NULL,'${adminId}'::uuid,NULL,
        '${failedProjectId}'::uuid,'268-failed',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,false,
        'FAILED',1,'${'5'.repeat(64)}','2026-09-01T04:05:00+00:00',NULL,NULL,
        '2026-09-01T04:00:00+00:00','2026-09-01T04:02:00+00:00',NULL,NULL,'TEST_FAILURE','2026-09-01T04:02:00+00:00');

    INSERT INTO public.public_feed_versions(
      id,operation,publication_mode,operation_id,previous_version_id,project_id,affected_public_id,
      authorizing_actor_id,completion_actor_id,artifact_content,byte_count,feed_hash,record_count,created_at
    ) VALUES
      ('${baselineVersionId}'::uuid,'baseline',NULL,'${baselineOperationId}'::uuid,NULL,NULL,NULL,
        '${adminId}'::uuid,'${adminId}'::uuid,'${exactContent}',${Buffer.byteLength(exactContent)},'${exactHash}',1,'2026-09-01T00:05:00+00:00'),
      ('${exactRemovalVersionId}'::uuid,'removal',NULL,'${exactRemovalOperationId}'::uuid,'${baselineVersionId}'::uuid,
        '${exactProjectId}'::uuid,'268-exact','${adminId}'::uuid,'${adminId}'::uuid,
        '${emptyContent}',${Buffer.byteLength(emptyContent)},'${emptyHash}',0,'${exactCompletedAt}'),
      ('${laterPublicationVersionId}'::uuid,'publication','normal','${laterPublicationOperationId}'::uuid,'${exactRemovalVersionId}'::uuid,
        '${ambiguousProjectId}'::uuid,'268-ambiguous','${adminId}'::uuid,'${adminId}'::uuid,
        '${ambiguousContent}',${Buffer.byteLength(ambiguousContent)},'${ambiguousHash}',1,'2026-09-01T02:12:00+00:00');

    UPDATE public.public_feed_operations SET baseline_storage_existed=true, baseline_version_id='${baselineVersionId}'::uuid,
      baseline_feed_content='${exactContent}',baseline_feed_hash='${exactHash}',baseline_record_count=1
      WHERE id='${exactRemovalOperationId}'::uuid;
    UPDATE public.public_feed_operations SET baseline_storage_existed=true, baseline_version_id='${exactRemovalVersionId}'::uuid,
      baseline_feed_content='${emptyContent}',baseline_feed_hash='${emptyHash}',baseline_record_count=0
      WHERE id IN ('${ambiguousRemovalOperationId}'::uuid,'${laterPublicationOperationId}'::uuid);
    UPDATE public.public_feed_operations SET baseline_storage_existed=true, baseline_version_id='${laterPublicationVersionId}'::uuid,
      baseline_feed_content='${ambiguousContent}',baseline_feed_hash='${ambiguousHash}',baseline_record_count=1
      WHERE id='${incompleteOperationId}'::uuid;

    INSERT INTO public.public_feed_version_members(version_id,ordinal,public_id,record_hash) VALUES
      ('${baselineVersionId}'::uuid,0,'268-exact','${hash('268-exact')}'),
      ('${laterPublicationVersionId}'::uuid,0,'268-ambiguous','${hash('268-ambiguous')}');
    INSERT INTO public.public_feed_head(
      singleton,current_version_id,generation,activated_by_id,transitioned_by_id,last_operation_id
    ) VALUES (true,'${laterPublicationVersionId}'::uuid,3,'${adminId}'::uuid,'${adminId}'::uuid,'${laterPublicationOperationId}'::uuid);
    INSERT INTO public.public_feed_operation_events(
      operation_id,sequence,from_state,to_state,actor_id,owner_epoch,
      observed_storage_hash,observed_storage_record_count,code,created_at
    ) VALUES
      ('${exactRemovalOperationId}'::uuid,1,'DB_FINALIZED','COMPLETED','${adminId}'::uuid,1,'${emptyHash}',0,NULL,'${exactCompletedAt}'),
      ('${ambiguousRemovalOperationId}'::uuid,1,'DB_FINALIZED','COMPLETED','${adminId}'::uuid,1,'${emptyHash}',0,NULL,'2026-09-01T02:02:00+00:00');
  `);
  const ledgerBefore = psql(`SELECT pg_catalog.jsonb_build_object(
    'operations',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(o) ORDER BY o.id) FROM public.public_feed_operations o),
    'versions',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(v) ORDER BY v.id) FROM public.public_feed_versions v),
    'members',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(m) ORDER BY m.version_id,m.ordinal) FROM public.public_feed_version_members m),
    'head',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(h) ORDER BY h.singleton) FROM public.public_feed_head h),
    'events',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(e) ORDER BY e.operation_id,e.sequence) FROM public.public_feed_operation_events e)
  )::text;`);
  const projectRowsBefore = psql(`SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.id)::text
    FROM public.projects p WHERE p.id::text LIKE '26800000-%';`);
  console.log(`PASS: disposable stack provisioned at the exact ${PRE_CORRECTION_MIGRATION_COUNT}-migration pre-correction baseline`);

  restoreMigrations(workdir, CORRECTION_MIGRATIONS);
  runSupabase('migrate', workdir, '');

  assert.equal(appliedCount(), String(CURRENT_MAIN_MIGRATION_COUNT), `The upgraded database is not exactly ${CURRENT_MAIN_MIGRATION_COUNT} migrations.`);
  assert.equal(
    psql(
      'SELECT count(*) FROM supabase_migrations.schema_migrations'
      + " WHERE version='20260906120000';",
    ),
    '1',
  );
  assert.equal(
    psql("SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='20260909120000';"),
    '1',
  );
  assert.equal(
    psql("SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='20260910120000';"),
    '1',
  );
  assert.equal(
    psql("SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='20260910120100';"),
    '1',
  );
  assert.equal(
    psql("SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='20260910120200';"),
    '1',
  );
  assert.equal(
    psql("SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='20260911120000';"),
    '1',
  );
  assert.equal(psql('SELECT public.get_release_capability_sentinel();'), RELEASE_CAPABILITY_SENTINEL);
  const completionDefinition = routineDefinition('complete_public_feed_operation');
  assert.ok(completionDefinition.includes("v_project.status <> 'archived'"));
  assert.ok(completionDefinition.includes("archived_from_status IS DISTINCT FROM 'published'"));
  assert.ok(completionDefinition.includes('pending_removal_from_public = false'));
  assert.ok(completionDefinition.includes("'INVALID_PROJECT_STATE'"));
  assert.equal(
    psql("SELECT p.prosecdef::text || '|' || pg_catalog.array_to_string(p.proconfig,',') FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='complete_public_feed_operation';"),
    'true|search_path=""',
  );
  assert.equal(
    psql("SELECT has_function_privilege('service_role','public.complete_public_feed_operation(uuid,bigint,text,uuid,text,integer)','EXECUTE')::text || '|' || has_function_privilege('anon','public.complete_public_feed_operation(uuid,bigint,text,uuid,text,integer)','EXECUTE')::text || '|' || has_function_privilege('authenticated','public.complete_public_feed_operation(uuid,bigint,text,uuid,text,integer)','EXECUTE')::text;"),
    'true|false|false',
  );

  const state = (projectIdValue: string) => psql(`SELECT pending_removal_from_public::text || '|' || COALESCE(public_removal_completed_at::text,'') FROM public.projects WHERE id='${projectIdValue}'::uuid;`);
  assert.equal(state(exactProjectId), 'false|2026-09-01 01:02:03+00');
  for (const untouched of [ambiguousProjectId, incompleteProjectId, failedProjectId, noOperationProjectId]) {
    assert.equal(state(untouched), 'true|');
  }
  assert.equal(state(reconciledProjectId), 'false|2026-08-01 01:02:03+00');
  assert.equal(
    psql(`SELECT pg_catalog.jsonb_build_object(
      'operations',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(o) ORDER BY o.id) FROM public.public_feed_operations o),
      'versions',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(v) ORDER BY v.id) FROM public.public_feed_versions v),
      'members',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(m) ORDER BY m.version_id,m.ordinal) FROM public.public_feed_version_members m),
      'head',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(h) ORDER BY h.singleton) FROM public.public_feed_head h),
      'events',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(e) ORDER BY e.operation_id,e.sequence) FROM public.public_feed_operation_events e)
    )::text;`),
    ledgerBefore,
  );
  assert.notEqual(
    psql(`SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.id)::text FROM public.projects p WHERE p.id::text LIKE '26800000-%';`),
    projectRowsBefore,
  );
  const projectRowsAfterFirst = psql(`SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.id)::text
    FROM public.projects p WHERE p.id::text LIKE '26800000-%';`);
  const exactStableBeforeReplay = state(exactProjectId);
  applyMigrationDirect(CORRECTION_MIGRATIONS[0]);
  assert.equal(state(exactProjectId), exactStableBeforeReplay);
  assert.equal(state(ambiguousProjectId), 'true|');
  assert.equal(
    psql(`SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.id)::text
      FROM public.projects p WHERE p.id::text LIKE '26800000-%';`),
    projectRowsAfterFirst,
  );
  assert.equal(
    psql(`SELECT count(*)::text || '|' || (SELECT count(*) FROM public.public_feed_versions)::text || '|' || (SELECT count(*) FROM public.public_feed_operation_events)::text FROM public.approval_records;`),
    '0|3|2',
  );
  console.log(`PASS: exact ${PRE_CORRECTION_MIGRATION_COUNT} -> ${CURRENT_MAIN_MIGRATION_COUNT} removal reconciliation repaired only exact durable evidence and replay stayed idempotent`);
}

function runSupabase(command: 'start' | 'stop' | 'migrate', workdir: string, networkId: string): void {
  const proxy = startDockerLoopbackProxy(repositoryRoot);
  const commandArguments = command === 'start'
    ? ['start', '--exclude', 'vector']
    : command === 'stop'
      ? ['stop', '--no-backup']
      : ['migration', 'up', '--local', '--include-all'];
  try {
    execFileSync(process.execPath, [
      path.join(repositoryRoot, 'node_modules', 'supabase', 'dist', 'supabase.js'),
      ...commandArguments,
      '--workdir', workdir, ...(networkId ? ['--network-id', networkId] : []),
    ], {
      // Supabase start prints disposable local keys in its normal stdout summary. The verifier
      // needs no value from that summary, so keep stdout out of CI/task logs while preserving
      // stderr for actionable startup or migration failures.
      cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'ignore', 'inherit'],
      timeout: command === 'start' ? 900_000 : 300_000,
      env: {
        ...process.env, SUPABASE_TELEMETRY_DISABLED: '1', DOCKER_HOST: proxy.dockerHost,
        DOCKER_CUSTOM_HEADERS: dockerProxyCustomHeaders(process.env.DOCKER_CUSTOM_HEADERS, proxy.authorizationToken),
      },
    });
  } finally {
    stopDockerLoopbackProxy(proxy);
  }
}

async function main(): Promise<void> {
  const upgradeRequested = selected.includes(UPGRADE_MODE);
  const scriptModes = selected.filter((name) => name !== UPGRADE_MODE);
  const emptyPublicationUniverseRequested = scriptModes.includes('annual-publication') || scriptModes.includes('integrated-cohort');
  if (emptyPublicationUniverseRequested && scriptModes.length !== 1) {
    console.error('The annual/integrated publication run needs its own empty disposable stack; run it as a separate invocation.');
    process.exitCode = 1;
    return;
  }
  if (upgradeRequested && scriptModes.length > 0) {
    console.error('The disposable upgrade run needs its own stack; run it as a separate invocation.');
    process.exitCode = 1;
    return;
  }
  await assertPortBlockAvailable();
  // An upgrade run must start from the exact pre-correction migration database; a script run starts
  // from a fresh full install. Provisioning one stack per invocation keeps both baselines exact.
  const workdir = createWorkdir(
    upgradeRequested ? CORRECTION_MIGRATIONS : [],
    emptyPublicationUniverseRequested,
  );
  let networkId = '';
  let networkCreateAttempted = false;
  let startAttempted = false;
  let exitCode = 1;
  try {
    networkCreateAttempted = true;
    networkId = docker([
      'network', 'create', '--opt', 'com.docker.network.bridge.host_binding_ipv4=127.0.0.1', networkName,
    ]);
    startAttempted = true;
    runSupabase('start', workdir, networkId);
    exitCode = 0;
    if (upgradeRequested) verifyCorrectionUpgrade(workdir);
    for (const name of scriptModes) {
      const script = RUNTIME_SCRIPTS[name];
      if (!script) throw new Error(`Unknown disposable runtime "${name}".`);
      if (name === 'browser-media') {
        psql(`INSERT INTO public.admin_users (id, email, full_name)
          VALUES ('57b00000-0000-4000-8000-000000000001', 'browser-media-runtime@example.invalid', 'Browser Media Runtime')
          ON CONFLICT (id) DO NOTHING;
          INSERT INTO public.user_roles (user_id, role)
          VALUES ('57b00000-0000-4000-8000-000000000001', 'admin')
          ON CONFLICT DO NOTHING;`);
      }
      const runtime = spawnSync(process.execPath, [
        ...(name === 'integrated-cohort' ? ['--conditions=react-server'] : []),
        path.join(repositoryRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        path.join(__dirname, script.file),
      ], {
        cwd: path.join(repositoryRoot, 'apps', 'admin-cms'), stdio: 'inherit',
        timeout: script.timeoutMs ?? RUNTIME_TIMEOUT_MS,
        killSignal: 'SIGTERM',
        env: {
          ...process.env,
          CAPSTONE_VERIFY_DISPOSABLE: '1',
          CAPSTONE_VERIFY_SUPABASE_WORKDIR: workdir,
          CAPSTONE_VERIFY_SUPABASE_PROJECT_ID: projectId,
          ...script.environment,
        },
      });
      if (runtime.error) {
        throw new Error(`Disposable runtime "${name}" failed to terminate: ${runtime.error.message}`);
      }
      if (runtime.status !== 0) {
        exitCode = runtime.status ?? 1;
        break;
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Disposable ledger runtime provisioning failed.');
    exitCode = 1;
  } finally {
    const cleanup = cleanupDisposableLedgerRuntime({
      projectId, networkName, startAttempted, networkCreateAttempted, docker,
      stopSupabase: () => runSupabase('stop', workdir, networkId),
      removeWorkdir: () => fs.rmSync(workdir, { recursive: true, force: true }),
      workdirExists: () => fs.existsSync(workdir),
    });
    for (const error of cleanup.errors) console.error(`Cleanup failure: ${error}`);
    if (cleanup.residue.containers.length > 0) {
      console.error(`Cleanup residue: ${cleanup.residue.containers.length} verifier container(s).`);
    }
    if (cleanup.residue.volumes.length > 0) {
      console.error(`Cleanup residue: ${cleanup.residue.volumes.length} verifier volume(s).`);
    }
    if (cleanup.residue.networkPresent) console.error('Cleanup residue: verifier network remains.');
    if (cleanup.residue.workdirPresent) console.error('Cleanup residue: verifier workdir remains.');
    if (!cleanup.clean) exitCode = 1;
  }
  process.exitCode = exitCode;
}

void main();
