import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  dockerProxyCustomHeaders,
  startDockerLoopbackProxy,
  stopDockerLoopbackProxy,
} from '../local-development/safeSupabaseCli';
import { validateCurrentRepositoryGate4Contract } from '../deployment/gate4SchemaEvidence';
import { collectLocalGate4Evidence } from './checkGate4SchemaEvidence';
import { MIGRATION_MANAGED_BUCKETS } from '../local-development/localSupabaseFixtures';

/**
 * Proves the exact hosted-like 48 -> 49 -> 50 -> 51 migration transition on a stack this verifier
 * owns outright.
 *
 * The known hosted staging-v2 baseline is 48 migrations through
 * 20260831090000_postgres17_maintain_privilege_alignment. A clean 51-migration install proves the
 * end state but not the transition, and the existing deployment-ledger upgrade proves a different
 * single migration. This rehearsal provisions exactly the 48-migration baseline, seeds the minimum
 * representative synthetic evidence a real 48-state database would hold, applies 0049, 0050 and
 * 0051 one at a time in deterministic order, and asserts after each step that nothing existing was
 * rewritten and that the new authority is exactly what the migration declares.
 *
 * Everything is disposable and loopback-only: its own project id, port block, Docker network,
 * containers, volumes and workdir, all removed and residue-verified afterwards. No hosted system is
 * contacted and no real participant, project, or staff data is used.
 */

const RELEASE_MIGRATIONS = [
  { ordinal: 49, version: '20260902010606', file: '20260902010606_controlled_project_links_import.sql' },
  { ordinal: 50, version: '20260903120000', file: '20260903120000_participant_preview_controlled_links.sql' },
  { ordinal: 51, version: '20260903130000', file: '20260903130000_participant_owned_corrections.sql' },
] as const;

const BASELINE_MIGRATION_COUNT = 48;
const BASELINE_LATEST_VERSION = '20260831090000';
const RELEASE_MIGRATION_COUNT = BASELINE_MIGRATION_COUNT + RELEASE_MIGRATIONS.length;

const CORRECTION_TABLES = [
  'participant_correction_submissions',
  'participant_correction_prior_revisions',
  'participant_correction_recovery_rows',
  'participant_correction_events',
] as const;

const CORRECTION_IMMUTABILITY_TRIGGERS = [
  'correction_event_immutable',
  'correction_prior_revision_immutable',
  'correction_recovery_row_immutable',
  'participant_correction_evidence_immutable',
] as const;

/**
 * Exact service-role RPC contract Migration 0051 adds, as PostgreSQL identity arguments: parameter
 * names and types, without default expressions.
 */
const CORRECTION_RPC_SIGNATURES = [
  'complete_participant_correction(p_token_hash text, p_submission_id uuid, p_package_hash text, p_public_id text, p_admin_id uuid)',
  'participant_correction_context(p_token_hash text)',
  'participant_correction_project_version(p_project_id uuid)',
  'pre_preview_package_context(p_public_id text, p_admin_id uuid)',
  'reserve_participant_correction(p_token_hash text, p_package_hash text, p_metadata jsonb, p_files jsonb, p_warnings jsonb, p_bucket text, p_validation_checks jsonb, p_public_id text, p_admin_id uuid)',
  'review_participant_correction(p_public_id text, p_admin_id uuid, p_submission_id uuid, p_package_hash text, p_expected_version text, p_action text)',
] as const;

/**
 * Rows that must survive 0049, 0050 and 0051 byte-identically. Shared taxonomy, publication and
 * deployment-ledger state are included because a release migration must never quietly touch them.
 */
const PRESERVED_TABLES = [
  'admin_users', 'user_roles',
  'programs', 'disciplines', 'industry_categories',
  'import_batches', 'projects', 'project_disciplines', 'project_industry_categories',
  'media_assets', 'validation_flags', 'approval_records', 'published_snapshots',
  'browser_import_commits', 'browser_import_media_commits',
  'participant_previews', 'participant_preview_confirmations',
  'participant_preview_correction_requests',
  'participant_preview_notifications', 'participant_preview_reminder_schedules',
  'publication_attempts', 'public_removal_attempts',
  'public_feed_operations', 'public_feed_versions', 'public_feed_version_members',
  'public_feed_head', 'feed_rollback_preparations', 'public_feed_operation_events',
  'public_feed_activation_authority',
  'public_feed_project_projection_authority', 'public_feed_discipline_projection_authority',
] as const;

/** Exact overloads of the participant-preview issuance authority and its legacy wrapper. */
const PREVIEW_ISSUANCE_IDENTITY = 'p_public_id text, p_admin_id uuid, p_token_hash text, p_expires_in_seconds integer, p_private_bucket text, p_is_correction_reissue boolean';
const PREVIEW_WRAPPER_IDENTITY = 'p_public_id text, p_admin_id uuid, p_token_hash text, p_expires_in_seconds integer, p_private_bucket text';

