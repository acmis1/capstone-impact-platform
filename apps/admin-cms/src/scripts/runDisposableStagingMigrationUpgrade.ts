import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
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
import { executeControlledPublication } from '../projects/controlledPublicationService';
import { createControlledPublicationDependencies } from '../projects/createControlledPublicationDependencies';
import { executeControlledPublicRemoval } from '../projects/controlledPublicRemovalService';
import { createControlledPublicRemovalDependencies } from '../projects/createControlledPublicRemovalDependencies';
import {
  composePublicFeedRemoval,
  createPublicFeedArtifact,
  verifyPublicFeedArtifact,
  type VerifiedPublicFeedArtifact,
} from '../feed/publicFeedArtifact';
import type { PublicFeedRecord } from '../domain/publicFeed';

/**
 * Proves the exact hosted-like 48 -> 49 -> 50 -> 51 -> 52 -> 53 -> 54 -> 55 -> 56 -> 57 -> 58 -> 59 -> 60 -> 61 migration transition on a stack this
 * verifier owns outright.
 *
 * The known hosted staging-v2 baseline is 48 migrations through
 * 20260831090000_postgres17_maintain_privilege_alignment. A clean 61-migration install proves the
 * end state but not the transition, and the existing deployment-ledger upgrade proves a different
 * single migration. This rehearsal provisions exactly the 48-migration baseline, seeds the minimum
 * representative synthetic evidence a real 48-state database would hold, applies 0049 through
 * 0061 one at a time in deterministic order, and asserts after each step that nothing existing was
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
  { ordinal: 58, version: '20260914100000', file: '20260914100000_layout_recipe_library.sql' },
  { ordinal: 59, version: '20260916120000', file: '20260916120000_archived_project_restore.sql' },
  { ordinal: 60, version: '20260917090000', file: '20260917090000_archived_project_republish_media_rearm.sql' },
  { ordinal: 61, version: '20260917120000', file: '20260917120000_governed_project_soft_delete.sql' },
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

const LAYOUT_RECIPE_TABLES = [
  'layout_recipe_versions',
  'layout_recipe_audit_events',
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
// The 47-table Migration-0058 release inventory minus the two layout-recipe tables, four correction
// tables and four tables first created by 0053/0054/0055 is the exact 37-table public contract at
// 6125bb56 (0048). Assert the live baseline set before fingerprinting.
export const PRESERVED_PUBLIC_TABLES = ALL_REQUIRED_TABLES.filter(
  (table) => table !== 'staff_lifecycle_events'
    && table !== 'participant_preview_access_observations'
    && table !== 'public_feed_rollback_capability_events'
    && table !== 'public_feed_rollback_preparation_capabilities'
    && !(CORRECTION_TABLES as readonly string[]).includes(table)
    && !(LAYOUT_RECIPE_TABLES as readonly string[]).includes(table),
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
    .filter((table) => table !== 'participant_preview_access_observations'
      && !(LAYOUT_RECIPE_TABLES as readonly string[]).includes(table))
    .map((table) => `public.${table}`),
  ...PRESERVED_EXECUTION_CONTROL_TABLES,
];
const CURRENT_55_TABLES = [
  ...ALL_REQUIRED_TABLES
    .filter((table) => !(LAYOUT_RECIPE_TABLES as readonly string[]).includes(table))
    .map((table) => `public.${table}`),
  ...PRESERVED_EXECUTION_CONTROL_TABLES,
];
const CURRENT_57_TABLES = CURRENT_55_TABLES;
const CURRENT_58_TABLES = [
  ...ALL_REQUIRED_TABLES.map((table) => `public.${table}`),
  ...PRESERVED_EXECUTION_CONTROL_TABLES,
];
const CURRENT_59_TABLES_FINGERPRINTED_BEFORE_M60 = CURRENT_58_TABLES.filter(
  (table) => table !== 'public.media_assets'
    && table !== 'public.participant_previews'
    && table !== 'public.public_feed_project_projection_authority',
);

/** Exact overloads of the participant-preview issuance authority and its legacy wrapper. */
const PREVIEW_ISSUANCE_IDENTITY = 'p_public_id text, p_admin_id uuid, p_token_hash text, p_expires_in_seconds integer, p_private_bucket text, p_is_correction_reissue boolean';
const PREVIEW_WRAPPER_IDENTITY = 'p_public_id text, p_admin_id uuid, p_token_hash text, p_expires_in_seconds integer, p_private_bucket text';

const ADMIN_ID = '3f000000-0000-4000-8000-000000000001';
const ADMIN_AUTH_ID = '3f000000-0000-4000-8000-000000000101';
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
const disposableApiUrl = `http://127.0.0.1:${portBase + 1}`;
const publicFeedBucket = 'public-feeds';
const baselineFeedPath = 'upgrade-restore-head';
const publicationFeedPath = 'upgrade-restore-published-head';

const RECONCILIATION_REMOVAL_PUBLIC_IDS = [
  'upgrade-reconcile-eligible',
  'upgrade-reconcile-already-rearmed',
  'upgrade-reconcile-writer-blocked',
  'upgrade-reconcile-no-feed-change',
  'upgrade-reconcile-race-archive-first',
  'upgrade-reconcile-race-reconcile-first',
  'upgrade-reconcile-race-media-change',
  'upgrade-reconcile-race-edit-change',
  'upgrade-reconcile-race-tombstone',
] as const;

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
      cwd: repositoryRoot, encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'inherit'],
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
    env.API_URL === disposableApiUrl && env.SERVICE_ROLE_KEY,
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

/** Digest participant preview rows on their pre-0058 columns so the additive layout snapshot cannot mask drift. */
function historicalParticipantPreviewFingerprint(): string {
  return psql(
    "SELECT pg_catalog.count(*)::text || ':' || pg_catalog.encode(pg_catalog.sha256("
    + "pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(row_text, chr(10) ORDER BY row_text), ''), 'UTF8')), 'hex')"
    + " FROM (SELECT (pg_catalog.to_jsonb(preview) - 'layout_config_snapshot')::text AS row_text"
    + ' FROM public.participant_previews AS preview) AS s;',
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

function assertAfter58(
  current57Tables: Record<string, string>,
  participantPreviewsBefore58: string,
  publicTableGrantsBefore58: string,
  untrustedRoutineGrantsBefore58: string,
): void {
  assert.equal(Object.keys(current57Tables).length, 47, 'The current 0057 retained-table inventory is incomplete.');
  assertTablesUnchanged(current57Tables, 'Migration 0058');
  assert.equal(
    historicalParticipantPreviewFingerprint(),
    participantPreviewsBefore58,
    'Migration 0058 changed historical participant preview fields.',
  );

  assert.equal(
    psql("SELECT data_type || '|' || is_nullable FROM information_schema.columns"
      + " WHERE table_schema='public' AND table_name='participant_previews'"
      + " AND column_name='layout_config_snapshot';"),
    'jsonb|YES',
    'Migration 0058 did not add the nullable JSONB preview layout snapshot exactly.',
  );
  assert.equal(
    psql('SELECT count(*)::text FROM public.participant_previews WHERE layout_config_snapshot IS NOT NULL;'),
    '0',
    'Migration 0058 backfilled historical participant preview layout evidence.',
  );
  assert.equal(
    psql("SELECT count(*)::text FROM pg_catalog.pg_trigger"
      + " WHERE tgrelid='public.participant_previews'::regclass"
      + " AND tgname IN ('capture_participant_preview_layout_config','participant_preview_layout_config_immutable')"
      + ' AND NOT tgisinternal;'),
    '2',
    'Migration 0058 preview layout capture/immutability triggers are incomplete.',
  );

  const validStockLayout = JSON.stringify({
    templateId: 'poster_showcase',
    featuredMedia: 'poster',
    sectionOrder: ['background', 'solution', 'snapshots', 'video', 'team', 'links', 'citations', 'accessibilityText'],
    hiddenSections: [],
  });
  const invalidHiddenSnapshotsLayout = JSON.stringify({
    templateId: 'poster_showcase',
    featuredMedia: 'poster',
    sectionOrder: ['background', 'solution', 'snapshots', 'video', 'team', 'links', 'citations', 'accessibilityText'],
    hiddenSections: ['snapshots'],
  });
  assert.equal(psql(`SELECT public.layout_recipe_config_valid('${validStockLayout}'::jsonb)::text;`), 'true');
  assert.equal(psql(`SELECT public.layout_recipe_config_valid('${invalidHiddenSnapshotsLayout}'::jsonb)::text;`), 'false');

  for (const table of LAYOUT_RECIPE_TABLES) {
    assert.equal(
      psql(`SELECT pg_catalog.to_regclass('public.${table}') IS NOT NULL;`),
      't',
      `Migration 0058 did not create public.${table}.`,
    );
    assert.equal(tableGrantsFor(table), 'service_role:SELECT', `public.${table} grant contract drifted.`);
    assert.equal(
      psql(`SELECT relrowsecurity::text FROM pg_catalog.pg_class WHERE oid='public.${table}'::regclass;`),
      'true',
      `public.${table} does not have RLS enabled.`,
    );
    assert.equal(psql(`SELECT count(*)::text FROM public.${table};`), '0', `Migration 0058 manufactured rows in public.${table}.`);
  }

  const expectedPublicTableGrants = [
    ...publicTableGrantsBefore58.split('\n').filter(Boolean),
    'layout_recipe_audit_events=service_role:SELECT',
    'layout_recipe_versions=service_role:SELECT',
  ].sort().join('\n');
  assert.equal(
    publicTableGrants(),
    expectedPublicTableGrants,
    'Migration 0058 changed direct table grants beyond the two SELECT-only layout recipe tables.',
  );
  assert.equal(
    untrustedRoutineExecuteGrants(),
    untrustedRoutineGrantsBefore58,
    'Migration 0058 introduced an unsafe direct routine grant.',
  );

  for (const signature of [
    'public.create_layout_recipe(uuid,text,jsonb,uuid)',
    'public.version_layout_recipe(uuid,uuid,integer,text,jsonb)',
    'public.retire_layout_recipe(uuid,uuid,integer)',
  ] as const) {
    assert.equal(
      psql(`SELECT has_function_privilege('service_role','${signature}','EXECUTE')::text`
        + ` || '|' || has_function_privilege('anon','${signature}','EXECUTE')::text`
        + ` || '|' || has_function_privilege('authenticated','${signature}','EXECUTE')::text;`),
      'true|false|false',
      `Migration 0058 public RPC grant contract drifted for ${signature}.`,
    );
  }

  assert.equal(
    psql(`SELECT has_function_privilege('service_role','public.layout_recipe_config_valid(jsonb)','EXECUTE')::text`
      + ` || '|' || has_function_privilege('anon','public.layout_recipe_config_valid(jsonb)','EXECUTE')::text`
      + ` || '|' || has_function_privilege('authenticated','public.layout_recipe_config_valid(jsonb)','EXECUTE')::text;`),
    'true|false|false',
    'Migration 0058 layout validator must remain service-role-only so CHECK constraints can execute.',
  );

  for (const signature of [
    'public.layout_recipe_actor_can_manage(uuid)',
    'public.get_project_publication_readiness_without_layout_recipe(text,uuid,text)',
    'public.get_project_reconciliation_readiness_without_layout_recipe(text,uuid,text)',
    'public.capture_participant_preview_layout_config()',
    'public.guard_participant_preview_layout_config_immutable()',
  ] as const) {
    assert.equal(
      psql(`SELECT has_function_privilege('service_role','${signature}','EXECUTE')::text`
        + ` || '|' || has_function_privilege('anon','${signature}','EXECUTE')::text`
        + ` || '|' || has_function_privilege('authenticated','${signature}','EXECUTE')::text;`),
      'false|false|false',
      `Migration 0058 exposed internal helper ${signature}.`,
    );
  }

  for (const signature of [
    'public.get_project_publication_readiness(text,uuid,text)',
    'public.get_project_reconciliation_readiness(text,uuid,text)',
  ] as const) {
    assert.equal(
      psql(`SELECT has_function_privilege('service_role','${signature}','EXECUTE')::text`
        + ` || '|' || has_function_privilege('anon','${signature}','EXECUTE')::text`
        + ` || '|' || has_function_privilege('authenticated','${signature}','EXECUTE')::text;`),
      'true|false|false',
      `Migration 0058 readiness wrapper grant contract drifted for ${signature}.`,
    );
  }

  let immutableRejected = false;
  try {
    psql(`UPDATE public.participant_previews
      SET layout_config_snapshot='${validStockLayout}'::jsonb
      WHERE id=(SELECT id FROM public.participant_previews ORDER BY id LIMIT 1);`);
  } catch {
    immutableRejected = true;
  }
  assert.equal(immutableRejected, true, 'Migration 0058 allowed mutation of historical participant layout evidence.');
  assert.equal(
    psql('SELECT count(*)::text FROM public.participant_previews WHERE layout_config_snapshot IS NOT NULL;'),
    '0',
    'Migration 0058 immutability refusal still changed historical layout evidence.',
  );

  assert.equal(
    psql('SELECT public.get_release_capability_sentinel();'),
    '20260914100000_layout_recipe_library|active_staff_catalog_rls_v1|staff_lifecycle_v1|staging_feed_rollback_capability_v1|preview_response_observation_v1|assistive_worker_environment_identity_v1|gallery_text_equivalent_v1|layout_recipe_library_v1',
  );
  console.log('PASS: Migration 0058 preserved retained rows, kept historical layout evidence null/immutable, and installed service-only bounded layout recipe authority');
}

function assertAfter59(
  current58Tables: Record<string, string>,
  publicTableGrantsBefore59: string,
  untrustedRoutineGrantsBefore59: string,
  reviewDefinitionBefore59: string,
): void {
  assert.equal(Object.keys(current58Tables).length, 50, 'The current 0058 retained-table inventory is incomplete.');
  assertTablesUnchanged(current58Tables, 'Migration 0059');
  assert.equal(publicTableGrants(), publicTableGrantsBefore59, 'Migration 0059 changed direct table grants.');
  assert.equal(
    untrustedRoutineExecuteGrants(),
    untrustedRoutineGrantsBefore59,
    'Migration 0059 introduced an unsafe direct routine grant.',
  );

  const identity = 'p_public_id text, p_action text, p_comments text, p_admin_id uuid';
  const helperDefinition = routineDefinition('perform_project_review_action_without_restore', identity)
    .replaceAll('perform_project_review_action_without_restore', 'perform_project_review_action');
  assert.equal(
    helperDefinition,
    reviewDefinitionBefore59,
    'Migration 0059 rewrote the established non-restore review authority.',
  );
  assert.equal(
    psql("SELECT has_function_privilege('service_role','public.perform_project_review_action_without_restore(text,text,text,uuid)','EXECUTE')::text"
      + " || '|' || has_function_privilege('anon','public.perform_project_review_action_without_restore(text,text,text,uuid)','EXECUTE')::text"
      + " || '|' || has_function_privilege('authenticated','public.perform_project_review_action_without_restore(text,text,text,uuid)','EXECUTE')::text;"),
    'false|false|false',
    'Migration 0059 exposed the delegated review helper.',
  );
  assert.equal(
    psql("SELECT has_function_privilege('service_role','public.perform_project_review_action(text,text,text,uuid)','EXECUTE')::text"
      + " || '|' || has_function_privilege('anon','public.perform_project_review_action(text,text,text,uuid)','EXECUTE')::text"
      + " || '|' || has_function_privilege('authenticated','public.perform_project_review_action(text,text,text,uuid)','EXECUTE')::text;"),
    'true|false|false',
    'Migration 0059 review wrapper grant contract drifted.',
  );

  const wrapper = routineDefinition('perform_project_review_action', identity);
  assert.match(wrapper, /p_action IS DISTINCT FROM 'restore'/);
  assert.match(wrapper, /WHEN 'published' THEN 'approved'/);
  assert.doesNotMatch(wrapper, /WHEN 'published' THEN 'published'/);
  assert.match(wrapper, /ARCHIVE_PROVENANCE_AMBIGUOUS/);
  assert.match(wrapper, /RESTORE_PUBLIC_FEED_UNSAFE/);
  assert.match(wrapper, /public_feed_canonical_writer/);
  assert.match(wrapper, /action_taken,[\s\S]*'restore'/);
  assert.equal(
    psql('SELECT public.get_release_capability_sentinel();'),
    '20260916120000_archived_project_restore|active_staff_catalog_rls_v1|staff_lifecycle_v1|staging_feed_rollback_capability_v1|preview_response_observation_v1|assistive_worker_environment_identity_v1|gallery_text_equivalent_v1|layout_recipe_library_v1|archived_project_restore_v1',
  );
  console.log('PASS: Migration 0059 preserved all 50 retained tables and installed service-only, fail-closed archived-project restoration');
}

interface InteractivePsqlSession {
  execute(sql: string): Promise<string>;
  close(): Promise<void>;
}

/** A controllable disposable psql session used only for deterministic lock-order rehearsals. */
/** Observe immediately; rethrow at the awaited checkpoint so outer owned cleanup can run. */
function observeConcurrentPsql(operation: Promise<string>): () => Promise<string> {
  const settled = operation.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  return async () => {
    const result = await settled;
    if (!result.ok) throw result.error;
    return result.value;
  };
}

function interactivePsql(applicationName: string): InteractivePsqlSession {
  const child = spawn('docker', [
    'exec', '-i', '-e', 'PGOPTIONS=-c statement_timeout=60000 -c lock_timeout=30000',
    '-e', `PGAPPNAME=${applicationName}`,
    `supabase_db_${projectId}`, 'psql', '-U', 'postgres', '-d', 'postgres',
    '-Atq', '-v', 'ON_ERROR_STOP=1',
  ], {
    cwd: repositoryRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  let pending: {
    marker: string;
    start: number;
    resolve: (value: string) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  } | null = null;

  const settleFromOutput = (): void => {
    if (!pending) return;
    const markerIndex = stdout.indexOf(pending.marker, pending.start);
    if (markerIndex < 0) return;
    const current = pending;
    pending = null;
    clearTimeout(current.timeout);
    current.resolve(stdout.slice(current.start, markerIndex).trim());
  };
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    settleFromOutput();
  });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  child.on('exit', (code) => {
    if (!pending) return;
    const current = pending;
    pending = null;
    clearTimeout(current.timeout);
    current.reject(new Error(`INTERACTIVE_PSQL_EXIT_${code ?? 'UNKNOWN'}:${stderr.trim()}`));
  });

  return {
    execute(sql: string): Promise<string> {
      if (pending) return Promise.reject(new Error('INTERACTIVE_PSQL_COMMAND_OVERLAP'));
      const marker = `__CAPSTONE_PSQL_${randomBytes(12).toString('hex')}__`;
      return new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (!pending || pending.marker !== marker) return;
          pending = null;
          child.kill();
          reject(new Error(`INTERACTIVE_PSQL_TIMEOUT:${applicationName}`));
        }, PSQL_COMMAND_TIMEOUT_MS);
        pending = { marker, start: stdout.length, resolve, reject, timeout };
        child.stdin.write(`${sql}\n\\echo ${marker}\n`);
      });
    },
    close(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        if (child.exitCode !== null) {
          if (child.exitCode === 0) resolve();
          else reject(new Error(`INTERACTIVE_PSQL_EXIT_${child.exitCode}:${stderr.trim()}`));
          return;
        }
        child.once('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`INTERACTIVE_PSQL_EXIT_${code ?? 'UNKNOWN'}:${stderr.trim()}`));
        });
        child.stdin.end('\\q\n');
      });
    },
  };
}

async function waitForDatabaseLockWait(applicationName: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (psql(`SELECT pg_catalog.count(*)::text FROM pg_catalog.pg_stat_activity WHERE application_name='${applicationName}' AND wait_event_type='Lock';`) !== '0') return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`DATABASE_LOCK_WAIT_NOT_OBSERVED:${applicationName}`);
}

/** Link the synthetic administrator only after the migration-0054 unlinked-history gate is proven. */
function linkSyntheticAdminIdentity(): void {
  psql(`
INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) VALUES (
  '00000000-0000-0000-0000-000000000000', '${ADMIN_AUTH_ID}', 'authenticated',
  'authenticated', 'upgrade-rehearsal-reviewer@example.invalid', '', pg_catalog.now(),
  '{}'::jsonb, '{}'::jsonb, pg_catalog.now(), pg_catalog.now(), '', '', '', ''
);
UPDATE public.admin_users
   SET auth_user_id='${ADMIN_AUTH_ID}'::uuid
 WHERE id='${ADMIN_ID}'::uuid;
`);
  assert.equal(
    psql(`SELECT public.public_feed_actor_is_admin('${ADMIN_ID}'::uuid)::text;`),
    'true',
    'Synthetic administrator did not become active canonical writer authority.',
  );
}

/** Digest every media field except the four current publication-mapping authorities M60 rearms. */
function mediaRearmPreservedFingerprint(): string {
  return psql(
    "SELECT pg_catalog.count(*)::text || ':' || pg_catalog.encode(pg_catalog.sha256("
    + "pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(row_text, chr(10) ORDER BY row_text), ''), 'UTF8')), 'hex')"
    + " FROM (SELECT (pg_catalog.to_jsonb(m) - 'is_public_approved' - 'public_url'"
    + " - 'public_storage_bucket' - 'public_storage_path')::text AS row_text"
    + ' FROM public.media_assets AS m) AS s;',
  );
}

/** Digest every participant-preview field except the explicit revocation evidence M60 may add. */
function previewRearmPreservedFingerprint(): string {
  return psql(
    "SELECT pg_catalog.count(*)::text || ':' || pg_catalog.encode(pg_catalog.sha256("
    + "pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(row_text, chr(10) ORDER BY row_text), ''), 'UTF8')), 'hex')"
    + " FROM (SELECT (pg_catalog.to_jsonb(preview) - 'status' - 'revoked_at'"
    + " - 'revoked_by')::text AS row_text"
    + ' FROM public.participant_previews AS preview) AS s;',
  );
}

function untouchedProjectProjectionAuthorityFingerprint(): string {
  return psql(
    "SELECT pg_catalog.count(*)::text || ':' || pg_catalog.encode(pg_catalog.sha256("
    + "pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(pg_catalog.to_jsonb(authority)::text,"
    + " chr(10) ORDER BY authority.project_id), ''), 'UTF8')), 'hex')"
    + ' FROM public.public_feed_project_projection_authority authority'
    + ' JOIN public.projects project ON project.id = authority.project_id'
    + " WHERE project.public_id NOT IN ('upgrade-reconcile-eligible',"
    + " 'upgrade-reconcile-no-feed-change');",
  );
}

function syntheticRetainedFeedRecord(publicId: string, id: number): PublicFeedRecord {
  return {
    id,
    publicId,
    title: `Synthetic retained feed record ${id}`,
    summary: 'Synthetic retained baseline for disposable publication verification.',
    background: 'Synthetic local history with no participant or production data.',
    solution: 'Canonical fixture bytes exercise retained public-feed membership.',
    year: '2026',
    program: 'Synthetic Software Systems',
    studyProgram: 'Synthetic Software Systems',
    discipline: 'Synthetic Software Engineering',
    disciplines: ['Synthetic Software Engineering'],
    industry: 'Synthetic Technology',
    industryPartner: 'Synthetic Industry Partner',
    academicSupervisor: 'Synthetic Supervisor',
    groupName: 'Synthetic Fixture Team',
    teamMembers: ['Synthetic Member'],
    poster: `https://assets.synthetic.invalid/${publicId}/poster.png`,
    posterPdf: `https://assets.synthetic.invalid/${publicId}/poster.pdf`,
    posterText: 'Synthetic retained poster text.',
    accessibilityText: 'Synthetic retained accessibility description.',
    snapshots: [],
    snapshotMedia: [],
    layoutConfig: {
      templateId: 'poster_showcase',
      featuredMedia: 'poster',
      sectionOrder: ['background', 'solution', 'snapshots', 'links'],
      hiddenSections: [],
    },
  };
}

