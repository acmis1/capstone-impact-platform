import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Real PostgreSQL 17 privilege proof for Migration 0048.
 *
 * Local Supabase is pinned to PostgreSQL 15, which has no MAINTAIN privilege at all, so the Local
 * migration path can only prove that the migration parses and is inert there. The behaviour that
 * actually matters - that replaying the historical `GRANT ALL` statements on PostgreSQL 17 widens
 * service_role by MAINTAIN, and that Migration 0048 removes exactly that one privilege - can only
 * be proven by a real PostgreSQL 17 server evaluating its own ACLs.
 *
 * This verifier owns a throwaway PostgreSQL 17 container outright: its own image, its own Docker
 * network, no published port, no application data, and synthetic roles and tables only. It never
 * contacts hosted Supabase, the canonical Local stack, or any other service, and it removes the
 * container, its anonymous volume and its network before exiting.
 *
 * Nothing here is mocked. Every privilege assertion is answered by PostgreSQL 17's own
 * `has_table_privilege` against the ACLs the server itself maintains.
 */

const IMAGE = 'postgres:17-alpine';
const MIGRATION_FILENAME = '20260831090000_postgres17_maintain_privilege_alignment.sql';

/** The five tables whose historical `GRANT ALL ... TO service_role` the migration aligns. */
const ALIGNED_TABLES = [
  'browser_import_commits',
  'browser_import_media_commits',
  'participant_previews',
  'participant_preview_confirmations',
  'participant_preview_correction_requests',
] as const;

/**
 * A sixth table that also receives `GRANT ALL` but is deliberately outside the migration's list.
 * It must keep MAINTAIN afterwards, which is what proves the migration targets exactly five tables
 * rather than every table service_role can reach.
 */
const UNTARGETED_TABLE = 'untargeted_grant_all_control';

/** A second grantee on an aligned table. It must keep MAINTAIN, proving only service_role changes. */
const BYSTANDER_ROLE = 'synthetic_bystander_role';

/** PostgreSQL 15 grants exactly these seven privileges for `GRANT ALL` on a table. */
const PRESERVED_PRIVILEGES = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
] as const;

const ALL_PRIVILEGES = [...PRESERVED_PRIVILEGES, 'MAINTAIN'] as const;

const DOCKER_TIMEOUT_MS = 120_000;
const IMAGE_PULL_TIMEOUT_MS = 600_000;
const PSQL_TIMEOUT_MS = 60_000;
const READINESS_TIMEOUT_MS = 120_000;

const suffix = crypto.randomBytes(4).toString('hex');
const containerName = `capstone-pp1-pg17-maintain-${suffix}`;
const networkName = `${containerName}-net`;
const repositoryRoot = path.resolve(__dirname, '../../../..');
const migrationPath = path.join(repositoryRoot, 'infra/supabase/migrations', MIGRATION_FILENAME);

type PrivilegeMatrix = Record<string, Record<string, boolean>>;