const ADMIN_ID = '3f000000-0000-4000-8000-000000000001';
const LINKS_ABSENT_PUBLIC_ID = 'upgrade-links-absent';
const LINKS_PRESENT_PUBLIC_ID = 'upgrade-links-present';
const CORRECTION_PUBLIC_ID = 'upgrade-correction-open';
const SYNTHETIC_VIDEO_URL = 'https://video.invalid/upgrade-rehearsal';
const SYNTHETIC_DEMO_URL = 'https://demo.invalid/upgrade-rehearsal';
const SYNTHETIC_REPOSITORY_URL = 'https://repository.invalid/upgrade-rehearsal';

const DOCKER_COMMAND_TIMEOUT_MS = 30_000;
const PSQL_COMMAND_TIMEOUT_MS = 120_000;

const repositoryRoot = path.resolve(__dirname, '../../../..');
const portBase = Number.parseInt(process.env.CAPSTONE_STAGING_UPGRADE_PORT_BASE ?? '54920', 10);
const projectId = `capstone-pp1-upgrade-${randomBytes(4).toString('hex')}`;
const networkName = `${projectId}-loopback`;

if (!Number.isSafeInteger(portBase) || portBase < 1024 || portBase > 65_527) {
  throw new Error('CAPSTONE_STAGING_UPGRADE_PORT_BASE_INVALID');
}

function docker(args: string[]): string {
  return execFileSync('docker', args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: DOCKER_COMMAND_TIMEOUT_MS,
  }).trim();
}

function repositoryMigrationFiles(): string[] {
  return fs.readdirSync(path.join(repositoryRoot, 'infra', 'supabase', 'migrations'))
    .filter((file) => file.endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right));
}

function repositoryMigrationVersions(): string[] {
  return repositoryMigrationFiles().map((file) => {
    const version = /^(\d{14})_/.exec(file)?.[1];
    if (!version) throw new Error('REPOSITORY_MIGRATION_FILENAME_INVALID');
    return version;
  });
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

/** Copies the repository Supabase workdir while withholding the release migrations. */
function createWorkdir(): string {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'capstone-upgrade-rehearsal-'));
  const source = path.join(repositoryRoot, 'infra', 'supabase');
  const destination = path.join(workdir, 'supabase');
  fs.cpSync(source, destination, { recursive: true });
  for (const migration of RELEASE_MIGRATIONS) {
    const withheld = path.join(destination, 'migrations', migration.file);
    if (!fs.existsSync(withheld)) throw new Error(`RELEASE_MIGRATION_MISSING:${migration.file}`);
    fs.rmSync(withheld);
  }
  const configPath = path.join(destination, 'config.toml');
  fs.writeFileSync(configPath, configurePorts(fs.readFileSync(configPath, 'utf8')), 'utf8');
  return workdir;
}

function restoreMigration(workdir: string, file: string): void {
  fs.copyFileSync(
    path.join(repositoryRoot, 'infra', 'supabase', 'migrations', file),
    path.join(workdir, 'supabase', 'migrations', file),
  );
}