async function seedAlreadyRestoredRepublishReconciliation(
  client: SupabaseClient,
): Promise<VerifiedPublicFeedArtifact> {
  const archivedAt = '2026-09-16T12:00:00+00';
  const finalizedAt = '2026-09-16T12:00:30+00';
  const completedAt = '2026-09-16T12:01:00+00';
  const restoredAt = '2026-09-16T12:02:00+00';
  const initialArtifact = createPublicFeedArtifact([
    syntheticRetainedFeedRecord('upgrade-reconcile-eligible', 900_001),
    syntheticRetainedFeedRecord('upgrade-reconcile-already-rearmed', 900_002),
    syntheticRetainedFeedRecord('upgrade-reconcile-writer-blocked', 900_003),
    syntheticRetainedFeedRecord('upgrade-reconcile-current-feed', 900_004),
  ]);
  let sequentialArtifact = initialArtifact;
  const removalCandidates = RECONCILIATION_REMOVAL_PUBLIC_IDS.map((publicId) => {
    sequentialArtifact = composePublicFeedRemoval(sequentialArtifact, publicId);
    return {
      publicId,
      content: sequentialArtifact.content,
      feedHash: sequentialArtifact.feedHash,
      recordCount: sequentialArtifact.recordCount,
      members: sequentialArtifact.members,
    };
  });
  const retainedArtifact = sequentialArtifact;
  psql(`
BEGIN;
WITH activation_operation AS (
  INSERT INTO public.public_feed_operations (
    operation_key, kind, authorizing_actor_id, completion_actor_id,
    candidate_feed_hash, candidate_record_count, candidate_byte_count,
    candidate_feed_content, candidate_members, storage_bucket, storage_path,
    state, owner_epoch, owner_token_hash, lease_expires_at,
    observed_storage_hash, observed_storage_record_count,
    created_at, updated_at, finalized_at, completed_at
  ) VALUES (
    pg_catalog.gen_random_uuid(), 'activation', '${ADMIN_ID}', '${ADMIN_ID}',
    '${initialArtifact.feedHash}', ${initialArtifact.recordCount}, ${initialArtifact.bytes.byteLength},
    '${initialArtifact.content}', '${JSON.stringify(initialArtifact.members)}'::jsonb,
    'synthetic-local', 'upgrade-restore-head',
    'COMPLETED', 1, '${'e'.repeat(64)}', '${archivedAt}'::timestamptz - interval '1 day',
    '${initialArtifact.feedHash}', ${initialArtifact.recordCount}, '${archivedAt}'::timestamptz - interval '1 day',
    '${archivedAt}'::timestamptz - interval '1 day',
    '${archivedAt}'::timestamptz - interval '1 day',
    '${archivedAt}'::timestamptz - interval '1 day'
  )
  RETURNING id, authorizing_actor_id, completion_actor_id,
            candidate_feed_content, candidate_byte_count,
            candidate_feed_hash, candidate_record_count
), activation_version AS (
  INSERT INTO public.public_feed_versions (
    operation, operation_id, authorizing_actor_id, completion_actor_id,
    artifact_content, byte_count, feed_hash, record_count, created_at
  )
  SELECT 'baseline', operation.id, operation.authorizing_actor_id,
         operation.completion_actor_id, operation.candidate_feed_content,
         operation.candidate_byte_count, operation.candidate_feed_hash,
         operation.candidate_record_count, '${archivedAt}'::timestamptz - interval '1 day'
    FROM activation_operation operation
  RETURNING id, operation_id, authorizing_actor_id, completion_actor_id
)
INSERT INTO public.public_feed_head (
  singleton, current_version_id, generation, activated_by_id, activated_at,
  transitioned_by_id, transitioned_at, last_operation_id
)
SELECT true, version.id, 1, version.authorizing_actor_id,
       '${archivedAt}'::timestamptz - interval '1 day', version.completion_actor_id,
       '${archivedAt}'::timestamptz - interval '1 day', version.operation_id
  FROM activation_version version;

INSERT INTO public.public_feed_version_members(version_id, ordinal, public_id, record_hash)
SELECT head.current_version_id,
       (member.value->>'ordinal')::integer,
       member.value->>'publicId',
       member.value->>'recordHash'
  FROM public.public_feed_head head
 CROSS JOIN LATERAL pg_catalog.jsonb_array_elements('${JSON.stringify(initialArtifact.members)}'::jsonb) member(value)
 WHERE head.singleton = true;

INSERT INTO public.projects (
  public_id, title, year, program_id, program_name, study_program, status, source_folder,
  pending_removal_from_public, public_removal_completed_at
)
SELECT candidate.public_id, candidate.title, 2026, programs.id, programs.name, programs.name,
       CASE WHEN candidate.public_id IN (
         'upgrade-reconcile-eligible',
         'upgrade-reconcile-already-rearmed',
         'upgrade-reconcile-writer-blocked',
         'upgrade-reconcile-no-feed-change',
         'upgrade-reconcile-race-archive-first',
         'upgrade-reconcile-race-reconcile-first',
         'upgrade-reconcile-race-media-change',
         'upgrade-reconcile-race-edit-change',
         'upgrade-reconcile-race-tombstone'
       ) THEN 'published' ELSE 'approved' END,
       'upgrade-restore-rehearsal', false,
       CASE WHEN candidate.public_id = 'upgrade-reconcile-unrelated'
            THEN NULL ELSE '${completedAt}'::timestamptz END
  FROM (VALUES
    ('upgrade-reconcile-eligible', 'Eligible already-restored project'),
    ('upgrade-reconcile-already-rearmed', 'Already rearmed project'),
    ('upgrade-reconcile-no-feed-change', 'Canonical no-feed-change removal'),
    ('upgrade-reconcile-race-archive-first', 'Archive-first reconciliation race'),
    ('upgrade-reconcile-race-reconcile-first', 'Reconcile-first archive race'),
    ('upgrade-reconcile-race-media-change', 'Media-change reconciliation race'),
    ('upgrade-reconcile-race-edit-change', 'Eligibility-edit reconciliation race'),
    ('upgrade-reconcile-race-tombstone', 'Tombstone reconciliation race'),
    ('upgrade-reconcile-missing-restore', 'Missing restore audit'),
    ('upgrade-reconcile-duplicate-restore', 'Duplicate restore audit'),
    ('upgrade-reconcile-missing-archive', 'Missing archive audit'),
    ('upgrade-reconcile-contradictory-archive', 'Contradictory archive audit'),
    ('upgrade-reconcile-missing-removal', 'Missing removal operation'),
    ('upgrade-reconcile-duplicate-removal', 'Duplicate removal operation'),
    ('upgrade-reconcile-invalid-removal', 'Invalid removal count'),
    ('upgrade-reconcile-malformed-removal', 'Malformed removal content'),
    ('upgrade-reconcile-duplicate-event', 'Duplicate completion event'),
    ('upgrade-reconcile-failure-code', 'Removal failure code'),
    ('upgrade-reconcile-ordinal-overflow', 'Overflowing member ordinal'),
    ('upgrade-reconcile-ordinal-long', 'Extremely long member ordinal'),
    ('upgrade-reconcile-ordinal-missing', 'Missing member ordinal'),
    ('upgrade-reconcile-ordinal-null', 'Null member ordinal'),
    ('upgrade-reconcile-ordinal-wrong-type', 'Wrong-type member ordinal'),
    ('upgrade-reconcile-current-feed', 'Current feed member'),
    ('upgrade-reconcile-writer-blocked', 'Writer blocked replay'),
    ('upgrade-reconcile-unrelated', 'Unrelated approved project')
  ) AS candidate(public_id, title)
 CROSS JOIN LATERAL (
   SELECT id, name FROM public.programs ORDER BY name LIMIT 1
 ) programs;

INSERT INTO public.approval_records (
  project_id, admin_id, action_taken, from_status, to_status, comments, created_at
)
SELECT project.id, '${ADMIN_ID}', 'archive',
       CASE WHEN project.public_id = 'upgrade-reconcile-contradictory-archive'
            THEN 'approved' ELSE 'published' END,
       'archived', 'Synthetic already-restored archive evidence.', '${archivedAt}'::timestamptz
  FROM public.projects project
 WHERE project.source_folder = 'upgrade-restore-rehearsal'
   AND project.public_id LIKE 'upgrade-reconcile-%'
   AND project.public_id NOT IN (
     'upgrade-reconcile-missing-archive', 'upgrade-reconcile-unrelated',
     'upgrade-reconcile-eligible', 'upgrade-reconcile-already-rearmed',
     'upgrade-reconcile-writer-blocked', 'upgrade-reconcile-no-feed-change'
     , 'upgrade-reconcile-race-archive-first', 'upgrade-reconcile-race-reconcile-first'
     , 'upgrade-reconcile-race-media-change', 'upgrade-reconcile-race-edit-change'
     , 'upgrade-reconcile-race-tombstone'
   );

INSERT INTO public.approval_records (
  project_id, admin_id, action_taken, from_status, to_status, comments, event_details, created_at
)
SELECT project.id, '${ADMIN_ID}', 'restore', 'archived', 'approved',
       'Synthetic M59 restore evidence.',
       pg_catalog.jsonb_build_object(
         'version', 1,
         'type', 'archived_project_restore',
         'archivedFromStatus', 'published',
         'restoredStatus', 'approved',
         'republishRequired', true
       ),
       '${restoredAt}'::timestamptz
  FROM public.projects project
 WHERE project.source_folder = 'upgrade-restore-rehearsal'
   AND project.public_id LIKE 'upgrade-reconcile-%'
   AND project.public_id NOT IN (
     'upgrade-reconcile-missing-restore', 'upgrade-reconcile-unrelated',
     'upgrade-reconcile-eligible', 'upgrade-reconcile-already-rearmed',
     'upgrade-reconcile-writer-blocked', 'upgrade-reconcile-no-feed-change'
     , 'upgrade-reconcile-race-archive-first', 'upgrade-reconcile-race-reconcile-first'
     , 'upgrade-reconcile-race-media-change', 'upgrade-reconcile-race-edit-change'
     , 'upgrade-reconcile-race-tombstone'
   );

INSERT INTO public.approval_records (
  project_id, admin_id, action_taken, from_status, to_status, comments, event_details, created_at
)
SELECT project.id, '${ADMIN_ID}', 'restore', 'archived', 'approved',
       'Synthetic duplicate restore evidence.',
       pg_catalog.jsonb_build_object(
         'version', 1,
         'type', 'archived_project_restore',
         'archivedFromStatus', 'published',
         'restoredStatus', 'approved',
         'republishRequired', true
       ),
       '${restoredAt}'::timestamptz + interval '1 second'
  FROM public.projects project
 WHERE project.public_id = 'upgrade-reconcile-duplicate-restore';

WITH removal_fixture(public_id, operation_count, candidate_content, candidate_count, failure_code) AS (
  VALUES
    ('upgrade-reconcile-missing-restore', 1, '[]', 0, NULL),
    ('upgrade-reconcile-duplicate-restore', 1, '[]', 0, NULL),
    ('upgrade-reconcile-missing-archive', 1, '[]', 0, NULL),
    ('upgrade-reconcile-contradictory-archive', 1, '[]', 0, NULL),
    ('upgrade-reconcile-duplicate-removal', 2, '[]', 0, NULL),
    ('upgrade-reconcile-invalid-removal', 1, '[]', 1, NULL),
    ('upgrade-reconcile-malformed-removal', 1, 'not-json', 0, NULL),
    ('upgrade-reconcile-duplicate-event', 1, '[]', 0, NULL),
    ('upgrade-reconcile-failure-code', 1, '[]', 0, 'SYNTHETIC_FAILURE'),
    ('upgrade-reconcile-ordinal-overflow', 0, '[]', 0, NULL),
    ('upgrade-reconcile-ordinal-long', 0, '[]', 0, NULL),
    ('upgrade-reconcile-ordinal-missing', 0, '[]', 0, NULL),
    ('upgrade-reconcile-ordinal-null', 0, '[]', 0, NULL),
    ('upgrade-reconcile-ordinal-wrong-type', 0, '[]', 0, NULL),
    ('upgrade-reconcile-current-feed', 1, '[]', 0, NULL),
    ('upgrade-reconcile-writer-blocked', 0, '[]', 0, NULL),
    ('upgrade-reconcile-no-feed-change', 0, '[]', 0, NULL),
    ('upgrade-reconcile-race-archive-first', 0, '[]', 0, NULL),
    ('upgrade-reconcile-race-reconcile-first', 0, '[]', 0, NULL),
    ('upgrade-reconcile-race-media-change', 0, '[]', 0, NULL),
    ('upgrade-reconcile-race-edit-change', 0, '[]', 0, NULL),
    ('upgrade-reconcile-race-tombstone', 0, '[]', 0, NULL)
)
INSERT INTO public.public_feed_operations (
  operation_key, kind, authorizing_actor_id, completion_actor_id, project_id, public_id,
  archive_reason, candidate_feed_hash, candidate_record_count, candidate_byte_count,
  candidate_feed_content, candidate_members, state, owner_epoch, owner_token_hash,
  lease_expires_at, observed_storage_hash, observed_storage_record_count, failure_code,
  created_at, updated_at, finalized_at, completed_at
)
SELECT pg_catalog.gen_random_uuid(), 'removal', '${ADMIN_ID}', '${ADMIN_ID}', project.id,
       project.public_id, 'Synthetic already-restored removal evidence.',
       pg_catalog.encode(
         extensions.digest(pg_catalog.convert_to(fixture.candidate_content, 'UTF8'), 'sha256'),
         'hex'
       ),
       fixture.candidate_count, pg_catalog.octet_length(fixture.candidate_content),
       fixture.candidate_content, '[]'::jsonb, 'COMPLETED', 1, '${'a'.repeat(64)}',
       '${completedAt}'::timestamptz,
       pg_catalog.encode(
         extensions.digest(pg_catalog.convert_to(fixture.candidate_content, 'UTF8'), 'sha256'),
         'hex'
       ),
       fixture.candidate_count, fixture.failure_code,
       '${archivedAt}'::timestamptz, '${completedAt}'::timestamptz,
       '${finalizedAt}'::timestamptz, '${completedAt}'::timestamptz
  FROM removal_fixture fixture
  JOIN public.projects project ON project.public_id = fixture.public_id
 CROSS JOIN LATERAL pg_catalog.generate_series(1, fixture.operation_count) duplicate;

INSERT INTO public.public_feed_operation_events (
  operation_id, sequence, from_state, to_state, actor_id, owner_epoch,
  observed_storage_hash, observed_storage_record_count, created_at
)
SELECT operation.id, sequence.value, 'DB_FINALIZED', 'COMPLETED', operation.completion_actor_id,
       operation.owner_epoch, operation.observed_storage_hash,
       operation.observed_storage_record_count, operation.completed_at
  FROM public.public_feed_operations operation
 CROSS JOIN LATERAL pg_catalog.generate_series(
   1,
   CASE WHEN operation.public_id = 'upgrade-reconcile-duplicate-event' THEN 2 ELSE 1 END
  ) sequence(value)
 WHERE operation.public_id LIKE 'upgrade-reconcile-%';

-- Exercise the real canonical removal state machine and preserved M59 restore authority for every
-- positive reconciliation row. Only adversarial negative history below is inserted synthetically.
DO $reconciliation$
DECLARE
  v_public_id text;
  v_owner_token text;
  v_operation_id uuid;
  v_baseline public.public_feed_versions%ROWTYPE;
  v_fixture jsonb;
  v_candidate jsonb;
  v_candidate_content text;
  v_candidate_hash text;
  v_candidate_members jsonb;
  v_result jsonb;
BEGIN
  FOREACH v_public_id IN ARRAY ARRAY[
    ${RECONCILIATION_REMOVAL_PUBLIC_IDS.map((publicId) => `'${publicId}'`).join(',\n    ')}
  ]::text[]
  LOOP
    SELECT version.* INTO v_baseline
      FROM public.public_feed_head head
      JOIN public.public_feed_versions version ON version.id = head.current_version_id
     WHERE head.singleton = true;
    SELECT fixture.value INTO STRICT v_fixture
      FROM pg_catalog.jsonb_array_elements('${JSON.stringify(removalCandidates)}'::jsonb) fixture(value)
     WHERE fixture.value->>'publicId' = v_public_id;
    v_candidate_content := v_fixture->>'content';
    v_candidate_hash := v_fixture->>'feedHash';
    v_candidate := v_candidate_content::jsonb;
    v_candidate_members := v_fixture->'members';
    v_owner_token := 'upgrade-reconciliation-owner-token-' || v_public_id;

    v_result := public.reserve_public_feed_operation(
      pg_catalog.gen_random_uuid(), 'removal', NULL, '${ADMIN_ID}'::uuid, v_public_id,
      v_owner_token, NULL, NULL, NULL, 'Synthetic canonical removal.', NULL, NULL,
      'public-feeds', 'upgrade-restore-head', false
    );
    IF v_result->>'resultCode' IS DISTINCT FROM 'OPERATION_RESERVED' THEN
      RAISE EXCEPTION 'RECONCILIATION_RESERVE_FAILED: %', v_result;
    END IF;
    v_operation_id := (v_result->>'operationId')::uuid;

    v_result := public.bind_public_feed_operation(
      v_operation_id, 1, v_owner_token, '${ADMIN_ID}'::uuid,
      v_baseline.id, true, v_baseline.feed_hash, v_baseline.record_count,
      v_baseline.artifact_content, v_candidate_hash,
      pg_catalog.jsonb_array_length(v_candidate), v_candidate_content,
      v_candidate_members, 'https://example.invalid/public-feed.json', '[]'::jsonb
    );
    IF v_result->>'resultCode' IS DISTINCT FROM 'ARTIFACT_BOUND' THEN
      RAISE EXCEPTION 'RECONCILIATION_BIND_FAILED: %', v_result;
    END IF;
    IF v_candidate_hash IS DISTINCT FROM v_baseline.feed_hash THEN
      v_result := public.mark_public_feed_write_started(
        v_operation_id, 1, v_owner_token, '${ADMIN_ID}'::uuid
      );
      IF v_result->>'resultCode' IS DISTINCT FROM 'WRITE_STARTED' THEN
        RAISE EXCEPTION 'RECONCILIATION_WRITE_START_FAILED: %', v_result;
      END IF;
    END IF;
    v_result := public.mark_public_feed_candidate_observed(
      v_operation_id, 1, v_owner_token, '${ADMIN_ID}'::uuid,
      v_candidate_hash, pg_catalog.jsonb_array_length(v_candidate)
    );
    IF v_result->>'resultCode' IS DISTINCT FROM 'CANDIDATE_OBSERVED' THEN
      RAISE EXCEPTION 'RECONCILIATION_OBSERVE_FAILED: %', v_result;
    END IF;
    v_result := public.finalize_public_feed_operation(
      v_operation_id, 1, v_owner_token, '${ADMIN_ID}'::uuid
    );
    IF v_result->>'resultCode' IS DISTINCT FROM 'DB_FINALIZED' THEN
      RAISE EXCEPTION 'RECONCILIATION_FINALIZE_FAILED: %', v_result;
    END IF;
    v_result := public.complete_public_feed_operation(
      v_operation_id, 1, v_owner_token, '${ADMIN_ID}'::uuid,
      v_candidate_hash, pg_catalog.jsonb_array_length(v_candidate)
    );
    IF v_result->>'resultCode' IS DISTINCT FROM 'COMPLETED' THEN
      RAISE EXCEPTION 'RECONCILIATION_COMPLETE_FAILED: %', v_result;
    END IF;
    v_result := public.perform_project_review_action(
      v_public_id, 'restore', 'Synthetic canonical restore.', '${ADMIN_ID}'::uuid
    );
    IF v_result->>'status' IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION 'RECONCILIATION_RESTORE_FAILED: %', v_result;
    END IF;
  END LOOP;
END;
$reconciliation$;

-- Make the duplicate-event negative otherwise evidence-complete. Its extra null-code COMPLETED
-- event carries a conflicting hash, so accepting one matching terminal event would be unsafe.
ALTER TABLE public.public_feed_operation_events DISABLE TRIGGER reject_public_feed_event_mutation;
DELETE FROM public.public_feed_operation_events event
 USING public.public_feed_operations operation
 WHERE event.operation_id = operation.id
   AND operation.public_id = 'upgrade-reconcile-duplicate-event';
ALTER TABLE public.public_feed_operation_events ENABLE TRIGGER reject_public_feed_event_mutation;

WITH baseline AS (
  SELECT version.*
    FROM public.public_feed_head head
    JOIN public.public_feed_versions version ON version.id = head.current_version_id
   WHERE head.singleton = true
)
UPDATE public.public_feed_operations operation
   SET baseline_version_id = baseline.id,
       baseline_storage_existed = true,
       baseline_feed_hash = baseline.feed_hash,
       baseline_record_count = baseline.record_count,
       baseline_feed_content = baseline.artifact_content,
       candidate_feed_hash = baseline.feed_hash,
       candidate_record_count = baseline.record_count,
       candidate_byte_count = baseline.byte_count,
       candidate_feed_content = baseline.artifact_content,
       candidate_members = (
         SELECT pg_catalog.jsonb_agg(
           pg_catalog.jsonb_build_object(
             'ordinal', member.ordinal,
             'publicId', member.public_id,
             'recordHash', member.record_hash
           ) ORDER BY member.ordinal
         )
           FROM public.public_feed_version_members member
          WHERE member.version_id = baseline.id
       ),
       observed_storage_hash = baseline.feed_hash,
       observed_storage_record_count = baseline.record_count
  FROM baseline
 WHERE operation.public_id = 'upgrade-reconcile-duplicate-event';

INSERT INTO public.public_feed_operation_events (
  operation_id, sequence, from_state, to_state, actor_id, owner_epoch,
  observed_storage_hash, observed_storage_record_count, code, created_at
)
SELECT operation.id, fixture.sequence, fixture.from_state, fixture.to_state,
       CASE WHEN fixture.sequence <= 2 THEN operation.authorizing_actor_id
            ELSE operation.completion_actor_id END,
       operation.owner_epoch,
       CASE WHEN fixture.sequence <= 2 THEN NULL
            WHEN fixture.sequence = 6 THEN '${'e'.repeat(64)}'
            ELSE operation.candidate_feed_hash END,
       CASE WHEN fixture.sequence <= 2 THEN NULL
            ELSE operation.candidate_record_count END,
       fixture.code,
       CASE WHEN fixture.sequence = 4 THEN operation.finalized_at
            WHEN fixture.sequence >= 5 THEN operation.completed_at
            ELSE operation.created_at + fixture.sequence * interval '1 second' END
  FROM public.public_feed_operations operation
 CROSS JOIN (VALUES
   (1, NULL::text, 'RESERVED', NULL::text),
   (2, 'RESERVED', 'PREPARED', NULL::text),
   (3, 'PREPARED', 'CANDIDATE_OBSERVED', NULL::text),
   (4, 'CANDIDATE_OBSERVED', 'DB_FINALIZED', 'NO_FEED_CHANGE'),
   (5, 'DB_FINALIZED', 'COMPLETED', NULL::text),
   (6, 'DB_FINALIZED', 'COMPLETED', NULL::text)
 ) fixture(sequence, from_state, to_state, code)
 WHERE operation.public_id = 'upgrade-reconcile-duplicate-event';

-- Each malformed ordinal row has an otherwise parseable baseline/candidate binding so M60 must
-- reach the bounded ordinal validator, skip that target and continue to valid rows without error.
WITH malformed(public_id, candidate_members) AS (
  VALUES
    ('upgrade-reconcile-ordinal-overflow',
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'ordinal', '2147483648', 'publicId', 'upgrade-reconcile-current-feed',
        'recordHash', '${initialArtifact.members[3].recordHash}'
      ))),
    ('upgrade-reconcile-ordinal-long',
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'ordinal', '${'9'.repeat(256)}', 'publicId', 'upgrade-reconcile-current-feed',
        'recordHash', '${initialArtifact.members[3].recordHash}'
      ))),
    ('upgrade-reconcile-ordinal-missing',
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'publicId', 'upgrade-reconcile-current-feed',
        'recordHash', '${initialArtifact.members[3].recordHash}'
      ))),
    ('upgrade-reconcile-ordinal-null',
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'ordinal', NULL, 'publicId', 'upgrade-reconcile-current-feed',
        'recordHash', '${initialArtifact.members[3].recordHash}'
      ))),
    ('upgrade-reconcile-ordinal-wrong-type',
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'ordinal', pg_catalog.jsonb_build_object('value', 0),
        'publicId', 'upgrade-reconcile-current-feed',
        'recordHash', '${initialArtifact.members[3].recordHash}'
      )))
), baseline AS (
  SELECT version.*
    FROM public.public_feed_head head
    JOIN public.public_feed_versions version ON version.id = head.current_version_id
   WHERE head.singleton = true
)
INSERT INTO public.public_feed_operations (
  operation_key, kind, authorizing_actor_id, completion_actor_id, project_id, public_id,
  archive_reason, baseline_version_id, baseline_storage_existed, baseline_feed_hash,
  baseline_record_count, baseline_feed_content, candidate_feed_hash, candidate_record_count,
  candidate_byte_count, candidate_feed_content, candidate_members, state, owner_epoch,
  owner_token_hash, lease_expires_at, observed_storage_hash, observed_storage_record_count,
  created_at, updated_at, finalized_at, completed_at
)
SELECT pg_catalog.gen_random_uuid(), 'removal', '${ADMIN_ID}', '${ADMIN_ID}', project.id,
       project.public_id, 'Malformed ordinal evidence.', baseline.id, true, baseline.feed_hash,
       baseline.record_count, baseline.artifact_content, baseline.feed_hash,
       baseline.record_count, baseline.byte_count, baseline.artifact_content,
       malformed.candidate_members, 'COMPLETED', 1, '${'d'.repeat(64)}',
       '${completedAt}'::timestamptz, baseline.feed_hash, baseline.record_count,
       '${archivedAt}'::timestamptz, '${completedAt}'::timestamptz,
       '${finalizedAt}'::timestamptz, '${completedAt}'::timestamptz
  FROM malformed
  JOIN public.projects project ON project.public_id = malformed.public_id
 CROSS JOIN baseline;

INSERT INTO public.media_assets (
  project_id, asset_type, file_name, storage_bucket, storage_path, public_url,
  public_storage_bucket, public_storage_path, mime_type, file_size_bytes,
  is_public_approved, alt_text_public
)
SELECT project.id, 'poster_image', 'retained.png', 'project-drafts-private',
       'drafts/' || project.public_id || '/poster_image/retained.png',
       'https://example.invalid/' || project.public_id || '/retained.png',
       'project-public-assets', 'published/' || project.public_id || '/poster_image/retained.png',
       'image/png', 64, true, 'Synthetic retained media mapping.'
  FROM public.projects project
 WHERE project.source_folder = 'upgrade-restore-rehearsal'
   AND project.public_id LIKE 'upgrade-reconcile-%';

UPDATE public.media_assets
   SET is_public_approved = false,
       public_url = NULL,
       public_storage_bucket = NULL,
       public_storage_path = NULL
 WHERE project_id IN (
   SELECT id FROM public.projects WHERE public_id IN (
      'upgrade-reconcile-already-rearmed',
      'upgrade-reconcile-writer-blocked',
      'upgrade-reconcile-race-archive-first',
     'upgrade-reconcile-race-reconcile-first',
     'upgrade-reconcile-race-media-change',
     'upgrade-reconcile-race-edit-change',
     'upgrade-reconcile-race-tombstone'
   )
 );

WITH inserted AS (
  INSERT INTO public.participant_previews (
    project_id, token_hash, snapshot, media_snapshot, status, created_by, created_at, expires_at
  )
  SELECT project.id,
         pg_catalog.encode(
           extensions.digest(
             pg_catalog.convert_to('pre-restore-token:' || project.public_id, 'UTF8'),
             'sha256'
           ),
           'hex'
         ),
         '{}'::jsonb, '[]'::jsonb, 'active', '${ADMIN_ID}',
         archive.created_at - interval '1 minute', pg_catalog.now() + interval '7 days'
    FROM public.projects project
    JOIN public.approval_records archive
      ON archive.project_id = project.id AND archive.action_taken = 'archive'
   WHERE project.public_id IN (
     'upgrade-reconcile-eligible', 'upgrade-reconcile-writer-blocked'
   )
  RETURNING id, project_id
)
INSERT INTO public.participant_preview_confirmations(participant_preview_id, confirmed_at)
SELECT inserted.id, archive.created_at - interval '30 seconds'
  FROM inserted
  JOIN public.projects project ON project.id = inserted.project_id
  JOIN public.approval_records archive
    ON archive.project_id = project.id AND archive.action_taken = 'archive'
 WHERE project.public_id = 'upgrade-reconcile-eligible';
COMMIT;
`);

  const positiveFixtureIds = [
    'upgrade-reconcile-eligible',
    'upgrade-reconcile-already-rearmed',
    'upgrade-reconcile-writer-blocked',
    'upgrade-reconcile-no-feed-change',
    'upgrade-reconcile-race-archive-first',
    'upgrade-reconcile-race-reconcile-first',
    'upgrade-reconcile-race-media-change',
    'upgrade-reconcile-race-edit-change',
    'upgrade-reconcile-race-tombstone',
  ].sort();
  assert.equal(
    psql(`
SELECT fixture.public_id || '|' || count(operation.id)::text || '|'
       || count(operation.id) FILTER (
            WHERE operation.archive_reason = 'Synthetic canonical removal.'
          )::text
  FROM (VALUES
    ${positiveFixtureIds.map((publicId) => `('${publicId}')`).join(',\n    ')}
  ) AS fixture(public_id)
  LEFT JOIN public.public_feed_operations operation
    ON operation.public_id = fixture.public_id
   AND operation.kind = 'removal'
   AND operation.state = 'COMPLETED'
 GROUP BY fixture.public_id
 ORDER BY fixture.public_id;
`),
    positiveFixtureIds.map((publicId) => `${publicId}|1|1`).join('\n'),
    'Positive reconciliation fixtures must each have exactly one genuine canonical completed removal before M60.',
  );
  assert.equal(
    psql("SELECT version.feed_hash || '|' || version.record_count::text || '|'"
      + " || version.byte_count::text || '|' || pg_catalog.count(member.*)::text"
      + ' FROM public.public_feed_head head'
      + ' JOIN public.public_feed_versions version ON version.id=head.current_version_id'
      + ' LEFT JOIN public.public_feed_version_members member ON member.version_id=version.id'
      + ' WHERE head.singleton=true'
      + ' GROUP BY version.feed_hash, version.record_count, version.byte_count;'),
    `${retainedArtifact.feedHash}|${retainedArtifact.recordCount}|${retainedArtifact.bytes.byteLength}|${retainedArtifact.members.length}`,
    'The retained canonical head does not match its exact artifact hash, count, bytes and members.',
  );
  const baselineUpload = await client.storage.from(publicFeedBucket).upload(
    publicationFeedPath,
    retainedArtifact.bytes,
    { contentType: 'application/json', upsert: false },
  );
  assert.ifError(baselineUpload.error);
  const persistedBaseline = await client.storage.from(publicFeedBucket).download(publicationFeedPath);
  assert.ifError(persistedBaseline.error);
  assert.ok(persistedBaseline.data);
  const persistedBaselineBytes = Buffer.from(await persistedBaseline.data.arrayBuffer());
  assert.deepEqual(persistedBaselineBytes, retainedArtifact.bytes);
  assert.deepEqual(verifyPublicFeedArtifact(persistedBaselineBytes).members, retainedArtifact.members);
  return retainedArtifact;
}

