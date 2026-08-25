import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  dockerProxyCustomHeaders,
  startDockerLoopbackProxy,
  stopDockerLoopbackProxy,
} from '../local-development/safeSupabaseCli';

/**
 * Provisions a throwaway Supabase stack that the public deployment ledger runtime owns outright,
 * runs the runtime against it, and removes everything it created.
 *
 * The ledger runtime activates the singleton public feed head and drives irreversible forward-only
 * operations, so it must never run against a developer's canonical stack. Isolating it behind a
 * verifier-only project id, its own port block, its own Docker network and a temporary workdir is
 * what lets this production-critical writer be exercised on every CI run rather than by hand.
 */

const RUNTIME_SCRIPTS: Record<string, string> = {
  ledger: 'verifyPublicFeedLedgerRuntime.ts',
  publication: 'verifyControlledPublicationRuntime.ts',
  removal: 'verifyControlledPublicRemovalRuntime.ts',
};

/**
 * The three migrations this branch contributes. Everything else in the tree is already on `main`,
 * so removing exactly these three reproduces a `main` database, and re-adding them reproduces the
 * upgrade an existing deployment would actually perform.
 */
const STREAM_K_MIGRATIONS = [
  '20260824180000_public_feed_deployment_ledger.sql',
  '20260824183000_public_feed_writer_protocol.sql',
  '20260825030000_public_feed_taxonomy_operation_guard.sql',
];

const MAIN_MIGRATION_COUNT = 40;
const UPGRADE_MODE = 'upgrade';

const repositoryRoot = path.resolve(__dirname, '../../../..');
const portBase = Number.parseInt(process.env.CAPSTONE_LEDGER_RUNTIME_PORT_BASE ?? '54520', 10);
const suffix = randomBytes(4).toString('hex');
const projectId = `capstone-pp1-ledger-${suffix}`;
const networkName = `${projectId}-loopback`;
const requested = process.argv.slice(2).filter((argument) => !argument.startsWith('-'));
const selected = requested.length > 0 ? requested : Object.keys(RUNTIME_SCRIPTS);

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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

