import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ALL_REQUIRED_TABLES } from '../deployment/hostedDeploymentReadiness';
import { parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';
import {
  dockerProxyCustomHeaders,
  startDockerLoopbackProxy,
  stopDockerLoopbackProxy,
} from '../local-development/safeSupabaseCli';
import { validateCurrentRepositoryGate4Contract } from '../deployment/gate4SchemaEvidence';
import { collectLocalGate4Evidence } from './checkGate4SchemaEvidence';
import { MIGRATION_MANAGED_BUCKETS } from '../local-development/localSupabaseFixtures';

/**
 * Proves the exact hosted-like 48 -> 49 -> 50 -> 51 -> 52 -> 53 -> 54 -> 55 -> 56 -> 57 migration transition on a stack this
 * verifier owns outright.
 *
 * The known hosted staging-v2 baseline is 48 migrations through
 * 20260831090000_postgres17_maintain_privilege_alignment. A clean 57-migration install proves the
 * end state but not the transition, and the existing deployment-ledger upgrade proves a different
 * single migration. This rehearsal provisions exactly the 48-migration baseline, seeds the minimum
 * representative synthetic evidence a real 48-state database would hold, applies 0049 through
 * 0057 one at a time in deterministic order, and asserts after each step that nothing existing was
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
  { ordinal: 52, version: '20260906120000', file: '20260906120000_public_removal_completion_reconciliation.sql' },
  { ordinal: 53, version: '20260909120000', file: '20260909120000_staff_lifecycle_readiness.sql' },
  { ordinal: 54, version: '20260910120000', file: '20260910120000_public_feed_rollback_capability.sql' },
  { ordinal: 55, version: '20260910120100', file: '20260910120100_participant_preview_access_observations.sql' },
  { ordinal: 56, version: '20260910120200', file: '20260910120200_assistive_worker_production_identity.sql' },
  { ordinal: 57, version: '20260911120000', file: '20260911120000_gallery_full_text_equivalents.sql' },
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
 * Rows that must survive 0049 through 0052 byte-identically. Shared taxonomy, publication and
 * deployment-ledger state are included because a release migration must never quietly touch them.
 */
// The 44-table release inventory minus the four tables first created by 0051 and the three tables
// first created by 0053/0054/0055 is the exact 37-table public contract at 6125bb56 (0048). Assert the
// live baseline set before fingerprinting.
export const PRESERVED_PUBLIC_TABLES = ALL_REQUIRED_TABLES.filter(
  (table) => table !== 'staff_lifecycle_events'
    && table !== 'participant_preview_access_observations'
    && table !== 'public_feed_rollback_capability_events'
    && table !== 'public_feed_rollback_preparation_capabilities'
    && !(CORRECTION_TABLES as readonly string[]).includes(table),
);
export const PRESERVED_EXECUTION_CONTROL_TABLES = [
  'assistive_execution_control.launch_budget_guard',
  'assistive_execution_control.launch_reservations',
  'assistive_execution_control.executor_registrations',
] as const;
const PRESERVED_TABLES = [
  ...PRESERVED_PUBLIC_TABLES.map((table) => `public.${table}`),
  ...PRESERVED_EXECUTION_CONTROL_TABLES,
];
const CURRENT_54_TABLES = [
  ...ALL_REQUIRED_TABLES
    .filter((table) => table !== 'participant_preview_access_observations')
    .map((table) => `public.${table}`),
  ...PRESERVED_EXECUTION_CONTROL_TABLES,
];
const CURRENT_55_TABLES = [
  ...ALL_REQUIRED_TABLES.map((table) => `public.${table}`),
  ...PRESERVED_EXECUTION_CONTROL_TABLES,
];

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
    "SELECT pg_catalog.count(*)::text || ':' || pg_catalog.encode(pg_catalog.sha256("
    + "pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(row_text, chr(10) ORDER BY row_text), ''), 'UTF8')), 'hex')"
    + ` FROM (SELECT pg_catalog.to_jsonb(t)::text AS row_text FROM ${table} AS t) AS s;`,
  );
}

/** Digest only the pre-0053 staff profile columns so additive lifecycle metadata cannot mask drift. */
function historicalAdminUserFingerprint(): string {
  return psql(
    "SELECT pg_catalog.count(*)::text || ':' || pg_catalog.encode(pg_catalog.sha256("
    + "pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(row_text, chr(10) ORDER BY row_text), ''), 'UTF8')), 'hex')"
    + " FROM (SELECT pg_catalog.jsonb_build_object("
    + "'id',staff.id,'email',staff.email,'full_name',staff.full_name,'created_at',staff.created_at,"
    + "'auth_user_id',staff.auth_user_id)::text AS row_text FROM public.admin_users AS staff) AS s;",
  );
}

function fingerprintPreservedTables(): Record<string, string> {
  const fingerprints: Record<string, string> = {};
  for (const table of PRESERVED_TABLES) fingerprints[table] = tableFingerprint(table);
  return fingerprints;
}

function fingerprintTables(tables: readonly string[]): Record<string, string> {
  return Object.fromEntries(tables.map((table) => [table, tableFingerprint(table)]));
}

function assertTablesUnchanged(before: Record<string, string>, stage: string): void {
  for (const [table, fingerprint] of Object.entries(before)) {
    assert.equal(tableFingerprint(table), fingerprint, `${stage} changed existing rows in ${table}.`);
  }
}