function runSupabase(command: 'start' | 'stop' | 'migrate', workdir: string, networkId: string): void {
  const proxy = startDockerLoopbackProxy(repositoryRoot);
  const commandArguments = command === 'start'
    ? ['start', '--exclude', 'vector']
    : command === 'stop'
      ? ['stop', '--no-backup']
      : ['migration', 'up', '--local'];
  try {
    execFileSync(process.execPath, [
      path.join(repositoryRoot, 'node_modules', 'supabase', 'dist', 'supabase.js'),
      ...commandArguments,
      '--workdir', workdir, ...(networkId ? ['--network-id', networkId] : []),
    ], {
      // Supabase start prints disposable local keys; keep stdout out of CI logs and keep stderr
      // for actionable startup or migration failures.
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

function psql(sql: string): string {
  return execFileSync('docker', [
    'exec', '-i', '-e', 'PGOPTIONS=-c statement_timeout=60000 -c lock_timeout=10000',
    `supabase_db_${projectId}`, 'psql', '-U', 'postgres', '-d', 'postgres',
    '-At', '-v', 'ON_ERROR_STOP=1',
  ], {
    cwd: repositoryRoot, encoding: 'utf8', input: sql,
    stdio: ['pipe', 'pipe', 'pipe'], timeout: PSQL_COMMAND_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

/** Order-independent content digest for one table; never prints row content. */
function tableFingerprint(table: string): string {
  return psql(
    "SELECT pg_catalog.md5(COALESCE(pg_catalog.string_agg(row_text, chr(10) ORDER BY row_text), ''))"
    + ` FROM (SELECT pg_catalog.to_jsonb(t)::text AS row_text FROM public.${table} AS t) AS s;`,
  );
}

function fingerprintPreservedTables(): Record<string, string> {
  const fingerprints: Record<string, string> = {};
  for (const table of PRESERVED_TABLES) fingerprints[table] = tableFingerprint(table);
  return fingerprints;
}

function assertPreservedTablesUnchanged(
  before: Record<string, string>,
  stage: string,
): void {
  for (const table of PRESERVED_TABLES) {
    assert.equal(
      tableFingerprint(table),
      before[table],
      `${stage} changed existing rows in public.${table}.`,
    );
  }
}

/**
 * Every EXECUTE grant on a public routine held by an untrusted runtime role. `acldefault` is used
 * so a routine with a NULL ACL, which implicitly grants EXECUTE to PUBLIC, is still counted.
 */
function untrustedRoutineExecuteGrants(): string {
  return psql(
    "SELECT COALESCE(pg_catalog.string_agg(entry, chr(10) ORDER BY entry), '') FROM ("
    + "  SELECT routine.proname || '(' || pg_catalog.pg_get_function_identity_arguments(routine.oid)"
    + "    || ')=' || grantee.name AS entry"
    + '  FROM pg_catalog.pg_proc AS routine'
    + '  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace'
    + '  CROSS JOIN LATERAL ('
    + "    SELECT CASE WHEN acl.grantee = 0 THEN 'PUBLIC'"
    + '      ELSE pg_catalog.pg_get_userbyid(acl.grantee) END AS name'
    + "    FROM pg_catalog.aclexplode(COALESCE(routine.proacl, pg_catalog.acldefault('f', routine.proowner))) AS acl"
    + "    WHERE acl.privilege_type = 'EXECUTE'"
    + '  ) AS grantee'
    + "  WHERE namespace.nspname = 'public'"
    + "    AND grantee.name IN ('PUBLIC', 'anon', 'authenticated')"
    + ') AS s;',
  );
}

/** Every table privilege in the public schema held by a relevant runtime role. */
function publicTableGrants(): string {
  return psql(
    "SELECT COALESCE(pg_catalog.string_agg(entry, chr(10) ORDER BY entry), '') FROM ("
    + "  SELECT relation.relname || '=' || grantee.name || ':' || grantee.privilege AS entry"
    + '  FROM pg_catalog.pg_class AS relation'
    + '  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace'
    + '  CROSS JOIN LATERAL ('
    + "    SELECT CASE WHEN acl.grantee = 0 THEN 'PUBLIC'"
    + '      ELSE pg_catalog.pg_get_userbyid(acl.grantee) END AS name,'
    + '      acl.privilege_type AS privilege'
    + "    FROM pg_catalog.aclexplode(COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))) AS acl"
    + '  ) AS grantee'
    + "  WHERE namespace.nspname = 'public' AND relation.relkind IN ('r', 'p')"
    + "    AND grantee.name IN ('PUBLIC', 'anon', 'authenticated', 'service_role')"
    + ') AS s;',
  );
}

function tableGrantsFor(table: string): string {
  return psql(
    "SELECT COALESCE(pg_catalog.string_agg(DISTINCT grantee.name || ':' || grantee.privilege, ','), 'NONE')"
    + '  FROM pg_catalog.pg_class AS relation'
    + '  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace'
    + '  CROSS JOIN LATERAL ('
    + "    SELECT CASE WHEN acl.grantee = 0 THEN 'PUBLIC'"
    + '      ELSE pg_catalog.pg_get_userbyid(acl.grantee) END AS name,'
    + '      acl.privilege_type AS privilege'
    + "    FROM pg_catalog.aclexplode(COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))) AS acl"
    + '  ) AS grantee'
    + `  WHERE namespace.nspname = 'public' AND relation.relname = '${table}'`
    + "    AND grantee.name IN ('PUBLIC', 'anon', 'authenticated', 'service_role');",
  );
}

/**
 * One routine definition. `identityArguments` selects an exact overload: generate_participant_preview
 * has both the six-argument issuance authority and a five-argument backward-compatibility wrapper,
 * and reading whichever sorts first would assert against the wrong one.
 */
function routineDefinition(name: string, identityArguments?: string): string {
  return psql(
    'SELECT pg_catalog.pg_get_functiondef(routine.oid) FROM pg_catalog.pg_proc AS routine'
    + ' JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace'
    + ` WHERE namespace.nspname = 'public' AND routine.proname = '${name}'`
    + (identityArguments === undefined
      ? ''
      : ` AND pg_catalog.pg_get_function_identity_arguments(routine.oid) = '${identityArguments}'`)
    + ' ORDER BY pg_catalog.pg_get_function_identity_arguments(routine.oid) LIMIT 1;',
  );
}

function appliedMigrations(): string[] {
  const output = psql('SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;');
  return output ? output.split(/\r?\n/).filter(Boolean) : [];
}

function storageObjectCount(): string {
  return psql('SELECT pg_catalog.count(*)::text FROM storage.objects;');
}

/**
 * The minimum representative 48-state evidence: staff identity and roles, shared taxonomy links,
 * projects with and without controlled links, an import ledger row, review/audit history, a
 * published snapshot, and confirmed participant previews issued by the pre-0050 authority so their
 * stored snapshots genuinely carry no controlled-link keys.
 */
function seedBaselineEvidence(): void {
  psql(`
BEGIN;
INSERT INTO public.admin_users (id, email, full_name)
VALUES ('${ADMIN_ID}', 'upgrade-rehearsal-reviewer@example.invalid', 'Upgrade Rehearsal Reviewer');
INSERT INTO public.user_roles (user_id, role) VALUES ('${ADMIN_ID}', 'admin');

INSERT INTO public.import_batches (id, batch_name, mode, source_folder, imported_by, status, total_projects, warning_count, error_count)
VALUES ('3f000000-0000-4000-8000-000000000010', 'upgrade-rehearsal', 'batch', 'upgrade-rehearsal', '${ADMIN_ID}', 'completed', 3, 0, 0);

INSERT INTO public.projects (
  public_id, title, summary, background, solution, year, program_id, program_name, study_program,
  discipline, industry, industry_partner, academic_supervisor, group_name, team_members,
  poster_text_public, accessibility_text_public, video_url, demo_url, repository_url,
  status, import_batch_id, source_folder
)
SELECT
  candidate.public_id, candidate.title, 'Synthetic upgrade rehearsal summary.',
  'Synthetic background.', 'Synthetic solution.', 2026, programs.id, programs.name, programs.name,
  'Software Engineering', 'Technology', 'Synthetic Partner', 'Synthetic Supervisor',
  candidate.public_id, ARRAY['Synthetic Member A', 'Synthetic Member B'],
  'Synthetic poster text for the upgrade rehearsal.',
  'Synthetic accessibility text for the upgrade rehearsal.',
  candidate.video_url, candidate.demo_url, candidate.repository_url,
  'approved', '3f000000-0000-4000-8000-000000000010', 'upgrade-rehearsal'
FROM (VALUES
  ('${LINKS_ABSENT_PUBLIC_ID}', 'Upgrade Rehearsal Without Controlled Links', NULL::text, NULL::text, NULL::text),
  ('${LINKS_PRESENT_PUBLIC_ID}', 'Upgrade Rehearsal With Controlled Links', '${SYNTHETIC_VIDEO_URL}', '${SYNTHETIC_DEMO_URL}', '${SYNTHETIC_REPOSITORY_URL}'),
  ('${CORRECTION_PUBLIC_ID}', 'Upgrade Rehearsal With Open Correction', NULL, NULL, NULL)
) AS candidate(public_id, title, video_url, demo_url, repository_url)
CROSS JOIN LATERAL (
  SELECT id, name FROM public.programs ORDER BY name LIMIT 1
) AS programs;

INSERT INTO public.project_disciplines (project_id, discipline_id)
SELECT projects.id, disciplines.id
FROM public.projects AS projects
CROSS JOIN LATERAL (SELECT id FROM public.disciplines ORDER BY name LIMIT 1) AS disciplines
WHERE projects.source_folder = 'upgrade-rehearsal';

INSERT INTO public.project_industry_categories (project_id, industry_category_id)
SELECT projects.id, categories.id
FROM public.projects AS projects
CROSS JOIN LATERAL (SELECT id FROM public.industry_categories ORDER BY name LIMIT 1) AS categories
WHERE projects.source_folder = 'upgrade-rehearsal';

INSERT INTO public.approval_records (project_id, admin_id, action_taken, from_status, to_status, comments)
SELECT projects.id, '${ADMIN_ID}', 'approve', 'in_review', 'approved', 'Synthetic upgrade rehearsal approval.'
FROM public.projects AS projects
WHERE projects.source_folder = 'upgrade-rehearsal';
COMMIT;
`);

  // Issue and confirm previews through the real pre-0050 authorities so the stored snapshots are
  // genuine historical evidence rather than a hand-written approximation of one.
  for (const publicId of [LINKS_ABSENT_PUBLIC_ID, LINKS_PRESENT_PUBLIC_ID, CORRECTION_PUBLIC_ID]) {
    const tokenHash = psql(
      `SELECT pg_catalog.encode(pg_catalog.sha256('${publicId}'::bytea), 'hex');`,
    );
    const issued = psql(
      "SELECT public.generate_participant_preview("
      + `'${publicId}', '${ADMIN_ID}'::uuid, '${tokenHash}', 604800, 'project-drafts-private')->>'resultCode';`,
    );
    assert.equal(issued, 'SUCCESS', `Baseline preview issuance for ${publicId} returned ${issued}.`);
    const confirmed = psql(`SELECT public.confirm_participant_preview('${tokenHash}')->>'resultCode';`);
    assert.equal(confirmed, 'SUCCESS', `Baseline preview confirmation for ${publicId} returned ${confirmed}.`);
  }

  // One open correction request, so 0051's fail-closed resolution behaviour is proven against real
  // pre-existing correction evidence rather than an empty table.
  psql(
    'INSERT INTO public.participant_preview_correction_requests (participant_preview_id, correction_comment)'
    + ' SELECT previews.id, \'Synthetic upgrade rehearsal correction request.\''
    + '   FROM public.participant_previews AS previews'
    + '   JOIN public.projects AS projects ON projects.id = previews.project_id'
    + `  WHERE projects.public_id = '${CORRECTION_PUBLIC_ID}';`,
  );

  const historicalSnapshots = psql(
    'SELECT pg_catalog.count(*)::text FROM public.participant_previews AS previews'
    + " WHERE previews.snapshot ? 'videoUrl' OR previews.snapshot ? 'demoUrl'"
    + " OR previews.snapshot ? 'repositoryUrl';",
  );
  assert.equal(
    historicalSnapshots,
    '0',
    'The 48-state baseline previews already carry controlled-link keys; the baseline is not pre-0050.',
  );
}

function publicationReadiness(publicId: string): string {
  return psql(
    'SELECT public.get_project_publication_readiness('
    + `'${publicId}', '${ADMIN_ID}'::uuid, 'project-drafts-private')->>'resultCode';`,
  );
}

function gate4ContractErrors(): string[] {
  try {
    return validateCurrentRepositoryGate4Contract(
      collectLocalGate4Evidence(repositoryRoot, projectId),
      repositoryMigrationVersions(),
    );
  } catch (error) {
    return [error instanceof Error ? error.message : 'LOCAL_GATE4_QUERY_FAILED'];
  }
}

function assertBaseline(): void {
  const applied = appliedMigrations();
  assert.equal(
    applied.length,
    BASELINE_MIGRATION_COUNT,
    `The provisioned baseline is ${applied.length} migrations, not ${BASELINE_MIGRATION_COUNT}.`,
  );
  assert.equal(applied.at(-1), BASELINE_LATEST_VERSION, 'The baseline head is not Migration 0048.');
  for (const migration of RELEASE_MIGRATIONS) {
    assert.ok(!applied.includes(migration.version), `Migration ${migration.ordinal} is already applied.`);
  }
  assert.equal(
    psql("SELECT pg_catalog.count(*)::text FROM storage.buckets WHERE id = 'participant-corrections-private';"),
    '0',
    'The migration-owned correction bucket exists before Migration 0051; config or fixtures pre-created it.',
  );
  for (const table of CORRECTION_TABLES) {
    assert.equal(
      psql(`SELECT pg_catalog.to_regclass('public.${table}') IS NULL;`),
      't',
      `public.${table} exists before Migration 0051.`,
    );
  }
  console.log(`PASS: provisioned exactly ${BASELINE_MIGRATION_COUNT} migrations through ${BASELINE_LATEST_VERSION}`);
}

function applyRelease(workdir: string, networkId: string, ordinal: number): void {
  const migration = RELEASE_MIGRATIONS.find((candidate) => candidate.ordinal === ordinal);
  if (!migration) throw new Error('RELEASE_MIGRATION_UNKNOWN');
  restoreMigration(workdir, migration.file);
  runSupabase('migrate', workdir, networkId);
  const applied = appliedMigrations();
  assert.ok(applied.includes(migration.version), `Migration ${ordinal} was not recorded as applied.`);
  assert.equal(applied.at(-1), migration.version, `Migration ${ordinal} is not the applied head.`);
  const expectedCount = BASELINE_MIGRATION_COUNT
    + RELEASE_MIGRATIONS.filter((candidate) => candidate.ordinal <= ordinal).length;
  assert.equal(
    applied.length,
    expectedCount,
    `Applied migration count after ${ordinal} is ${applied.length}, not ${expectedCount}.`,
  );
}

interface BaselineEvidence {
  tables: Record<string, string>;
  untrustedRoutineGrants: string;
  publicTableGrants: string;
  storageObjects: string;
  controlledLinkReadinessBefore50: string;
  absentLinkReadinessBefore50: string;
}

function assertAfter49(baseline: BaselineEvidence): void {
  assertPreservedTablesUnchanged(baseline.tables, 'Migration 0049');

  const urls = psql(
    "SELECT projects.public_id || '|' || COALESCE(projects.video_url, 'NULL')"
    + " || '|' || COALESCE(projects.demo_url, 'NULL')"
    + " || '|' || COALESCE(projects.repository_url, 'NULL')"
    + " FROM public.projects AS projects WHERE projects.source_folder = 'upgrade-rehearsal'"
    + ' ORDER BY projects.public_id;',
  );
  assert.equal(urls, [
    `${CORRECTION_PUBLIC_ID}|NULL|NULL|NULL`,
    `${LINKS_ABSENT_PUBLIC_ID}|NULL|NULL|NULL`,
    `${LINKS_PRESENT_PUBLIC_ID}|${SYNTHETIC_VIDEO_URL}|${SYNTHETIC_DEMO_URL}|${SYNTHETIC_REPOSITORY_URL}`,
  ].join('\n'), 'Migration 0049 rewrote existing project URL columns.');

  const definition = routineDefinition('stage_browser_import_metadata');
  for (const key of ['videoUrl', 'demoUrl', 'repositoryUrl']) {
    assert.ok(definition.includes(`'${key}'`), `stage_browser_import_metadata does not read ${key}.`);
  }
  for (const column of ['video_url', 'demo_url', 'repository_url']) {
    assert.ok(definition.includes(column), `stage_browser_import_metadata does not persist ${column}.`);
  }
  assert.ok(definition.includes("SET search_path TO ''"), 'stage_browser_import_metadata lost its pinned search_path.');
  assert.ok(definition.includes('SECURITY DEFINER'), 'stage_browser_import_metadata is no longer SECURITY DEFINER.');
  assert.equal(
    untrustedRoutineExecuteGrants(),
    baseline.untrustedRoutineGrants,
    'Migration 0049 introduced an unsafe direct routine grant.',
  );
  assert.equal(
    publicTableGrants(),
    baseline.publicTableGrants,
    'Migration 0049 changed the public-schema table grant matrix.',
  );
  assert.equal(storageObjectCount(), baseline.storageObjects, 'Migration 0049 changed Storage objects.');
  console.log('PASS: Migration 0049 added the controlled-link intake contract without touching existing rows or grants');
}

function assertAfter50(baseline: BaselineEvidence): void {
  assertPreservedTablesUnchanged(baseline.tables, 'Migration 0050');
  assert.equal(
    psql(
      'SELECT pg_catalog.count(*)::text FROM public.participant_previews AS previews'
      + " WHERE previews.snapshot ? 'videoUrl' OR previews.snapshot ? 'demoUrl'"
      + " OR previews.snapshot ? 'repositoryUrl';",
    ),
    '0',
    'Migration 0050 backfilled stored participant snapshots.',
  );

  const snapshotAuthorities = [
    { routine: 'generate_participant_preview', identityArguments: PREVIEW_ISSUANCE_IDENTITY },
    { routine: 'get_project_publication_readiness', identityArguments: undefined },
    { routine: 'get_project_reconciliation_readiness', identityArguments: undefined },
  ];
  for (const authority of snapshotAuthorities) {
    const definition = routineDefinition(authority.routine, authority.identityArguments);
    assert.notEqual(definition, '', `${authority.routine} was not found after Migration 0050.`);
    for (const key of ['videoUrl', 'demoUrl', 'repositoryUrl']) {
      assert.ok(definition.includes(`'${key}'`), `${authority.routine} does not carry the ${key} contract.`);
    }
  }

  // The legacy five-argument entry point must stay a delegating wrapper. If it built its own
  // snapshot it would be a second, now-stale issuance authority.
  const wrapper = routineDefinition('generate_participant_preview', PREVIEW_WRAPPER_IDENTITY);
  assert.ok(
    wrapper.includes('public.generate_participant_preview('),
    'The legacy five-argument preview entry point no longer delegates to the issuance authority.',
  );
  assert.ok(
    !wrapper.includes("'title'"),
    'The legacy five-argument preview entry point builds its own snapshot.',
  );
  for (const routine of ['get_project_publication_readiness', 'get_project_reconciliation_readiness']) {
    const definition = routineDefinition(routine);
    assert.ok(
      definition.includes("v_comparable_snapshot - 'videoUrl' - 'demoUrl' - 'repositoryUrl'"),
      `${routine} has no historical-snapshot compatibility path.`,
    );
  }

  // A historical snapshot with no controlled-link keys stays equivalent while the project still has
  // no controlled link at all.
  assert.equal(
    baseline.absentLinkReadinessBefore50,
    publicationReadiness(LINKS_ABSENT_PUBLIC_ID),
    'Migration 0050 changed readiness for a historical preview whose project has no controlled link.',
  );
  assert.notEqual(
    publicationReadiness(LINKS_ABSENT_PUBLIC_ID),
    'PROJECT_SNAPSHOT_STALE',
    'A historical preview with no controlled link was wrongly invalidated.',
  );

  // A populated controlled link is public-eligible content the participant never saw, so it must
  // invalidate the confirmation instead of being grandfathered in.
  assert.notEqual(
    baseline.controlledLinkReadinessBefore50,
    'PROJECT_SNAPSHOT_STALE',
    'The 48-state baseline already treated the controlled link as evidence; the gap is not reproduced.',
  );
  assert.equal(
    publicationReadiness(LINKS_PRESENT_PUBLIC_ID),
    'PROJECT_SNAPSHOT_STALE',
    'A populated controlled link was grandfathered into an old confirmed snapshot.',
  );

  assert.equal(
    untrustedRoutineExecuteGrants(),
    baseline.untrustedRoutineGrants,
    'Migration 0050 introduced an unsafe direct routine grant.',
  );
  assert.equal(
    publicTableGrants(),
    baseline.publicTableGrants,
    'Migration 0050 changed the public-schema table grant matrix.',
  );
  assert.equal(storageObjectCount(), baseline.storageObjects, 'Migration 0050 changed Storage objects.');
  console.log('PASS: Migration 0050 made controlled links participant evidence without rewriting a stored snapshot');
}

function assertAfter51(baseline: BaselineEvidence): void {
  assertPreservedTablesUnchanged(baseline.tables, 'Migration 0051');

  const expectedBucket = MIGRATION_MANAGED_BUCKETS[0];
  const bucket = psql(
    "SELECT buckets.id || '|' || buckets.name || '|' || buckets.public::text || '|'"
    + " || buckets.file_size_limit::text || '|'"
    + " || pg_catalog.array_to_string(ARRAY(SELECT pg_catalog.unnest(buckets.allowed_mime_types) ORDER BY 1), ',')"
    + ` FROM storage.buckets AS buckets WHERE buckets.id = '${expectedBucket.name}';`,
  );
  assert.equal(bucket, [
    expectedBucket.name,
    expectedBucket.name,
    String(expectedBucket.isPublic),
    String(expectedBucket.fileSizeLimit),
    [...expectedBucket.allowedMimeTypes].sort().join(','),
  ].join('|'), 'Migration 0051 did not create the correction bucket with its exact contract.');

  for (const table of CORRECTION_TABLES) {
    assert.equal(
      psql(`SELECT pg_catalog.to_regclass('public.${table}') IS NOT NULL;`),
      't',
      `public.${table} is missing after Migration 0051.`,
    );
    assert.equal(
      tableGrantsFor(table),
      'service_role:SELECT',
      `public.${table} does not expose SELECT-only authority to service_role and nothing else.`,
    );
    assert.equal(
      psql(
        'SELECT relation.relrowsecurity::text FROM pg_catalog.pg_class AS relation'
        + ' JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace'
        + ` WHERE namespace.nspname = 'public' AND relation.relname = '${table}';`,
      ),
      'true',
      `public.${table} does not have row level security enabled.`,
    );
    assert.equal(
      psql(`SELECT pg_catalog.count(*)::text FROM public.${table};`),
      '0',
      `Migration 0051 manufactured rows in public.${table}.`,
    );
  }

  const triggers = psql(
    'SELECT COALESCE(pg_catalog.string_agg(trigger_definition.tgname, chr(10) ORDER BY trigger_definition.tgname), \'\')'
    + '  FROM pg_catalog.pg_trigger AS trigger_definition'
    + '  JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger_definition.tgrelid'
    + '  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace'
    + "  WHERE namespace.nspname = 'public' AND NOT trigger_definition.tgisinternal"
    + `    AND relation.relname IN ('${CORRECTION_TABLES.join("','")}');`,
  );
  assert.equal(
    triggers,
    [...CORRECTION_IMMUTABILITY_TRIGGERS].sort().join('\n'),
    'The correction evidence immutability triggers are not exactly as declared.',
  );

  const cascades = psql(
    'SELECT COALESCE(pg_catalog.string_agg(constraint_definition.conname, chr(10)), \'\')'
    + '  FROM pg_catalog.pg_constraint AS constraint_definition'
    + '  JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_definition.conrelid'
    + '  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace'
    + "  WHERE namespace.nspname = 'public' AND constraint_definition.contype = 'f'"
    + "    AND constraint_definition.confdeltype <> 'a'"
    + `    AND relation.relname IN ('${CORRECTION_TABLES.join("','")}');`,
  );
  assert.equal(cascades, '', 'A correction evidence foreign key carries a non-default delete action.');

  assert.equal(
    psql(
      "SELECT public.start_participant_preview_correction_resolution("
      + `'${CORRECTION_PUBLIC_ID}', '${ADMIN_ID}'::uuid)->>'resultCode';`,
    ),
    'PARTICIPANT_CANDIDATE_REQUIRED',
    'The legacy correction resolution shortcut is not fail-closed.',
  );

  const correctionRpcs = psql(
    "SELECT COALESCE(pg_catalog.string_agg(entry, chr(10) ORDER BY entry), '') FROM ("
    + "  SELECT routine.proname || '(' || pg_catalog.pg_get_function_identity_arguments(routine.oid) || ')' AS entry"
    + '  FROM pg_catalog.pg_proc AS routine'
    + '  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace'
    + "  WHERE namespace.nspname = 'public'"
    + `    AND routine.proname IN ('${CORRECTION_RPC_SIGNATURES.map((signature) => signature.split('(')[0]).join("','")}')`
    + ') AS s;',
  );
  assert.equal(
    correctionRpcs,
    [...CORRECTION_RPC_SIGNATURES].sort().join('\n'),
    'The correction RPC signatures are not exactly as declared.',
  );
  for (const signature of CORRECTION_RPC_SIGNATURES) {
    const name = signature.split('(')[0];
    const grants = psql(
      "SELECT COALESCE(pg_catalog.string_agg(DISTINCT grantee.name, ','), 'NONE')"
      + '  FROM pg_catalog.pg_proc AS routine'
      + '  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace'
      + '  CROSS JOIN LATERAL ('
      + "    SELECT CASE WHEN acl.grantee = 0 THEN 'PUBLIC'"
      + '      ELSE pg_catalog.pg_get_userbyid(acl.grantee) END AS name'
      + "    FROM pg_catalog.aclexplode(COALESCE(routine.proacl, pg_catalog.acldefault('f', routine.proowner))) AS acl"
      + "    WHERE acl.privilege_type = 'EXECUTE'"
      + '  ) AS grantee'
      + `  WHERE namespace.nspname = 'public' AND routine.proname = '${name}'`
      + "    AND grantee.name IN ('PUBLIC', 'anon', 'authenticated', 'service_role');",
    );
    assert.equal(grants, 'service_role', `${name} does not grant EXECUTE to service_role alone.`);
  }

  assert.equal(
    untrustedRoutineExecuteGrants(),
    baseline.untrustedRoutineGrants,
    'Migration 0051 introduced an unsafe direct routine grant.',
  );
  assert.equal(storageObjectCount(), baseline.storageObjects, 'Migration 0051 removed or added a Storage object.');
  console.log('PASS: Migration 0051 added fail-closed, immutable, service-only correction authority');
}

function verifyUpgrade(workdir: string, networkId: string): void {
  assertBaseline();
  seedBaselineEvidence();

  const baselineGate4Errors = gate4ContractErrors();
  assert.ok(
    baselineGate4Errors.length > 0,
    'The current 51-migration Gate 4 contract accepted a 48-migration source; the pre-upgrade capture refusal is not real.',
  );
  console.log(
    `PASS: current Gate 4 contract refuses the 48-state source (${baselineGate4Errors.length} findings)`,
  );

  const baseline: BaselineEvidence = {
    absentLinkReadinessBefore50: publicationReadiness(LINKS_ABSENT_PUBLIC_ID),
    controlledLinkReadinessBefore50: publicationReadiness(LINKS_PRESENT_PUBLIC_ID),
    tables: fingerprintPreservedTables(),
    untrustedRoutineGrants: untrustedRoutineExecuteGrants(),
    publicTableGrants: publicTableGrants(),
    storageObjects: storageObjectCount(),
  };
  console.log('PASS: seeded and fingerprinted representative synthetic 48-state evidence');

  applyRelease(workdir, networkId, 49);
  assertAfter49(baseline);
  applyRelease(workdir, networkId, 50);
  assertAfter50(baseline);
  applyRelease(workdir, networkId, 51);
  assertAfter51(baseline);

  const applied = appliedMigrations();
  assert.equal(applied.length, RELEASE_MIGRATION_COUNT, 'The upgraded head is not the full release migration set.');
  assert.deepEqual(applied, repositoryMigrationVersions(), 'The upgraded history does not match the repository manifest.');

  const upgradedGate4Errors = gate4ContractErrors();
  assert.deepEqual(
    upgradedGate4Errors,
    [],
    `The upgraded database does not satisfy the current Gate 4 contract: ${upgradedGate4Errors.join(' | ')}`,
  );
  console.log(`PASS: exact ${BASELINE_MIGRATION_COUNT} -> ${RELEASE_MIGRATION_COUNT} upgrade satisfies the current Gate 4 contract`);
}

function removeOwnedDockerResidue(): void {
  const containers = docker(['ps', '-aq', '--filter', `label=com.supabase.cli.project=${projectId}`])
    .split(/\r?\n/).filter(Boolean);
  if (containers.length > 0) docker(['rm', '-f', ...containers]);
  const volumes = docker(['volume', 'ls', '-q', '--filter', `label=com.supabase.cli.project=${projectId}`])
    .split(/\r?\n/).filter(Boolean);
  if (volumes.length > 0) docker(['volume', 'rm', ...volumes]);
  const networks = docker(['network', 'ls', '--filter', `name=${networkName}`, '--format', '{{.Name}}'])
    .split(/\r?\n/).filter(Boolean);
  if (networks.includes(networkName)) docker(['network', 'rm', networkName]);
}

function main(): void {
  const migrationFiles = repositoryMigrationFiles();
  if (migrationFiles.length !== RELEASE_MIGRATION_COUNT) {
    console.error(`Repository has ${migrationFiles.length} migrations; this rehearsal targets ${RELEASE_MIGRATION_COUNT}.`);
    process.exitCode = 1;
    return;
  }

  const startedAt = Date.now();
  const workdir = createWorkdir();
  let networkId = '';
  let startAttempted = false;
  let exitCode = 1;
  try {
    networkId = docker([
      'network', 'create', '--opt', 'com.docker.network.bridge.host_binding_ipv4=127.0.0.1', networkName,
    ]);
    startAttempted = true;
    runSupabase('start', workdir, networkId);
    verifyUpgrade(workdir, networkId);
    console.log('PASS: staging migration 0048 -> 0051 upgrade rehearsal');
    console.log('HOSTED_SYSTEMS_CONTACTED = NO');
    exitCode = 0;
  } catch (error) {
    console.error(`FAIL: ${error instanceof Error ? error.message : 'STAGING_MIGRATION_UPGRADE_FAILED'}`);
    exitCode = 1;
  } finally {
    if (startAttempted) {
      try { runSupabase('stop', workdir, networkId); }
      catch { console.error('Disposable upgrade Supabase stop failed; exact-identity cleanup continues.'); exitCode = 1; }
    }
    try { removeOwnedDockerResidue(); }
    catch { console.error('Disposable upgrade Docker cleanup failed.'); exitCode = 1; }
    try { fs.rmSync(workdir, { recursive: true, force: true }); }
    catch { console.error('Disposable upgrade workdir cleanup failed.'); exitCode = 1; }

    let residue: string[] = [];
    try {
      residue = [
        ...docker(['ps', '-aq', '--filter', `label=com.supabase.cli.project=${projectId}`]).split(/\r?\n/).filter(Boolean),
        ...docker(['volume', 'ls', '-q', '--filter', `label=com.supabase.cli.project=${projectId}`]).split(/\r?\n/).filter(Boolean),
        ...docker(['network', 'ls', '--filter', `name=${networkName}`, '--format', '{{.Name}}']).split(/\r?\n/).filter(Boolean),
      ];
    } catch {
      console.error('Disposable upgrade residue inspection failed.');
      exitCode = 1;
    }
    if (residue.length > 0 || fs.existsSync(workdir)) {
      console.error('Disposable upgrade cleanup residue remains.');
      exitCode = 1;
    } else {
      console.log('PASS: disposable containers, volumes, network and workdir removed');
    }
    console.log(`Staging migration upgrade elapsed seconds: ${Math.ceil((Date.now() - startedAt) / 1000)}`);
  }
  process.exitCode = exitCode;
}

if (require.main === module) main();