function assertAfter60(
  current59Tables: Record<string, string>,
  preservedMediaBefore60: string,
  preservedPreviewsBefore60: string,
  untouchedProjectionAuthorityBefore60: string,
  eligibleProjectionGenerationBefore60: number,
  publicTableGrantsBefore60: string,
  untrustedRoutineGrantsBefore60: string,
  reviewDefinitionBefore60: string,
): void {
  assert.equal(
    Object.keys(current59Tables).length,
    CURRENT_59_TABLES_FINGERPRINTED_BEFORE_M60.length,
    'The current 0059 non-rearmed retained-table inventory is incomplete.',
  );
  assertTablesUnchanged(current59Tables, 'Migration 0060');
  assert.equal(
    mediaRearmPreservedFingerprint(),
    preservedMediaBefore60,
    'Migration 0060 changed private source identity or preserved media metadata.',
  );
  assert.equal(
    previewRearmPreservedFingerprint(),
    preservedPreviewsBefore60,
    'Migration 0060 changed immutable participant-preview evidence beyond revocation fields.',
  );
  assert.equal(
    untouchedProjectProjectionAuthorityFingerprint(),
    untouchedProjectionAuthorityBefore60,
    'Migration 0060 advanced an unrelated project projection fence.',
  );
  assert.equal(
    Number(psql("SELECT authority.generation::text"
      + ' FROM public.public_feed_project_projection_authority authority'
      + ' JOIN public.projects project ON project.id=authority.project_id'
      + " WHERE project.public_id='upgrade-reconcile-eligible';")),
    eligibleProjectionGenerationBefore60 + 1,
    'Migration 0060 did not advance the rearmed project projection fence exactly once.',
  );
  assert.equal(publicTableGrants(), publicTableGrantsBefore60, 'Migration 0060 changed direct table grants.');
  assert.equal(
    untrustedRoutineExecuteGrants(),
    untrustedRoutineGrantsBefore60,
    'Migration 0060 introduced an unsafe direct routine grant.',
  );

  const identity = 'p_public_id text, p_action text, p_comments text, p_admin_id uuid';
  const helperDefinition = routineDefinition('perform_project_review_action_without_media_rearm', identity)
    .replaceAll('perform_project_review_action_without_media_rearm', 'perform_project_review_action');
  assert.equal(
    helperDefinition,
    reviewDefinitionBefore60,
    'Migration 0060 rewrote the established M59 restore authority.',
  );
  assert.equal(
    psql("SELECT has_function_privilege('service_role','public.perform_project_review_action_without_media_rearm(text,text,text,uuid)','EXECUTE')::text"
      + " || '|' || has_function_privilege('anon','public.perform_project_review_action_without_media_rearm(text,text,text,uuid)','EXECUTE')::text"
      + " || '|' || has_function_privilege('authenticated','public.perform_project_review_action_without_media_rearm(text,text,text,uuid)','EXECUTE')::text;"),
    'false|false|false',
    'Migration 0060 exposed the delegated M59 restore helper.',
  );
  assert.equal(
    psql("SELECT has_function_privilege('service_role','public.perform_project_review_action(text,text,text,uuid)','EXECUTE')::text"
      + " || '|' || has_function_privilege('anon','public.perform_project_review_action(text,text,text,uuid)','EXECUTE')::text"
      + " || '|' || has_function_privilege('authenticated','public.perform_project_review_action(text,text,text,uuid)','EXECUTE')::text;"),
    'true|false|false',
    'Migration 0060 review wrapper grant contract drifted.',
  );
  assert.equal(
    psql("SELECT has_function_privilege('service_role','public.reconcile_archived_project_republish_media()','EXECUTE')::text"
      + " || '|' || has_function_privilege('anon','public.reconcile_archived_project_republish_media()','EXECUTE')::text"
      + " || '|' || has_function_privilege('authenticated','public.reconcile_archived_project_republish_media()','EXECUTE')::text;"),
    'false|false|false',
    'Migration 0060 exposed the owner-only reconciliation helper.',
  );
  assert.equal(
    psql("SELECT has_function_privilege('service_role','public.parse_archived_republish_candidate_json(text)','EXECUTE')::text"
      + " || '|' || has_function_privilege('anon','public.parse_archived_republish_candidate_json(text)','EXECUTE')::text"
      + " || '|' || has_function_privilege('authenticated','public.parse_archived_republish_candidate_json(text)','EXECUTE')::text;"),
    'false|false|false',
    'Migration 0060 exposed the malformed-evidence parser helper.',
  );

  const wrapper = routineDefinition('perform_project_review_action', identity);
  assert.match(wrapper, /perform_project_review_action_without_media_rearm/);
  assert.match(wrapper, /archivedFromStatus/);
  assert.match(wrapper, /v_archive_origin = 'published'/);
  assert.match(wrapper, /UPDATE public\.media_assets/);
  assert.match(wrapper, /is_public_approved = false/);
  assert.match(wrapper, /public_storage_path = NULL/);
  assert.equal(
    psql('SELECT public.get_release_capability_sentinel();'),
    '20260917090000_archived_project_republish_media_rearm|active_staff_catalog_rls_v1|staff_lifecycle_v1|staging_feed_rollback_capability_v1|preview_response_observation_v1|assistive_worker_environment_identity_v1|gallery_text_equivalent_v1|layout_recipe_library_v1|archived_project_restore_v1|archived_project_republish_media_rearm_v1',
  );
  console.log('PASS: Migration 0060 preserved M59 authority and installed target-scoped published-origin media rearm');
}

function verifyAlreadyRestoredRepublishReconciliation(): void {
  for (const publicId of [
    'upgrade-reconcile-eligible',
    'upgrade-reconcile-already-rearmed',
    'upgrade-reconcile-no-feed-change',
  ]) {
    assert.equal(
      psql(`SELECT is_public_approved::text || '|' || COALESCE(public_url,'NULL') || '|'`
        + ` || COALESCE(public_storage_bucket,'NULL') || '|' || COALESCE(public_storage_path,'NULL')`
        + ` FROM public.media_assets WHERE project_id=(`
        + `SELECT id FROM public.projects WHERE public_id='${publicId}');`),
      'false|NULL|NULL|NULL',
      `${publicId} was not in coherent private-workflow state after M60.`,
    );
  }

  for (const publicId of [
    'upgrade-reconcile-missing-restore',
    'upgrade-reconcile-duplicate-restore',
    'upgrade-reconcile-missing-archive',
    'upgrade-reconcile-contradictory-archive',
    'upgrade-reconcile-missing-removal',
    'upgrade-reconcile-duplicate-removal',
    'upgrade-reconcile-invalid-removal',
    'upgrade-reconcile-malformed-removal',
    'upgrade-reconcile-duplicate-event',
    'upgrade-reconcile-failure-code',
    'upgrade-reconcile-ordinal-overflow',
    'upgrade-reconcile-ordinal-long',
    'upgrade-reconcile-ordinal-missing',
    'upgrade-reconcile-ordinal-null',
    'upgrade-reconcile-ordinal-wrong-type',
    'upgrade-reconcile-current-feed',
    'upgrade-reconcile-unrelated',
  ]) {
    assert.equal(
      psql(`SELECT is_public_approved::text FROM public.media_assets WHERE project_id=(`
        + `SELECT id FROM public.projects WHERE public_id='${publicId}');`),
      'true',
      `${publicId} was changed despite incomplete, contradictory, ambiguous, or unsafe evidence.`,
    );
  }
  assert.equal(
    psql("SELECT is_public_approved::text FROM public.media_assets WHERE project_id=(SELECT id FROM public.projects WHERE public_id='upgrade-reconcile-writer-blocked');"),
    'false',
    'The intentionally private writer-blocked fixture changed before its active-writer scenario was armed.',
  );

  assert.equal(
    psql("SELECT preview.status || '|' || (preview.revoked_at IS NOT NULL)::text || '|'"
      + ` || (preview.revoked_by = '${ADMIN_ID}'::uuid)::text || '|'`
      + ' || (SELECT pg_catalog.count(*) FROM public.participant_preview_confirmations confirmation'
      + ' WHERE confirmation.participant_preview_id=preview.id)::text'
      + ' FROM public.participant_previews preview JOIN public.projects project'
      + " ON project.id=preview.project_id WHERE project.public_id='upgrade-reconcile-eligible';"),
    'revoked|true|true|1',
    'Reconciliation did not revoke the pre-restore preview while retaining its confirmation.',
  );
  assert.equal(
    psql("SELECT public.confirm_participant_preview(pg_catalog.encode(extensions.digest("
      + "pg_catalog.convert_to('pre-restore-token:upgrade-reconcile-eligible','UTF8'),'sha256'),'hex'))"
      + "->>'resultCode';"),
    'NOT_FOUND',
    'A confirmed pre-restore token retained participant authority after reconciliation.',
  );

  const replayFreshToken = createHash('sha256')
    .update('upgrade-reconcile-already-rearmed-fresh')
    .digest('hex');
  psql(`
INSERT INTO public.participant_previews (
  project_id, token_hash, snapshot, media_snapshot, status, created_by, created_at, expires_at
)
SELECT project.id, '${replayFreshToken}', '{}'::jsonb, '[]'::jsonb, 'active', '${ADMIN_ID}',
       restore.created_at + interval '1 second', pg_catalog.now() + interval '7 days'
  FROM public.projects project
  JOIN public.approval_records restore
    ON restore.project_id=project.id AND restore.action_taken='restore'
 WHERE project.public_id='upgrade-reconcile-already-rearmed';
`);
  assert.equal(
    psql(`SELECT public.confirm_participant_preview('${replayFreshToken}')->>'resultCode';`),
    'SUCCESS',
    'The already-rearmed fixture did not accept a fresh synthetic confirmation.',
  );

  assert.equal(
    psql('SELECT public.reconcile_archived_project_republish_media()::text;'),
    '0',
    'An immediate reconciliation replay was not idempotent.',
  );

  armReconciliationRaceFixture('upgrade-reconcile-writer-blocked');
  psql(`
INSERT INTO public.public_feed_operations (
  operation_key, kind, authorizing_actor_id, state, owner_token_hash, lease_expires_at,
  storage_path
) VALUES (
  pg_catalog.gen_random_uuid(), 'activation', '${ADMIN_ID}', 'RESERVED',
  '${'c'.repeat(64)}', pg_catalog.now() + interval '2 minutes',
  'upgrade-reconcile-active-writer'
);
`);
  assert.equal(
    psql('SELECT public.reconcile_archived_project_republish_media()::text;'),
    '0',
    'Migration reconciliation did not refuse an active canonical writer.',
  );
  assert.equal(
    psql("SELECT is_public_approved::text FROM public.media_assets WHERE project_id=(SELECT id"
      + " FROM public.projects WHERE public_id='upgrade-reconcile-writer-blocked');"),
    'true',
    'Active-writer refusal partially changed the candidate media.',
  );
  psql("DELETE FROM public.public_feed_operations WHERE storage_path='upgrade-reconcile-active-writer';");
  assert.equal(
    psql('SELECT public.reconcile_archived_project_republish_media()::text;'),
    '1',
    'The uniquely eligible writer-blocked fixture did not rearm after writer exclusion cleared.',
  );
  assert.equal(
    psql('SELECT public.reconcile_archived_project_republish_media()::text;'),
    '0',
    'A completed reconciliation changed rows again on replay.',
  );
  assert.equal(
    psql(`SELECT status || '|' || (revoked_at IS NULL)::text FROM public.participant_previews WHERE token_hash='${replayFreshToken}';`),
    'active|true',
    'Owner-helper replay revoked a fresh preview on an already-rearmed row.',
  );
  assert.equal(
    psql("SELECT public.confirm_participant_preview(pg_catalog.encode(extensions.digest("
      + "pg_catalog.convert_to('pre-restore-token:upgrade-reconcile-writer-blocked','UTF8'),'sha256'),'hex'))"
      + "->>'resultCode';"),
    'NOT_FOUND',
    'A later-confirmed pre-restore token retained authority after deferred reconciliation.',
  );
  console.log('PASS: M59 already-restored reconciliation is evidence-complete, fail-closed and idempotent');
}

function armReconciliationRaceFixture(publicId: string): void {
  psql(`
BEGIN;
ALTER TABLE public.media_assets DISABLE TRIGGER USER;
UPDATE public.media_assets
   SET is_public_approved=true,
       public_url='https://example.invalid/${publicId}/retained.png',
       public_storage_bucket='project-public-assets',
       public_storage_path='published/${publicId}/poster_image/retained.png'
 WHERE project_id=(SELECT id FROM public.projects WHERE public_id='${publicId}');
ALTER TABLE public.media_assets ENABLE TRIGGER USER;
COMMIT;
`);
}

async function verifyReconciliationLockRaces(): Promise<void> {
  const archiveFirstId = 'upgrade-reconcile-race-archive-first';
  armReconciliationRaceFixture(archiveFirstId);
  const archiveFirst = interactivePsql('upgrade_reconcile_archive_first');
  const helperAfterArchive = interactivePsql('upgrade_helper_after_archive');
  assert.equal(
    await archiveFirst.execute(
      `BEGIN; SELECT public.perform_project_review_action('${archiveFirstId}', 'archive',`
      + ` 'Concurrent archive.', '${ADMIN_ID}'::uuid)->>'status';`,
    ),
    'archived',
    'Archive-first reconciliation race did not execute the actual archive authority.',
  );
  const helperAfterArchiveResult = observeConcurrentPsql(helperAfterArchive.execute(
    'BEGIN; SELECT public.reconcile_archived_project_republish_media()::text;',
  ));
  await waitForDatabaseLockWait('upgrade_helper_after_archive');
  await archiveFirst.execute('COMMIT;');
  await archiveFirst.close();
  assert.equal(
    await helperAfterArchiveResult(),
    '0',
    'Reconciliation used a stale Approved snapshot after a waiting archive committed.',
  );
  await helperAfterArchive.execute('COMMIT;');
  await helperAfterArchive.close();
  assert.equal(
    psql(`SELECT status || '|' || (SELECT is_public_approved::text FROM public.media_assets`
      + ` WHERE project_id=project.id) FROM public.projects project WHERE public_id='${archiveFirstId}';`),
    'archived|true',
    'Archive-first reconciliation changed media after eligibility was lost.',
  );

  const reconcileFirstId = 'upgrade-reconcile-race-reconcile-first';
  armReconciliationRaceFixture(reconcileFirstId);
  const reconcileFirst = interactivePsql('upgrade_reconcile_first');
  const archiveAfterReconcile = interactivePsql('upgrade_archive_after_reconcile');
  assert.equal(
    await reconcileFirst.execute(
      'BEGIN; SELECT public.reconcile_archived_project_republish_media()::text;',
    ).then((output) => output.split('\n').at(-1)),
    '1',
    'Reconcile-first race did not rearm the locked eligible project.',
  );
  const archiveAfterReconcileResult = observeConcurrentPsql(archiveAfterReconcile.execute(
    `BEGIN; SELECT public.perform_project_review_action('${reconcileFirstId}', 'archive',`
    + ` 'Archive after reconciliation.', '${ADMIN_ID}'::uuid)->>'status';`,
  ));
  await waitForDatabaseLockWait('upgrade_archive_after_reconcile');
  await reconcileFirst.execute('COMMIT;');
  await reconcileFirst.close();
  assert.equal(
    await archiveAfterReconcileResult(),
    'archived',
    'Archive did not proceed after reconcile-first ordering committed.',
  );
  await archiveAfterReconcile.execute('COMMIT;');
  await archiveAfterReconcile.close();
  assert.equal(
    psql(`SELECT status || '|' || (SELECT is_public_approved::text FROM public.media_assets`
      + ` WHERE project_id=project.id) FROM public.projects project WHERE public_id='${reconcileFirstId}';`),
    'archived|false',
    'Reconcile-first ordering left stale public mapping authority after archive.',
  );

  const mediaChangeId = 'upgrade-reconcile-race-media-change';
  armReconciliationRaceFixture(mediaChangeId);
  const mediaChange = interactivePsql('upgrade_media_change_first');
  const helperAfterMedia = interactivePsql('upgrade_helper_after_media');
  await mediaChange.execute(
    `BEGIN; UPDATE public.media_assets SET is_public_approved=false, public_url=NULL,`
    + ` public_storage_bucket=NULL, public_storage_path=NULL WHERE project_id=(`
    + `SELECT id FROM public.projects WHERE public_id='${mediaChangeId}');`,
  );
  const helperAfterMediaResult = observeConcurrentPsql(helperAfterMedia.execute(
    'BEGIN; SELECT public.reconcile_archived_project_republish_media()::text;',
  ));
  await waitForDatabaseLockWait('upgrade_helper_after_media');
  await mediaChange.execute('COMMIT;');
  await mediaChange.close();
  assert.equal(await helperAfterMediaResult(), '0', 'Reconciliation ignored a waiting media rearm.');
  await helperAfterMedia.execute('COMMIT;');
  await helperAfterMedia.close();

  for (const [publicId, applicationName, mutation] of [
    [
      'upgrade-reconcile-race-edit-change',
      'upgrade_edit_change_first',
      "pending_removal_from_public=true",
    ],
    [
      'upgrade-reconcile-race-tombstone',
      'upgrade_tombstone_first',
      "deleted_at=pg_catalog.now()",
    ],
  ] as const) {
    armReconciliationRaceFixture(publicId);
    const mutationSession = interactivePsql(applicationName);
    const helperSessionName = `${applicationName}_helper`;
    const helperSession = interactivePsql(helperSessionName);
    await mutationSession.execute(
      `BEGIN; UPDATE public.projects SET ${mutation} WHERE public_id='${publicId}';`,
    );
    const helperResult = observeConcurrentPsql(helperSession.execute(
      'BEGIN; SELECT public.reconcile_archived_project_republish_media()::text;',
    ));
    await waitForDatabaseLockWait(helperSessionName);
    await mutationSession.execute('COMMIT;');
    await mutationSession.close();
    assert.equal(
      await helperResult(),
      '0',
      `Reconciliation ignored a committed eligibility mutation for ${publicId}.`,
    );
    await helperSession.execute('COMMIT;');
    await helperSession.close();
    assert.equal(
      psql(`SELECT is_public_approved::text FROM public.media_assets WHERE project_id=(`
        + `SELECT id FROM public.projects WHERE public_id='${publicId}');`),
      'true',
      `Reconciliation repaired ${publicId} from a stale eligibility snapshot.`,
    );
  }
  console.log('PASS: reconciliation lock order rechecks archive, media, edit and tombstone races');
}

