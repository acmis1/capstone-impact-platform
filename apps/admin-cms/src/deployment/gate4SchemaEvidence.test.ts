import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GATE4_EVIDENCE_FORMAT,
  canonicalizePostgresType,
  canonicalizeSqlExpression,
  compareGate4Evidence,
  gate4EvidenceStats,
  parseGate4Evidence,
  type Gate4SchemaEvidence,
} from './gate4SchemaEvidence';
import { gitStatusShowsCleanTrackedCheckout } from '../scripts/checkGate4SchemaEvidence';

function exactEvidence(): Gate4SchemaEvidence {
  return {
    formatVersion: GATE4_EVIDENCE_FORMAT,
    roles: [
      { name: 'anon', exists: true, canLogin: false, inherits: true, bypassRls: false, superuser: false },
      { name: 'authenticated', exists: true, canLogin: false, inherits: true, bypassRls: false, superuser: false },
      { name: 'service_role', exists: true, canLogin: false, inherits: true, bypassRls: true, superuser: false },
    ],
    migrations: ['20260601035138', '20260601035139'],
    tables: [
      { schema: 'public', name: 'admin_users', kind: 'table' },
      { schema: 'public', name: 'media_assets', kind: 'table' },
      { schema: 'public', name: 'projects', kind: 'table' },
      { schema: 'public', name: 'programs', kind: 'table' },
    ],
    columns: [
      { schema: 'public', table: 'admin_users', name: 'id', ordinal: 1, dataType: 'uuid', arrayElementType: null, nullable: false, identity: '', generated: '', defaultExpression: 'gen_random_uuid()' },
      { schema: 'public', table: 'admin_users', name: 'auth_user_id', ordinal: 2, dataType: 'uuid', arrayElementType: null, nullable: true, identity: '', generated: '', defaultExpression: null },
      { schema: 'public', table: 'media_assets', name: 'alt_text_public', ordinal: 1, dataType: 'text', arrayElementType: null, nullable: true, identity: '', generated: '', defaultExpression: null },
      { schema: 'public', table: 'projects', name: 'id', ordinal: 1, dataType: 'uuid', arrayElementType: null, nullable: false, identity: '', generated: '', defaultExpression: 'gen_random_uuid()' },
      { schema: 'public', table: 'projects', name: 'year', ordinal: 2, dataType: 'integer', arrayElementType: null, nullable: false, identity: '', generated: '', defaultExpression: '2026' },
      { schema: 'public', table: 'projects', name: 'program_id', ordinal: 3, dataType: 'uuid', arrayElementType: null, nullable: true, identity: '', generated: '', defaultExpression: null },
      { schema: 'public', table: 'projects', name: 'poster_text_public', ordinal: 4, dataType: 'text', arrayElementType: null, nullable: true, identity: '', generated: '', defaultExpression: null },
      { schema: 'public', table: 'projects', name: 'accessibility_text_public', ordinal: 5, dataType: 'text', arrayElementType: null, nullable: true, identity: '', generated: '', defaultExpression: null },
      { schema: 'public', table: 'projects', name: 'participant_contact_email', ordinal: 6, dataType: 'text', arrayElementType: null, nullable: true, identity: '', generated: '', defaultExpression: null },
      { schema: 'public', table: 'programs', name: 'id', ordinal: 1, dataType: 'uuid', arrayElementType: null, nullable: false, identity: '', generated: '', defaultExpression: 'gen_random_uuid()' },
    ],
    constraints: [
      { schema: 'public', table: 'admin_users', name: 'admin_users_auth_user_id_fkey', type: 'foreign_key', definition: 'FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE SET NULL', deferrable: false, initiallyDeferred: false, validated: true },
      { schema: 'public', table: 'projects', name: 'projects_pkey', type: 'primary_key', definition: 'PRIMARY KEY (id)', deferrable: false, initiallyDeferred: false, validated: true },
      { schema: 'public', table: 'projects', name: 'projects_program_id_fkey', type: 'foreign_key', definition: 'FOREIGN KEY (program_id) REFERENCES programs(id) ON UPDATE RESTRICT ON DELETE SET NULL', deferrable: false, initiallyDeferred: false, validated: true },
      { schema: 'public', table: 'projects', name: 'projects_year_check', type: 'check', definition: 'CHECK ((year >= 2020) AND (year <= 2100))', deferrable: false, initiallyDeferred: false, validated: true },
      { schema: 'public', table: 'programs', name: 'programs_name_key', type: 'unique', definition: 'UNIQUE (name)', deferrable: false, initiallyDeferred: false, validated: true },
    ],
    rls: [
      { schema: 'public', table: 'admin_users', enabled: true, forced: false },
      { schema: 'public', table: 'media_assets', enabled: true, forced: false },
      { schema: 'public', table: 'projects', enabled: true, forced: false },
      { schema: 'public', table: 'programs', enabled: true, forced: false },
    ],
    policies: [
      { schema: 'public', table: 'projects', name: 'admin_all_projects', permissive: false, command: 'all', roles: ['authenticated'], usingExpression: 'false', withCheckExpression: 'false' },
      { schema: 'public', table: 'programs', name: 'select_programs_authenticated', permissive: true, command: 'select', roles: ['authenticated'], usingExpression: 'true', withCheckExpression: null },
    ],
    tableGrants: [
      { schema: 'public', table: 'programs', role: 'authenticated', privilege: 'SELECT', grantable: false },
      { schema: 'public', table: 'projects', role: 'service_role', privilege: 'SELECT', grantable: false },
      { schema: 'public', table: 'projects', role: 'service_role', privilege: 'INSERT', grantable: false },
      { schema: 'public', table: 'projects', role: 'service_role', privilege: 'UPDATE', grantable: false },
      { schema: 'public', table: 'projects', role: 'service_role', privilege: 'DELETE', grantable: false },
    ],
    schemaGrants: [
      { schema: 'public', role: 'anon', privilege: 'USAGE', grantable: false },
      { schema: 'public', role: 'authenticated', privilege: 'USAGE', grantable: false },
      { schema: 'public', role: 'service_role', privilege: 'USAGE', grantable: false },
    ],
    functions: [
      {
        schema: 'public', name: 'generate_participant_preview', kind: 'function',
        argumentNames: ['p_public_id', 'p_admin_id'], argumentTypes: ['text', 'uuid'], returnType: 'jsonb',
        securityDefiner: true, configuration: ['search_path=pg_catalog, public'],
        executeGrants: [{ role: 'service_role', grantable: false }], classification: 'application_rpc',
      },
      {
        schema: 'public', name: 'generate_participant_preview', kind: 'function',
        argumentNames: ['p_public_id', 'p_admin_id', 'p_is_correction_reissue'], argumentTypes: ['text', 'uuid', 'boolean'], returnType: 'jsonb',
        securityDefiner: true, configuration: ['search_path=pg_catalog, public'],
        executeGrants: [{ role: 'service_role', grantable: false }], classification: 'application_rpc',
      },
      {
        schema: 'public', name: 'canonical_staff_roles', kind: 'function', argumentNames: ['p_roles'],
        argumentTypes: ['text[]'], returnType: 'text[]', securityDefiner: false, configuration: [],
        executeGrants: [{ role: 'service_role', grantable: false }], classification: 'canonical_helper',
      },
      {
        schema: 'public', name: 'get_current_password_recovery_session_state', kind: 'function', argumentNames: [],
        argumentTypes: [], returnType: 'jsonb', securityDefiner: true, configuration: ['search_path=pg_catalog, auth, public'],
        executeGrants: [{ role: 'authenticated', grantable: false }], classification: 'other_exposed_routine',
      },
    ],
    storageBuckets: [
      { id: 'project-drafts-private', name: 'project-drafts-private', public: false, fileSizeLimit: 20 * 1024 * 1024, allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'] },
      { id: 'project-public-assets', name: 'project-public-assets', public: true, fileSizeLimit: 20 * 1024 * 1024, allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'] },
      { id: 'public-feeds', name: 'public-feeds', public: true, fileSizeLimit: 10 * 1024 * 1024, allowedMimeTypes: ['application/json'] },
    ],
  };
}

function mutate(mutator: (evidence: Gate4SchemaEvidence) => void): Gate4SchemaEvidence {
  const evidence = structuredClone(exactEvidence());
  mutator(evidence);
  return evidence;
}

function expectDrift(actual: Gate4SchemaEvidence, category: string): void {
  const result = compareGate4Evidence(exactEvidence(), actual);
  expect(result.classification).toBe('GATE4_DRIFT');
  expect(result.differences.some((difference) => difference.category === category)).toBe(true);
}

describe('Gate 4 exact schema evidence comparison', () => {
  it('classifies the exact expected snapshot as MATCH', () => {
    const result = compareGate4Evidence(exactEvidence(), structuredClone(exactEvidence()));
    expect(result.classification).toBe('GATE4_MATCH');
    expect(result.totalDifferences).toBe(0);
  });

  it('detects a missing table', () => {
    expectDrift(mutate((evidence) => { evidence.tables = evidence.tables.filter((table) => table.name !== 'projects'); }), 'TABLES');
  });

  it('detects an unexpected public application table', () => {
    expectDrift(mutate((evidence) => { evidence.tables.push({ schema: 'public', name: 'unexpected_application_table', kind: 'table' }); }), 'TABLES');
  });

  it('detects an altered column type', () => {
    expectDrift(mutate((evidence) => { evidence.columns.find((column) => column.name === 'year')!.dataType = 'bigint'; }), 'COLUMNS');
  });

  it('detects altered nullability', () => {
    expectDrift(mutate((evidence) => { evidence.columns.find((column) => column.name === 'poster_text_public')!.nullable = false; }), 'COLUMNS');
  });

  it('detects a missing foreign key', () => {
    expectDrift(mutate((evidence) => { evidence.constraints = evidence.constraints.filter((constraint) => constraint.name !== 'projects_program_id_fkey'); }), 'CONSTRAINTS');
  });

  it('detects altered ON DELETE behavior', () => {
    expectDrift(mutate((evidence) => { evidence.constraints.find((constraint) => constraint.name === 'projects_program_id_fkey')!.definition = 'FOREIGN KEY (program_id) REFERENCES programs(id) ON UPDATE RESTRICT ON DELETE CASCADE'; }), 'CONSTRAINTS');
  });

  it('detects altered CHECK logic', () => {
    expectDrift(mutate((evidence) => { evidence.constraints.find((constraint) => constraint.name === 'projects_year_check')!.definition = 'CHECK ((year >= 2021) AND (year <= 2100))'; }), 'CONSTRAINTS');
  });

  it('detects disabled RLS', () => {
    expectDrift(mutate((evidence) => { evidence.rls.find((table) => table.table === 'projects')!.enabled = false; }), 'RLS');
  });

  it('detects a missing policy', () => {
    expectDrift(mutate((evidence) => { evidence.policies = evidence.policies.filter((policy) => policy.name !== 'admin_all_projects'); }), 'POLICIES');
  });

  it('detects an unexpectedly permissive policy', () => {
    expectDrift(mutate((evidence) => {
      const policy = evidence.policies.find((candidate) => candidate.name === 'admin_all_projects')!;
      policy.permissive = true;
      policy.usingExpression = 'true';
    }), 'POLICIES');
  });

  it('detects an unexpected anon table privilege', () => {
    expectDrift(mutate((evidence) => { evidence.tableGrants.push({ schema: 'public', table: 'projects', role: 'anon', privilege: 'SELECT', grantable: false }); }), 'TABLE_GRANTS');
  });

  it('detects a missing authenticated lookup privilege', () => {
    expectDrift(mutate((evidence) => { evidence.tableGrants = evidence.tableGrants.filter((grant) => !(grant.table === 'programs' && grant.role === 'authenticated')); }), 'TABLE_GRANTS');
  });

  it('detects a missing application RPC', () => {
    expectDrift(mutate((evidence) => { evidence.functions = evidence.functions.filter((routine) => routine.name !== 'generate_participant_preview'); }), 'FUNCTIONS');
  });

  it('detects a missing overloaded RPC signature', () => {
    expectDrift(mutate((evidence) => { evidence.functions = evidence.functions.filter((routine) => routine.argumentTypes.length !== 3 || routine.name !== 'generate_participant_preview'); }), 'FUNCTIONS');
  });

  it('detects altered RPC argument order and type', () => {
    expectDrift(mutate((evidence) => {
      const routine = evidence.functions.find((candidate) => candidate.classification === 'application_rpc')!;
      routine.argumentNames = ['p_admin_id', 'p_public_id'];
      routine.argumentTypes = ['uuid', 'text'];
    }), 'FUNCTIONS');
  });

  it('detects unsafe execute-grant expansion', () => {
    expectDrift(mutate((evidence) => { evidence.functions[0].executeGrants.push({ role: 'anon', grantable: false }); }), 'FUNCTIONS');
  });

  it('keeps canonical_staff_roles separate from application RPC counts', () => {
    const stats = gate4EvidenceStats(exactEvidence());
    expect(stats.applicationRpcSignatures).toBe(2);
    expect(stats.applicationRpcNames).toBe(1);
    expect(stats.canonicalStaffRoleHelpers).toBe(1);
  });

  it('detects Storage bucket visibility drift', () => {
    expectDrift(mutate((evidence) => { evidence.storageBuckets.find((bucket) => bucket.id === 'project-drafts-private')!.public = true; }), 'STORAGE_BUCKETS');
  });

  it('classifies malformed or incomplete evidence as EVIDENCE_INVALID', () => {
    const incomplete = structuredClone(exactEvidence()) as unknown as Record<string, unknown>;
    delete incomplete.constraints;
    expect(compareGate4Evidence(exactEvidence(), incomplete).classification).toBe('EVIDENCE_INVALID');
    expect(parseGate4Evidence({}).ok).toBe(false);
  });

  it('rejects duplicate catalog identities as EVIDENCE_INVALID', () => {
    const duplicated = mutate((evidence) => { evidence.tables.push(structuredClone(evidence.tables[0])); });
    expect(compareGate4Evidence(exactEvidence(), duplicated).classification).toBe('EVIDENCE_INVALID');
  });

  it('normalizes only canonical formatting, role ordering, MIME ordering, and PostgreSQL type aliases', () => {
    const equivalent = mutate((evidence) => {
      evidence.columns.find((column) => column.name === 'year')!.dataType = 'int4';
      evidence.columns.find((column) => column.name === 'id')!.defaultExpression = ' pg_catalog.gen_random_uuid (  ) ';
      evidence.constraints.find((constraint) => constraint.name === 'projects_year_check')!.definition = ' CHECK ( ( year>=2020 ) AND ( year<=2100 ) ) ';
      evidence.storageBuckets[0].allowedMimeTypes!.reverse();
    });
    expect(compareGate4Evidence(exactEvidence(), equivalent).classification).toBe('GATE4_MATCH');
    expect(canonicalizePostgresType('timestamptz[]')).toBe('timestamp with time zone[]');
    expect(canonicalizeSqlExpression(" ( pg_catalog.btrim ( value ) <> '' ) ")).toBe("btrim(value)<>''");
  });
});

describe('Gate 4 hosted SQL safety contract', () => {
  const sqlPath = path.resolve(__dirname, '../../../../infra/supabase/gate4-schema-evidence.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8').replace(/\r\n/g, '\n');
  const executable = sql
    .replace(/--.*$/gm, '')
    .replace(/'(?:''|[^'])*'/g, "''");

  it('is one SELECT-only statement with no application/Auth/Storage object reads', () => {
    expect(executable.trimStart()).toMatch(/^WITH\b/i);
    expect((executable.match(/;/g) ?? [])).toHaveLength(1);
    expect(executable).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP|MERGE|CALL|DO|COPY|LOCK)\b/i);
    expect(sql).not.toMatch(/\bstorage\.objects\b/i);
    expect(sql).not.toMatch(/\bauth\.users\b/i);
    expect(sql).toContain('FROM storage.buckets');
    expect(sql).toContain('FROM supabase_migrations.schema_migrations');
  });

  it('collects every required structural evidence category', () => {
    for (const category of [
      'roles', 'migrations', 'tables', 'columns', 'constraints', 'rls', 'policies',
      'tableGrants', 'schemaGrants', 'functions', 'storageBuckets',
    ]) {
      expect(sql).toContain(`'${category}'`);
    }
    expect(sql).toContain("routine_name = 'canonical_staff_roles'");
    expect(sql).toContain("'application_rpc'");
  });
});

describe('Gate 4 exact Git identity guard', () => {
  it('requires a checkout with no tracked staged or unstaged changes', () => {
    expect(gitStatusShowsCleanTrackedCheckout('')).toBe(true);
    expect(gitStatusShowsCleanTrackedCheckout('  \r\n')).toBe(true);
    expect(gitStatusShowsCleanTrackedCheckout(' M infra/supabase/gate4-schema-evidence.sql\n')).toBe(false);
    expect(gitStatusShowsCleanTrackedCheckout('M  apps/admin-cms/src/deployment/gate4SchemaEvidence.ts\n')).toBe(false);
  });
});