function assertPreservedTablesUnchanged(
  before: Record<string, string>,
  stage: string,
): void {
  for (const table of PRESERVED_TABLES) {
    assert.equal(
      tableFingerprint(table),
      before[table],
      `${stage} changed existing rows in ${table}.`,
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

function localStorageClient(workdir: string): SupabaseClient {
  let raw: string;
  try {
    raw = execFileSync(process.execPath, [
      path.join(repositoryRoot, 'node_modules', 'supabase', 'dist', 'supabase.js'),
      'status', '--workdir', workdir, '-o', 'env',
    ], {
      cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
      env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
    });
  } catch {
    // Child-process errors can contain CLI output with local credentials.
    throw new Error('UPGRADE_LOCAL_STORAGE_ENV_UNAVAILABLE');
  }
  const env = parseSupabaseCliEnv(raw);
  assert.ok(
    env.API_URL === `http://127.0.0.1:${portBase + 1}` && env.SERVICE_ROLE_KEY,
    'UPGRADE_STORAGE_TARGET_MUST_MATCH_OWNED_LOOPBACK_STACK',
  );
  return createClient(env.API_URL, env.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

interface StorageObjectEvidence {
  bucket: string;
  key: string;
  byteLength: number;
  sha256: string;
}

function byteEvidence(bytes: Uint8Array): Pick<StorageObjectEvidence, 'byteLength' | 'sha256'> {
  return { byteLength: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export async function readStorageEvidence(
  client: SupabaseClient,
  objects: Array<{ bucket: string; key: string }>,
): Promise<StorageObjectEvidence[]> {
  const evidence: StorageObjectEvidence[] = [];
  for (const object of objects) {
    const { data, error } = await client.storage.from(object.bucket).download(object.key);
    if (error || !data) throw new Error('UPGRADE_STORAGE_DOWNLOAD_FAILED');
    evidence.push({ ...object, ...byteEvidence(new Uint8Array(await data.arrayBuffer())) });
  }
  return evidence;
}

/**
 * The long-running rehearsal keeps the local Storage service alive while PostgreSQL applies and
 * fingerprints each release migration. Retry only a transient read failure, for a bounded 3.5
 * seconds; every successful result is still checked by exact key, byte length and SHA-256, and a
 * missing or changed object therefore remains a hard failure.
 */
async function readStorageEvidenceAfterTransientFailure(
  client: SupabaseClient,
  objects: Array<{ bucket: string; key: string }>,
): Promise<StorageObjectEvidence[]> {
  for (const delayMs of [0, 500, 1_000, 2_000]) {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      return await readStorageEvidence(client, objects);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'UPGRADE_STORAGE_DOWNLOAD_FAILED' || delayMs === 2_000) {
        throw error;
      }
    }
  }
  throw new Error('UPGRADE_STORAGE_DOWNLOAD_FAILED');
}

function storageInventory(): Array<{ bucket: string; key: string }> {
  return JSON.parse(psql(
    "SELECT COALESCE(jsonb_agg(jsonb_build_object('bucket', bucket_id, 'key', name)"
    + " ORDER BY bucket_id, name), '[]'::jsonb)::text FROM storage.objects;",
  ));
}

async function seedStorageEvidence(client: SupabaseClient): Promise<StorageObjectEvidence[]> {
  // A fixed, synthetic 1x1 PNG in a pre-0051 bucket; never pre-create the correction bucket.
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  );
  const object = { bucket: 'project-drafts-private', key: `upgrade-rehearsal/${projectId}/sentinel.png` };
  const previous = await readStorageEvidence(client, storageInventory());
  const { error } = await client.storage.from(object.bucket).upload(object.key, bytes, {
    contentType: 'image/png', upsert: false,
  });
  if (error) throw new Error('UPGRADE_STORAGE_UPLOAD_FAILED');
  const expected = [...previous, { ...object, ...byteEvidence(bytes) }]
    .sort((left, right) => left.bucket.localeCompare(right.bucket) || left.key.localeCompare(right.key));
  const actual = await readStorageEvidence(client, storageInventory());
  assert.deepEqual(actual, expected, 'The supported Storage upload did not preserve the exact object set and bytes.');
  console.log(`PASS: nonzero synthetic Storage object: ${bytes.length} bytes, SHA-256 ${byteEvidence(bytes).sha256}`);
  return actual;
}

async function assertStorageUnchanged(client: SupabaseClient, baseline: BaselineEvidence, stage: string): Promise<void> {
  assert.deepEqual(
    await readStorageEvidenceAfterTransientFailure(client, storageInventory()), baseline.storageObjects,
    `${stage} changed the Storage object set or bytes.`,
  );
  assert.equal(tableFingerprint('storage.objects'), baseline.storageRows, `${stage} changed Storage metadata.`);
  console.log(`PASS: ${stage} preserved all Storage keys, byte lengths, SHA-256 checksums and metadata`);
}

/**
 * The minimum representative 48-state evidence: staff identity and roles, shared taxonomy links,
 * projects with and without controlled links, an import batch, approval/audit rows and confirmed
 * participant previews issued by the pre-0050 authority without controlled-link keys. Taxonomy,
 * base projects and media metadata come from seed.sql. No import-commit ledger or published
 * snapshot fixture is inserted; empty tables are still covered by count/content fingerprints.
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
  assert.equal(PRESERVED_PUBLIC_TABLES.length, 37, 'The pre-0051 inventory must contain 37 public tables.');
  const liveTables = psql(
    "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename;",
  ).split(/\r?\n/);
  assert.deepEqual(liveTables, [...PRESERVED_PUBLIC_TABLES].sort(), 'The live 0048 public inventory differs.');
  for (const table of PRESERVED_TABLES) {
    assert.equal(psql(`SELECT pg_catalog.to_regclass('${table}') IS NOT NULL;`), 't', `${table} is missing.`);
  }
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
  storageObjects: StorageObjectEvidence[];
  storageRows: string;
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
  console.log('PASS: Migration 0051 added fail-closed, immutable, service-only correction authority');
}

function assertAfter52(baseline: BaselineEvidence, publicTableGrantsBefore52: string): void {
  assertPreservedTablesUnchanged(baseline.tables, 'Migration 0052');
  const completion = routineDefinition(
    'complete_public_feed_operation',
    'p_operation_id uuid, p_owner_epoch bigint, p_owner_token text, p_actor_id uuid, p_observed_hash text, p_observed_record_count integer',
  );
  assert.ok(completion.includes('SECURITY DEFINER'), 'Migration 0052 lost SECURITY DEFINER.');
  assert.ok(completion.includes("SET search_path TO ''"), 'Migration 0052 lost the empty search path.');
  assert.ok(completion.includes('pending_removal_from_public = false'));
  assert.ok(completion.includes('public_removal_completed_at = v_completed_at'));
  assert.ok(completion.includes("v_operation.state <> 'DB_FINALIZED'"));
  assert.ok(completion.includes("'INVALID_PROJECT_STATE'"));
  assert.equal(
    psql("SELECT COALESCE(pg_catalog.string_agg(CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee) END, ',' ORDER BY acl.grantee), 'NONE') FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl WHERE n.nspname='public' AND p.proname='complete_public_feed_operation' AND acl.privilege_type='EXECUTE' AND (acl.grantee=0 OR pg_catalog.pg_get_userbyid(acl.grantee) IN ('anon','authenticated','service_role'));"),
    'service_role',
  );
  assert.equal(
    untrustedRoutineExecuteGrants(),
    baseline.untrustedRoutineGrants,
    'Migration 0052 introduced an unsafe direct routine grant.',
  );
  assert.equal(
    publicTableGrants(),
    publicTableGrantsBefore52,
    'Migration 0052 changed the public-schema table grant matrix.',
  );
  console.log('PASS: Migration 0052 installed atomic removal completion without changing unrelated rows or privileges');
}

function assertAfter53(
  baseline: BaselineEvidence,
  historicalAdminUsersBefore53: string,
): void {
  for (const table of PRESERVED_TABLES.filter((candidate) => candidate !== 'public.admin_users')) {
    assert.equal(
      tableFingerprint(table),
      baseline.tables[table],
      `Migration 0053 changed existing rows in ${table}.`,
    );
  }
  assert.equal(
    historicalAdminUserFingerprint(),
    historicalAdminUsersBefore53,
    'Migration 0053 changed existing staff profile identity/history columns.',
  );
  assert.equal(
    psql("SELECT lifecycle_status || '|' || lifecycle_version::text || '|'"
      + " || COALESCE(deactivated_at::text, '') FROM public.admin_users"
      + ` WHERE id = '${ADMIN_ID}'::uuid;`),
    'active|1|',
  );
  assert.equal(psql("SELECT pg_catalog.to_regclass('public.staff_lifecycle_events') IS NOT NULL;"), 't');
  assert.equal(
    psql("SELECT relrowsecurity::text || '|' || relforcerowsecurity::text"
      + " FROM pg_catalog.pg_class WHERE oid = 'public.staff_lifecycle_events'::regclass;"),
    'true|true',
  );
  assert.equal(tableGrantsFor('staff_lifecycle_events'), 'service_role:SELECT');

  for (const [signature, trustedRole] of [
    ['public.manage_staff_lifecycle(uuid,text,text,text[],bigint)', 'service_role'],
    ['public.claim_staff_provider_reconciliation(uuid,text,bigint)', 'service_role'],
    ['public.complete_staff_provider_reconciliation(uuid,uuid,boolean,text)', 'service_role'],
    ['public.staff_session_is_active()', 'authenticated'],
    ['public.get_release_capability_sentinel()', 'service_role'],
  ] as const) {
    assert.equal(
      psql(`SELECT has_function_privilege('${trustedRole}', '${signature}', 'EXECUTE')::text`
        + ` || '|' || has_function_privilege('anon', '${signature}', 'EXECUTE')::text`
        + ` || '|' || has_function_privilege('${trustedRole === 'service_role' ? 'authenticated' : 'service_role'}', '${signature}', 'EXECUTE')::text;`),
      'true|false|false',
      `${signature} has an unsafe runtime EXECUTE grant.`,
    );
  }
  for (const signature of [
    'public.manage_staff_lifecycle(uuid,text,text,text[],bigint)',
    'public.claim_staff_provider_reconciliation(uuid,text,bigint)',
    'public.complete_staff_provider_reconciliation(uuid,uuid,boolean,text)',
    'public.staff_session_is_active()',
  ]) {
    assert.equal(
      psql(`SELECT prosecdef::text || '|' || pg_catalog.array_to_string(proconfig, ',')`
        + ` FROM pg_catalog.pg_proc WHERE oid = '${signature}'::regprocedure;`),
      'true|search_path=""',
      `${signature} is not a search-path-pinned SECURITY DEFINER function.`,
    );
  }
  assert.equal(
    psql("SELECT prosecdef::text || '|' || provolatile::text || '|' || proparallel::text || '|'"
      + " || pg_catalog.array_to_string(proconfig, ',') FROM pg_catalog.pg_proc"
      + " WHERE oid = 'public.get_release_capability_sentinel()'::regprocedure;"),
    'false|i|s|search_path=""',
  );
  assert.equal(
    psql('SELECT public.get_release_capability_sentinel();'),
    '20260909120000_staff_lifecycle_readiness|active_staff_catalog_rls_v1|staff_lifecycle_v1',
  );
  for (const table of ['programs', 'disciplines', 'industry_categories']) {
    assert.ok(
      psql(`SELECT pg_catalog.pg_get_expr(polqual, polrelid) FROM pg_catalog.pg_policy`
        + ` WHERE polrelid = 'public.${table}'::regclass`
        + ` AND polname = 'select_${table}_authenticated';`).includes('staff_session_is_active'),
      `public.${table} does not enforce the durable active-staff predicate.`,
    );
  }
  assert.ok(
    untrustedRoutineExecuteGrants().split('\n').includes('staff_session_is_active()=authenticated'),
  );
  console.log('PASS: Migration 0053 installed lifecycle, retained-token RLS, and immutable readiness authority without rewriting existing records');
}

function assertAfter54(
  preservedTablesBefore54: Record<string, string>,
  untrustedRoutineGrantsBefore54: string,
): void {
  assertPreservedTablesUnchanged(preservedTablesBefore54, 'Migration 0054');
  assert.equal(
    psql("SELECT pg_catalog.to_regclass('public.public_feed_rollback_capability_events') IS NOT NULL;"),
    't',
  );
  assert.equal(
    psql('SELECT pg_catalog.count(*)::text FROM public.public_feed_rollback_capability_events;'),
    '0',
    'Migration 0054 created a capability event without an operator transition.',
  );
  assert.equal(
    psql("SELECT pg_catalog.to_regclass('public.public_feed_rollback_preparation_capabilities') IS NOT NULL;"),
    't',
  );
  assert.equal(
    psql('SELECT pg_catalog.count(*)::text FROM public.public_feed_rollback_preparation_capabilities;'),
    '0',
    'Migration 0054 bound a preexisting rollback preparation to a capability event.',
  );
  assert.equal(
    psql("SELECT relrowsecurity::text || '|' || relforcerowsecurity::text"
      + " FROM pg_catalog.pg_class WHERE oid = 'public.public_feed_rollback_capability_events'::regclass;"),
    'true|true',
  );
  assert.equal(
    psql("SELECT relrowsecurity::text || '|' || relforcerowsecurity::text"
      + " FROM pg_catalog.pg_class WHERE oid = 'public.public_feed_rollback_preparation_capabilities'::regclass;"),
    'true|true',
  );
  assert.equal(
    tableGrantsFor('public_feed_rollback_capability_events'),
    'service_role:SELECT',
  );
  assert.equal(
    tableGrantsFor('public_feed_rollback_preparation_capabilities'),
    'service_role:SELECT',
  );
  assert.equal(
    psql("SELECT pg_catalog.count(*)::text FROM pg_catalog.pg_trigger"
      + " WHERE tgrelid = 'public.public_feed_rollback_capability_events'::regclass"
      + " AND tgname = 'reject_public_feed_rollback_capability_event_mutation' AND NOT tgisinternal;"),
    '1',
  );
  assert.equal(
    psql("SELECT pg_catalog.count(*)::text FROM pg_catalog.pg_indexes"
      + " WHERE schemaname = 'public' AND tablename = 'public_feed_rollback_capability_events'"
      + " AND indexname IN ('public_feed_rollback_capability_events_actor_idx',"
      + " 'public_feed_rollback_capability_events_head_version_idx');"),
    '2',
  );
  assert.equal(
    psql("SELECT pg_catalog.count(*)::text FROM pg_catalog.pg_trigger"
      + " WHERE tgrelid = 'public.public_feed_rollback_preparation_capabilities'::regclass"
      + " AND tgname = 'reject_public_feed_rollback_preparation_capability_mutation' AND NOT tgisinternal;"),
    '1',
  );
  assert.equal(
    psql("SELECT pg_catalog.count(*)::text FROM pg_catalog.pg_indexes"
      + " WHERE schemaname = 'public' AND tablename = 'public_feed_rollback_preparation_capabilities'"
      + " AND indexname = 'public_feed_rollback_preparation_capabilities_event_idx';"),
    '1',
  );
  for (const signature of [
    'public.transition_public_feed_rollback_capability(uuid,boolean,boolean,bigint,bigint,text,integer,text)',
    'public.prepare_verified_staging_public_feed_rollback(uuid,bigint,text,integer,jsonb)',
    'public.reserve_verified_staging_public_feed_rollback(uuid,text,uuid,text,text,text)',
  ]) {
    assert.equal(
      psql(`SELECT has_function_privilege('service_role', '${signature}', 'EXECUTE')::text`
        + ` || '|' || has_function_privilege('anon', '${signature}', 'EXECUTE')::text`
        + ` || '|' || has_function_privilege('authenticated', '${signature}', 'EXECUTE')::text;`),
      'true|false|false',
      `${signature} has an unsafe runtime EXECUTE grant.`,
    );
    assert.equal(
      psql(`SELECT prosecdef::text || '|' || pg_catalog.array_to_string(proconfig, ',')`
        + ` FROM pg_catalog.pg_proc WHERE oid = '${signature}'::regprocedure;`),
      'true|search_path=""',
      `${signature} is not a search-path-pinned SECURITY DEFINER function.`,
    );
  }
  const transition = routineDefinition('transition_public_feed_rollback_capability');
  for (const requiredFragment of [
    'SECURITY DEFINER',
    "SET search_path TO ''",
    'public_feed_canonical_writer',
    'p_require_exact_head_event',
    'RECOVERY_REQUIRED',
    'PUBLICATION_IN_PROGRESS',
    'CONFIRMATION_MISMATCH',
    'confirmation_digest',
  ]) {
    assert.ok(transition.includes(requiredFragment), `Migration 0054 RPC is missing ${requiredFragment}.`);
  }
  const actorGuard = routineDefinition('public_feed_actor_is_admin');
  for (const requiredFragment of [
    'capstone.staff_lifecycle_admin_invariant',
    "lifecycle_status = 'active'",
    'auth_user_id IS NOT NULL',
    "status = 'pending_activation'",
    'FOR SHARE',
  ]) {
    assert.ok(actorGuard.includes(requiredFragment), `Migration 0054 active-admin guard is missing ${requiredFragment}.`);
  }
  assert.equal(
    psql(`SELECT public.public_feed_actor_is_admin('${ADMIN_ID}'::uuid)::text;`),
    'false',
    'Migration 0054 treated a historical profile without a canonical Auth identity as active.',
  );
  assert.equal(
    psql("SELECT public.transition_public_feed_rollback_capability("
      + `'${ADMIN_ID}'::uuid,true,true,1,1,repeat('0',64),0,`
      + "'ENABLE PUBLIC FEED ROLLBACK FOR VERSION 1 GENERATION 1 HASH "
      + "0000000000000000000000000000000000000000000000000000000000000000 COUNT 0'"
      + ")->>'resultCode';"),
    'PERMISSION_DENIED',
  );
  assert.equal(
    psql("SELECT public.prepare_verified_staging_public_feed_rollback("
      + `'${ADMIN_ID}'::uuid,1,repeat('0',64),0,'{}'::jsonb)->>'resultCode';`),
    'PERMISSION_DENIED',
  );
  assert.equal(
    psql("SELECT public.reserve_verified_staging_public_feed_rollback("
      + `'${ADMIN_ID}'::uuid,repeat('x',32),'00000000-0000-4000-8000-000000000001'::uuid,`
      + "'synthetic acknowledgement','public-feeds','capstones-latest.json')->>'resultCode';"),
    'PERMISSION_DENIED',
  );
  assert.equal(
    psql('SELECT pg_catalog.count(*)::text FROM public.public_feed_rollback_capability_events;'),
    '0',
    'A denied Migration 0054 request created a capability event.',
  );
  assert.equal(
    psql('SELECT pg_catalog.count(*)::text FROM public.public_feed_rollback_preparation_capabilities;'),
    '0',
    'A denied Migration 0054 request created a preparation binding.',
  );
  assert.equal(
    untrustedRoutineExecuteGrants(),
    untrustedRoutineGrantsBefore54,
    'Migration 0054 introduced an unsafe direct routine grant.',
  );
  assert.equal(
    psql('SELECT public.get_release_capability_sentinel();'),
    '20260910120000_public_feed_rollback_capability|active_staff_catalog_rls_v1|staff_lifecycle_v1|staging_feed_rollback_capability_v1',
  );
  console.log('PASS: Migration 0054 installed disabled-by-default exact-head rollback authority and empty immutable audit without rewriting existing records');
}

function assertAfter55(
  current54Tables: Record<string, string>,
  untrustedRoutineGrantsBefore55: string,
): void {
  assert.equal(Object.keys(current54Tables).length, 47, 'The current 0054 table inventory is incomplete.');
  assertTablesUnchanged(current54Tables, 'Migration 0055');
  assert.equal(
    psql("SELECT pg_catalog.to_regclass('public.participant_preview_access_observations') IS NOT NULL;"),
    't',
  );
  assert.equal(
    psql('SELECT pg_catalog.count(*)::text FROM public.participant_preview_access_observations;'),
    '0',
    'Migration 0055 backfilled historical access observations.',
  );
  assert.equal(
    psql("SELECT relrowsecurity::text || '|' || relforcerowsecurity::text"
      + " FROM pg_catalog.pg_class WHERE oid = 'public.participant_preview_access_observations'::regclass;"),
    'true|true',
  );
  assert.equal(tableGrantsFor('participant_preview_access_observations'), 'service_role:SELECT');
  assert.equal(
    psql("SELECT has_function_privilege('service_role',"
      + " 'public.record_participant_preview_response_prepared(uuid,text)', 'EXECUTE')::text"
      + " || '|' || has_function_privilege('anon',"
      + " 'public.record_participant_preview_response_prepared(uuid,text)', 'EXECUTE')::text"
      + " || '|' || has_function_privilege('authenticated',"
      + " 'public.record_participant_preview_response_prepared(uuid,text)', 'EXECUTE')::text;"),
    'true|false|false',
  );
  assert.equal(
    psql("SELECT prosecdef::text || '|' || pg_catalog.array_to_string(proconfig, ',')"
      + " FROM pg_catalog.pg_proc WHERE oid ="
      + " 'public.record_participant_preview_response_prepared(uuid,text)'::regprocedure;"),
    'true|search_path=""',
  );
  const observation = routineDefinition('record_participant_preview_response_prepared');
  for (const requiredFragment of [
    'SECURITY DEFINER', "SET search_path TO ''", 'participant_preview_id',
    'token_hash = p_token_hash', 'FOR SHARE', "status <> 'active'", 'expires_at <= v_observed_at',
    'ON CONFLICT (participant_preview_id) DO NOTHING',
  ]) {
    assert.ok(observation.includes(requiredFragment), `Migration 0055 RPC is missing ${requiredFragment}.`);
  }
  assert.equal(
    untrustedRoutineExecuteGrants(),
    untrustedRoutineGrantsBefore55,
    'Migration 0055 introduced an unsafe direct routine grant.',
  );
  assert.equal(psql('SELECT public.get_release_capability_sentinel();'),
    '20260910120100_participant_preview_access_observations|active_staff_catalog_rls_v1|staff_lifecycle_v1|staging_feed_rollback_capability_v1|preview_response_observation_v1');
  console.log('PASS: Migration 0055 preserved all current 0054 data, performed no backfill, and installed narrow response-observation authority');
}

function assertAfter56(
  current55Tables: Record<string, string>,
  publicTableGrantsBefore56: string,
  untrustedRoutineGrantsBefore56: string,
): void {
  assert.equal(Object.keys(current55Tables).length, 48, 'The current 0055 table inventory is incomplete.');
  assertTablesUnchanged(current55Tables, 'Migration 0056');
  assert.equal(publicTableGrants(), publicTableGrantsBefore56, 'Migration 0056 changed direct table grants.');
  assert.equal(
    untrustedRoutineExecuteGrants(),
    untrustedRoutineGrantsBefore56,
    'Migration 0056 introduced an unsafe direct routine grant.',
  );
  assert.equal(
    psql("SELECT relrowsecurity::text || '|' || relforcerowsecurity::text"
      + " FROM pg_catalog.pg_class WHERE oid = 'public.assistive_worker_heartbeats'::regclass;"),
    'true|true',
  );
  assert.equal(tableGrantsFor('assistive_worker_heartbeats'), 'NONE');
  const environmentConstraint = psql("SELECT pg_catalog.pg_get_constraintdef(oid)"
    + " FROM pg_catalog.pg_constraint WHERE conrelid='public.assistive_worker_heartbeats'::regclass"
    + " AND conname='check_assistive_worker_environment';");
  assert.ok(environmentConstraint.includes('staging') && environmentConstraint.includes('production'));

  for (const signature of [
    'public.upsert_assistive_worker_heartbeat(text,text,text,text,text,text,text)',
    'public.get_assistive_worker_availability(text,text,text,text,text,integer)',
  ]) {
    assert.equal(
      psql(`SELECT has_function_privilege('service_role', '${signature}', 'EXECUTE')::text`
        + ` || '|' || has_function_privilege('anon', '${signature}', 'EXECUTE')::text`
        + ` || '|' || has_function_privilege('authenticated', '${signature}', 'EXECUTE')::text;`),
      'true|false|false',
    );
    assert.equal(
      psql(`SELECT prosecdef::text || '|' || pg_catalog.array_to_string(proconfig, ',')`
        + ` FROM pg_catalog.pg_proc WHERE oid = '${signature}'::regprocedure;`),
      'true|search_path=""',
    );
  }

  const heartbeatArguments = `'assistive-deterministic-checks/v3','${'a'.repeat(40)}',`
    + "'paddle-title/pp-ocrv6-small@3.7.0','languagetool/en-au@6.6'";
  assert.equal(
    psql(`SELECT public.get_assistive_worker_availability('production',${heartbeatArguments},60)->>'resultCode';`),
    'UNAVAILABLE',
    'Synthetic staging evidence qualified production at the same deployment and capabilities.',
  );
  assert.equal(
    psql(`SELECT public.upsert_assistive_worker_heartbeat('upgrade-synthetic-staging','production',${heartbeatArguments},'READY')->>'resultCode';`),
    'VALIDATION_FAILED',
    'Migration 0056 allowed a synthetic staging instance ID to be relabelled as production.',
  );
  assert.equal(
    psql("SELECT environment FROM public.assistive_worker_heartbeats"
      + " WHERE worker_instance_id='upgrade-synthetic-staging';"),
    'staging',
  );
  assert.equal(
    psql(`SELECT public.upsert_assistive_worker_heartbeat('upgrade-synthetic-production','production',${heartbeatArguments},'READY')->>'resultCode';`),
    'HEARTBEAT_RECORDED',
  );
  assert.equal(
    psql(`SELECT public.get_assistive_worker_availability('production',${heartbeatArguments},60)->>'compatibleWorkerCount';`),
    '1',
  );
  assert.equal(
    psql(`SELECT public.get_assistive_worker_availability('staging',${heartbeatArguments},60)->>'compatibleWorkerCount';`),
    '1',
  );
  assert.equal(
    psql(`SELECT public.get_assistive_worker_availability('local',${heartbeatArguments},60)->>'resultCode';`),
    'VALIDATION_FAILED',
  );
  assert.equal(
    psql('SELECT public.get_release_capability_sentinel();'),
    '20260910120200_assistive_worker_production_identity|active_staff_catalog_rls_v1|staff_lifecycle_v1|staging_feed_rollback_capability_v1|preview_response_observation_v1|assistive_worker_environment_identity_v1',
  );
  console.log('PASS: Migration 0056 preserved all current 0055 data and installed exact, service-only staging/production heartbeat identity');
}

/** Digest media rows on their pre-0057 columns only, so the two additive columns cannot mask drift. */
function historicalMediaAssetFingerprint(): string {
  return psql(
    "SELECT pg_catalog.count(*)::text || ':' || pg_catalog.encode(pg_catalog.sha256("
    + "pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(row_text, chr(10) ORDER BY row_text), ''), 'UTF8')), 'hex')"
    + " FROM (SELECT (pg_catalog.to_jsonb(m) - 'image_content_kind' - 'full_text_public')::text AS row_text"
    + ' FROM public.media_assets AS m) AS s;',
  );
}

/** Runs a mutation that must be refused by the gallery text-equivalent check constraint. */
function assertGalleryCheckRefuses(mutation: string, label: string): void {
  const diagnosticLabel = label.replaceAll("'", "''");
  psql(`DO $$ BEGIN
    BEGIN
      ${mutation}
      RAISE EXCEPTION 'GALLERY_CHECK_NOT_ENFORCED: ${diagnosticLabel}';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END $$;`);
  assert.equal(psql("SELECT count(*) FROM public.media_assets WHERE file_name = 'upgrade-check.png';"), '0',
    `Migration 0057 check constraint did not refuse: ${label}`);
}

function assertAfter57(
  current56Tables: Record<string, string>,
  mediaAssetsBefore57: string,
  publicTableGrantsBefore57: string,
  untrustedRoutineGrantsBefore57: string,
): void {
  assert.equal(Object.keys(current56Tables).length, 47, 'The current 0056 table inventory is incomplete.');
  assertTablesUnchanged(current56Tables, 'Migration 0057');
  assert.equal(historicalMediaAssetFingerprint(), mediaAssetsBefore57, 'Migration 0057 changed existing media rows.');
  // Additive and unbackfilled: every pre-existing snapshot stays undeclared (NULL), never "ordinary".
  assert.equal(
    psql('SELECT count(*) FROM public.media_assets WHERE image_content_kind IS NOT NULL OR full_text_public IS NOT NULL;'),
    '0',
    'Migration 0057 backfilled a text-equivalent declaration.',
  );
  assert.equal(publicTableGrants(), publicTableGrantsBefore57, 'Migration 0057 changed direct table grants.');
  assert.equal(
    untrustedRoutineExecuteGrants(),
    untrustedRoutineGrantsBefore57,
    'Migration 0057 introduced an unsafe direct routine grant.',
  );
  assert.equal(
    psql("SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' ORDER BY column_name)"
      + " FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'media_assets'"
      + " AND column_name IN ('image_content_kind', 'full_text_public');"),
    'full_text_public:text:YES,image_content_kind:text:YES',
  );
  const galleryConstraint = psql("SELECT pg_catalog.pg_get_constraintdef(oid)"
    + " FROM pg_catalog.pg_constraint WHERE conrelid='public.media_assets'::regclass"
    + " AND conname='check_media_asset_gallery_text_equivalent';");
  for (const fragment of ["'ordinary'", "'text_bearing'", 'full_text_public IS NULL', '<= 5000', 'btrim(full_text_public)']) {
    assert.ok(galleryConstraint.includes(fragment), `Migration 0057 constraint is missing ${fragment}.`);
  }

  // Every forward-redefined RPC carries the contract, stays SECURITY DEFINER with an empty
  // search_path, and remains service-role-only.
  for (const [signature, fragment] of [
    ['public.finalize_browser_import_media_stage(uuid,text,text,uuid,jsonb)', "'snapshotContentKind'"],
    ['public.submit_import_projects_for_review(uuid,text[],uuid,text)', "'MISSING_SNAPSHOT_CONTENT_TYPE'"],
    ['public.perform_project_review_action(text,text,text,uuid)', 'v_undeclared_snapshot_count'],
    ['public.generate_participant_preview(text,uuid,text,integer,text,boolean)', "'contentKind', ma.image_content_kind"],
    ['public.get_project_publication_readiness(text,uuid,text)', "'Snapshot image %s content type is missing'"],
    ['public.get_project_reconciliation_readiness(text,uuid,text)', "'Snapshot image %s content type is missing'"],
    ['public.reserve_participant_correction(text,text,jsonb,jsonb,jsonb,text,jsonb,text,uuid)', "'contentKind','fullText'"],
    ['public.review_participant_correction(text,uuid,uuid,text,text,text)', "image_content_kind=f->>'contentKind'"],
  ] as const) {
    assert.ok(
      psql(`SELECT pg_catalog.pg_get_functiondef('${signature}'::regprocedure);`).includes(fragment),
      `Migration 0057 did not redefine ${signature} (${fragment} missing).`,
    );
    assert.equal(
      psql(`SELECT has_function_privilege('service_role', '${signature}', 'EXECUTE')::text`
        + ` || '|' || has_function_privilege('anon', '${signature}', 'EXECUTE')::text`
        + ` || '|' || has_function_privilege('authenticated', '${signature}', 'EXECUTE')::text;`),
      'true|false|false',
    );
    assert.equal(
      psql(`SELECT prosecdef::text || '|' || pg_catalog.array_to_string(proconfig, ',')`
        + ` FROM pg_catalog.pg_proc WHERE oid = '${signature}'::regprocedure;`),
      'true|search_path=""',
    );
  }

  // Constraint behaviour on a synthetic snapshot row: coherent declarations persist, incoherent
  // ones are refused, and nothing is inferred for an undeclared row.
  const insertSnapshot = (kind: string, fullText: string) => `INSERT INTO public.media_assets (
      project_id, asset_type, gallery_position, file_name, storage_bucket, storage_path, mime_type,
      file_size_bytes, is_public_approved, alt_text_public, image_content_kind, full_text_public
    ) SELECT projects.id, 'snapshot_image', 9, 'upgrade-check.png', 'project-drafts-private',
      'drafts/' || projects.public_id || '/snapshot_image/upgrade-check.png', 'image/png', 1024, false,
      'Synthetic upgrade check image.', ${kind}, ${fullText}
    FROM public.projects AS projects WHERE projects.source_folder = 'upgrade-rehearsal' LIMIT 1;`;
  assertGalleryCheckRefuses(insertSnapshot("'text_bearing'", 'NULL'), 'text-bearing without full text');
  assertGalleryCheckRefuses(insertSnapshot("'ordinary'", "'Unexpected transcription.'"), 'ordinary with full text');
  assertGalleryCheckRefuses(insertSnapshot('NULL', "'Undeclared transcription.'"), 'full text without declaration');
  assertGalleryCheckRefuses(insertSnapshot("'photograph'", 'NULL'), 'unknown content kind');
  assertGalleryCheckRefuses(insertSnapshot("'text_bearing'", `'${'x'.repeat(5001)}'`), 'oversized full text');
  assertGalleryCheckRefuses(insertSnapshot("'text_bearing'", "'  padded  '"), 'untrimmed full text');
  psql(insertSnapshot("'text_bearing'", "'Synthetic dashboard: queue length 12 vehicles; wait 41 s.'"));
  psql("UPDATE public.media_assets SET image_content_kind = 'ordinary', full_text_public = NULL WHERE file_name = 'upgrade-check.png';");
  assert.equal(
    psql("SELECT image_content_kind || '|' || COALESCE(full_text_public, '<null>') FROM public.media_assets WHERE file_name = 'upgrade-check.png';"),
    'ordinary|<null>',
  );
  psql("DELETE FROM public.media_assets WHERE file_name = 'upgrade-check.png';");
  assert.equal(historicalMediaAssetFingerprint(), mediaAssetsBefore57, 'Migration 0057 rehearsal left synthetic media behind.');

  assert.equal(
    psql('SELECT public.get_release_capability_sentinel();'),
    '20260911120000_gallery_full_text_equivalents|active_staff_catalog_rls_v1|staff_lifecycle_v1|staging_feed_rollback_capability_v1|preview_response_observation_v1|assistive_worker_environment_identity_v1|gallery_text_equivalent_v1',
  );
  console.log('PASS: Migration 0057 preserved all current 0056 data, performed no backfill, and installed the gallery text-equivalent contract');
}

async function verifyUpgrade(workdir: string, networkId: string): Promise<void> {
  assertBaseline();
  seedBaselineEvidence();
  const storageClient = localStorageClient(workdir);
  const storageObjects = await seedStorageEvidence(storageClient);

  const baselineGate4Errors = gate4ContractErrors();
  assert.ok(
    baselineGate4Errors.length > 0,
    'The current 57-migration Gate 4 contract accepted a 48-migration source; the pre-upgrade capture refusal is not real.',
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
    storageObjects,
    storageRows: tableFingerprint('storage.objects'),
  };
  console.log('PASS: fingerprinted counts/content for all 37 public and 3 execution-control baseline tables');

  applyRelease(workdir, networkId, 49);
  assertAfter49(baseline);
  await assertStorageUnchanged(storageClient, baseline, 'Migration 0049');
  assert.equal(psql("SELECT count(*) FROM storage.buckets WHERE id = 'participant-corrections-private';"), '0');
  applyRelease(workdir, networkId, 50);
  assertAfter50(baseline);
  await assertStorageUnchanged(storageClient, baseline, 'Migration 0050');
  assert.equal(psql("SELECT count(*) FROM storage.buckets WHERE id = 'participant-corrections-private';"), '0');
  applyRelease(workdir, networkId, 51);
  assertAfter51(baseline);
  await assertStorageUnchanged(storageClient, baseline, 'Migration 0051');
  const publicTableGrantsBefore52 = publicTableGrants();
  applyRelease(workdir, networkId, 52);
  assertAfter52(baseline, publicTableGrantsBefore52);
  await assertStorageUnchanged(storageClient, baseline, 'Migration 0052');
  const historicalAdminUsersBefore53 = historicalAdminUserFingerprint();
  applyRelease(workdir, networkId, 53);
  assertAfter53(baseline, historicalAdminUsersBefore53);
  await assertStorageUnchanged(storageClient, baseline, 'Migration 0053');
  const preservedTablesBefore54 = fingerprintPreservedTables();
  const untrustedRoutineGrantsBefore54 = untrustedRoutineExecuteGrants();
  applyRelease(workdir, networkId, 54);
  assertAfter54(preservedTablesBefore54, untrustedRoutineGrantsBefore54);
  await assertStorageUnchanged(storageClient, baseline, 'Migration 0054');
  const current54Tables = fingerprintTables(CURRENT_54_TABLES);
  const untrustedRoutineGrantsBefore55 = untrustedRoutineExecuteGrants();
  applyRelease(workdir, networkId, 55);
  assertAfter55(current54Tables, untrustedRoutineGrantsBefore55);
  await assertStorageUnchanged(storageClient, baseline, 'Migration 0055');
  psql(`INSERT INTO public.assistive_worker_heartbeats (
    worker_instance_id, environment, pipeline_version, deployment_version,
    ocr_capability, language_capability, health_state, heartbeat_at
  ) VALUES (
    'upgrade-synthetic-staging', 'staging', 'assistive-deterministic-checks/v3', '${'a'.repeat(40)}',
    'paddle-title/pp-ocrv6-small@3.7.0', 'languagetool/en-au@6.6', 'READY', pg_catalog.statement_timestamp()
  );`);
  const current55Tables = fingerprintTables(CURRENT_55_TABLES);
  const publicTableGrantsBefore56 = publicTableGrants();
  const untrustedRoutineGrantsBefore56 = untrustedRoutineExecuteGrants();
  applyRelease(workdir, networkId, 56);
  assertAfter56(current55Tables, publicTableGrantsBefore56, untrustedRoutineGrantsBefore56);
  await assertStorageUnchanged(storageClient, baseline, 'Migration 0056');
  // media_assets gains two columns in 0057, so it is fingerprinted on its historical columns only.
  const current56Tables = fingerprintTables(CURRENT_55_TABLES.filter((table) => table !== 'public.media_assets'));
  const mediaAssetsBefore57 = historicalMediaAssetFingerprint();
  const publicTableGrantsBefore57 = publicTableGrants();
  const untrustedRoutineGrantsBefore57 = untrustedRoutineExecuteGrants();
  applyRelease(workdir, networkId, 57);
  assertAfter57(current56Tables, mediaAssetsBefore57, publicTableGrantsBefore57, untrustedRoutineGrantsBefore57);
  await assertStorageUnchanged(storageClient, baseline, 'Migration 0057');

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

async function main(): Promise<void> {
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
    await verifyUpgrade(workdir, networkId);
    console.log('PASS: staging migration 0048 -> 0057 upgrade rehearsal');
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

if (require.main === module) void main();