async function verifyArchivedRestoreRuntime(
  client: SupabaseClient,
  retainedBaseline: VerifiedPublicFeedArtifact,
  activationGenerationBeforeFixture: number,
): Promise<void> {
  assert.equal(
    psql("SELECT version.feed_hash || '|' || version.record_count::text || '|'"
      + " || version.byte_count::text || '|' || pg_catalog.count(member.version_id)::text"
      + ' FROM public.public_feed_head head'
      + ' JOIN public.public_feed_versions version ON version.id=head.current_version_id'
      + ' LEFT JOIN public.public_feed_version_members member ON member.version_id=version.id'
      + ' WHERE head.singleton=true'
      + ' GROUP BY version.feed_hash, version.record_count, version.byte_count;'),
    `${retainedBaseline.feedHash}|${retainedBaseline.recordCount}|${retainedBaseline.bytes.byteLength}|${retainedBaseline.members.length}`,
    'Restore runtime did not start from the exact retained canonical head.',
  );
  const storedBaseline = await client.storage.from(publicFeedBucket).download(publicationFeedPath);
  assert.ifError(storedBaseline.error);
  assert.ok(storedBaseline.data);
  assert.deepEqual(
    Buffer.from(await storedBaseline.data.arrayBuffer()),
    retainedBaseline.bytes,
    'Restore runtime did not start from exact retained canonical Storage bytes.',
  );
  const reviewerId = '3f000000-0000-4000-8000-000000000059';
  const inactiveAdminId = '3f000000-0000-4000-8000-000000000060';
  const roleRemovedAdminId = '3f000000-0000-4000-8000-000000000061';
  const pendingAdminId = '3f000000-0000-4000-8000-000000000062';
  const unlinkedAdminId = '3f000000-0000-4000-8000-000000000063';
  const unknownAdminId = '3f000000-0000-4000-8000-000000000064';
  const restoreFirstAdminId = '3f000000-0000-4000-8000-000000000065';
  const deactivateFirstAdminId = '3f000000-0000-4000-8000-000000000066';
  const fixtureActorIds = [
    reviewerId, inactiveAdminId, roleRemovedAdminId, pendingAdminId, unlinkedAdminId,
    restoreFirstAdminId, deactivateFirstAdminId,
  ];
  const archivedAt = '2026-09-16T12:00:00+00';
  const completedAt = '2026-09-16T12:01:00+00';
  const staleCompletedAt = '2026-09-15T12:01:00+00';
  psql(`
BEGIN;
INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
)
SELECT '00000000-0000-0000-0000-000000000000', actor.auth_id::uuid, 'authenticated',
       'authenticated', actor.email, '', pg_catalog.now(), '{}'::jsonb, '{}'::jsonb,
       pg_catalog.now(), pg_catalog.now(), '', '', '', ''
  FROM (VALUES
    ('3f000000-0000-4000-8000-000000000159', 'upgrade-restore-reviewer@example.invalid'),
    ('3f000000-0000-4000-8000-000000000160', 'upgrade-restore-inactive@example.invalid'),
    ('3f000000-0000-4000-8000-000000000161', 'upgrade-restore-role-removed@example.invalid'),
    ('3f000000-0000-4000-8000-000000000162', 'upgrade-restore-pending@example.invalid'),
    ('3f000000-0000-4000-8000-000000000165', 'upgrade-restore-first@example.invalid'),
    ('3f000000-0000-4000-8000-000000000166', 'upgrade-deactivate-first@example.invalid')
  ) actor(auth_id, email);
INSERT INTO public.admin_users (
  id, email, full_name, auth_user_id, lifecycle_status, deactivated_at
)
VALUES
  ('${reviewerId}', 'upgrade-restore-reviewer@example.invalid', 'Restore Reviewer',
   '3f000000-0000-4000-8000-000000000159', 'active', NULL),
  ('${inactiveAdminId}', 'upgrade-restore-inactive@example.invalid', 'Inactive Restore Admin',
   '3f000000-0000-4000-8000-000000000160', 'deactivated', pg_catalog.now()),
  ('${roleRemovedAdminId}', 'upgrade-restore-role-removed@example.invalid', 'Role Removed Admin',
   '3f000000-0000-4000-8000-000000000161', 'active', NULL),
  ('${pendingAdminId}', 'upgrade-restore-pending@example.invalid', 'Pending Restore Admin',
   '3f000000-0000-4000-8000-000000000162', 'active', NULL),
  ('${unlinkedAdminId}', 'upgrade-restore-unlinked@example.invalid', 'Unlinked Restore Admin',
   NULL, 'active', NULL),
  ('${restoreFirstAdminId}', 'upgrade-restore-first@example.invalid', 'Restore First Admin',
   '3f000000-0000-4000-8000-000000000165', 'active', NULL),
  ('${deactivateFirstAdminId}', 'upgrade-deactivate-first@example.invalid', 'Deactivate First Admin',
   '3f000000-0000-4000-8000-000000000166', 'active', NULL);
INSERT INTO public.user_roles (user_id, role) VALUES
  ('${reviewerId}', 'reviewer'),
  ('${inactiveAdminId}', 'admin'),
  ('${roleRemovedAdminId}', 'reviewer'),
  ('${pendingAdminId}', 'admin'),
  ('${unlinkedAdminId}', 'admin'),
  ('${restoreFirstAdminId}', 'admin'),
  ('${deactivateFirstAdminId}', 'admin');
INSERT INTO public.staff_provisioning_requests (
  normalized_email, full_name, requested_roles, status, requested_by_admin_id,
  requested_by_full_name_snapshot, requested_by_email_snapshot,
  execution_token_hash, auth_ownership_token_hash, lease_expires_at,
  auth_user_id, auth_identity_owned, admin_user_id
) VALUES (
  'upgrade-restore-pending@example.invalid', 'Pending Restore Admin', ARRAY['admin'],
  'pending_activation', '${ADMIN_ID}', 'Upgrade Rehearsal Reviewer',
  'upgrade-rehearsal-reviewer@example.invalid', '${'7'.repeat(64)}', '${'8'.repeat(64)}',
  pg_catalog.now() + interval '1 hour', '3f000000-0000-4000-8000-000000000162', true,
  '${pendingAdminId}'
);

INSERT INTO public.projects (
  public_id, title, year, program_id, program_name, study_program, status, source_folder,
  archived_at, archived_from_status, archive_reason, pending_removal_from_public,
  public_removal_completed_at, poster_text_public, accessibility_text_public
)
SELECT
  candidate.public_id, candidate.title, 2026, programs.id, programs.name, programs.name,
  'archived', 'upgrade-restore-rehearsal', '${archivedAt}'::timestamptz,
  candidate.origin, 'Synthetic archive restore rehearsal.', false,
  CASE
    WHEN candidate.public_id IN (
      'upgrade-restore-published', 'upgrade-restore-published-duplicate',
      'upgrade-restore-published-no-removal', 'upgrade-restore-concurrent',
      'upgrade-restore-media-failure', 'upgrade-restore-lifecycle-restore-first',
      'upgrade-restore-lifecycle-deactivate-first'
    )
      THEN '${completedAt}'::timestamptz
    WHEN candidate.public_id = 'upgrade-restore-published-stale' THEN '${staleCompletedAt}'::timestamptz
    ELSE NULL
  END,
  'Synthetic poster text for the restore rehearsal.',
  'Synthetic accessibility text for the restore rehearsal.'
FROM (VALUES
  ('upgrade-restore-submitted', 'Restore submitted origin', 'submitted'),
  ('upgrade-restore-in-review', 'Restore in-review origin', 'in_review'),
  ('upgrade-restore-approved', 'Restore approved origin', 'approved'),
  ('upgrade-restore-published', 'Restore published origin', 'published'),
  ('upgrade-restore-ambiguous', 'Restore ambiguous origin', 'approved'),
  ('upgrade-restore-contradictory', 'Restore contradictory origin', 'approved'),
  ('upgrade-restore-unsupported', 'Restore unsupported origin', 'draft'),
  ('upgrade-restore-feed-unsafe', 'Restore feed-unsafe origin', 'approved'),
  ('upgrade-restore-published-no-removal', 'Restore missing-removal origin', 'published'),
  ('upgrade-restore-published-stale', 'Restore stale-removal origin', 'published'),
  ('upgrade-restore-published-duplicate', 'Restore duplicate-removal origin', 'published'),
  ('upgrade-restore-writer-blocked', 'Restore writer-blocked origin', 'approved'),
  ('upgrade-restore-unauthorized', 'Restore unauthorized origin', 'approved'),
  ('upgrade-restore-concurrent', 'Restore concurrent origin', 'published'),
  ('upgrade-restore-lifecycle-restore-first', 'Restore-first lifecycle race', 'published'),
  ('upgrade-restore-lifecycle-deactivate-first', 'Deactivate-first lifecycle race', 'published'),
  ('upgrade-restore-audit-failure', 'Restore audit failure origin', 'approved'),
  ('upgrade-restore-media-failure', 'Restore media failure origin', 'published')
) AS candidate(public_id, title, origin)
CROSS JOIN LATERAL (SELECT id, name FROM public.programs ORDER BY name LIMIT 1) AS programs;

INSERT INTO public.approval_records (
  project_id, admin_id, action_taken, from_status, to_status, comments, created_at
)
SELECT project.id, '${ADMIN_ID}', 'archive', project.archived_from_status, 'archived',
       project.archive_reason, project.archived_at
 FROM public.projects project
 WHERE project.source_folder = 'upgrade-restore-rehearsal'
   AND project.public_id LIKE 'upgrade-restore-%'
   AND project.public_id <> 'upgrade-restore-ambiguous';

INSERT INTO public.approval_records (
  project_id, admin_id, action_taken, from_status, to_status, comments, created_at
)
SELECT project.id, '${ADMIN_ID}', 'archive', 'submitted', 'archived',
       'Contradictory synthetic provenance.', project.archived_at
  FROM public.projects project
 WHERE project.public_id = 'upgrade-restore-contradictory';

WITH removal_fixture(public_id, operation_count, finalized_at, completed_at) AS (
  VALUES
    ('upgrade-restore-published', 1, '${archivedAt}'::timestamptz, '${completedAt}'::timestamptz),
    ('upgrade-restore-published-stale', 1, '${staleCompletedAt}'::timestamptz - interval '1 minute', '${staleCompletedAt}'::timestamptz),
    ('upgrade-restore-published-duplicate', 2, '${archivedAt}'::timestamptz, '${completedAt}'::timestamptz),
    ('upgrade-restore-concurrent', 1, '${archivedAt}'::timestamptz, '${completedAt}'::timestamptz),
    ('upgrade-restore-lifecycle-restore-first', 1, '${archivedAt}'::timestamptz, '${completedAt}'::timestamptz),
    ('upgrade-restore-lifecycle-deactivate-first', 1, '${archivedAt}'::timestamptz, '${completedAt}'::timestamptz),
    ('upgrade-restore-media-failure', 1, '${archivedAt}'::timestamptz, '${completedAt}'::timestamptz)
)
INSERT INTO public.public_feed_operations (
  operation_key, kind, authorizing_actor_id, completion_actor_id, project_id, public_id,
  archive_reason, candidate_feed_hash, candidate_record_count, candidate_byte_count,
  candidate_feed_content, candidate_members, state, owner_epoch, owner_token_hash,
  lease_expires_at, observed_storage_hash, observed_storage_record_count,
  created_at, updated_at, finalized_at, completed_at
)
SELECT pg_catalog.gen_random_uuid(), 'removal', '${ADMIN_ID}', '${ADMIN_ID}', project.id,
       project.public_id, project.archive_reason,
       pg_catalog.encode(extensions.digest(pg_catalog.convert_to('[]', 'UTF8'), 'sha256'), 'hex'),
       0, 2, '[]', '[]'::jsonb, 'COMPLETED', 1, '${'a'.repeat(64)}', fixture.completed_at,
       pg_catalog.encode(extensions.digest(pg_catalog.convert_to('[]', 'UTF8'), 'sha256'), 'hex'),
       0, fixture.finalized_at, fixture.completed_at, fixture.finalized_at, fixture.completed_at
  FROM removal_fixture fixture
  JOIN public.projects project ON project.public_id = fixture.public_id
 CROSS JOIN LATERAL pg_catalog.generate_series(1, fixture.operation_count) duplicate;

INSERT INTO public.public_feed_operation_events (
  operation_id, sequence, from_state, to_state, actor_id, owner_epoch,
  observed_storage_hash, observed_storage_record_count, created_at
)
SELECT operation.id, 1, 'DB_FINALIZED', 'COMPLETED', operation.completion_actor_id,
       operation.owner_epoch, operation.observed_storage_hash,
       operation.observed_storage_record_count, operation.completed_at
  FROM public.public_feed_operations operation
 WHERE operation.public_id IN (
   'upgrade-restore-published',
   'upgrade-restore-published-stale',
   'upgrade-restore-concurrent',
   'upgrade-restore-lifecycle-restore-first',
   'upgrade-restore-lifecycle-deactivate-first',
   'upgrade-restore-media-failure'
 )
    OR operation.id = (
      SELECT duplicate.id
        FROM public.public_feed_operations duplicate
       WHERE duplicate.public_id = 'upgrade-restore-published-duplicate'
       ORDER BY duplicate.id::text
       LIMIT 1
    );

COMMIT;
`);

  const retainedMediaBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  );
  const retainedPdfBytes = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF', 'ascii');
  const retainedPrivatePath = 'drafts/upgrade-restore-published/poster_image/poster.png';
  const retainedPublicPath = 'published/upgrade-restore-published/poster_image/poster.png';
  const retainedPrivatePdfPath = 'drafts/upgrade-restore-published/poster_pdf/poster.pdf';
  const retainedPublicPdfPath = 'published/upgrade-restore-published/poster_pdf/poster.pdf';
  for (const [bucket, objectPath, bytes, contentType] of [
    ['project-drafts-private', retainedPrivatePath, retainedMediaBytes, 'image/png'],
    ['project-public-assets', retainedPublicPath, retainedMediaBytes, 'image/png'],
    ['project-drafts-private', retainedPrivatePdfPath, retainedPdfBytes, 'application/pdf'],
    ['project-public-assets', retainedPublicPdfPath, retainedPdfBytes, 'application/pdf'],
  ] as const) {
    const uploaded = await client.storage.from(bucket).upload(objectPath, bytes, {
      contentType, upsert: false,
    });
    assert.ifError(uploaded.error);
  }
  const retainedPublicUrl = client.storage.from('project-public-assets')
    .getPublicUrl(retainedPublicPath).data.publicUrl;
  const retainedPublicPdfUrl = client.storage.from('project-public-assets')
    .getPublicUrl(retainedPublicPdfPath).data.publicUrl;

  // Create a genuine confirmed preview while the source row is private, then reproduce the hosted
  // defect by returning the project to its proven archived-from-published state with public mapping
  // authority still attached. The public object is intentionally retained throughout the restore.
  psql(`
 INSERT INTO public.media_assets (
   project_id, asset_type, file_name, storage_bucket, storage_path, public_url,
   public_storage_bucket, public_storage_path, mime_type, file_size_bytes,
   is_public_approved, alt_text_public, image_content_kind, full_text_public
 )
 SELECT project.id, fixture.asset_type, fixture.file_name, 'project-drafts-private', fixture.storage_path,
        NULL, NULL, NULL, fixture.mime_type, fixture.file_size_bytes, false,
        fixture.alt_text_public, NULL, NULL
   FROM public.projects project
  CROSS JOIN (VALUES
    ('poster_image', 'poster.png', '${retainedPrivatePath}', 'image/png', ${retainedMediaBytes.length}, NULL),
    ('poster_pdf', 'poster.pdf', '${retainedPrivatePdfPath}', 'application/pdf', ${retainedPdfBytes.length}, NULL)
  ) AS fixture(asset_type, file_name, storage_path, mime_type, file_size_bytes, alt_text_public)
  WHERE project.public_id = 'upgrade-restore-published';
UPDATE public.projects
   SET status='approved', archived_at=NULL, archived_from_status=NULL, archive_reason=NULL
 WHERE public_id='upgrade-restore-published';
`);
  const oldTokenHash = createHash('sha256').update('upgrade-restore-published-old-preview').digest('hex');
  assert.equal(
    psql(`SELECT public.generate_participant_preview('upgrade-restore-published', '${ADMIN_ID}'::uuid, '${oldTokenHash}', 604800, 'project-drafts-private')->>'resultCode';`),
    'SUCCESS',
    'Could not issue the synthetic pre-publication preview.',
  );
  assert.equal(
    psql(`SELECT public.confirm_participant_preview('${oldTokenHash}')->>'resultCode';`),
    'SUCCESS',
    'Could not confirm the synthetic pre-publication preview.',
  );
  psql(`
UPDATE public.projects
   SET status='archived', archived_at='${archivedAt}'::timestamptz,
       archived_from_status='published', archive_reason='Synthetic archive restore rehearsal.',
       pending_removal_from_public=false, public_removal_completed_at='${completedAt}'::timestamptz
 WHERE public_id='upgrade-restore-published';
UPDATE public.media_assets
   SET is_public_approved=true, public_url='${retainedPublicUrl}',
       public_storage_bucket='project-public-assets', public_storage_path='${retainedPublicPath}'
  WHERE project_id=(SELECT id FROM public.projects WHERE public_id='upgrade-restore-published')
    AND asset_type='poster_image';
UPDATE public.media_assets
   SET is_public_approved=true, public_url='${retainedPublicPdfUrl}',
       public_storage_bucket='project-public-assets', public_storage_path='${retainedPublicPdfPath}'
 WHERE project_id=(SELECT id FROM public.projects WHERE public_id='upgrade-restore-published')
   AND asset_type='poster_pdf';

INSERT INTO public.media_assets (
  project_id, asset_type, file_name, storage_bucket, storage_path, public_url,
  public_storage_bucket, public_storage_path, mime_type, file_size_bytes,
  is_public_approved, alt_text_public
)
SELECT project.id, 'poster_image', 'untouched.png', 'project-drafts-private',
       'drafts/' || project.public_id || '/poster_image/untouched.png',
       'https://example.invalid/' || project.public_id || '/untouched.png',
       'project-public-assets', 'published/' || project.public_id || '/poster_image/untouched.png',
       'image/png', 64, true, 'Synthetic untouched mapping.'
  FROM public.projects project
 WHERE project.public_id IN (
   'upgrade-restore-approved', 'upgrade-restore-ambiguous',
   'upgrade-restore-contradictory', 'upgrade-restore-unsupported',
   'upgrade-restore-feed-unsafe',
   'upgrade-restore-published-no-removal', 'upgrade-restore-published-stale',
   'upgrade-restore-published-duplicate', 'upgrade-restore-writer-blocked',
   'upgrade-restore-unauthorized', 'upgrade-restore-concurrent',
   'upgrade-restore-lifecycle-restore-first',
   'upgrade-restore-lifecycle-deactivate-first',
   'upgrade-restore-audit-failure', 'upgrade-restore-media-failure'
 );
`);

  // Execute the unchanged M59 authority inside a rolled-back transaction to prove the hosted
  // defect itself: lifecycle restoration succeeds, but retained publication mappings alone make
  // the old confirmed preview fail the private-media snapshot comparison. The M60 wrapper is
  // exercised below. Accessibility is intentionally satisfied so this assertion reaches the
  // actual stale-preview ordering rather than masking it with a generic content refusal.
  psql(`
BEGIN;
DO $m59_defect$
DECLARE
  v_restore jsonb;
  v_readiness jsonb;
BEGIN
  v_restore := public.perform_project_review_action_without_media_rearm(
    'upgrade-restore-published', 'restore', NULL, '${ADMIN_ID}'::uuid
  );
  IF v_restore->>'status' IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'M59_RESTORE_DID_NOT_SUCCEED';
  END IF;
  v_readiness := public.get_project_publication_readiness(
    'upgrade-restore-published', '${ADMIN_ID}'::uuid, 'project-drafts-private'
  );
   IF v_readiness->>'resultCode' IS DISTINCT FROM 'MEDIA_SNAPSHOT_STALE' THEN
     RAISE EXCEPTION 'M59_PUBLIC_MAPPING_DEFECT_NOT_REPRODUCED: %', v_readiness;
  END IF;
END
$m59_defect$;
ROLLBACK;
`);
  const retainedMediaIdentityBefore = psql(`SELECT storage_bucket || '|' || storage_path || '|'
    || file_name || '|' || mime_type || '|' || file_size_bytes::text || '|'
    || COALESCE(alt_text_public,'') || '|' || COALESCE(gallery_position::text,'') || '|'
     || COALESCE(image_content_kind,'') || '|' || COALESCE(full_text_public,'')
     FROM public.media_assets
     WHERE project_id=(SELECT id FROM public.projects WHERE public_id='upgrade-restore-published')
     ORDER BY asset_type;`);
  const storageBeforeRestore = await readStorageEvidence(client, storageInventory());

  const feedBefore = fingerprintTables([
    'public.publication_attempts',
    'public.public_removal_attempts',
    'public.public_feed_operations',
    'public.public_feed_versions',
    'public.public_feed_version_members',
    'public.public_feed_head',
    'public.public_feed_operation_events',
    'public.published_snapshots',
  ]);
  for (const [origin, expected] of [
    ['submitted', 'submitted'],
    ['in-review', 'in_review'],
    ['approved', 'approved'],
    ['published', 'approved'],
  ] as const) {
    assert.equal(
      psql(`SELECT public.perform_project_review_action('upgrade-restore-${origin}', 'restore', 'Synthetic restore.', '${ADMIN_ID}'::uuid)->>'status';`),
      expected,
      `Restore did not preserve the safe ${origin} origin.`,
    );
  }
  assertTablesUnchanged(feedBefore, 'Archived-project restore runtime');
  assert.equal(
    psql("SELECT status || '|' || (archived_at IS NULL)::text || '|' || (archived_from_status IS NULL)::text"
      + " || '|' || (archive_reason IS NULL)::text FROM public.projects WHERE public_id='upgrade-restore-published';"),
    'approved|true|true|true',
    'Published-origin restore was not private Approved state with cleared archive fields.',
  );
  assert.equal(
    psql("SELECT event_details->>'republishRequired' FROM public.approval_records"
      + " WHERE project_id=(SELECT id FROM public.projects WHERE public_id='upgrade-restore-published')"
      + " AND action_taken='restore';"),
    'true',
    'Published-origin restore audit does not record the explicit republish requirement.',
  );
  assert.equal(
    psql("SELECT asset_type || '|' || is_public_approved::text || '|' || COALESCE(public_url,'NULL') || '|'"
      + " || COALESCE(public_storage_bucket,'NULL') || '|' || COALESCE(public_storage_path,'NULL')"
      + " FROM public.media_assets WHERE project_id=(SELECT id FROM public.projects"
      + " WHERE public_id='upgrade-restore-published') ORDER BY asset_type;"),
    'poster_image|false|NULL|NULL|NULL\nposter_pdf|false|NULL|NULL|NULL',
    'Published-origin restore did not clear exactly the four public mapping authorities on every target media row.',
  );
  assert.equal(
    psql(`SELECT storage_bucket || '|' || storage_path || '|'
      || file_name || '|' || mime_type || '|' || file_size_bytes::text || '|'
      || COALESCE(alt_text_public,'') || '|' || COALESCE(gallery_position::text,'') || '|'
       || COALESCE(image_content_kind,'') || '|' || COALESCE(full_text_public,'')
       FROM public.media_assets
       WHERE project_id=(SELECT id FROM public.projects WHERE public_id='upgrade-restore-published')
       ORDER BY asset_type;`),
    retainedMediaIdentityBefore,
    'Published-origin restore changed private source identity or media metadata.',
  );
  assert.equal(
    psql("SELECT is_public_approved::text || '|' || public_storage_path"
      + " FROM public.media_assets WHERE project_id=(SELECT id FROM public.projects"
      + " WHERE public_id='upgrade-restore-approved');"),
    'true|published/upgrade-restore-approved/poster_image/untouched.png',
    'A non-published restore origin changed its media mapping.',
  );
  const readinessCode = publicationReadiness('upgrade-restore-published');
  assert.equal(
    readinessCode,
    'NO_ACTIVE_PREVIEW',
    'A pre-restore confirmation retained ordinary publication authority after M60 rearm.',
  );
  assert.equal(
    psql("SELECT preview.status || '|' || (preview.revoked_at IS NOT NULL)::text || '|'"
      + ` || (preview.revoked_by = '${ADMIN_ID}'::uuid)::text || '|'`
      + ' || (SELECT pg_catalog.count(*) FROM public.participant_preview_confirmations confirmation'
      + ' WHERE confirmation.participant_preview_id=preview.id)::text'
      + ' FROM public.participant_previews preview JOIN public.projects project'
      + " ON project.id=preview.project_id WHERE project.public_id='upgrade-restore-published';"),
    'revoked|true|true|1',
    'Restore did not retain and revoke the old preview/confirmation evidence.',
  );
  assert.equal(
    psql(`SELECT public.confirm_participant_preview('${oldTokenHash}')->>'resultCode';`),
    'NOT_FOUND',
    'A pre-restore token could still be confirmed after restore.',
  );
  const freshTokenHash = createHash('sha256').update('upgrade-restore-published-fresh-preview').digest('hex');
  assert.equal(
    psql(`SELECT public.generate_participant_preview('upgrade-restore-published', '${ADMIN_ID}'::uuid, '${freshTokenHash}', 604800, 'project-drafts-private')->>'resultCode';`),
    'SUCCESS',
    'Fresh participant preview generation failed against rearmed private media.',
  );
  assert.equal(
    psql(`SELECT public.confirm_participant_preview('${freshTokenHash}')->>'resultCode';`),
    'SUCCESS',
    'Fresh participant confirmation failed after media rearm.',
  );
  assert.equal(
    publicationReadiness('upgrade-restore-published'),
    'READY',
    'Fresh confirmation did not restore ordinary publication readiness.',
  );
  assert.deepEqual(
    await readStorageEvidence(client, storageInventory()),
    storageBeforeRestore,
    'Restore or preview regeneration changed retained Storage objects.',
  );

  let staleRetryRejected = false;
  try {
    psql(`SELECT public.perform_project_review_action('upgrade-restore-published', 'restore', NULL, '${ADMIN_ID}'::uuid);`);
  } catch {
    staleRetryRejected = true;
  }
  assert.equal(staleRetryRejected, true, 'A repeated stale restore did not fail closed.');
  assert.equal(
    psql("SELECT count(*)::text FROM public.approval_records WHERE action_taken='restore'"
      + " AND project_id=(SELECT id FROM public.projects WHERE public_id='upgrade-restore-published');"),
    '1',
    'A repeated restore created a duplicate audit record.',
  );

  assert.equal(
    psql(`SELECT public.perform_project_review_action('upgrade-restore-ambiguous', 'restore', NULL, '${ADMIN_ID}'::uuid)->>'resultCode';`),
    'ARCHIVE_PROVENANCE_AMBIGUOUS',
  );
  assert.equal(
    psql("SELECT status || '|' || count(*) FILTER (WHERE action_taken='restore')::text"
      + " FROM public.projects project LEFT JOIN public.approval_records audit ON audit.project_id=project.id"
      + " WHERE project.public_id='upgrade-restore-ambiguous' GROUP BY project.status;"),
    'archived|0',
    'Ambiguous provenance mutated project state or audit history.',
  );

  // The deliberately inconsistent current membership is scoped to this transaction. It proves
  // the refusal against the real head without contaminating the canonical publisher baseline.
  psql(`
BEGIN;
INSERT INTO public.public_feed_version_members(version_id, ordinal, public_id, record_hash)
SELECT head.current_version_id,
       COALESCE((SELECT pg_catalog.max(member.ordinal) + 1
                   FROM public.public_feed_version_members member
                  WHERE member.version_id = head.current_version_id), 0),
       'upgrade-restore-feed-unsafe', '${'b'.repeat(64)}'
  FROM public.public_feed_head head
 WHERE head.singleton = true;
DO $feed_unsafe$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.perform_project_review_action(
    'upgrade-restore-feed-unsafe', 'restore', NULL, '${ADMIN_ID}'::uuid
  );
  IF v_result->>'resultCode' IS DISTINCT FROM 'RESTORE_PUBLIC_FEED_UNSAFE' THEN
    RAISE EXCEPTION 'FEED_UNSAFE_REFUSAL_MISMATCH: %', v_result;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.projects project
     WHERE project.public_id='upgrade-restore-feed-unsafe' AND project.status='archived'
  ) OR EXISTS (
    SELECT 1 FROM public.approval_records audit
     JOIN public.projects project ON project.id=audit.project_id
     WHERE project.public_id='upgrade-restore-feed-unsafe' AND audit.action_taken='restore'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.media_assets media
     JOIN public.projects project ON project.id=media.project_id
     WHERE project.public_id='upgrade-restore-feed-unsafe' AND media.is_public_approved=true
  ) THEN
    RAISE EXCEPTION 'FEED_UNSAFE_REFUSAL_MUTATED_FIXTURE';
  END IF;
END
$feed_unsafe$;
ROLLBACK;
`);
  assert.equal(
    psql("SELECT status || '|' || (SELECT pg_catalog.count(*) FROM public.approval_records audit"
      + " WHERE audit.project_id=project.id AND audit.action_taken='restore')::text || '|'"
      + " || (SELECT pg_catalog.bool_and(media.is_public_approved) FROM public.media_assets media"
      + " WHERE media.project_id=project.id)::text FROM public.projects project"
      + " WHERE project.public_id='upgrade-restore-feed-unsafe';"),
    'archived|0|true',
    'Rolled-back feed-unsafe proof changed lifecycle, audit or media state.',
  );
  assert.equal(
    psql("SELECT count(*)::text FROM public.public_feed_version_members"
      + " WHERE public_id='upgrade-restore-feed-unsafe';"),
    '0',
    'Rolled-back feed-unsafe proof contaminated the canonical head membership.',
  );

  for (const [publicId, expectedCode] of [
    ['upgrade-restore-contradictory', 'ARCHIVE_PROVENANCE_AMBIGUOUS'],
    ['upgrade-restore-unsupported', 'ARCHIVE_PROVENANCE_AMBIGUOUS'],
    ['upgrade-restore-published-no-removal', 'ARCHIVE_PROVENANCE_AMBIGUOUS'],
    ['upgrade-restore-published-stale', 'ARCHIVE_PROVENANCE_AMBIGUOUS'],
    ['upgrade-restore-published-duplicate', 'ARCHIVE_PROVENANCE_AMBIGUOUS'],
  ] as const) {
    assert.equal(
      psql(`SELECT public.perform_project_review_action('${publicId}', 'restore', NULL, '${ADMIN_ID}'::uuid)->>'resultCode';`),
      expectedCode,
      `${publicId} did not fail closed with ${expectedCode}.`,
    );
    assert.equal(
      psql(`SELECT status || '|' || (SELECT pg_catalog.count(*) FROM public.approval_records audit WHERE audit.project_id = project.id AND audit.action_taken = 'restore')::text FROM public.projects project WHERE project.public_id = '${publicId}';`),
      'archived|0',
      `${publicId} mutated project state or restore-audit history.`,
    );
    assert.equal(
      psql(`SELECT is_public_approved::text FROM public.media_assets WHERE project_id=(SELECT id FROM public.projects WHERE public_id='${publicId}');`),
      'true',
      `${publicId} mutated media before its restore refusal.`,
    );
  }

  psql(`
INSERT INTO public.public_feed_operations (
  operation_key, kind, authorizing_actor_id, state, owner_token_hash, lease_expires_at
) VALUES (
  pg_catalog.gen_random_uuid(), 'activation', '${ADMIN_ID}', 'RESERVED',
  '${'c'.repeat(64)}', pg_catalog.now() + interval '2 minutes'
);
`);
  assert.equal(
    psql(`SELECT public.perform_project_review_action('upgrade-restore-writer-blocked', 'restore', NULL, '${ADMIN_ID}'::uuid)->>'resultCode';`),
    'PUBLICATION_IN_PROGRESS',
    'Restore did not refuse an active canonical feed writer.',
  );
  assert.equal(psql("SELECT status FROM public.projects WHERE public_id='upgrade-restore-writer-blocked';"), 'archived');
  assert.equal(psql("SELECT is_public_approved::text FROM public.media_assets WHERE project_id=(SELECT id FROM public.projects WHERE public_id='upgrade-restore-writer-blocked');"), 'true');
  psql("DELETE FROM public.public_feed_operations WHERE kind='activation' AND state='RESERVED' AND project_id IS NULL;");

  for (const [label, actorId] of [
    ['reviewer-only', reviewerId],
    ['deactivated', inactiveAdminId],
    ['admin-role-removed', roleRemovedAdminId],
    ['pending-activation', pendingAdminId],
    ['auth-unlinked', unlinkedAdminId],
    ['unknown', unknownAdminId],
  ] as const) {
    let unauthorizedRejected = false;
    try {
      psql(`SELECT public.perform_project_review_action('upgrade-restore-unauthorized', 'restore', NULL, '${actorId}'::uuid);`);
    } catch {
      unauthorizedRejected = true;
    }
    assert.equal(unauthorizedRejected, true, `${label} actor could restore an archived project.`);
  }
  assert.equal(psql("SELECT status FROM public.projects WHERE public_id='upgrade-restore-unauthorized';"), 'archived');
  assert.equal(psql("SELECT is_public_approved::text FROM public.media_assets WHERE project_id=(SELECT id FROM public.projects WHERE public_id='upgrade-restore-unauthorized');"), 'true');

  // Restore-first ordering: the canonical actor guard holds the lifecycle lock while waiting for
  // the writer. Deactivation waits, the already-authorized restore commits, then deactivation wins.
  const writerHolder = interactivePsql('upgrade_restore_writer_holder');
  const restoreFirst = interactivePsql('upgrade_restore_first');
  const deactivateAfterRestore = interactivePsql('upgrade_deactivate_after_restore');
  await writerHolder.execute(
    "BEGIN; SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('public_feed_canonical_writer'));",
  );
  const restoreFirstResult = observeConcurrentPsql(restoreFirst.execute(
    `BEGIN; SELECT public.perform_project_review_action('upgrade-restore-lifecycle-restore-first',`
    + ` 'restore', NULL, '${restoreFirstAdminId}'::uuid)->>'status';`,
  ));
  await waitForDatabaseLockWait('upgrade_restore_first');
  const deactivateAfterRestoreResult = observeConcurrentPsql(deactivateAfterRestore.execute(
    `BEGIN; SELECT public.manage_staff_lifecycle('${ADMIN_ID}'::uuid,`
    + " 'upgrade-restore-first@example.invalid', 'deactivate', NULL, 1)->>'resultCode';",
  ));
  await waitForDatabaseLockWait('upgrade_deactivate_after_restore');
  await writerHolder.execute('COMMIT;');
  await writerHolder.close();
  assert.equal(await restoreFirstResult(), 'approved', 'Restore-first lifecycle ordering did not restore.');
  await restoreFirst.execute('COMMIT;');
  await restoreFirst.close();
  assert.equal(
    await deactivateAfterRestoreResult(),
    'UPDATED',
    'Restore-first lifecycle ordering did not apply the waiting deactivation.',
  );
  await deactivateAfterRestore.execute('COMMIT;');
  await deactivateAfterRestore.close();
  assert.equal(
    psql(`SELECT project.status || '|' || staff.lifecycle_status FROM public.projects project`
      + ` CROSS JOIN public.admin_users staff WHERE project.public_id='upgrade-restore-lifecycle-restore-first'`
      + ` AND staff.id='${restoreFirstAdminId}'::uuid;`),
    'approved|deactivated',
    'Restore-first ordering did not serialize restore before staff deactivation.',
  );

  // Deactivation-first ordering: hold the actual lifecycle transition open, then prove Restore
  // waits and re-evaluates the now-deactivated actor instead of using a role captured beforehand.
  const deactivateFirst = interactivePsql('upgrade_deactivate_first');
  const restoreAfterDeactivation = interactivePsql('upgrade_restore_after_deactivation');
  assert.equal(
    await deactivateFirst.execute(
      `BEGIN; SELECT public.manage_staff_lifecycle('${ADMIN_ID}'::uuid,`
      + " 'upgrade-deactivate-first@example.invalid', 'deactivate', NULL, 1)->>'resultCode';",
    ),
    'UPDATED',
    'Deactivate-first lifecycle transition did not start.',
  );
  const restoreAfterDeactivationResult = observeConcurrentPsql(restoreAfterDeactivation.execute(
    `BEGIN; SELECT public.perform_project_review_action('upgrade-restore-lifecycle-deactivate-first',`
    + ` 'restore', NULL, '${deactivateFirstAdminId}'::uuid);`,
  ));
  await waitForDatabaseLockWait('upgrade_restore_after_deactivation');
  await deactivateFirst.execute('COMMIT;');
  await deactivateFirst.close();
  let restoreAfterDeactivationRejected = false;
  try {
    await restoreAfterDeactivationResult();
  } catch (error) {
    restoreAfterDeactivationRejected = error instanceof Error
      && error.message.includes('REVIEW_PERMISSION_DENIED');
  }
  assert.equal(
    restoreAfterDeactivationRejected,
    true,
    'A restore waiting behind deactivation retained stale administrator authority.',
  );
  assert.equal(
    psql("SELECT status FROM public.projects WHERE public_id='upgrade-restore-lifecycle-deactivate-first';"),
    'archived',
    'Deactivate-first ordering mutated the archived project.',
  );
  assert.equal(
    psql("SELECT is_public_approved::text FROM public.media_assets WHERE project_id=(SELECT id"
      + " FROM public.projects WHERE public_id='upgrade-restore-lifecycle-deactivate-first');"),
    'true',
    'Deactivate-first ordering mutated retained media.',
  );

  const concurrent = await Promise.all([
    client.rpc('perform_project_review_action', {
      p_public_id: 'upgrade-restore-concurrent', p_action: 'restore', p_comments: null, p_admin_id: ADMIN_ID,
    }),
    client.rpc('perform_project_review_action', {
      p_public_id: 'upgrade-restore-concurrent', p_action: 'restore', p_comments: null, p_admin_id: ADMIN_ID,
    }),
  ]);
  assert.equal(concurrent.filter((result) => result.data?.status === 'approved').length, 1, 'Concurrent restore did not have exactly one winner.');
  assert.equal(concurrent.filter((result) => result.error?.message.includes('REVIEW_TRANSITION_INVALID')).length, 1, 'Concurrent restore did not reject exactly one stale attempt.');
  assert.equal(
    psql("SELECT count(*)::text FROM public.approval_records WHERE action_taken='restore'"
      + " AND project_id=(SELECT id FROM public.projects WHERE public_id='upgrade-restore-concurrent');"),
    '1',
    'Concurrent restore wrote more than one audit record.',
  );
  assert.equal(
    psql("SELECT is_public_approved::text || '|' || COALESCE(public_storage_path,'NULL')"
      + " FROM public.media_assets WHERE project_id=(SELECT id FROM public.projects"
      + " WHERE public_id='upgrade-restore-concurrent');"),
    'false|NULL',
    'Concurrent restore left a partial public media mapping.',
  );

  psql(`
CREATE FUNCTION public.reject_upgrade_restore_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.action_taken = 'restore' THEN RAISE EXCEPTION 'SYNTHETIC_RESTORE_AUDIT_FAILURE'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reject_upgrade_restore_audit
BEFORE INSERT ON public.approval_records
FOR EACH ROW EXECUTE FUNCTION public.reject_upgrade_restore_audit();
`);
  let auditFailureRejected = false;
  try {
    psql(`SELECT public.perform_project_review_action('upgrade-restore-audit-failure', 'restore', NULL, '${ADMIN_ID}'::uuid);`);
  } catch {
    auditFailureRejected = true;
  } finally {
    psql('DROP TRIGGER reject_upgrade_restore_audit ON public.approval_records; DROP FUNCTION public.reject_upgrade_restore_audit();');
  }
  assert.equal(auditFailureRejected, true, 'Synthetic restore audit failure did not abort the transaction.');
  assert.equal(psql("SELECT status FROM public.projects WHERE public_id='upgrade-restore-audit-failure';"), 'archived');
  assert.equal(psql("SELECT is_public_approved::text FROM public.media_assets WHERE project_id=(SELECT id FROM public.projects WHERE public_id='upgrade-restore-audit-failure');"), 'true');

  psql(`
CREATE FUNCTION public.reject_upgrade_restore_media() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.project_id = (
    SELECT id FROM public.projects WHERE public_id='upgrade-restore-media-failure'
  ) AND NEW.is_public_approved = false THEN
    RAISE EXCEPTION 'SYNTHETIC_RESTORE_MEDIA_FAILURE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reject_upgrade_restore_media
BEFORE UPDATE ON public.media_assets
FOR EACH ROW EXECUTE FUNCTION public.reject_upgrade_restore_media();
`);
  let mediaFailureRejected = false;
  try {
    psql(`SELECT public.perform_project_review_action('upgrade-restore-media-failure', 'restore', NULL, '${ADMIN_ID}'::uuid);`);
  } catch {
    mediaFailureRejected = true;
  } finally {
    psql('DROP TRIGGER reject_upgrade_restore_media ON public.media_assets; DROP FUNCTION public.reject_upgrade_restore_media();');
  }
  assert.equal(mediaFailureRejected, true, 'Synthetic media failure did not abort the restore transaction.');
  assert.equal(
    psql("SELECT status || '|' || (SELECT count(*) FROM public.approval_records audit"
      + " WHERE audit.project_id=project.id AND audit.action_taken='restore')::text"
      + " FROM public.projects project WHERE public_id='upgrade-restore-media-failure';"),
    'archived|0',
    'Synthetic media failure did not roll back the project restore and audit.',
  );
  assert.equal(
    psql("SELECT is_public_approved::text || '|' || public_storage_path"
      + " FROM public.media_assets WHERE project_id=(SELECT id FROM public.projects"
      + " WHERE public_id='upgrade-restore-media-failure');"),
    'true|published/upgrade-restore-media-failure/poster_image/untouched.png',
    'Synthetic media failure left a partial media demotion.',
  );
  assertTablesUnchanged(feedBefore, 'Archived-project restore adverse runtime');
  assert.deepEqual(
    await readStorageEvidence(client, storageInventory()),
    storageBeforeRestore,
    'Adverse restore cases changed retained Storage objects.',
  );

  // Exercise the same bounded normal publisher used by the application from the exact retained
  // canonical head seeded above. Historical removal evidence remains intact and the unrelated
  // member must survive the append unchanged.
  assert.equal(
    psql("SELECT version.feed_hash || '|' || version.record_count::text || '|'"
      + " || version.byte_count::text || '|' || pg_catalog.count(member.version_id)::text"
      + ' FROM public.public_feed_head head'
      + ' JOIN public.public_feed_versions version ON version.id=head.current_version_id'
      + ' LEFT JOIN public.public_feed_version_members member ON member.version_id=version.id'
      + ' WHERE head.singleton=true'
      + ' GROUP BY version.feed_hash, version.record_count, version.byte_count;'),
    `${retainedBaseline.feedHash}|${retainedBaseline.recordCount}|${retainedBaseline.bytes.byteLength}|${retainedBaseline.members.length}`,
    'Adverse restore cases contaminated the retained publisher baseline.',
  );
  const baselineFeedDownload = await client.storage.from(publicFeedBucket).download(publicationFeedPath);
  assert.ifError(baselineFeedDownload.error);
  assert.ok(baselineFeedDownload.data);
  assert.deepEqual(
    Buffer.from(await baselineFeedDownload.data.arrayBuffer()),
    retainedBaseline.bytes,
    'Adverse restore cases changed the retained physical feed baseline.',
  );
  const versionsBeforeNormalPublication = Number(psql('SELECT count(*) FROM public.public_feed_versions;'));
  const snapshotsBeforeNormalPublication = Number(psql('SELECT count(*) FROM public.published_snapshots;'));
  const normalPublication = await executeControlledPublication({
    permissions: ['projects.publish'], publicId: 'upgrade-restore-published',
    privateBucket: 'project-drafts-private', publicAssetsBucket: 'project-public-assets',
    publicFeedBucket, publicFeedPath: publicationFeedPath,
    dependencies: createControlledPublicationDependencies({
      supabase: client, supabaseUrl: disposableApiUrl, publicId: 'upgrade-restore-published',
      adminId: ADMIN_ID, privateBucket: 'project-drafts-private', publicFeedBucket,
      publicFeedPath: publicationFeedPath, executionTarget: 'local',
    }),
  });
  assert.equal(normalPublication.resultCode, 'COMPLETED', JSON.stringify(normalPublication));
  assert.ok(
    normalPublication.resultCode === 'COMPLETED' && normalPublication.snapshotId,
    'Normal publisher did not return its exact publication snapshot ID.',
  );
  const publishedSnapshotId = normalPublication.snapshotId;
  assert.equal(psql("SELECT status FROM public.projects WHERE public_id='upgrade-restore-published';"), 'published');
  assert.equal(
    psql("SELECT count(*)::text FROM public.approval_records WHERE project_id=(SELECT id FROM public.projects WHERE public_id='upgrade-restore-published') AND action_taken='publish';"),
    '1',
    'Normal publisher did not write exactly one publish audit record.',
  );
  assert.equal(
    psql("SELECT is_public_approved::text || '|' || public_storage_bucket || '|' || public_storage_path FROM public.media_assets WHERE project_id=(SELECT id FROM public.projects WHERE public_id='upgrade-restore-published') ORDER BY asset_type;"),
    'true|project-public-assets|published/upgrade-restore-published/poster_image/poster.png\ntrue|project-public-assets|published/upgrade-restore-published/poster_pdf/poster.pdf',
    'Normal publisher did not reuse the deterministic public mappings for both retained media objects.',
  );
  assert.equal(
    Number(psql('SELECT count(*) FROM public.public_feed_versions;')),
    versionsBeforeNormalPublication + 1,
    'Normal publisher did not append exactly one feed-history version.',
  );
  assert.equal(
    Number(psql('SELECT count(*) FROM public.published_snapshots;')),
    snapshotsBeforeNormalPublication + 1,
    'Normal publisher did not append exactly one publication snapshot.',
  );
  assert.match(
    psql(`SELECT version.id::text || '|' || version.published_snapshot_id::text
      FROM public.public_feed_versions version
      WHERE version.operation_id='${normalPublication.attemptId}'::uuid;`),
    new RegExp(`^[0-9a-f-]{36}\\|${publishedSnapshotId}$`),
    'Normal publisher result did not identify the snapshot bound to its exact appended version.',
  );
  const publishedFeed = await client.storage.from(publicFeedBucket).download(publicationFeedPath);
  assert.ifError(publishedFeed.error);
  assert.ok(publishedFeed.data);
  const publishedFeedBytes = Buffer.from(await publishedFeed.data.arrayBuffer());
  const publishedArtifact = verifyPublicFeedArtifact(publishedFeedBytes);
  const publishedFeedContent = publishedArtifact.content;
  assert.match(publishedFeedContent, /upgrade-restore-published/);
  assert.match(publishedFeedContent, /published\/upgrade-restore-published\/poster_image\/poster\.png/);
  assert.equal(publishedArtifact.recordCount, retainedBaseline.recordCount + 1);
  assert.deepEqual(
    publishedArtifact.members.find((member) => member.publicId === 'upgrade-reconcile-current-feed'),
    retainedBaseline.members[0],
    'Normal publication did not preserve the unrelated retained feed member exactly.',
  );
  assert.equal(
    psql("SELECT version.feed_hash || '|' || version.record_count::text || '|'"
      + " || version.byte_count::text FROM public.public_feed_head head"
      + ' JOIN public.public_feed_versions version ON version.id=head.current_version_id'
      + ' WHERE head.singleton=true;'),
    `${publishedArtifact.feedHash}|${publishedArtifact.recordCount}|${publishedArtifact.bytes.byteLength}`,
    'Normal publication did not bind the head hash, count and bytes to the physical artifact.',
  );
  assert.equal(
    psql('SELECT version.artifact_content FROM public.public_feed_head head'
      + ' JOIN public.public_feed_versions version ON version.id=head.current_version_id'
      + ' WHERE head.singleton=true;'),
    publishedArtifact.content,
    'Normal publication did not persist the exact canonical artifact content.',
  );
  assert.equal(
    psql("SELECT member.ordinal::text || '|' || member.record_hash"
      + ' FROM public.public_feed_head head'
      + ' JOIN public.public_feed_version_members member ON member.version_id=head.current_version_id'
      + " WHERE head.singleton=true AND member.public_id='upgrade-reconcile-current-feed';"),
    `${retainedBaseline.members[0].ordinal}|${retainedBaseline.members[0].recordHash}`,
    'Normal publication did not persist the unrelated retained member binding.',
  );
  assert.equal(storageBeforeRestore.filter((object) => object.bucket === publicFeedBucket && object.key === publicationFeedPath).length, 1);
  const expectedStorageAfterPublication = storageBeforeRestore.map((object) =>
    object.bucket === publicFeedBucket && object.key === publicationFeedPath
      ? { ...object, ...byteEvidence(publishedArtifact.bytes) }
      : object);
  assert.deepEqual(await readStorageEvidence(client, storageInventory()), expectedStorageAfterPublication,
    'Normal publisher changed an immutable retained object or unexpected Storage identity.');
  console.log('PASS: normal controlled publisher reused both retained public objects and changed only the verified canonical feed bytes');

  // A different approved target with a conflicting retained destination must fail during the
  // publisher's real binding read, before WRITE_STARTED can permit any public side effect.
  const conflictPublicId = 'upgrade-restore-conflicting-retained-bytes';
  const conflictPrivateImagePath = `drafts/${conflictPublicId}/poster_image/poster.png`;
  const conflictPrivatePdfPath = `drafts/${conflictPublicId}/poster_pdf/poster.pdf`;
  const conflictPublicImagePath = `published/${conflictPublicId}/poster_image/poster.png`;
  const conflictingPublicBytes = Buffer.concat([retainedMediaBytes, Buffer.from([0x00])]);
  psql(`
INSERT INTO public.projects (
  public_id, title, slug, summary, background, solution, year, program_id, program_name,
  study_program, discipline, industry, industry_partner, academic_supervisor, group_name,
  team_members, poster_text_public, accessibility_text_public, snapshots, status, source_folder
)
SELECT '${conflictPublicId}', 'Conflicting retained bytes', '${conflictPublicId}',
       'Synthetic summary.', 'Synthetic background.', 'Synthetic solution.', 2026, programs.id,
       programs.name, programs.name, 'Software Engineering', 'Technology', 'Synthetic Partner',
       'Synthetic Supervisor', 'Synthetic Group', ARRAY['Synthetic Member'],
       'Synthetic poster text.', 'Synthetic accessibility text.', ARRAY[]::text[], 'approved',
       'upgrade-restore-rehearsal'
  FROM public.programs programs ORDER BY programs.name LIMIT 1;
`);
  for (const [objectPath, bytes, contentType] of [
    [conflictPrivateImagePath, retainedMediaBytes, 'image/png'],
    [conflictPrivatePdfPath, retainedPdfBytes, 'application/pdf'],
  ] as const) {
    const uploaded = await client.storage.from('project-drafts-private').upload(objectPath, bytes, {
      contentType, upsert: false,
    });
    assert.ifError(uploaded.error);
  }
  psql(`
INSERT INTO public.media_assets (
  project_id, asset_type, file_name, storage_bucket, storage_path, mime_type, file_size_bytes,
  is_public_approved, public_url, public_storage_bucket, public_storage_path,
  alt_text_public, image_content_kind, full_text_public
)
SELECT project.id, fixture.asset_type, fixture.file_name, 'project-drafts-private', fixture.storage_path,
       fixture.mime_type, fixture.file_size_bytes, false, NULL, NULL, NULL,
       fixture.alt_text_public, NULL, NULL
  FROM public.projects project
 CROSS JOIN (VALUES
   ('poster_image', 'poster.png', '${conflictPrivateImagePath}', 'image/png', ${retainedMediaBytes.length}, NULL),
   ('poster_pdf', 'poster.pdf', '${conflictPrivatePdfPath}', 'application/pdf', ${retainedPdfBytes.length}, NULL)
 ) AS fixture(asset_type, file_name, storage_path, mime_type, file_size_bytes, alt_text_public)
 WHERE project.public_id='${conflictPublicId}';
`);
  const conflictingUpload = await client.storage.from('project-public-assets').upload(
    conflictPublicImagePath, conflictingPublicBytes, { contentType: 'image/png', upsert: false },
  );
  assert.ifError(conflictingUpload.error);
  const conflictTokenHash = createHash('sha256').update('upgrade-restore-conflicting-retained-bytes-preview').digest('hex');
  assert.equal(
    psql(`SELECT public.generate_participant_preview('${conflictPublicId}', '${ADMIN_ID}'::uuid, '${conflictTokenHash}', 604800, 'project-drafts-private')->>'resultCode';`),
    'SUCCESS',
    'Conflicting-byte target did not receive a real participant preview.',
  );
  assert.equal(
    psql(`SELECT public.confirm_participant_preview('${conflictTokenHash}')->>'resultCode';`),
    'SUCCESS',
    'Conflicting-byte target did not receive a real synthetic confirmation.',
  );
  const feedBeforeConflict = await client.storage.from(publicFeedBucket).download(publicationFeedPath);
  assert.ifError(feedBeforeConflict.error);
  assert.ok(feedBeforeConflict.data);
  const headBeforeConflict = psql('SELECT current_version_id::text || \'|\' || generation::text FROM public.public_feed_head WHERE singleton=true;');
  const versionsBeforeConflict = Number(psql('SELECT count(*) FROM public.public_feed_versions;'));
  const snapshotsBeforeConflict = Number(psql('SELECT count(*) FROM public.published_snapshots;'));
  const conflictPublication = await executeControlledPublication({
    permissions: ['projects.publish'], publicId: conflictPublicId,
    privateBucket: 'project-drafts-private', publicAssetsBucket: 'project-public-assets',
    publicFeedBucket, publicFeedPath: publicationFeedPath,
    dependencies: createControlledPublicationDependencies({
      supabase: client, supabaseUrl: disposableApiUrl, publicId: conflictPublicId,
      adminId: ADMIN_ID, privateBucket: 'project-drafts-private', publicFeedBucket,
      publicFeedPath: publicationFeedPath, executionTarget: 'local',
    }),
  });
  assert.equal(conflictPublication.resultCode, 'EXECUTION_FAILED', JSON.stringify(conflictPublication));
  if (conflictPublication.resultCode === 'EXECUTION_FAILED') {
    assert.equal(conflictPublication.failureCode, 'MEDIA_STORAGE_CONFLICT');
  }
  assert.equal(Number(psql('SELECT count(*) FROM public.public_feed_versions;')), versionsBeforeConflict);
  assert.equal(
    Number(psql('SELECT count(*) FROM public.published_snapshots;')),
    snapshotsBeforeConflict,
    'Conflicting retained bytes appended a publication snapshot.',
  );
  assert.equal(psql('SELECT current_version_id::text || \'|\' || generation::text FROM public.public_feed_head WHERE singleton=true;'), headBeforeConflict);
  assert.equal(psql(`SELECT status FROM public.projects WHERE public_id='${conflictPublicId}';`), 'approved');
  assert.equal(
    psql(`SELECT count(*)::text FROM public.approval_records WHERE project_id=(SELECT id FROM public.projects WHERE public_id='${conflictPublicId}') AND action_taken='publish';`),
    '0',
    'Conflicting retained bytes wrote a publish audit record.',
  );
  assert.equal(
    psql(`SELECT is_public_approved::text || '|' || COALESCE(public_storage_path,'NULL') FROM public.media_assets WHERE project_id=(SELECT id FROM public.projects WHERE public_id='${conflictPublicId}') ORDER BY asset_type;`),
    'false|NULL\nfalse|NULL',
  );
  const feedAfterConflict = await client.storage.from(publicFeedBucket).download(publicationFeedPath);
  assert.ifError(feedAfterConflict.error);
  assert.ok(feedAfterConflict.data);
  assert.deepEqual(
    Buffer.from(await feedAfterConflict.data.arrayBuffer()),
    Buffer.from(await feedBeforeConflict.data.arrayBuffer()),
    'Conflicting retained bytes changed the canonical feed before refusal.',
  );
  const conflictObject = await client.storage.from('project-public-assets').download(conflictPublicImagePath);
  assert.ifError(conflictObject.error);
  assert.ok(conflictObject.data);
  assert.deepEqual(Buffer.from(await conflictObject.data.arrayBuffer()), conflictingPublicBytes);
  assert.equal(
    psql(`SELECT COALESCE(pg_catalog.string_agg(name, ',' ORDER BY name), '') FROM storage.objects WHERE bucket_id='project-public-assets' AND name LIKE 'published/${conflictPublicId}/%';`),
    conflictPublicImagePath,
    'Conflicting retained bytes created a new public media object before refusal.',
  );
  console.log('PASS: normal controlled publisher failed closed on conflicting retained bytes before public write intent');
  const activationGenerationBeforeCleanup = Number(psql(
    'SELECT generation::text FROM public.public_feed_activation_authority WHERE singleton=true;',
  ));
  assert.ok(
    activationGenerationBeforeCleanup > activationGenerationBeforeFixture,
    'Fixture lifecycle changes did not advance public-feed activation authority.',
  );
  assert.equal(
    psql("SELECT COALESCE(active_activation_operation_id::text, '') FROM public.public_feed_activation_authority WHERE singleton=true;"),
    '',
    'Fixture behavior left public-feed activation authority claimed before cleanup.',
  );
  for (const [bucket, paths] of [
    ['project-drafts-private', [conflictPrivateImagePath, conflictPrivatePdfPath]],
    ['project-public-assets', [conflictPublicImagePath]],
  ] as const) {
    const removed = await client.storage.from(bucket).remove([...paths]);
    assert.ifError(removed.error);
  }
  for (const [bucket, paths] of [
    ['project-drafts-private', [retainedPrivatePath, retainedPrivatePdfPath]],
    ['project-public-assets', [retainedPublicPath, retainedPublicPdfPath]],
    [publicFeedBucket, [publicationFeedPath]],
  ] as const) {
    const removed = await client.storage.from(bucket).remove([...paths]);
    assert.ifError(removed.error);
  }
  assert.equal(
    psql("SELECT count(*)::text FROM storage.objects WHERE"
      + ` (bucket_id='${publicFeedBucket}' AND name='${publicationFeedPath}')`
      + " OR (bucket_id IN ('project-drafts-private','project-public-assets')"
      + " AND name LIKE '%/upgrade-restore-published/%');"),
    '0',
    'Restore runtime left owned feed or retained-media Storage objects behind.',
  );

  psql(`
BEGIN;
  CREATE TEMP TABLE upgrade_restore_cleanup_ids AS
  SELECT id FROM public.projects WHERE source_folder = 'upgrade-restore-rehearsal';
  CREATE TEMP TABLE upgrade_restore_cleanup_operation_ids AS
SELECT id FROM public.public_feed_operations
 WHERE public_id LIKE 'upgrade-restore-%'
    OR public_id LIKE 'upgrade-reconcile-%'
    OR storage_path IN ('${baselineFeedPath}', '${publicationFeedPath}');
CREATE TEMP TABLE upgrade_restore_cleanup_version_ids AS
SELECT id FROM public.public_feed_versions
 WHERE operation_id IN (SELECT id FROM upgrade_restore_cleanup_operation_ids);
CREATE TEMP TABLE upgrade_restore_cleanup_snapshot_ids AS
SELECT DISTINCT published_snapshot_id AS id
  FROM public.public_feed_versions
 WHERE id IN (SELECT id FROM upgrade_restore_cleanup_version_ids)
   AND published_snapshot_id IS NOT NULL;
DO $cleanup_scope$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.public_feed_operations operation
     WHERE operation.project_id IN (SELECT id FROM upgrade_restore_cleanup_ids)
       AND operation.id NOT IN (SELECT id FROM upgrade_restore_cleanup_operation_ids)
  ) OR EXISTS (
    SELECT 1 FROM public.public_feed_operations operation
     WHERE operation.id NOT IN (SELECT id FROM upgrade_restore_cleanup_operation_ids)
       AND operation.baseline_version_id IN (SELECT id FROM upgrade_restore_cleanup_version_ids)
  ) OR EXISTS (
    SELECT 1 FROM public.public_feed_versions version
     WHERE version.id NOT IN (SELECT id FROM upgrade_restore_cleanup_version_ids)
       AND (version.previous_version_id IN (SELECT id FROM upgrade_restore_cleanup_version_ids)
         OR version.restored_from_version_id IN (SELECT id FROM upgrade_restore_cleanup_version_ids))
  ) THEN
    RAISE EXCEPTION 'UPGRADE_RESTORE_CLEANUP_LEDGER_SCOPE_INCOMPLETE';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM upgrade_restore_cleanup_snapshot_ids) <> 1
     OR NOT EXISTS (
       SELECT 1 FROM upgrade_restore_cleanup_snapshot_ids
        WHERE id='${publishedSnapshotId}'::uuid
     )
  THEN
    RAISE EXCEPTION 'UPGRADE_RESTORE_CLEANUP_SNAPSHOT_SCOPE_MISMATCH';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.feed_rollback_preparations preparation
     WHERE preparation.target_version_id IN (SELECT id FROM upgrade_restore_cleanup_version_ids)
        OR preparation.baseline_version_id IN (SELECT id FROM upgrade_restore_cleanup_version_ids)
        OR preparation.operation_id IN (SELECT id FROM upgrade_restore_cleanup_operation_ids)
  ) OR EXISTS (
    SELECT 1 FROM public.public_feed_rollback_capability_events capability
     WHERE capability.head_version_id IN (SELECT id FROM upgrade_restore_cleanup_version_ids)
  ) OR EXISTS (
    SELECT 1 FROM public.published_snapshots snapshot
     WHERE snapshot.id NOT IN (SELECT id FROM upgrade_restore_cleanup_snapshot_ids)
       AND snapshot.rollback_of_snapshot_id IN (SELECT id FROM upgrade_restore_cleanup_snapshot_ids)
  ) THEN
    RAISE EXCEPTION 'UPGRADE_RESTORE_CLEANUP_UNEXPECTED_VERSION_DEPENDENCY';
  END IF;
END
$cleanup_scope$;
  ALTER TABLE public.public_feed_operation_events DISABLE TRIGGER reject_public_feed_event_mutation;
DELETE FROM public.public_feed_operation_events
 WHERE operation_id IN (SELECT id FROM upgrade_restore_cleanup_operation_ids);
ALTER TABLE public.public_feed_operation_events ENABLE TRIGGER reject_public_feed_event_mutation;
ALTER TABLE public.public_feed_version_members DISABLE TRIGGER reject_public_feed_member_mutation;
  DELETE FROM public.public_feed_version_members
 WHERE version_id IN (SELECT id FROM upgrade_restore_cleanup_version_ids);
  ALTER TABLE public.public_feed_version_members ENABLE TRIGGER reject_public_feed_member_mutation;
  DELETE FROM public.public_feed_head
 WHERE current_version_id IN (SELECT id FROM upgrade_restore_cleanup_version_ids)
    OR last_operation_id IN (SELECT id FROM upgrade_restore_cleanup_operation_ids);
UPDATE public.public_feed_operations
   SET baseline_version_id = NULL
 WHERE id IN (SELECT id FROM upgrade_restore_cleanup_operation_ids)
   AND baseline_version_id IN (SELECT id FROM upgrade_restore_cleanup_version_ids);
  ALTER TABLE public.public_feed_versions DISABLE TRIGGER reject_public_feed_version_mutation;
UPDATE public.public_feed_versions
   SET previous_version_id = CASE
         WHEN previous_version_id IN (SELECT id FROM upgrade_restore_cleanup_version_ids) THEN NULL
         ELSE previous_version_id
       END,
       restored_from_version_id = CASE
         WHEN restored_from_version_id IN (SELECT id FROM upgrade_restore_cleanup_version_ids) THEN NULL
         ELSE restored_from_version_id
       END
 WHERE id IN (SELECT id FROM upgrade_restore_cleanup_version_ids)
   AND (previous_version_id IN (SELECT id FROM upgrade_restore_cleanup_version_ids)
     OR restored_from_version_id IN (SELECT id FROM upgrade_restore_cleanup_version_ids));
  DELETE FROM public.public_feed_versions
 WHERE id IN (SELECT id FROM upgrade_restore_cleanup_version_ids);
  ALTER TABLE public.public_feed_versions ENABLE TRIGGER reject_public_feed_version_mutation;
DELETE FROM public.published_snapshots
 WHERE id IN (SELECT id FROM upgrade_restore_cleanup_snapshot_ids);
  DELETE FROM public.public_feed_operations
 WHERE id IN (SELECT id FROM upgrade_restore_cleanup_operation_ids);
  DELETE FROM public.projects WHERE source_folder = 'upgrade-restore-rehearsal';
DO $restore_activation_generation$
DECLARE
  v_generation bigint;
BEGIN
  UPDATE public.public_feed_activation_authority
     SET generation = ${activationGenerationBeforeFixture}
   WHERE singleton = true
     AND active_activation_operation_id IS NULL
   RETURNING generation INTO v_generation;
  IF v_generation IS DISTINCT FROM ${activationGenerationBeforeFixture} THEN
    RAISE EXCEPTION 'UPGRADE_RESTORE_ACTIVATION_GENERATION_RESTORE_FAILED';
  END IF;
END
$restore_activation_generation$;
  DELETE FROM public.public_feed_project_projection_authority authority
USING upgrade_restore_cleanup_ids fixture
WHERE authority.project_id = fixture.id;
DELETE FROM public.staff_provisioning_requests
 WHERE admin_user_id IN (${fixtureActorIds.map((id) => `'${id}'`).join(', ')});
DELETE FROM public.staff_lifecycle_events
 WHERE target_admin_user_id IN (${fixtureActorIds.map((id) => `'${id}'`).join(', ')});
DELETE FROM public.user_roles
 WHERE user_id IN (${fixtureActorIds.map((id) => `'${id}'`).join(', ')});
DELETE FROM public.admin_users
 WHERE id IN (${fixtureActorIds.map((id) => `'${id}'`).join(', ')});
DELETE FROM auth.users
 WHERE id IN (
   '3f000000-0000-4000-8000-000000000159',
   '3f000000-0000-4000-8000-000000000160',
   '3f000000-0000-4000-8000-000000000161',
   '3f000000-0000-4000-8000-000000000162',
   '3f000000-0000-4000-8000-000000000165',
   '3f000000-0000-4000-8000-000000000166'
 );
COMMIT;
`);
  assert.equal(psql("SELECT count(*)::text FROM public.projects WHERE source_folder='upgrade-restore-rehearsal';"), '0');
  assert.equal(
    Number(psql('SELECT generation::text FROM public.public_feed_activation_authority WHERE singleton=true;')),
    activationGenerationBeforeFixture,
    'Owned cleanup did not restore the exact pre-fixture activation generation.',
  );
  console.log('PASS: restore runtime covers all origins, contradictory provenance, canonical removal timing/uniqueness, feed-head absence, writer exclusion, RBAC, atomicity, history preservation and concurrent replay');
}