function createWorkdir(excludeMigrations: readonly string[] = []): string {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'capstone-ledger-runtime-'));
  const source = path.join(repositoryRoot, 'infra', 'supabase');
  const destination = path.join(workdir, 'supabase');
  fs.cpSync(source, destination, { recursive: true });
  for (const migration of excludeMigrations) {
    fs.rmSync(path.join(destination, 'migrations', migration), { force: true });
  }
  const configPath = path.join(destination, 'config.toml');
  fs.writeFileSync(configPath, configurePorts(fs.readFileSync(configPath, 'utf8')), 'utf8');
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
      'exec', '-i', `supabase_db_${projectId}`, 'psql', '-U', 'postgres', '-d', 'postgres',
      '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql,
    ],
    { cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
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

/**
 * Proves the upgrade an existing `main` deployment would perform, rather than only proving a fresh
 * install. The stack is provisioned from a `main`-only migration set, the deployment-ledger stream
 * is then applied forward with `--include-all` (its timestamps predate the final merged gallery
 * migration, so it is legitimately out of order), and the composed end state is re-inspected.
 */
function verifyMainUpgrade(workdir: string): void {
  const appliedCount = () => psql('SELECT count(*) FROM supabase_migrations.schema_migrations;');
  const baselineFiles = fs.readdirSync(path.join(workdir, 'supabase', 'migrations'))
    .filter((name) => name.endsWith('.sql'));

  assert.equal(baselineFiles.length, MAIN_MIGRATION_COUNT, 'The main-only baseline is not exactly 40 files.');
  assert.equal(appliedCount(), String(MAIN_MIGRATION_COUNT), 'The provisioned baseline is not exactly main.');
  assert.equal(psql("SELECT to_regclass('public.public_feed_operations') IS NULL;"), 't');
  assert.equal(psql("SELECT to_regclass('public.public_feed_head') IS NULL;"), 't');
  assert.equal(routineCount('get_project_reconciliation_readiness'), '0');
  // The merged approved-only pre-publication authority and final review submission are already on
  // main, and the upgrade must not disturb either of them.
  assert.equal(routineCount('get_project_publication_readiness'), '1');
  assert.equal(routineCount('submit_import_projects_for_review'), '1');
  psql(`
    INSERT INTO public.disciplines(id,name)
      VALUES ('18600000-0000-4000-8000-000000000011'::uuid,'Upgrade Preserved Discipline');
    INSERT INTO public.industry_categories(id,name)
      VALUES ('18600000-0000-4000-8000-000000000012'::uuid,'Upgrade Preserved Industry');
    INSERT INTO public.projects(id,public_id,title,slug,year,status)
      VALUES ('18600000-0000-4000-8000-000000000013'::uuid,'186-upgrade-preserved',
        'Upgrade Preserved Project','186-upgrade-preserved',2026,'draft');
    INSERT INTO public.project_disciplines(project_id,discipline_id)
      VALUES ('18600000-0000-4000-8000-000000000013'::uuid,
        '18600000-0000-4000-8000-000000000011'::uuid);
    INSERT INTO public.project_industry_categories(project_id,industry_category_id)
      VALUES ('18600000-0000-4000-8000-000000000013'::uuid,
        '18600000-0000-4000-8000-000000000012'::uuid);
  `);
  const preservedBefore = psql(`SELECT pg_catalog.jsonb_build_object(
      'project', (SELECT pg_catalog.to_jsonb(p) FROM public.projects p
        WHERE p.id='18600000-0000-4000-8000-000000000013'::uuid),
      'discipline', (SELECT pg_catalog.to_jsonb(d) FROM public.disciplines d
        WHERE d.id='18600000-0000-4000-8000-000000000011'::uuid),
      'industry', (SELECT pg_catalog.to_jsonb(ic) FROM public.industry_categories ic
        WHERE ic.id='18600000-0000-4000-8000-000000000012'::uuid),
      'disciplineLink', (SELECT pg_catalog.to_jsonb(pd) FROM public.project_disciplines pd
        WHERE pd.project_id='18600000-0000-4000-8000-000000000013'::uuid),
      'industryLink', (SELECT pg_catalog.to_jsonb(pic) FROM public.project_industry_categories pic
        WHERE pic.project_id='18600000-0000-4000-8000-000000000013'::uuid)
    )::text;`);
  const headAbsentBefore = psql("SELECT to_regclass('public.public_feed_head') IS NULL;");
  assert.equal(headAbsentBefore, 't');
  console.log('PASS: disposable stack provisioned at exactly the 40 migrations on main');

  restoreMigrations(workdir, STREAM_K_MIGRATIONS);
  runSupabase('migrate', workdir, '');

  assert.equal(appliedCount(), '43', 'The upgraded database is not exactly 43 migrations.');
  assert.equal(
    psql(
      'SELECT count(*) FROM supabase_migrations.schema_migrations'
      + " WHERE version IN ('20260824180000','20260824183000','20260825030000');",
    ),
    '3',
  );
  assert.equal(
    psql(
      "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN"
      + " ('public_feed_operations','public_feed_versions','public_feed_version_members',"
      + "'public_feed_head','feed_rollback_preparations','public_feed_operation_events');",
    ),
    '6',
  );
  assert.equal(routineCount('get_project_reconciliation_readiness'), '1');
  assert.equal(routineCount('reserve_public_feed_operation'), '1');
  assert.equal(routineCount('mark_public_feed_write_started'), '1');
  assert.equal(routineCount('guard_active_public_feed_taxonomy'), '1');
  assert.equal(
    psql("SELECT count(*) FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND c.relname IN ('disciplines','industry_categories') AND t.tgname IN ('guard_discipline_lookup_during_public_feed_operation','guard_industry_category_lookup_during_public_feed_operation');"),
    '2',
  );
  // Upgrading installs authority, never deployment state: nothing is active and no version exists.
  assert.equal(psql('SELECT count(*) FROM public.public_feed_head;'), '0');
  assert.equal(psql('SELECT count(*) FROM public.public_feed_versions;'), '0');
  assert.equal(psql(`SELECT pg_catalog.jsonb_build_object(
      'project', (SELECT pg_catalog.to_jsonb(p) FROM public.projects p
        WHERE p.id='18600000-0000-4000-8000-000000000013'::uuid),
      'discipline', (SELECT pg_catalog.to_jsonb(d) FROM public.disciplines d
        WHERE d.id='18600000-0000-4000-8000-000000000011'::uuid),
      'industry', (SELECT pg_catalog.to_jsonb(ic) FROM public.industry_categories ic
        WHERE ic.id='18600000-0000-4000-8000-000000000012'::uuid),
      'disciplineLink', (SELECT pg_catalog.to_jsonb(pd) FROM public.project_disciplines pd
        WHERE pd.project_id='18600000-0000-4000-8000-000000000013'::uuid),
      'industryLink', (SELECT pg_catalog.to_jsonb(pic) FROM public.project_industry_categories pic
        WHERE pic.project_id='18600000-0000-4000-8000-000000000013'::uuid)
    )::text;`), preservedBefore);
  console.log('PASS: main upgraded forward to the integrated 43-migration deployment ledger with project and taxonomy data preserved');

  // End-of-sequence composition. The deployment-ledger migrations carry earlier timestamps than the
  // final merged gallery migration, so the composed database must still end on the merged gallery
  // and accessibility behavior rather than on anything this stream redefined.
  assert.ok(
    routineDefinition('submit_import_projects_for_review').includes('INVALID_SNAPSHOT_GALLERY_STRUCTURE'),
    'The merged gallery review-submission authority did not survive the upgrade.',
  );
  const normalReadiness = routineDefinition('get_project_publication_readiness');
  assert.ok(
    normalReadiness.includes("v_project.status <> 'approved'"),
    'The approved-only pre-publication gate was weakened by the upgrade.',
  );
  assert.ok(
    normalReadiness.includes("'galleryPosition'"),
    'The merged gallery evidence was lost from the pre-publication gate.',
  );
  // Reconciliation is a separate authority, proved at both boundaries, and never a relaxed reuse.
  const reconciliation = routineDefinition('get_project_reconciliation_readiness');
  assert.ok(reconciliation.includes("v_project.status <> 'published'"));
  assert.ok(reconciliation.includes("'galleryPosition'"));
  assert.ok(reconciliation.includes('PUBLISHED_MEDIA_MAPPING_INVALID'));
  for (const boundary of ['reserve_public_feed_operation', 'mark_public_feed_write_started']) {
    assert.ok(
      routineDefinition(boundary).includes('public.get_project_reconciliation_readiness('),
      `${boundary} does not prove the reconciliation authority after upgrade.`,
    );
  }
  console.log('PASS: composed end state keeps the merged gallery gate and both reconciliation boundaries');
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

function main(): void {
  const upgradeRequested = selected.includes(UPGRADE_MODE);
  const scriptModes = selected.filter((name) => name !== UPGRADE_MODE);
  if (upgradeRequested && scriptModes.length > 0) {
    console.error('The disposable upgrade run needs its own stack; run it as a separate invocation.');
    process.exitCode = 1;
    return;
  }
  // An upgrade run must start from a main-only database; a script run must start from a fresh full
  // install. Provisioning one stack per invocation keeps both baselines exact.
  const workdir = createWorkdir(upgradeRequested ? STREAM_K_MIGRATIONS : []);
  let networkId = '';
  let started = false;
  let exitCode = 1;
  try {
    networkId = docker([
      'network', 'create', '--opt', 'com.docker.network.bridge.host_binding_ipv4=127.0.0.1', networkName,
    ]);
    runSupabase('start', workdir, networkId);
    started = true;
    exitCode = 0;
    if (upgradeRequested) verifyMainUpgrade(workdir);
    for (const name of scriptModes) {
      const script = RUNTIME_SCRIPTS[name];
      if (!script) throw new Error(`Unknown disposable runtime "${name}".`);
      const runtime = spawnSync(process.execPath, [
        path.join(repositoryRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        path.join(__dirname, script),
      ], {
        cwd: path.join(repositoryRoot, 'apps', 'admin-cms'), stdio: 'inherit',
        env: {
          ...process.env,
          CAPSTONE_VERIFY_DISPOSABLE: '1',
          CAPSTONE_VERIFY_SUPABASE_WORKDIR: workdir,
          CAPSTONE_VERIFY_SUPABASE_PROJECT_ID: projectId,
        },
      });
      if (runtime.status !== 0) {
        exitCode = runtime.status ?? 1;
        break;
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Disposable ledger runtime provisioning failed.');
    exitCode = 1;
  } finally {
    if (started && networkId) {
      try { runSupabase('stop', workdir, networkId); } catch { /* cleanup is best effort */ }
    }
    if (networkId) {
      try { docker(['network', 'rm', networkName]); } catch { /* the network may already be gone */ }
    }
    fs.rmSync(workdir, { recursive: true, force: true });
  }
  process.exitCode = exitCode;
}

main();