function docker(args: string[], options: { allowFailure?: boolean; timeoutMs?: number } = {}): string {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeoutMs ?? DOCKER_TIMEOUT_MS,
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`docker ${args[0]} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return (result.stdout ?? '').trim();
}

function psql(sql: string): string {
  return execFileSync(
    'docker',
    [
      'exec', '-i', containerName,
      'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: PSQL_TIMEOUT_MS },
  ).trim();
}

/** Runs a whole SQL file through psql exactly as written, with no repository-side rewriting. */
function psqlFile(sql: string): string {
  return execFileSync(
    'docker',
    [
      'exec', '-i', containerName,
      'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-f', '-',
    ],
    { encoding: 'utf8', input: sql, stdio: ['pipe', 'pipe', 'pipe'], timeout: PSQL_TIMEOUT_MS },
  ).trim();
}

function sleepMilliseconds(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function waitForReadiness(): void {
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  for (;;) {
    const probe = spawnSync(
      'docker',
      ['exec', containerName, 'pg_isready', '-U', 'postgres', '-d', 'postgres'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 },
    );
    if (probe.status === 0) return;
    if (Date.now() > deadline) {
      const logs = docker(['logs', '--tail', '20', containerName], { allowFailure: true });
      throw new Error(`Disposable PostgreSQL 17 container never became ready: ${logs}`);
    }
    sleepMilliseconds(1_000);
  }
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Asks PostgreSQL itself which privileges a role holds on each relation. */
function privilegeMatrix(role: string, tables: readonly string[]): PrivilegeMatrix {
  const tableValues = tables.map((table) => `(${quote(table)})`).join(', ');
  const privilegeValues = ALL_PRIVILEGES.map((privilege) => `(${quote(privilege)})`).join(', ');
  const raw = psql(
    'SELECT pg_catalog.string_agg('
    + `t.name || '|' || p.name || '|' || pg_catalog.has_table_privilege(${quote(role)}, 'public.' || t.name, p.name)::text,`
    + " chr(10) ORDER BY t.name, p.name)"
    + ` FROM (VALUES ${tableValues}) AS t(name), (VALUES ${privilegeValues}) AS p(name);`,
  );
  const matrix: PrivilegeMatrix = {};
  for (const line of raw.split('\n').filter(Boolean)) {
    const [table, privilege, held] = line.split('|');
    matrix[table] = matrix[table] ?? {};
    matrix[table][privilege] = held === 'true';
  }
  return matrix;
}

/** Direct catalog membership read, so a REVOKE could never be mistaken for a role-membership change. */
function pgMaintainMembers(): string {
  return psql(
    "SELECT COALESCE(pg_catalog.string_agg(member.rolname, ',' ORDER BY member.rolname), 'NONE')"
    + ' FROM pg_catalog.pg_auth_members AS membership'
    + ' JOIN pg_catalog.pg_roles AS granted ON granted.oid = membership.roleid'
    + ' JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member'
    + " WHERE granted.rolname = 'pg_maintain';",
  );
}

/** The complete ACL of every synthetic table, so any unintended privilege change is visible. */
function relationAcls(): string {
  return psql(
    'SELECT pg_catalog.string_agg('
    + "relation.relname || '=' || COALESCE(relation.relacl::text, 'DEFAULT'), chr(10) ORDER BY relation.relname)"
    + ' FROM pg_catalog.pg_class AS relation'
    + ' JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace'
    + " WHERE namespace.nspname = 'public' AND relation.relkind = 'r';",
  );
}

function reportMatrix(label: string, matrix: PrivilegeMatrix): void {
  console.log(`--- ${label} ---`);
  for (const table of Object.keys(matrix).sort()) {
    const held = ALL_PRIVILEGES.map((privilege) => `${privilege}=${matrix[table][privilege]}`).join(' ');
    console.log(`  public.${table}: ${held}`);
  }
}

function dockerVolumes(): string[] {
  return docker(['volume', 'ls', '-q'], { allowFailure: true }).split('\n').filter(Boolean).sort();
}

function cleanup(baselineVolumes: readonly string[]): {
  containers: string;
  networks: string;
  leakedVolumes: string[];
} {
  docker(['rm', '-f', '-v', containerName], { allowFailure: true });
  docker(['network', 'rm', networkName], { allowFailure: true });
  const baseline = new Set(baselineVolumes);
  return {
    containers: docker(['ps', '-a', '--filter', `name=${containerName}`, '--format', '{{.Names}}'], { allowFailure: true }),
    networks: docker(['network', 'ls', '--filter', `name=${networkName}`, '--format', '{{.Name}}'], { allowFailure: true }),
    leakedVolumes: dockerVolumes().filter((volume) => !baseline.has(volume)),
  };
}

function main(): void {
  console.log('=== PostgreSQL 17 MAINTAIN Privilege Alignment Runtime Verification ===');
  console.log('Disposable verifier-owned PostgreSQL 17 container. No hosted service is contacted.');

  const migration = fs.readFileSync(migrationPath, 'utf8');
  let passed = 0;
  const scenario = (number: number, name: string, body: () => void): void => {
    body();
    passed += 1;
    console.log(`PASS: Scenario ${number} - ${name}`);
  };

  const baselineVolumes = dockerVolumes();
  docker(['pull', IMAGE], { timeoutMs: IMAGE_PULL_TIMEOUT_MS });
  docker(['network', 'create', networkName]);
  docker([
    'run', '-d',
    '--name', containerName,
    '--network', networkName,
    '--env', `POSTGRES_PASSWORD=${crypto.randomBytes(18).toString('hex')}`,
    '--env', 'POSTGRES_DB=postgres',
    IMAGE,
  ]);

  try {
    waitForReadiness();

    const serverVersion = psql("SELECT pg_catalog.current_setting('server_version_num');");
    console.log(`Server version_num: ${serverVersion} (${psql('SELECT pg_catalog.version();')})`);

    scenario(1, 'the disposable engine really is PostgreSQL 17 or newer', () => {
      assert.ok(
        Number.parseInt(serverVersion, 10) >= 170_000,
        `Expected a PostgreSQL 17+ engine, got server_version_num=${serverVersion}.`,
      );
      assert.equal(psql("SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname = 'pg_maintain';"), '1');
    });

    // Synthetic objects only. Column shapes are irrelevant to table-level ACLs, so these are
    // deliberately minimal and carry no application semantics or data.
    psql(`CREATE ROLE service_role NOLOGIN; CREATE ROLE ${BYSTANDER_ROLE} NOLOGIN;`);
    for (const table of [...ALIGNED_TABLES, UNTARGETED_TABLE]) {
      psql(`CREATE TABLE public.${table} (id bigint PRIMARY KEY, synthetic_note text);`);
    }

    const membersBeforeGrant = pgMaintainMembers();

    // Replays the exact statement form the five historical migrations used.
    for (const table of [...ALIGNED_TABLES, UNTARGETED_TABLE]) {
      psql(`GRANT ALL ON public.${table} TO service_role;`);
    }
    psql(`GRANT ALL ON public.${ALIGNED_TABLES[0]} TO ${BYSTANDER_ROLE};`);

    const before = privilegeMatrix('service_role', [...ALIGNED_TABLES, UNTARGETED_TABLE]);
    const bystanderBefore = privilegeMatrix(BYSTANDER_ROLE, [ALIGNED_TABLES[0]]);
    const aclsBefore = relationAcls();
    const membersBeforeMigration = pgMaintainMembers();
    reportMatrix('BEFORE (service_role, after historical GRANT ALL on PostgreSQL 17)', before);

    scenario(2, 'PostgreSQL 17 GRANT ALL really does include MAINTAIN alongside the seven historical privileges', () => {
      for (const table of [...ALIGNED_TABLES, UNTARGETED_TABLE]) {
        for (const privilege of ALL_PRIVILEGES) {
          assert.equal(
            before[table][privilege],
            true,
            `Expected service_role to hold ${privilege} on public.${table} before alignment.`,
          );
        }
      }
      assert.equal(bystanderBefore[ALIGNED_TABLES[0]].MAINTAIN, true);
    });

    scenario(3, 'service_role is not a member of pg_maintain before the migration', () => {
      assert.equal(membersBeforeGrant, 'NONE');
      assert.equal(membersBeforeMigration, 'NONE');
    });

    psqlFile(migration);
    const after = privilegeMatrix('service_role', [...ALIGNED_TABLES, UNTARGETED_TABLE]);
    const bystanderAfter = privilegeMatrix(BYSTANDER_ROLE, [ALIGNED_TABLES[0]]);
    const membersAfterMigration = pgMaintainMembers();
    reportMatrix('AFTER (service_role, once Migration 0048 has run)', after);

    scenario(4, 'MAINTAIN is revoked on exactly the five aligned tables', () => {
      for (const table of ALIGNED_TABLES) {
        assert.equal(after[table].MAINTAIN, false, `Expected MAINTAIN to be revoked on public.${table}.`);
      }
    });

    scenario(5, 'all seven pre-PostgreSQL-17 privileges survive on all five aligned tables', () => {
      for (const table of ALIGNED_TABLES) {
        for (const privilege of PRESERVED_PRIVILEGES) {
          assert.equal(after[table][privilege], true, `Expected ${privilege} to survive on public.${table}.`);
        }
      }
    });

    scenario(6, 'a sixth GRANT ALL table outside the migration list keeps MAINTAIN', () => {
      for (const privilege of ALL_PRIVILEGES) {
        assert.equal(
          after[UNTARGETED_TABLE][privilege],
          true,
          `Expected public.${UNTARGETED_TABLE} to be untouched.`,
        );
      }
    });

    scenario(7, 'a second grantee on an aligned table keeps every privilege including MAINTAIN', () => {
      for (const privilege of ALL_PRIVILEGES) {
        assert.equal(
          bystanderAfter[ALIGNED_TABLES[0]][privilege],
          true,
          `Expected ${BYSTANDER_ROLE} to be untouched.`,
        );
      }
    });

    scenario(8, 'pg_maintain role membership is neither added nor removed', () => {
      assert.equal(membersAfterMigration, membersBeforeMigration);
      assert.equal(membersAfterMigration, 'NONE');
    });

    scenario(9, 'the only ACL change anywhere is service_role losing MAINTAIN on the five aligned tables', () => {
      // Rebuilds the expected post-migration ACL text from the pre-migration text by deleting the
      // single MAINTAIN letter from service_role's entry on the aligned tables. Any other privilege,
      // role, grantor or table that changed makes this exact comparison fail.
      const expected = aclsBefore
        .split('\n')
        .map((line) => (ALIGNED_TABLES.some((table) => line.startsWith(`${table}=`))
          ? line.replace(
            /service_role=([a-zA-Z*]+)\//g,
            (_match, letters: string) => `service_role=${letters.replace('m', '')}/`,
          )
          : line))
        .join('\n');
      assert.notEqual(expected, aclsBefore, 'The pre-migration ACL text contained no MAINTAIN letter to remove.');
      assert.equal(relationAcls(), expected);
    });

    psqlFile(migration);
    const converged = privilegeMatrix('service_role', [...ALIGNED_TABLES, UNTARGETED_TABLE]);

    scenario(10, 're-running the migration converges instead of drifting further', () => {
      assert.deepEqual(converged, after);
      assert.equal(pgMaintainMembers(), membersAfterMigration);
    });

    console.log(`PostgreSQL 17 MAINTAIN privilege alignment verification passed (${passed} scenarios).`);
  } finally {
    const residue = cleanup(baselineVolumes);
    console.log(
      `Cleanup: containers="${residue.containers}" networks="${residue.networks}" leakedVolumes=${residue.leakedVolumes.length}`,
    );
    assert.equal(residue.containers, '', 'Disposable PostgreSQL 17 container was not removed.');
    assert.equal(residue.networks, '', 'Disposable PostgreSQL 17 network was not removed.');
    assert.deepEqual(residue.leakedVolumes, [], 'Disposable PostgreSQL 17 run left a Docker volume behind.');
  }
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