async function createDisposableAuthUser(client: SupabaseClient, email: string): Promise<string> {
  const { data, error } = await client.auth.admin.createUser({
    email,
    email_confirm: true,
    password: randomBytes(24).toString('base64url'),
  });
  assert.equal(error, null, error?.message);
  assert.ok(data.user?.id, `Disposable Auth user creation returned no identity for ${email}.`);
  return data.user.id;
}

function assertAfter61(
  current60Tables: Record<string, string>,
  publicTableGrantsBefore61: string,
  untrustedRoutineGrantsBefore61: string,
): void {
  assert.equal(Object.keys(current60Tables).length, 50, 'The current 0060 retained-table inventory is incomplete.');
  assertTablesUnchanged(current60Tables, 'Migration 0061');
  assert.equal(publicTableGrants(), publicTableGrantsBefore61, 'Migration 0061 changed direct table grants.');
  assert.equal(
    untrustedRoutineExecuteGrants(),
    untrustedRoutineGrantsBefore61,
    'Migration 0061 introduced an unsafe direct routine grant.',
  );

  for (const signature of [
    'public.get_project_soft_delete_preflight(text[],uuid)',
    'public.soft_delete_project_if_current(text,timestamp with time zone,uuid)',
  ] as const) {
    assert.equal(
      psql(`SELECT has_function_privilege('service_role','${signature}','EXECUTE')::text`
        + ` || '|' || has_function_privilege('anon','${signature}','EXECUTE')::text`
        + ` || '|' || has_function_privilege('authenticated','${signature}','EXECUTE')::text;`),
      'true|false|false',
      `Migration 0061 public RPC grant contract drifted for ${signature}.`,
    );
  }
  assert.equal(
    psql("SELECT has_function_privilege('service_role','public.project_soft_delete_decision(uuid,text,text,timestamp with time zone,boolean,timestamp with time zone,timestamp with time zone,text)','EXECUTE')::text"
      + " || '|' || has_function_privilege('anon','public.project_soft_delete_decision(uuid,text,text,timestamp with time zone,boolean,timestamp with time zone,timestamp with time zone,text)','EXECUTE')::text"
      + " || '|' || has_function_privilege('authenticated','public.project_soft_delete_decision(uuid,text,text,timestamp with time zone,boolean,timestamp with time zone,timestamp with time zone,text)','EXECUTE')::text;"),
    'false|false|false',
    'Migration 0061 exposed its internal eligibility helper.',
  );
  assert.equal(
    psql("SELECT has_function_privilege('service_role','public.parse_project_soft_delete_evidence_json(text)','EXECUTE')::text"
      + " || '|' || has_function_privilege('anon','public.parse_project_soft_delete_evidence_json(text)','EXECUTE')::text"
      + " || '|' || has_function_privilege('authenticated','public.parse_project_soft_delete_evidence_json(text)','EXECUTE')::text;"),
    'false|false|false',
    'Migration 0061 exposed its malformed-evidence parser.',
  );
  assert.equal(
    psql("SELECT has_function_privilege('service_role','public.project_soft_delete_artifact_members_match(uuid,text,integer)','EXECUTE')::text"
      + " || '|' || has_function_privilege('anon','public.project_soft_delete_artifact_members_match(uuid,text,integer)','EXECUTE')::text"
      + " || '|' || has_function_privilege('authenticated','public.project_soft_delete_artifact_members_match(uuid,text,integer)','EXECUTE')::text;"),
    'false|false|false',
    'Migration 0061 exposed its artifact/member integrity helper.',
  );
  assert.equal(
    psql("SELECT convalidated::text FROM pg_catalog.pg_constraint WHERE conname='projects_soft_delete_state_coherent';"),
    'false',
    'Migration 0061 unexpectedly validated or omitted its no-backfill lifecycle constraint.',
  );
  assert.equal(
    psql("SELECT count(*)::text FROM pg_catalog.pg_trigger WHERE tgrelid='public.approval_records'::regclass AND tgname='soft_delete_audit_immutable' AND NOT tgisinternal;"),
    '1',
    'Migration 0061 did not install the immutable soft-delete audit trigger.',
  );
  assert.equal(
    psql('SELECT public.get_release_capability_sentinel();'),
    '20260917120000_governed_project_soft_delete|active_staff_catalog_rls_v1|staff_lifecycle_v1|staging_feed_rollback_capability_v1|preview_response_observation_v1|assistive_worker_environment_identity_v1|gallery_text_equivalent_v1|layout_recipe_library_v1|archived_project_restore_v1|archived_project_republish_media_rearm_v1|governed_project_soft_delete_v1',
  );
  console.log('PASS: Migration 0061 preserved all 50 retained tables and installed bounded service-only soft-delete authority');
}

function softDeleteCode(publicId: string, expectedUpdatedAtSql: string, actorId = ADMIN_ID): string {
  return psql(
    `SELECT public.soft_delete_project_if_current('${publicId}', ${expectedUpdatedAtSql}, '${actorId}'::uuid)->>'resultCode';`,
  );
}

function javascriptRecordHashFromArtifact(artifactContent: string, publicId: string): string {
  const record = (JSON.parse(artifactContent) as PublicFeedRecord[]).find((candidate) => candidate.publicId === publicId);
  assert.ok(record, `The exact artifact did not contain retained member ${publicId}.`);
  return javascriptRecordHash(record);
}

function javascriptRecordHash(record: unknown): string {
  const serialized = JSON.stringify(record);
  if (typeof serialized !== 'string') throw new Error('SYNTHETIC_RECORD_NOT_JSON_SERIALIZABLE');
  return createHash('sha256').update(Buffer.from(serialized, 'utf8')).digest('hex');
}

function sqlUtf8TextExpression(value: string): string {
  return `pg_catalog.convert_from(pg_catalog.decode('${Buffer.from(value, 'utf8').toString('base64')}', 'base64'), 'UTF8')`;
}

function softDeleteArtifactBindingParityProbe(versionId: string): string {
  const records: Array<Record<string, unknown>> = [
    {
      publicId: 'upgrade-delete-hash-utf8',
      title: 'Dự án – 日本語',
      summary: 'UTF-8 generated record',
    },
    {
      publicId: 'upgrade-delete-hash-escaped',
      title: 'A "quoted" title \\ folder',
      spacing: 'keep  two spaces\nand\ttabs',
    },
    {
      publicId: 'upgrade-delete-hash-empty',
      empty: '',
      literal: '\\n not a newline',
      controls: '\b\f\r',
    },
    {
      publicId: 'upgrade-delete-hash-nested',
      nested: { object: { value: 'nested' }, array: [null, 0, 1e+21] },
    },
  ];
  const artifactContent = JSON.stringify(records, null, 2);
  if (typeof artifactContent !== 'string') throw new Error('SYNTHETIC_ARTIFACT_NOT_JSON_SERIALIZABLE');
  const artifactExpression = sqlUtf8TextExpression(artifactContent);
  const feedHash = createHash('sha256').update(Buffer.from(artifactContent, 'utf8')).digest('hex');
  const malformedArtifactContent = '{not-json';
  const malformedArtifactExpression = sqlUtf8TextExpression(malformedArtifactContent);
  const malformedFeedHash = createHash('sha256').update(Buffer.from(malformedArtifactContent, 'utf8')).digest('hex');
  const memberValues = records.map((record, ordinal) => `
    ('${versionId}'::uuid, ${ordinal}, '${record.publicId}', '${javascriptRecordHash(record)}')`).join(',');

  return psql(`
\\set QUIET 1
BEGIN;
ALTER TABLE public.public_feed_versions DISABLE TRIGGER reject_public_feed_version_mutation;
ALTER TABLE public.public_feed_version_members DISABLE TRIGGER reject_public_feed_member_mutation;
UPDATE public.public_feed_versions
   SET artifact_content=${artifactExpression},
       byte_count=pg_catalog.octet_length(${artifactExpression}),
       feed_hash='${feedHash}',
       record_count=${records.length}
 WHERE id='${versionId}'::uuid;
DELETE FROM public.public_feed_version_members WHERE version_id='${versionId}'::uuid;
INSERT INTO public.public_feed_version_members(version_id, ordinal, public_id, record_hash)
VALUES${memberValues};
ALTER TABLE public.public_feed_version_members ENABLE TRIGGER reject_public_feed_member_mutation;
ALTER TABLE public.public_feed_versions ENABLE TRIGGER reject_public_feed_version_mutation;
SELECT public.project_soft_delete_artifact_members_match('${versionId}'::uuid, ${artifactExpression}, ${records.length})::text;
SELECT public.project_soft_delete_artifact_members_match('${versionId}'::uuid, NULL::text, ${records.length})::text;
SELECT public.project_soft_delete_artifact_members_match('${versionId}'::uuid, pg_catalog.repeat('x', 10485761), ${records.length})::text;
SELECT public.project_soft_delete_artifact_members_match(NULL::uuid, ${artifactExpression}, ${records.length})::text;
SELECT public.project_soft_delete_artifact_members_match('${versionId}'::uuid, ${artifactExpression}, NULL::integer)::text;
ALTER TABLE public.public_feed_versions DISABLE TRIGGER reject_public_feed_version_mutation;
UPDATE public.public_feed_versions
   SET artifact_content=${malformedArtifactExpression},
       byte_count=pg_catalog.octet_length(${malformedArtifactExpression}),
       feed_hash='${malformedFeedHash}'
 WHERE id='${versionId}'::uuid;
ALTER TABLE public.public_feed_versions ENABLE TRIGGER reject_public_feed_version_mutation;
SELECT public.project_soft_delete_artifact_members_match('${versionId}'::uuid, ${malformedArtifactExpression}, ${records.length})::text;
ROLLBACK;
`);
}

function softDeleteMemberHashProbe(targetPublicId: string, memberPublicId: string, versionId: string, expectedHash: string, replacementHash: string): string {
  return psql(`
\\set QUIET 1
BEGIN;
ALTER TABLE public.public_feed_version_members DISABLE TRIGGER reject_public_feed_member_mutation;
WITH changed AS (
  UPDATE public.public_feed_version_members
     SET record_hash='${replacementHash}'
   WHERE version_id='${versionId}'::uuid
     AND public_id='${memberPublicId}'
     AND record_hash='${expectedHash}'
  RETURNING 1
)
SELECT CASE WHEN count(*) = 1 THEN 'MUTATED' ELSE 'NOT_EXACT' END FROM changed;
ALTER TABLE public.public_feed_version_members ENABLE TRIGGER reject_public_feed_member_mutation;
SELECT (item->>'disposition') || ':' || (item->>'reasonCode')
  FROM pg_catalog.jsonb_array_elements((public.get_project_soft_delete_preflight(ARRAY['${targetPublicId}'], '${ADMIN_ID}'::uuid))->'items') item;
ROLLBACK;
`);
}

function softDeletePairedMemberHashProbe(
  targetPublicId: string,
  memberPublicId: string,
  operationId: string,
  baselineVersionId: string,
  removalVersionId: string,
  baselineHash: string,
  removalHash: string,
  replacementHash: string,
): string {
  return psql(`
\\set QUIET 1
BEGIN;
ALTER TABLE public.public_feed_version_members DISABLE TRIGGER reject_public_feed_member_mutation;
WITH changed AS (
  UPDATE public.public_feed_version_members
     SET record_hash='${replacementHash}'
   WHERE public_id='${memberPublicId}'
     AND ((version_id='${baselineVersionId}'::uuid AND record_hash='${baselineHash}')
       OR (version_id='${removalVersionId}'::uuid AND record_hash='${removalHash}'))
  RETURNING 1
)
SELECT 'MEMBERS=' || count(*)::text FROM changed;
WITH changed AS (
  UPDATE public.public_feed_operations operation
     SET candidate_members=(
       SELECT pg_catalog.jsonb_agg(
         CASE WHEN item.value->>'publicId'='${memberPublicId}'
           THEN pg_catalog.jsonb_set(item.value, '{recordHash}', pg_catalog.to_jsonb('${replacementHash}'::text), false)
           ELSE item.value
         END ORDER BY item.ordinality
       )
         FROM pg_catalog.jsonb_array_elements(operation.candidate_members)
           WITH ORDINALITY AS item(value, ordinality)
     )
   WHERE operation.id='${operationId}'::uuid
     AND operation.kind='removal'
     AND operation.state='COMPLETED'
     AND EXISTS (
       SELECT 1 FROM pg_catalog.jsonb_array_elements(operation.candidate_members) item
        WHERE item->>'publicId'='${memberPublicId}' AND item->>'recordHash'='${removalHash}'
     )
  RETURNING 1
)
SELECT 'MANIFEST=' || count(*)::text FROM changed;
ALTER TABLE public.public_feed_version_members ENABLE TRIGGER reject_public_feed_member_mutation;
SELECT (item->>'disposition') || ':' || (item->>'reasonCode')
  FROM pg_catalog.jsonb_array_elements((public.get_project_soft_delete_preflight(ARRAY['${targetPublicId}'], '${ADMIN_ID}'::uuid))->'items') item;
ROLLBACK;
`);
}

function activateSoftDeleteFixtureFeed(feedBucket: string, feedPath: string): void {
  psql(`
DO $soft_delete_activation$
DECLARE
  v_owner_token text := 'upgrade-soft-delete-activation-owner-token';
  v_hash text := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to('[]', 'UTF8'), 'sha256'),
    'hex'
  );
  v_operation_id uuid;
  v_result jsonb;
BEGIN
  v_result := public.reserve_public_feed_operation(
    pg_catalog.gen_random_uuid(), 'activation', NULL, '${ADMIN_ID}'::uuid, NULL,
    v_owner_token, NULL, NULL, NULL, NULL, NULL, NULL,
    '${feedBucket}', '${feedPath}', false
  );
  IF v_result->>'resultCode' IS DISTINCT FROM 'OPERATION_RESERVED' THEN
    RAISE EXCEPTION 'SOFT_DELETE_ACTIVATION_RESERVE_FAILED: %', v_result;
  END IF;
  v_operation_id := (v_result->>'operationId')::uuid;
  v_result := public.bind_public_feed_operation(
    v_operation_id, 1, v_owner_token, '${ADMIN_ID}'::uuid,
    NULL, false, NULL, NULL, NULL, v_hash, 0, '[]', '[]'::jsonb,
    'https://example.invalid/upgrade-soft-delete-feed.json', '[]'::jsonb
  );
  IF v_result->>'resultCode' IS DISTINCT FROM 'ARTIFACT_BOUND' THEN
    RAISE EXCEPTION 'SOFT_DELETE_ACTIVATION_BIND_FAILED: %', v_result;
  END IF;
  v_result := public.mark_public_feed_write_started(
    v_operation_id, 1, v_owner_token, '${ADMIN_ID}'::uuid
  );
  IF v_result->>'resultCode' IS DISTINCT FROM 'WRITE_STARTED' THEN
    RAISE EXCEPTION 'SOFT_DELETE_ACTIVATION_WRITE_FAILED: %', v_result;
  END IF;
  v_result := public.mark_public_feed_candidate_observed(
    v_operation_id, 1, v_owner_token, '${ADMIN_ID}'::uuid, v_hash, 0
  );
  IF v_result->>'resultCode' IS DISTINCT FROM 'CANDIDATE_OBSERVED' THEN
    RAISE EXCEPTION 'SOFT_DELETE_ACTIVATION_OBSERVE_FAILED: %', v_result;
  END IF;
  v_result := public.finalize_public_feed_operation(
    v_operation_id, 1, v_owner_token, '${ADMIN_ID}'::uuid
  );
  IF v_result->>'resultCode' IS DISTINCT FROM 'DB_FINALIZED' THEN
    RAISE EXCEPTION 'SOFT_DELETE_ACTIVATION_FINALIZE_FAILED: %', v_result;
  END IF;
  v_result := public.complete_public_feed_operation(
    v_operation_id, 1, v_owner_token, '${ADMIN_ID}'::uuid, v_hash, 0
  );
  IF v_result->>'resultCode' IS DISTINCT FROM 'COMPLETED' THEN
    RAISE EXCEPTION 'SOFT_DELETE_ACTIVATION_COMPLETE_FAILED: %', v_result;
  END IF;
END
$soft_delete_activation$;
`);
}

function confirmSoftDeleteFixturePreview(publicId: string, generation: string): void {
  const tokenHash = createHash('sha256')
    .update(`upgrade-soft-delete-${publicId}-${generation}`)
    .digest('hex');
  assert.equal(
    psql(`SELECT public.generate_participant_preview('${publicId}', '${ADMIN_ID}'::uuid, '${tokenHash}', 604800, 'project-drafts-private')->>'resultCode';`),
    'SUCCESS',
    `Could not issue the ${generation} Delete61 preview for ${publicId}.`,
  );
  assert.equal(
    psql(`SELECT public.confirm_participant_preview('${tokenHash}')->>'resultCode';`),
    'SUCCESS',
    `Could not confirm the ${generation} Delete61 preview for ${publicId}.`,
  );
}

async function prepareSoftDeletePublicationFixture(
  client: SupabaseClient,
  publicId: string,
  imageBytes: Buffer,
  pdfBytes: Buffer,
): Promise<Array<{ bucket: string; key: string }>> {
  const objects = [
    {
      assetType: 'poster_image',
      fileName: 'poster.png',
      bucket: 'project-drafts-private',
      key: `drafts/${publicId}/poster_image/poster.png`,
      bytes: imageBytes,
      contentType: 'image/png',
      altText: null,
    },
    {
      assetType: 'poster_pdf',
      fileName: 'poster.pdf',
      bucket: 'project-drafts-private',
      key: `drafts/${publicId}/poster_pdf/poster.pdf`,
      bytes: pdfBytes,
      contentType: 'application/pdf',
      altText: null,
    },
  ] as const;
  for (const object of objects) {
    const uploaded = await client.storage.from(object.bucket).upload(object.key, object.bytes, {
      contentType: object.contentType,
      upsert: false,
    });
    assert.equal(uploaded.error, null, uploaded.error?.message);
  }
  psql(`
INSERT INTO public.media_assets (
  project_id, asset_type, file_name, storage_bucket, storage_path, mime_type,
  file_size_bytes, is_public_approved, alt_text_public
)
SELECT project.id, fixture.asset_type, fixture.file_name, fixture.bucket, fixture.storage_path,
       fixture.mime_type, fixture.file_size_bytes, false, fixture.alt_text_public
  FROM public.projects project
 CROSS JOIN (VALUES
   ('${objects[0].assetType}', '${objects[0].fileName}', '${objects[0].bucket}', '${objects[0].key}', '${objects[0].contentType}', ${objects[0].bytes.length}, NULL),
   ('${objects[1].assetType}', '${objects[1].fileName}', '${objects[1].bucket}', '${objects[1].key}', '${objects[1].contentType}', ${objects[1].bytes.length}, NULL)
 ) AS fixture(asset_type, file_name, bucket, storage_path, mime_type, file_size_bytes, alt_text_public)
 WHERE project.public_id='${publicId}';
`);
  confirmSoftDeleteFixturePreview(publicId, 'initial');
  return objects.map(({ bucket, key }) => ({ bucket, key }));
}

async function publishSoftDeleteFixture(
  client: SupabaseClient,
  publicId: string,
  feedBucket: string,
  feedPath: string,
): Promise<void> {
  const result = await executeControlledPublication({
    permissions: ['projects.publish'],
    publicId,
    privateBucket: 'project-drafts-private',
    publicAssetsBucket: 'project-public-assets',
    publicFeedBucket: feedBucket,
    publicFeedPath: feedPath,
    dependencies: createControlledPublicationDependencies({
      supabase: client,
      supabaseUrl: disposableApiUrl,
      publicId,
      adminId: ADMIN_ID,
      privateBucket: 'project-drafts-private',
      publicFeedBucket: feedBucket,
      publicFeedPath: feedPath,
      executionTarget: 'local',
    }),
  });
  assert.equal(result.resultCode, 'COMPLETED', JSON.stringify(result));
}

async function removeSoftDeleteFixture(
  client: SupabaseClient,
  publicId: string,
  feedBucket: string,
  feedPath: string,
): Promise<void> {
  const result = await executeControlledPublicRemoval({
    permissions: ['projects.archive'],
    publicId,
    archiveReason: `Canonical Delete61 removal for ${publicId}.`,
    dependencies: createControlledPublicRemovalDependencies({
      supabase: client,
      supabaseUrl: disposableApiUrl,
      publicId,
      adminId: ADMIN_ID,
      feedBucket,
      feedPath,
      executionTarget: 'local',
    }),
  });
  assert.equal(result.resultCode, 'COMPLETED', JSON.stringify(result));
}

async function verifyGovernedSoftDeleteRuntime(client: SupabaseClient): Promise<void> {
  const reviewerId = '3f000000-0000-4000-8000-000000000060';
  const editorId = '3f000000-0000-4000-8000-000000000061';
  const unknownActorId = '3f000000-0000-4000-8000-000000000062';
  const archivedAt = '2026-09-17T12:00:00+00';
  const removalCompletedAt = '2026-09-17T12:01:00+00';
  const softDeleteFeedBucket = 'public-feeds';
  const softDeleteFeedPath = 'upgrade-soft-delete/public-feed.json';
  const publicationFixtureIds = [
    'upgrade-delete-f3-retained',
    'upgrade-delete-prior-public',
    'upgrade-delete-two-cycles',
    'upgrade-delete-published',
    'upgrade-delete-feed-member',
    'upgrade-delete-probe-version-absent',
    'upgrade-delete-probe-version-mismatch',
  ] as const;
  const reviewerAuthUserId = await createDisposableAuthUser(client, 'upgrade-soft-delete-reviewer-auth@example.invalid');
  const editorAuthUserId = await createDisposableAuthUser(client, 'upgrade-soft-delete-editor-auth@example.invalid');
  const retainedStorageBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  );
  const retainedPdfBytes = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF', 'ascii');
  const retainedStorageObject = { bucket: 'project-drafts-private', key: 'upgrade-delete/retained.png' };
  psql(`
BEGIN;
INSERT INTO public.admin_users (id, email, full_name, auth_user_id) VALUES
  ('${reviewerId}', 'upgrade-soft-delete-reviewer@example.invalid', 'Soft Delete Reviewer', '${reviewerAuthUserId}'),
  ('${editorId}', 'upgrade-soft-delete-editor@example.invalid', 'Soft Delete Editor', '${editorAuthUserId}');
INSERT INTO public.user_roles (user_id, role) VALUES
  ('${reviewerId}', 'reviewer'), ('${editorId}', 'editor');

INSERT INTO public.projects (
  public_id, title, slug, summary, background, solution, year,
  program_id, program_name, study_program, discipline, industry, industry_partner,
  academic_supervisor, group_name, team_members, poster_text_public,
  accessibility_text_public, status, source_folder,
  pending_removal_from_public, archived_at, archived_from_status, archive_reason,
  public_removal_completed_at
)
SELECT candidate.public_id, candidate.title, candidate.public_id,
       'Synthetic Delete61 summary.', 'Synthetic Delete61 background.',
       'Synthetic Delete61 solution.', 2026, programs.id, programs.name, programs.name,
       'Software Engineering', 'Technology', 'Synthetic Partner', 'Synthetic Supervisor',
       'Synthetic Group', ARRAY['Synthetic Member'], 'Synthetic poster text.',
       'Synthetic accessible project text.',
       candidate.status, 'upgrade-soft-delete-rehearsal', candidate.pending_removal,
       CASE WHEN candidate.archived_from IS NULL THEN NULL ELSE '${archivedAt}'::timestamptz END,
       candidate.archived_from,
       CASE WHEN candidate.archived_from IS NULL THEN NULL ELSE 'Synthetic governed-delete rehearsal.' END,
       CASE WHEN candidate.public_id = 'upgrade-delete-ambiguous-removal' THEN '${removalCompletedAt}'::timestamptz ELSE NULL END
FROM (VALUES
  ('upgrade-delete-f3-retained', 'Unrelated retained F3 public record', 'approved', false, NULL::text),
  ('upgrade-delete-eligible', 'Eligible private project', 'draft', false, NULL::text),
  ('upgrade-delete-stale', 'Stale request project', 'approved', false, NULL::text),
  ('upgrade-delete-published', 'Published project', 'approved', false, NULL::text),
  ('upgrade-delete-feed-member', 'Stale lifecycle but public feed member', 'approved', false, NULL::text),
  ('upgrade-delete-pending-removal', 'Pending removal project', 'archived', true, 'published'),
  ('upgrade-delete-ambiguous-removal', 'Ambiguous prior-public project', 'archived', false, 'published'),
  ('upgrade-delete-prior-public', 'Proven removed project', 'approved', false, NULL::text),
  ('upgrade-delete-two-cycles', 'Two-cycle removed project', 'approved', false, NULL::text),
  ('upgrade-delete-no-feed-change', 'No-change removed project', 'archived', true, 'published'),
  ('upgrade-delete-probe-version-absent', 'Absent removal version probe', 'approved', false, NULL::text),
  ('upgrade-delete-probe-version-mismatch', 'Mismatched removal version probe', 'approved', false, NULL::text),
  ('upgrade-delete-pending-publication', 'Pending publication project', 'approved', false, NULL::text),
  ('upgrade-delete-audit-failure', 'Audit rollback project', 'draft', false, NULL::text),
  ('upgrade-delete-concurrent', 'Concurrent delete project', 'draft', false, NULL::text),
  ('upgrade-delete-publication-race', 'Concurrent publication project', 'approved', false, NULL::text),
  ('upgrade-delete-first-publication-race', 'Delete-first concurrent publication project', 'approved', false, NULL::text)
) AS candidate(public_id, title, status, pending_removal, archived_from)
CROSS JOIN LATERAL (SELECT id, name FROM public.programs ORDER BY name LIMIT 1) AS programs;

INSERT INTO public.project_disciplines(project_id, discipline_id)
SELECT project.id, discipline.id
  FROM public.projects project
 CROSS JOIN LATERAL (SELECT id FROM public.disciplines ORDER BY name LIMIT 1) discipline
 WHERE project.source_folder='upgrade-soft-delete-rehearsal';
INSERT INTO public.project_industry_categories(project_id, industry_category_id)
SELECT project.id, category.id
  FROM public.projects project
 CROSS JOIN LATERAL (SELECT id FROM public.industry_categories ORDER BY name LIMIT 1) category
 WHERE project.source_folder='upgrade-soft-delete-rehearsal';

INSERT INTO public.media_assets (
  project_id, asset_type, file_name, storage_bucket, storage_path, mime_type, file_size_bytes
)
SELECT id, 'poster_image', 'retained.png', 'project-drafts-private',
       'upgrade-delete/retained.png', 'image/png', ${retainedStorageBytes.length}
  FROM public.projects WHERE public_id='upgrade-delete-eligible';
INSERT INTO public.validation_flags(project_id, severity, rule_code, message)
SELECT id, 'info', 'M60_SYNTHETIC', 'Synthetic retained evidence.'
  FROM public.projects WHERE public_id='upgrade-delete-eligible';
INSERT INTO public.participant_previews(
  project_id, token_hash, snapshot, media_snapshot, status, created_by, expires_at
)
SELECT id, '${'6'.repeat(64)}', '{}'::jsonb, '[]'::jsonb, 'active', '${ADMIN_ID}',
       '${archivedAt}'::timestamptz + interval '1 day'
  FROM public.projects WHERE public_id='upgrade-delete-eligible';
INSERT INTO public.approval_records(project_id, admin_id, action_taken, from_status, to_status, comments)
SELECT id, '${ADMIN_ID}', 'update_metadata', 'draft', 'draft', 'Synthetic retained history.'
  FROM public.projects WHERE public_id='upgrade-delete-eligible';
INSERT INTO public.approval_records(
  project_id, admin_id, action_taken, from_status, to_status, comments, created_at
)
SELECT id, '${ADMIN_ID}', 'archive', 'published', 'archived', archive_reason,
       '${archivedAt}'::timestamptz
  FROM public.projects WHERE public_id='upgrade-delete-no-feed-change';
COMMIT;
`);

  activateSoftDeleteFixtureFeed(softDeleteFeedBucket, softDeleteFeedPath);
  const initialFeedUpload = await client.storage.from(softDeleteFeedBucket).upload(
    softDeleteFeedPath,
    Buffer.from('[]', 'utf8'),
    { contentType: 'application/json', upsert: false },
  );
  assert.equal(initialFeedUpload.error, null, initialFeedUpload.error?.message);

  const publicationStorageObjects = new Map<string, Array<{ bucket: string; key: string }>>();
  for (const publicId of publicationFixtureIds) {
    publicationStorageObjects.set(
      publicId,
      await prepareSoftDeletePublicationFixture(client, publicId, retainedStorageBytes, retainedPdfBytes),
    );
  }

  await publishSoftDeleteFixture(client, 'upgrade-delete-f3-retained', softDeleteFeedBucket, softDeleteFeedPath);
  await publishSoftDeleteFixture(client, 'upgrade-delete-prior-public', softDeleteFeedBucket, softDeleteFeedPath);
  await removeSoftDeleteFixture(client, 'upgrade-delete-prior-public', softDeleteFeedBucket, softDeleteFeedPath);

  await publishSoftDeleteFixture(client, 'upgrade-delete-two-cycles', softDeleteFeedBucket, softDeleteFeedPath);
  await removeSoftDeleteFixture(client, 'upgrade-delete-two-cycles', softDeleteFeedBucket, softDeleteFeedPath);
  assert.equal(
    psql(`SELECT public.perform_project_review_action('upgrade-delete-two-cycles', 'restore', 'Delete61 repeated-cycle restore.', '${ADMIN_ID}'::uuid)->>'status';`),
    'approved',
  );
  confirmSoftDeleteFixturePreview('upgrade-delete-two-cycles', 'second-cycle');
  await publishSoftDeleteFixture(client, 'upgrade-delete-two-cycles', softDeleteFeedBucket, softDeleteFeedPath);
  await removeSoftDeleteFixture(client, 'upgrade-delete-two-cycles', softDeleteFeedBucket, softDeleteFeedPath);

  await publishSoftDeleteFixture(client, 'upgrade-delete-probe-version-absent', softDeleteFeedBucket, softDeleteFeedPath);
  await removeSoftDeleteFixture(client, 'upgrade-delete-probe-version-absent', softDeleteFeedBucket, softDeleteFeedPath);
  await publishSoftDeleteFixture(client, 'upgrade-delete-probe-version-mismatch', softDeleteFeedBucket, softDeleteFeedPath);
  await removeSoftDeleteFixture(client, 'upgrade-delete-probe-version-mismatch', softDeleteFeedBucket, softDeleteFeedPath);

  // Advance the canonical head only for unrelated projects after the valid removals above.
  await publishSoftDeleteFixture(client, 'upgrade-delete-published', softDeleteFeedBucket, softDeleteFeedPath);
  await publishSoftDeleteFixture(client, 'upgrade-delete-feed-member', softDeleteFeedBucket, softDeleteFeedPath);
  psql(`UPDATE public.projects
    SET status='archived', archived_at=pg_catalog.now(), archived_from_status='approved',
        archive_reason='Synthetic current-feed contradiction.', pending_removal_from_public=false
    WHERE public_id='upgrade-delete-feed-member';`);

  await removeSoftDeleteFixture(client, 'upgrade-delete-no-feed-change', softDeleteFeedBucket, softDeleteFeedPath);

  const f3TargetPublicId = 'upgrade-delete-prior-public';
  const f3RetainedPublicId = 'upgrade-delete-f3-retained';
  assert.equal(
    psql("SELECT (item->>'disposition') || ':' || (item->>'reasonCode') FROM pg_catalog.jsonb_array_elements((public.get_project_soft_delete_preflight(ARRAY['upgrade-delete-prior-public'], '" + ADMIN_ID + "'::uuid))->'items') item;"),
    'eligible:ELIGIBLE',
    'F3 clean completed-removal control was not eligible before member-hash mutation.',
  );
  assert.equal(
    psql("SELECT count(*)::text FROM public.public_feed_operations WHERE public_id='upgrade-delete-prior-public' AND kind='removal' AND state='COMPLETED';"),
    '1',
    'F3 selected removal evidence was not a unique completed operation.',
  );
  const f3RemovalOperationId = psql("SELECT id::text FROM public.public_feed_operations WHERE public_id='upgrade-delete-prior-public' AND kind='removal' AND state='COMPLETED';");
  const f3BaselineVersionId = psql(`SELECT baseline_version_id::text FROM public.public_feed_operations WHERE id='${f3RemovalOperationId}'::uuid;`);
  const f3RemovalVersionId = psql(`SELECT id::text FROM public.public_feed_versions WHERE operation_id='${f3RemovalOperationId}'::uuid;`);
  const f3CurrentHeadVersionId = psql('SELECT current_version_id::text FROM public.public_feed_head WHERE singleton=true;');
  assert.equal(
    new Set([f3BaselineVersionId, f3RemovalVersionId, f3CurrentHeadVersionId]).size,
    3,
    'F3 baseline, selected removal, and later current-head probes did not use independent version rows.',
  );
  assert.equal(
    psql(`SELECT (headVersion.version_number > removalVersion.version_number AND head.current_version_id IS DISTINCT FROM removalVersion.id)::text
      FROM public.public_feed_head head
      JOIN public.public_feed_versions headVersion ON headVersion.id=head.current_version_id
      JOIN public.public_feed_versions removalVersion ON removalVersion.id='${f3RemovalVersionId}'::uuid
     WHERE head.singleton=true;`),
    'true',
    'F3 current head did not advance beyond the selected removal version.',
  );
  const f3ExpectedHashes = [
    javascriptRecordHashFromArtifact(psql(`SELECT artifact_content FROM public.public_feed_versions WHERE id='${f3BaselineVersionId}'::uuid;`), f3RetainedPublicId),
    javascriptRecordHashFromArtifact(psql(`SELECT artifact_content FROM public.public_feed_versions WHERE id='${f3RemovalVersionId}'::uuid;`), f3RetainedPublicId),
    javascriptRecordHashFromArtifact(psql(`SELECT artifact_content FROM public.public_feed_versions WHERE id='${f3CurrentHeadVersionId}'::uuid;`), f3RetainedPublicId),
  ];
  for (const [versionId, expectedHash] of [
    [f3BaselineVersionId, f3ExpectedHashes[0]],
    [f3RemovalVersionId, f3ExpectedHashes[1]],
    [f3CurrentHeadVersionId, f3ExpectedHashes[2]],
  ] as const) {
    assert.equal(
      psql(`SELECT record_hash FROM public.public_feed_version_members WHERE version_id='${versionId}'::uuid AND public_id='${f3RetainedPublicId}';`),
      expectedHash,
      `F3 exact JavaScript hash did not match the stored member row for ${versionId}.`,
    );
  }
  assert.equal(
    psql(`SELECT COALESCE(pg_catalog.bool_and(public.project_soft_delete_artifact_members_match(
      version.id, version.artifact_content, version.record_count
    )), false)::text FROM public.public_feed_versions version
    WHERE version.id IN ('${f3BaselineVersionId}'::uuid, '${f3RemovalVersionId}'::uuid, '${f3CurrentHeadVersionId}'::uuid);`),
    'true',
    'Normal baseline, selected-removal, or current-head artifact/member binding was rejected.',
  );
  assert.equal(
    softDeleteArtifactBindingParityProbe(f3BaselineVersionId),
    'true\nfalse\nfalse\nfalse\nfalse\nfalse',
    'The artifact/member helper did not accept Node-generated UTF-8 records or refuse malformed, oversized, and NULL inputs.',
  );
  const f3WrongHashes = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64)];
  f3WrongHashes.forEach((wrongHash, index) => assert.notEqual(wrongHash, f3ExpectedHashes[index % 3]));
  const f3ProbeResults = [
    softDeleteMemberHashProbe(f3TargetPublicId, f3RetainedPublicId, f3BaselineVersionId, f3ExpectedHashes[0], f3WrongHashes[0]),
    softDeleteMemberHashProbe(f3TargetPublicId, f3RetainedPublicId, f3RemovalVersionId, f3ExpectedHashes[1], f3WrongHashes[1]),
    softDeleteMemberHashProbe(f3TargetPublicId, f3RetainedPublicId, f3CurrentHeadVersionId, f3ExpectedHashes[2], f3WrongHashes[2]),
    softDeletePairedMemberHashProbe(
      f3TargetPublicId, f3RetainedPublicId, f3RemovalOperationId, f3BaselineVersionId, f3RemovalVersionId,
      f3ExpectedHashes[0], f3ExpectedHashes[1], f3WrongHashes[3],
    ),
  ];
  assert.deepEqual(
    f3ProbeResults,
    [
      'MUTATED\nblocked:REMOVAL_EVIDENCE_AMBIGUOUS',
      'MUTATED\nblocked:REMOVAL_EVIDENCE_AMBIGUOUS',
      'MUTATED\nblocked:REMOVAL_EVIDENCE_AMBIGUOUS',
      'MEMBERS=2\nMANIFEST=1\nblocked:REMOVAL_EVIDENCE_AMBIGUOUS',
    ],
    'F3 member-hash/artifact-binding probe did not fail closed for every corruption variant.',
  );
  assert.equal(
    psql(`SELECT count(*)::text || '|' || (SELECT count(*) FROM pg_catalog.jsonb_array_elements((SELECT candidate_members FROM public.public_feed_operations WHERE id='${f3RemovalOperationId}'::uuid)) item WHERE item->>'publicId'='${f3RetainedPublicId}' AND item->>'recordHash'='${f3ExpectedHashes[1]}') FROM public.public_feed_version_members
       WHERE (version_id='${f3BaselineVersionId}'::uuid AND public_id='${f3RetainedPublicId}' AND record_hash='${f3ExpectedHashes[0]}')
          OR (version_id='${f3RemovalVersionId}'::uuid AND public_id='${f3RetainedPublicId}' AND record_hash='${f3ExpectedHashes[1]}')
          OR (version_id='${f3CurrentHeadVersionId}'::uuid AND public_id='${f3RetainedPublicId}' AND record_hash='${f3ExpectedHashes[2]}');`),
    '3|1',
    'F3 rollback probe left persisted member or manifest-hash drift.',
  );

  const retainedUpload = await client.storage
    .from(retainedStorageObject.bucket)
    .upload(retainedStorageObject.key, retainedStorageBytes, { contentType: 'image/png', upsert: false });
  assert.equal(retainedUpload.error, null, retainedUpload.error?.message);
  const retainedStorageEvidenceBefore = await readStorageEvidence(client, [retainedStorageObject]);
  const assistiveRun = JSON.parse(psql(`SELECT public.persist_assistive_validation_run(
    (SELECT id FROM public.projects WHERE public_id='upgrade-delete-eligible'),
    '${ADMIN_ID}'::uuid, '${'7'.repeat(64)}', 'assistive-deterministic-checks/v1',
    'FAILED', 'EXTRACTION_FAILED', '[]'::jsonb
  )::text;`)) as { resultCode?: string; runId?: string };
  assert.equal(assistiveRun.resultCode, 'PERSISTED');
  assert.ok(assistiveRun.runId);

  // Bounded negative probe for the historical-removal evidence questions raised during M61
  // integration review. These fixtures are synthetic and disposable. The assertions intentionally
  // require fail-closed evidence binding and malformed-row isolation; they must not be relaxed to
  // whatever the current decision helper happens to return.
  psql(`
INSERT INTO public.projects (
  public_id, title, year, program_id, program_name, study_program, status, source_folder,
  pending_removal_from_public, archived_at, archived_from_status, archive_reason,
  public_removal_completed_at
)
SELECT candidate.public_id, candidate.title, 2026, programs.id, programs.name, programs.name,
       candidate.status, 'upgrade-soft-delete-evidence-probe', candidate.status='archived',
       CASE WHEN candidate.status='archived' THEN '${archivedAt}'::timestamptz ELSE NULL END,
       CASE WHEN candidate.status='archived' THEN 'published' ELSE NULL END,
       CASE WHEN candidate.status='archived' THEN 'Synthetic evidence-binding probe.' ELSE NULL END,
       NULL
  FROM (VALUES
    ('upgrade-delete-probe-control', 'Unrelated eligible control', 'draft'),
    ('upgrade-delete-probe-malformed', 'Malformed candidate JSON', 'archived'),
    ('upgrade-delete-probe-object', 'Object candidate JSON', 'archived'),
    ('upgrade-delete-probe-huge-ordinal', 'Huge manifest ordinal', 'archived'),
    ('upgrade-delete-probe-count', 'Contradictory candidate count', 'archived'),
    ('upgrade-delete-probe-extra-event', 'Extra terminal evidence', 'archived')
  ) AS candidate(public_id, title, status)
  CROSS JOIN LATERAL (SELECT id, name FROM public.programs ORDER BY name LIMIT 1) AS programs;

INSERT INTO public.approval_records(
  project_id, admin_id, action_taken, from_status, to_status, comments, created_at
)
SELECT project.id, '${ADMIN_ID}', 'archive', 'published', 'archived', project.archive_reason,
       '${archivedAt}'::timestamptz
  FROM public.projects project
 WHERE project.source_folder='upgrade-soft-delete-evidence-probe'
   AND project.status='archived';
`);

  for (const publicId of [
    'upgrade-delete-probe-malformed',
    'upgrade-delete-probe-object',
    'upgrade-delete-probe-huge-ordinal',
    'upgrade-delete-probe-count',
    'upgrade-delete-probe-extra-event',
  ] as const) {
    await removeSoftDeleteFixture(client, publicId, softDeleteFeedBucket, softDeleteFeedPath);
  }

  // Each negative starts as genuine completed protocol evidence. Mutate one bounded dimension only,
  // with immutable-history triggers disabled solely inside this owned disposable verifier.
  psql(`
ALTER TABLE public.public_feed_operation_events DISABLE TRIGGER reject_public_feed_event_mutation;
ALTER TABLE public.public_feed_versions DISABLE TRIGGER reject_public_feed_version_mutation;

WITH changed AS (
  UPDATE public.public_feed_operations operation
     SET candidate_feed_content='{not-json',
         candidate_byte_count=pg_catalog.octet_length('{not-json'),
         candidate_feed_hash=pg_catalog.encode(
           extensions.digest(pg_catalog.convert_to('{not-json', 'UTF8'), 'sha256'), 'hex'
         ),
         candidate_record_count=0,
         observed_storage_hash=pg_catalog.encode(
           extensions.digest(pg_catalog.convert_to('{not-json', 'UTF8'), 'sha256'), 'hex'
         ),
         observed_storage_record_count=0
    WHERE operation.public_id='upgrade-delete-probe-malformed'
      AND operation.kind='removal'
      AND operation.state='COMPLETED'
  RETURNING id, candidate_feed_hash, candidate_record_count
)
UPDATE public.public_feed_operation_events event
   SET observed_storage_hash=changed.candidate_feed_hash,
       observed_storage_record_count=changed.candidate_record_count
  FROM changed
 WHERE event.operation_id=changed.id
   AND event.observed_storage_hash IS NOT NULL;

WITH changed AS (
  UPDATE public.public_feed_operations operation
     SET candidate_feed_content='{}',
         candidate_byte_count=pg_catalog.octet_length('{}'),
         candidate_feed_hash=pg_catalog.encode(
           extensions.digest(pg_catalog.convert_to('{}', 'UTF8'), 'sha256'), 'hex'
         ),
         candidate_record_count=0,
         observed_storage_hash=pg_catalog.encode(
           extensions.digest(pg_catalog.convert_to('{}', 'UTF8'), 'sha256'), 'hex'
         ),
         observed_storage_record_count=0
    WHERE operation.public_id='upgrade-delete-probe-object'
      AND operation.kind='removal'
      AND operation.state='COMPLETED'
  RETURNING id, candidate_feed_hash, candidate_record_count
)
UPDATE public.public_feed_operation_events event
   SET observed_storage_hash=changed.candidate_feed_hash,
       observed_storage_record_count=changed.candidate_record_count
  FROM changed
 WHERE event.operation_id=changed.id
   AND event.observed_storage_hash IS NOT NULL;

WITH changed AS (
  UPDATE public.public_feed_operations operation
     SET candidate_record_count=candidate_record_count + 1,
         observed_storage_record_count=observed_storage_record_count + 1
   WHERE operation.public_id='upgrade-delete-probe-count'
     AND operation.kind='removal'
     AND operation.state='COMPLETED'
  RETURNING id, candidate_record_count
)
UPDATE public.public_feed_operation_events event
   SET observed_storage_record_count=changed.candidate_record_count
  FROM changed
 WHERE event.operation_id=changed.id
   AND event.observed_storage_record_count IS NOT NULL;

UPDATE public.public_feed_operations operation
   SET candidate_members=pg_catalog.jsonb_set(
     candidate_members, '{0,ordinal}',
     pg_catalog.to_jsonb('999999999999999999999999999999'::text)
   )
 WHERE operation.public_id='upgrade-delete-probe-huge-ordinal'
   AND operation.kind='removal'
   AND operation.state='COMPLETED';

INSERT INTO public.public_feed_operation_events(
  operation_id, sequence, from_state, to_state, actor_id, owner_epoch,
  observed_storage_hash, observed_storage_record_count, created_at
)
SELECT operation.id,
       (SELECT pg_catalog.max(event.sequence) + 1
          FROM public.public_feed_operation_events event
         WHERE event.operation_id=operation.id),
       'DB_FINALIZED', 'COMPLETED', operation.completion_actor_id, operation.owner_epoch,
       operation.observed_storage_hash, operation.observed_storage_record_count,
       operation.completed_at
  FROM public.public_feed_operations operation
 WHERE operation.public_id='upgrade-delete-probe-extra-event'
   AND operation.kind='removal'
   AND operation.state='COMPLETED';

UPDATE public.public_feed_versions version
   SET affected_public_id='different-public-id'
 WHERE version.operation_id=(
   SELECT operation.id FROM public.public_feed_operations operation
    WHERE operation.public_id='upgrade-delete-probe-version-mismatch'
      AND operation.kind='removal'
      AND operation.state='COMPLETED'
 );

WITH placeholder AS (
  INSERT INTO public.public_feed_operations(
    operation_key, kind, authorizing_actor_id, completion_actor_id, state,
    owner_token_hash, lease_expires_at, completed_at
  ) VALUES (
    pg_catalog.gen_random_uuid(), 'activation', '${ADMIN_ID}', '${ADMIN_ID}', 'COMPLETED',
    '${'8'.repeat(64)}', pg_catalog.now(), pg_catalog.now()
  ) RETURNING id
)
UPDATE public.public_feed_versions version
   SET operation_id=placeholder.id
  FROM placeholder
 WHERE version.operation_id=(
   SELECT operation.id FROM public.public_feed_operations operation
    WHERE operation.public_id='upgrade-delete-probe-version-absent'
      AND operation.kind='removal'
      AND operation.state='COMPLETED'
 );

ALTER TABLE public.public_feed_versions ENABLE TRIGGER reject_public_feed_version_mutation;
ALTER TABLE public.public_feed_operation_events ENABLE TRIGGER reject_public_feed_event_mutation;
`);

  const evidenceBindingProbe = psql(
    "SELECT pg_catalog.string_agg((item->>'publicId') || ':' || (item->>'disposition') || ':' || (item->>'reasonCode'), '|' ORDER BY ordinal)"
      + " FROM pg_catalog.jsonb_array_elements((public.get_project_soft_delete_preflight(ARRAY["
      + "'upgrade-delete-probe-control','upgrade-delete-probe-count','upgrade-delete-probe-version-absent',"
      + "'upgrade-delete-probe-version-mismatch','upgrade-delete-probe-huge-ordinal',"
      + "'upgrade-delete-probe-extra-event'], '" + ADMIN_ID
      + "'::uuid))->'items') WITH ORDINALITY AS requested(item, ordinal);",
  );
  let malformedMixedProbe = 'NO_RESULT';
  try {
    malformedMixedProbe = psql(
      "SELECT pg_catalog.string_agg((item->>'publicId') || ':' || (item->>'disposition') || ':' || (item->>'reasonCode'), '|' ORDER BY ordinal)"
        + " FROM pg_catalog.jsonb_array_elements((public.get_project_soft_delete_preflight(ARRAY["
        + "'upgrade-delete-probe-control','upgrade-delete-probe-malformed'], '" + ADMIN_ID
        + "'::uuid))->'items') WITH ORDINALITY AS requested(item, ordinal);",
    );
  } catch {
    malformedMixedProbe = 'PREFLIGHT_ABORTED_ON_MALFORMED_CANDIDATE_JSON';
  }
  assert.equal(
    evidenceBindingProbe,
    'upgrade-delete-probe-control:eligible:ELIGIBLE'
      + '|upgrade-delete-probe-count:blocked:REMOVAL_EVIDENCE_AMBIGUOUS'
      + '|upgrade-delete-probe-version-absent:blocked:REMOVAL_EVIDENCE_AMBIGUOUS'
      + '|upgrade-delete-probe-version-mismatch:blocked:REMOVAL_EVIDENCE_AMBIGUOUS'
      + '|upgrade-delete-probe-huge-ordinal:blocked:REMOVAL_EVIDENCE_AMBIGUOUS'
      + '|upgrade-delete-probe-extra-event:blocked:REMOVAL_EVIDENCE_AMBIGUOUS',
    'M61 evidence probe accepted contradictory count, absent/mismatched version binding, or extra terminal evidence.',
  );
  assert.equal(
    malformedMixedProbe,
    'upgrade-delete-probe-control:eligible:ELIGIBLE|upgrade-delete-probe-malformed:blocked:REMOVAL_EVIDENCE_AMBIGUOUS',
    'M61 malformed candidate JSON was not isolated while preserving the unrelated eligible row.',
  );
  assert.equal(
    psql("SELECT (item->>'disposition') || ':' || (item->>'reasonCode') FROM pg_catalog.jsonb_array_elements((public.get_project_soft_delete_preflight(ARRAY['upgrade-delete-probe-object'], '" + ADMIN_ID + "'::uuid))->'items') item;"),
    'blocked:REMOVAL_EVIDENCE_AMBIGUOUS',
    'M61 non-array candidate JSON did not fail closed without aborting preflight.',
  );

  assert.equal(
    psql("SELECT count(*)::text FROM public.public_feed_operations operation JOIN public.projects project ON project.id=operation.project_id WHERE project.public_id='upgrade-delete-two-cycles' AND operation.kind='removal' AND operation.state='COMPLETED';"),
    '2',
    'The repeated-history fixture did not complete two genuine removal cycles.',
  );
  assert.equal(
    psql("SELECT count(*)::text FROM public.public_feed_versions version JOIN public.projects project ON project.id=version.project_id WHERE project.public_id='upgrade-delete-two-cycles' AND version.operation='publication';"),
    '2',
    'The repeated-history fixture did not complete two genuine publication cycles.',
  );
  assert.equal(
    psql("SELECT count(*)::text FROM public.public_feed_versions version JOIN public.public_feed_operations operation ON operation.id=version.operation_id WHERE operation.public_id='upgrade-delete-no-feed-change' AND operation.kind='removal';"),
    '0',
    'The genuine no-feed-change removal wrote a fictitious version.',
  );
  assert.equal(
    psql("SELECT (head.version_number > removed.version_number)::text FROM public.public_feed_versions head CROSS JOIN public.public_feed_versions removed WHERE head.id=(SELECT current_version_id FROM public.public_feed_head WHERE singleton=true) AND removed.operation_id=(SELECT operation.id FROM public.public_feed_operations operation WHERE operation.public_id='upgrade-delete-prior-public' AND operation.kind='removal' AND operation.state='COMPLETED');"),
    'true',
    'The unrelated-newer-head fixture did not actually advance past the selected removal.',
  );

  psql(`UPDATE public.projects project
    SET public_removal_completed_at=(
      SELECT pg_catalog.min(operation.completed_at)
        FROM public.public_feed_operations operation
       WHERE operation.project_id=project.id
         AND operation.kind='removal'
         AND operation.state='COMPLETED'
    )
    WHERE project.public_id='upgrade-delete-two-cycles';`);
  assert.equal(
    psql("SELECT (item->>'disposition') || ':' || (item->>'reasonCode') FROM pg_catalog.jsonb_array_elements((public.get_project_soft_delete_preflight(ARRAY['upgrade-delete-two-cycles'], '" + ADMIN_ID + "'::uuid))->'items') item;"),
    'blocked:REMOVAL_EVIDENCE_AMBIGUOUS',
    'An older completed cycle was accepted instead of the current removal completion.',
  );
  psql(`UPDATE public.projects project
    SET public_removal_completed_at=(
      SELECT pg_catalog.max(operation.completed_at)
        FROM public.public_feed_operations operation
       WHERE operation.project_id=project.id
         AND operation.kind='removal'
         AND operation.state='COMPLETED'
    )
    WHERE project.public_id='upgrade-delete-two-cycles';`);

  assert.equal(
    psql("SELECT pg_catalog.string_agg((item->>'publicId') || ':' || (item->>'disposition') || ':' || (item->>'reasonCode'), '|' ORDER BY ordinal) FROM pg_catalog.jsonb_array_elements((public.get_project_soft_delete_preflight(ARRAY['upgrade-delete-eligible','upgrade-delete-published','upgrade-delete-pending-removal','upgrade-delete-ambiguous-removal','upgrade-delete-prior-public','upgrade-delete-no-feed-change','upgrade-delete-two-cycles'], '" + ADMIN_ID + "'::uuid))->'items') WITH ORDINALITY AS requested(item, ordinal);"),
    'upgrade-delete-eligible:eligible:ELIGIBLE|upgrade-delete-published:blocked:PUBLISHED_REQUIRES_ARCHIVE|upgrade-delete-pending-removal:blocked:REMOVAL_PENDING|upgrade-delete-ambiguous-removal:blocked:REMOVAL_EVIDENCE_AMBIGUOUS|upgrade-delete-prior-public:eligible:ELIGIBLE|upgrade-delete-no-feed-change:eligible:ELIGIBLE|upgrade-delete-two-cycles:eligible:ELIGIBLE',
    'Server-authoritative mixed preflight did not preserve order or truthful eligibility reasons.',
  );
  assert.equal(
    psql("SELECT (item->>'disposition') || ':' || (item->>'reasonCode') FROM pg_catalog.jsonb_array_elements((public.get_project_soft_delete_preflight(ARRAY['upgrade-delete-legacy-mismatch'], '" + ADMIN_ID + "'::uuid))->'items') item;"),
    'blocked:DELETE_STATE_AMBIGUOUS',
    'Migration 0061 did not fail closed on the retained legacy tombstone mismatch.',
  );

  assert.equal(
    psql("SELECT (SELECT count(*) FROM public.media_assets WHERE project_id=project.id)::text || '|' || (SELECT count(*) FROM public.validation_flags WHERE project_id=project.id)::text || '|' || (SELECT count(*) FROM public.participant_previews WHERE project_id=project.id)::text || '|' || (SELECT count(*) FROM public.approval_records WHERE project_id=project.id)::text || '|' || (SELECT count(*) FROM public.assistive_validation_runs WHERE project_id=project.id)::text FROM public.projects project WHERE public_id='upgrade-delete-eligible';"),
    '1|1|1|1|1',
  );
  assert.equal(softDeleteCode('upgrade-delete-eligible', "(SELECT updated_at FROM public.projects WHERE public_id='upgrade-delete-eligible')"), 'DELETED');
  assert.equal(
    psql("SELECT status || '|' || (deleted_at IS NOT NULL)::text || '|' || (SELECT count(*) FROM public.media_assets WHERE project_id=project.id)::text || '|' || (SELECT count(*) FROM public.validation_flags WHERE project_id=project.id)::text || '|' || (SELECT count(*) FROM public.participant_previews WHERE project_id=project.id)::text || '|' || (SELECT count(*) FROM public.approval_records WHERE project_id=project.id)::text || '|' || (SELECT count(*) FROM public.assistive_validation_runs WHERE project_id=project.id)::text FROM public.projects project WHERE public_id='upgrade-delete-eligible';"),
    'deleted|true|1|1|1|2|1',
    'Soft delete failed to preserve the row, assets, participant evidence, validation evidence, or audit history.',
  );
  assert.deepEqual(
    await readStorageEvidence(client, [retainedStorageObject]),
    retainedStorageEvidenceBefore,
    'Soft delete changed or removed the linked private Storage object.',
  );
  assert.equal(softDeleteCode('upgrade-delete-eligible', "(SELECT updated_at FROM public.projects WHERE public_id='upgrade-delete-eligible')"), 'ALREADY_DELETED');
  assert.equal(psql("SELECT count(*)::text FROM public.approval_records audit JOIN public.projects project ON project.id=audit.project_id WHERE project.public_id='upgrade-delete-eligible' AND audit.action_taken='soft_delete';"), '1');

  assert.equal(softDeleteCode('upgrade-delete-stale', "'2000-01-01T00:00:00Z'::timestamptz"), 'STALE_VERSION');
  assert.equal(softDeleteCode('upgrade-delete-published', "(SELECT updated_at FROM public.projects WHERE public_id='upgrade-delete-published')"), 'PUBLISHED_REQUIRES_ARCHIVE');
  assert.equal(softDeleteCode('upgrade-delete-feed-member', "(SELECT updated_at FROM public.projects WHERE public_id='upgrade-delete-feed-member')"), 'CURRENTLY_PUBLIC');
  assert.equal(softDeleteCode('upgrade-delete-pending-removal', "(SELECT updated_at FROM public.projects WHERE public_id='upgrade-delete-pending-removal')"), 'REMOVAL_PENDING');
  assert.equal(softDeleteCode('upgrade-delete-ambiguous-removal', "(SELECT updated_at FROM public.projects WHERE public_id='upgrade-delete-ambiguous-removal')"), 'REMOVAL_EVIDENCE_AMBIGUOUS');

  for (const actorId of [reviewerId, editorId, unknownActorId]) {
    for (const invoke of [
      () => softDeleteCode('upgrade-delete-stale', "(SELECT updated_at FROM public.projects WHERE public_id='upgrade-delete-stale')", actorId),
      () => psql(`SELECT public.get_project_soft_delete_preflight(ARRAY['upgrade-delete-stale'], '${actorId}'::uuid);`),
    ]) {
      let denied = false;
      try {
        invoke();
      } catch {
        denied = true;
      }
      assert.equal(denied, true, `Unauthorized actor ${actorId} reached a governed soft-delete authority.`);
    }
  }

  psql(`INSERT INTO public.public_feed_operations(
    operation_key, kind, publication_mode, authorizing_actor_id, project_id, public_id,
    state, owner_token_hash, lease_expires_at
  ) SELECT pg_catalog.gen_random_uuid(), 'publication', 'normal', '${ADMIN_ID}', id, public_id,
           'RESERVED', '${'c'.repeat(64)}', pg_catalog.now() + interval '2 minutes'
      FROM public.projects WHERE public_id='upgrade-delete-pending-publication';`);
  assert.equal(softDeleteCode('upgrade-delete-pending-publication', "(SELECT updated_at FROM public.projects WHERE public_id='upgrade-delete-pending-publication')"), 'PUBLICATION_OR_REMOVAL_PENDING');
  psql("UPDATE public.public_feed_operations SET state='RECOVERY_REQUIRED', failure_code='SYNTHETIC_RECOVERY_REQUIRED' WHERE public_id='upgrade-delete-pending-publication' AND state='RESERVED';");
  assert.equal(softDeleteCode('upgrade-delete-pending-publication', "(SELECT updated_at FROM public.projects WHERE public_id='upgrade-delete-pending-publication')"), 'PUBLICATION_OR_REMOVAL_PENDING');
  psql("DELETE FROM public.public_feed_operations WHERE public_id='upgrade-delete-pending-publication' AND state='RECOVERY_REQUIRED';");

  const priorPublicPrivateObjects = publicationStorageObjects.get('upgrade-delete-prior-public');
  const twoCyclePrivateObjects = publicationStorageObjects.get('upgrade-delete-two-cycles');
  assert.ok(priorPublicPrivateObjects);
  assert.ok(twoCyclePrivateObjects);
  const retainedPublicationObjects = [
    ...priorPublicPrivateObjects,
    { bucket: 'project-public-assets', key: 'published/upgrade-delete-prior-public/poster_image/poster.png' },
    { bucket: 'project-public-assets', key: 'published/upgrade-delete-prior-public/poster_pdf/poster.pdf' },
    ...twoCyclePrivateObjects,
    { bucket: 'project-public-assets', key: 'published/upgrade-delete-two-cycles/poster_image/poster.png' },
    { bucket: 'project-public-assets', key: 'published/upgrade-delete-two-cycles/poster_pdf/poster.pdf' },
  ];
  const retainedPublicationStorageBefore = await readStorageEvidence(client, retainedPublicationObjects);
  const priorPublicHistoryBefore = psql("SELECT (SELECT count(*) FROM public.public_feed_operations operation WHERE operation.project_id=project.id)::text || '|' || (SELECT count(*) FROM public.public_feed_versions version WHERE version.project_id=project.id)::text || '|' || (SELECT count(*) FROM public.public_feed_operation_events event JOIN public.public_feed_operations operation ON operation.id=event.operation_id WHERE operation.project_id=project.id)::text || '|' || (SELECT count(*) FROM public.media_assets media WHERE media.project_id=project.id)::text || '|' || (SELECT count(*) FROM public.participant_previews preview WHERE preview.project_id=project.id)::text FROM public.projects project WHERE public_id='upgrade-delete-prior-public';");
  const twoCycleHistoryBefore = psql("SELECT (SELECT count(*) FROM public.public_feed_operations operation WHERE operation.project_id=project.id)::text || '|' || (SELECT count(*) FROM public.public_feed_versions version WHERE version.project_id=project.id)::text || '|' || (SELECT count(*) FROM public.public_feed_operation_events event JOIN public.public_feed_operations operation ON operation.id=event.operation_id WHERE operation.project_id=project.id)::text || '|' || (SELECT count(*) FROM public.media_assets media WHERE media.project_id=project.id)::text || '|' || (SELECT count(*) FROM public.participant_previews preview WHERE preview.project_id=project.id)::text FROM public.projects project WHERE public_id='upgrade-delete-two-cycles';");

  assert.equal(softDeleteCode('upgrade-delete-prior-public', "(SELECT updated_at FROM public.projects WHERE public_id='upgrade-delete-prior-public')"), 'DELETED');
  assert.equal(softDeleteCode('upgrade-delete-no-feed-change', "(SELECT updated_at FROM public.projects WHERE public_id='upgrade-delete-no-feed-change')"), 'DELETED');
  assert.equal(softDeleteCode('upgrade-delete-two-cycles', "(SELECT updated_at FROM public.projects WHERE public_id='upgrade-delete-two-cycles')"), 'DELETED');
  assert.equal(
    psql("SELECT (SELECT count(*) FROM public.public_feed_operations operation WHERE operation.project_id=project.id)::text || '|' || (SELECT count(*) FROM public.public_feed_versions version WHERE version.project_id=project.id)::text || '|' || (SELECT count(*) FROM public.public_feed_operation_events event JOIN public.public_feed_operations operation ON operation.id=event.operation_id WHERE operation.project_id=project.id)::text || '|' || (SELECT count(*) FROM public.media_assets media WHERE media.project_id=project.id)::text || '|' || (SELECT count(*) FROM public.participant_previews preview WHERE preview.project_id=project.id)::text FROM public.projects project WHERE public_id='upgrade-delete-prior-public';"),
    priorPublicHistoryBefore,
    'Feed-changing soft delete changed retained history, media, or participant evidence.',
  );
  assert.equal(
    psql("SELECT (SELECT count(*) FROM public.public_feed_operations operation WHERE operation.project_id=project.id)::text || '|' || (SELECT count(*) FROM public.public_feed_versions version WHERE version.project_id=project.id)::text || '|' || (SELECT count(*) FROM public.public_feed_operation_events event JOIN public.public_feed_operations operation ON operation.id=event.operation_id WHERE operation.project_id=project.id)::text || '|' || (SELECT count(*) FROM public.media_assets media WHERE media.project_id=project.id)::text || '|' || (SELECT count(*) FROM public.participant_previews preview WHERE preview.project_id=project.id)::text FROM public.projects project WHERE public_id='upgrade-delete-two-cycles';"),
    twoCycleHistoryBefore,
    'Repeated-cycle soft delete changed retained history, media, or participant evidence.',
  );
  assert.deepEqual(
    await readStorageEvidence(client, retainedPublicationObjects),
    retainedPublicationStorageBefore,
    'Previously public soft delete changed retained private or public Storage objects.',
  );
  assert.equal(softDeleteCode('upgrade-delete-prior-public', "(SELECT updated_at FROM public.projects WHERE public_id='upgrade-delete-prior-public')"), 'ALREADY_DELETED');
  assert.equal(
    psql("SELECT count(*)::text FROM public.approval_records audit JOIN public.projects project ON project.id=audit.project_id WHERE project.public_id='upgrade-delete-prior-public' AND audit.action_taken='soft_delete';"),
    '1',
    'Repeated previously-public delete created more than one audit record.',
  );

  psql(`CREATE FUNCTION public.reject_upgrade_soft_delete_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.action_taken='soft_delete' THEN RAISE EXCEPTION 'SYNTHETIC_SOFT_DELETE_AUDIT_FAILURE'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reject_upgrade_soft_delete_audit BEFORE INSERT ON public.approval_records
FOR EACH ROW EXECUTE FUNCTION public.reject_upgrade_soft_delete_audit();`);
  let auditFailureRejected = false;
  try {
    softDeleteCode('upgrade-delete-audit-failure', "(SELECT updated_at FROM public.projects WHERE public_id='upgrade-delete-audit-failure')");
  } catch {
    auditFailureRejected = true;
  } finally {
    psql('DROP TRIGGER reject_upgrade_soft_delete_audit ON public.approval_records; DROP FUNCTION public.reject_upgrade_soft_delete_audit();');
  }
  assert.equal(auditFailureRejected, true, 'Synthetic audit failure did not abort soft delete.');
  assert.equal(psql("SELECT status || '|' || (deleted_at IS NULL)::text FROM public.projects WHERE public_id='upgrade-delete-audit-failure';"), 'draft|true');

  const concurrentDelete = await Promise.all([
    client.rpc('soft_delete_project_if_current', {
      p_public_id: 'upgrade-delete-concurrent',
      p_expected_updated_at: psql("SELECT updated_at::text FROM public.projects WHERE public_id='upgrade-delete-concurrent';"),
      p_admin_id: ADMIN_ID,
    }),
    client.rpc('soft_delete_project_if_current', {
      p_public_id: 'upgrade-delete-concurrent',
      p_expected_updated_at: psql("SELECT updated_at::text FROM public.projects WHERE public_id='upgrade-delete-concurrent';"),
      p_admin_id: ADMIN_ID,
    }),
  ]);
  assert.equal(concurrentDelete.filter((result) => result.data?.resultCode === 'DELETED').length, 1);
  assert.equal(concurrentDelete.filter((result) => result.data?.resultCode === 'ALREADY_DELETED').length, 1);
  assert.equal(psql("SELECT count(*)::text FROM public.approval_records audit JOIN public.projects project ON project.id=audit.project_id WHERE project.public_id='upgrade-delete-concurrent' AND audit.action_taken='soft_delete';"), '1');

  let auditMutationRejected = false;
  try {
    psql("UPDATE public.approval_records SET comments='tampered' WHERE action_taken='soft_delete' AND project_id=(SELECT id FROM public.projects WHERE public_id='upgrade-delete-eligible');");
  } catch {
    auditMutationRejected = true;
  }
  assert.equal(auditMutationRejected, true, 'Soft-delete audit evidence was mutable.');

  let physicalDeleteRejected = false;
  try {
    psql("DELETE FROM public.projects WHERE public_id='upgrade-delete-eligible';");
  } catch {
    physicalDeleteRejected = true;
  }
  assert.equal(physicalDeleteRejected, true, 'A tombstoned project with immutable soft-delete audit evidence was physically deleted.');
  assert.equal(
    psql("SELECT status || '|' || (deleted_at IS NOT NULL)::text FROM public.projects WHERE public_id='upgrade-delete-eligible';"),
    'deleted|true',
    'The rejected physical delete changed or removed the tombstoned project.',
  );

  for (const action of ['restore', 'approve'] as const) {
    let rejected = false;
    try {
      psql(`SELECT public.perform_project_review_action('upgrade-delete-eligible', '${action}', NULL, '${ADMIN_ID}'::uuid);`);
    } catch {
      rejected = true;
    }
    assert.equal(rejected, true, `Deleted project accepted ${action}.`);
  }
  assert.notEqual(
    psql(`SELECT public.get_project_publication_readiness('upgrade-delete-eligible', '${ADMIN_ID}'::uuid, 'project-drafts-private')->>'resultCode';`),
    'READY',
    'Deleted project remained publishable.',
  );
  assert.equal(
    psql(`SELECT public.update_project_metadata(
      'upgrade-delete-eligible', 'Tampered', 'Tampered summary', 'Background', 'Solution', 2026,
      (SELECT id FROM public.programs ORDER BY name LIMIT 1),
      ARRAY[(SELECT id FROM public.disciplines ORDER BY name LIMIT 1)]::uuid[],
      ARRAY[(SELECT id FROM public.industry_categories ORDER BY name LIMIT 1)]::uuid[],
      (SELECT updated_at FROM public.projects WHERE public_id='upgrade-delete-eligible'),
      '${ADMIN_ID}'::uuid, 'Accessible poster text', 'Accessible project text'
    )->>'resultCode';`),
    'PROJECT_NOT_FOUND',
    'Deleted project remained editable.',
  );
  assert.equal(
    psql("SELECT title FROM public.projects WHERE public_id='upgrade-delete-eligible';"),
    'Eligible private project',
    'Rejected edit still changed the deleted project.',
  );

  psql(`CREATE FUNCTION public.begin_synthetic_publication(p_project_id uuid, p_admin_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_operation_id uuid;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('public_feed_canonical_writer'));
  INSERT INTO public.public_feed_operations(
    operation_key, kind, publication_mode, authorizing_actor_id, project_id, public_id,
    state, owner_token_hash, lease_expires_at
  ) SELECT pg_catalog.gen_random_uuid(), 'publication', 'normal', p_admin_id, project.id,
           project.public_id, 'RESERVED', '${'e'.repeat(64)}', pg_catalog.now()+interval '2 minutes'
      FROM public.projects project
     WHERE project.id=p_project_id AND project.status='approved' AND project.deleted_at IS NULL
  RETURNING id INTO v_operation_id;
  PERFORM pg_catalog.pg_sleep(1);
  RETURN v_operation_id;
END;
$$;
REVOKE ALL ON FUNCTION public.begin_synthetic_publication(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_synthetic_publication(uuid,uuid) TO service_role;

CREATE FUNCTION public.soft_delete_then_pause(p_public_id text, p_expected_updated_at timestamptz, p_admin_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_result jsonb;
BEGIN
  v_result := public.soft_delete_project_if_current(p_public_id, p_expected_updated_at, p_admin_id);
  PERFORM pg_catalog.pg_sleep(1);
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.soft_delete_then_pause(text,timestamptz,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.soft_delete_then_pause(text,timestamptz,uuid) TO service_role;`);
  const publicationPromise = Promise.resolve(client.rpc('begin_synthetic_publication', {
    p_project_id: psql("SELECT id::text FROM public.projects WHERE public_id='upgrade-delete-publication-race';"),
    p_admin_id: ADMIN_ID,
  }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  const deletePromise = Promise.resolve(client.rpc('soft_delete_project_if_current', {
    p_public_id: 'upgrade-delete-publication-race',
    p_expected_updated_at: psql("SELECT updated_at::text FROM public.projects WHERE public_id='upgrade-delete-publication-race';"),
    p_admin_id: ADMIN_ID,
  }));
  const [publication, deletion] = await Promise.all([publicationPromise, deletePromise]);
  assert.equal(publication.error, null, publication.error?.message);
  assert.equal(deletion.error, null, deletion.error?.message);
  assert.equal(deletion.data?.resultCode, 'PUBLICATION_OR_REMOVAL_PENDING');
  assert.equal(psql("SELECT status FROM public.projects WHERE public_id='upgrade-delete-publication-race';"), 'approved');
  psql("DELETE FROM public.public_feed_operations WHERE public_id='upgrade-delete-publication-race' AND state='RESERVED';");

  const deleteFirstPromise = Promise.resolve(client.rpc('soft_delete_then_pause', {
    p_public_id: 'upgrade-delete-first-publication-race',
    p_expected_updated_at: psql("SELECT updated_at::text FROM public.projects WHERE public_id='upgrade-delete-first-publication-race';"),
    p_admin_id: ADMIN_ID,
  }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  const publicationSecondPromise = Promise.resolve(client.rpc('begin_synthetic_publication', {
    p_project_id: psql("SELECT id::text FROM public.projects WHERE public_id='upgrade-delete-first-publication-race';"),
    p_admin_id: ADMIN_ID,
  }));
  const [deleteFirst, publicationSecond] = await Promise.all([deleteFirstPromise, publicationSecondPromise]);
  assert.equal(deleteFirst.error, null, deleteFirst.error?.message);
  assert.equal(publicationSecond.error, null, publicationSecond.error?.message);
  assert.equal(deleteFirst.data?.resultCode, 'DELETED');
  assert.equal(publicationSecond.data, null, 'A publication operation was reserved after the project was soft-deleted.');
  assert.equal(
    psql("SELECT status || '|' || count(operation.id)::text FROM public.projects project LEFT JOIN public.public_feed_operations operation ON operation.project_id=project.id WHERE project.public_id='upgrade-delete-first-publication-race' GROUP BY project.status;"),
    'deleted|0',
  );
  psql('DROP FUNCTION public.soft_delete_then_pause(text,timestamptz,uuid); DROP FUNCTION public.begin_synthetic_publication(uuid,uuid);');

  console.log('PASS: soft-delete runtime covers genuine changed/no-change and repeated removal history, unrelated newer heads, malformed/contradictory mixed preflight, feed and pending/recovery blockers, active-admin authority, idempotency, immutable audit, retained database/Storage evidence, lifecycle exclusion, physical-delete refusal, legacy mismatch refusal, and both publication/delete lock orderings');
}



async function verifyUpgrade(workdir: string, networkId: string): Promise<void> {
  assertBaseline();
  seedBaselineEvidence();
  const storageClient = localStorageClient(workdir);
  const storageObjects = await seedStorageEvidence(storageClient);

  const baselineGate4Errors = gate4ContractErrors();
  assert.ok(
    baselineGate4Errors.length > 0,
    'The current 58-migration Gate 4 contract accepted a 48-migration source; the pre-upgrade capture refusal is not real.',
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

  // Migration 0058 adds one nullable participant-preview column plus two new layout-recipe tables.
  // Fingerprint the retained pre-0058 tables while excluding participant_previews, whose historical
  // columns are compared separately so the additive NULL column cannot mask row drift.
  const current57Tables = fingerprintTables(CURRENT_57_TABLES.filter((table) => table !== 'public.participant_previews'));
  const participantPreviewsBefore58 = historicalParticipantPreviewFingerprint();
  const publicTableGrantsBefore58 = publicTableGrants();
  const untrustedRoutineGrantsBefore58 = untrustedRoutineExecuteGrants();
  applyRelease(workdir, networkId, 58);
  assertAfter58(current57Tables, participantPreviewsBefore58, publicTableGrantsBefore58, untrustedRoutineGrantsBefore58);
  await assertStorageUnchanged(storageClient, baseline, 'Migration 0058');

  linkSyntheticAdminIdentity();
  const current58Tables = fingerprintTables(CURRENT_58_TABLES);
  const publicTableGrantsBefore59 = publicTableGrants();
  const untrustedRoutineGrantsBefore59 = untrustedRoutineExecuteGrants();
  const reviewDefinitionBefore59 = routineDefinition(
    'perform_project_review_action',
    'p_public_id text, p_action text, p_comments text, p_admin_id uuid',
  );
  applyRelease(workdir, networkId, 59);
  assertAfter59(current58Tables, publicTableGrantsBefore59, untrustedRoutineGrantsBefore59, reviewDefinitionBefore59);
  await assertStorageUnchanged(storageClient, baseline, 'Migration 0059');

  const current59Tables = fingerprintTables(CURRENT_58_TABLES);
  const activationGenerationBeforeFixture = Number(psql(
    'SELECT generation::text FROM public.public_feed_activation_authority WHERE singleton=true;',
  ));
  assert.equal(
    psql("SELECT COALESCE(active_activation_operation_id::text, '') FROM public.public_feed_activation_authority WHERE singleton=true;"),
    '',
    'Pre-fixture public-feed activation authority is unexpectedly claimed.',
  );
  const retainedBaseline = await seedAlreadyRestoredRepublishReconciliation(storageClient);
  assert.ok(
    Number(psql('SELECT generation::text FROM public.public_feed_activation_authority WHERE singleton=true;'))
      > activationGenerationBeforeFixture,
    'Published reconciliation fixture did not advance public-feed activation authority.',
  );
  assert.equal(
    psql("SELECT COALESCE(active_activation_operation_id::text, '') FROM public.public_feed_activation_authority WHERE singleton=true;"),
    '',
    'Published reconciliation fixture left public-feed activation authority claimed.',
  );
  // The fixture adds one known feed object before M60; retain the original sentinel evidence too.
  const storageBefore60: BaselineEvidence = {
    ...baseline,
    storageObjects: [...baseline.storageObjects, {
      bucket: publicFeedBucket, key: publicationFeedPath, ...byteEvidence(retainedBaseline.bytes),
    }].sort((left, right) =>
      left.bucket.localeCompare(right.bucket) || left.key.localeCompare(right.key)),
    storageRows: tableFingerprint('storage.objects'),
  };
  await assertStorageUnchanged(storageClient, storageBefore60, 'Migration 0059 reconciliation fixture');
  const current59NonMediaTables = fingerprintTables(CURRENT_59_TABLES_FINGERPRINTED_BEFORE_M60);
  const preservedMediaBefore60 = mediaRearmPreservedFingerprint();
  const preservedPreviewsBefore60 = previewRearmPreservedFingerprint();
  const untouchedProjectionAuthorityBefore60 = untouchedProjectProjectionAuthorityFingerprint();
  const eligibleProjectionGenerationBefore60 = Number(psql(
    "SELECT authority.generation::text"
    + ' FROM public.public_feed_project_projection_authority authority'
    + ' JOIN public.projects project ON project.id=authority.project_id'
    + " WHERE project.public_id='upgrade-reconcile-eligible';",
  ));
  const publicTableGrantsBefore60 = publicTableGrants();
  const untrustedRoutineGrantsBefore60 = untrustedRoutineExecuteGrants();
  const reviewDefinitionBefore60 = routineDefinition(
    'perform_project_review_action',
    'p_public_id text, p_action text, p_comments text, p_admin_id uuid',
  );
  applyRelease(workdir, networkId, 60);
  assertAfter60(
    current59NonMediaTables,
    preservedMediaBefore60,
    preservedPreviewsBefore60,
    untouchedProjectionAuthorityBefore60,
    eligibleProjectionGenerationBefore60,
    publicTableGrantsBefore60,
    untrustedRoutineGrantsBefore60,
    reviewDefinitionBefore60,
  );
  await assertStorageUnchanged(storageClient, storageBefore60, 'Migration 0060');
  verifyAlreadyRestoredRepublishReconciliation();
  await verifyReconciliationLockRaces();
  await verifyArchivedRestoreRuntime(storageClient, retainedBaseline, activationGenerationBeforeFixture);
  await assertStorageUnchanged(storageClient, baseline, 'Migration 0060 restore-runtime cleanup');
  assertTablesUnchanged(current59Tables, 'Migration 0060 restore-runtime cleanup');
  psql(`INSERT INTO public.projects (public_id, title, year, program_id, program_name, study_program, status, source_folder, deleted_at) SELECT 'upgrade-delete-legacy-mismatch', 'Legacy mismatched tombstone', 2026, programs.id, programs.name, programs.name, 'draft', 'upgrade-soft-delete-legacy', '2026-09-17T11:59:00+00'::timestamptz FROM public.programs programs ORDER BY programs.name LIMIT 1;`);
  assert.equal(
    psql("SELECT status || '|' || (deleted_at IS NOT NULL)::text FROM public.projects WHERE public_id='upgrade-delete-legacy-mismatch';"),
    'draft|true',
    'Migration 0060 legacy mismatch fixture was not seeded with its expected state.',
  );

  const current60Tables = fingerprintTables(CURRENT_58_TABLES);
  const publicTableGrantsBefore61 = publicTableGrants();
  const untrustedRoutineGrantsBefore61 = untrustedRoutineExecuteGrants();
  applyRelease(workdir, networkId, 61);
  assertAfter61(current60Tables, publicTableGrantsBefore61, untrustedRoutineGrantsBefore61);
  await assertStorageUnchanged(storageClient, baseline, 'Migration 0061');
  await verifyGovernedSoftDeleteRuntime(storageClient);

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
    console.log(`DISPOSABLE_RUNTIME_ID=${projectId}; API_URL=${disposableApiUrl}`);
    networkId = docker([
      'network', 'create', '--opt', 'com.docker.network.bridge.host_binding_ipv4=127.0.0.1', networkName,
    ]);
    startAttempted = true;
    runSupabase('start', workdir, networkId);
    await verifyUpgrade(workdir, networkId);
    console.log('PASS: staging migration 0048 -> 0061 upgrade rehearsal');
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
    let residueInspectionSucceeded = true;
    try {
      residue = [
        ...docker(['ps', '-aq', '--filter', `label=com.supabase.cli.project=${projectId}`]).split(/\r?\n/).filter(Boolean),
        ...docker(['volume', 'ls', '-q', '--filter', `label=com.supabase.cli.project=${projectId}`]).split(/\r?\n/).filter(Boolean),
        ...docker(['network', 'ls', '--filter', `name=${networkName}`, '--format', '{{.Name}}']).split(/\r?\n/).filter(Boolean),
      ];
    } catch {
      console.error('Disposable upgrade residue inspection failed.');
      exitCode = 1;
      residueInspectionSucceeded = false;
    }
    if (!residueInspectionSucceeded) {
      console.error('Disposable upgrade cleanup status unproven.');
    } else if (residue.length > 0 || fs.existsSync(workdir)) {
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
