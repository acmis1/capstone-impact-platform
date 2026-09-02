import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  compareGate4Evidence,
  GATE4_EVIDENCE_FORMAT,
  validateCurrentRepositoryGate4Contract,
  type Gate4SchemaEvidence,
  type Gate4TableGrantEvidence,
} from '../deployment/gate4SchemaEvidence';
import { ALL_REQUIRED_TABLES, REQUIRED_RPC_SIGNATURES, REQUIRED_STORAGE_BUCKETS } from '../deployment/hostedDeploymentReadiness';
import * as collector from '../scripts/checkGate4SchemaEvidence';
import { repositoryMigrationVersions } from './captureRecoveryBackup';
import * as stack from './disposableSupabaseStack';
import { alignTableGrantPortability, classifyRestoreFailure, runGate4 } from './restoreRecoveryRehearsal';
import { constraintRenderingDifferencesAreExpected, REVIEWED_CONSTRAINT_RENDERING_PAIRS } from './constraintRenderingCompatibility';
import { installSyntheticTableDefaultAclFixture } from './syntheticTableDefaultAclFixture';
import { planTableGrantPortabilityCompatibility } from './tableGrantPortabilityCompatibility';
import { RecoveryGuardError, resolveClassification } from './zeroCostRecoveryContract';

const repositoryRoot = path.resolve(__dirname, '../../../..');
const migrations = repositoryMigrationVersions(repositoryRoot);
const highPrivileges = ['REFERENCES', 'TRIGGER', 'TRUNCATE'] as const;
const historicalHighTables = ['browser_import_commits', 'browser_import_media_commits',
  'participant_preview_confirmations', 'participant_preview_correction_requests', 'participant_previews'];

function evidence(): Gate4SchemaEvidence {
  const controlTables = ['executor_registrations', 'launch_budget_guard', 'launch_reservations'];
  const tables: Gate4SchemaEvidence['tables'] = [
    ...ALL_REQUIRED_TABLES.map((name) => ({ schema: 'public', name, kind: 'table' as const })),
    ...controlTables.map((name) => ({ schema: 'assistive_execution_control', name, kind: 'table' as const })),
  ];
  const functions: Gate4SchemaEvidence['functions'] = REQUIRED_RPC_SIGNATURES.map((routine) => ({
    schema: 'public', name: routine.name, kind: 'function', argumentNames: [...routine.parameterNames],
    argumentTypes: [...routine.parameterTypes], returnType: 'jsonb', securityDefiner: true,
    configuration: ['search_path=public'], executeGrants: [{ role: 'service_role', grantable: false }],
    classification: 'application_rpc',
  }));
  functions.push({ schema: 'public', name: 'canonical_staff_roles', kind: 'function',
    argumentNames: ['p_roles'], argumentTypes: ['text[]'], returnType: 'text[]', securityDefiner: false,
    configuration: [], executeGrants: [], classification: 'canonical_helper' });
  for (const [name, argumentNames, argumentTypes] of [
    ['inspect_assistive_launch_eligibility', [], []],
    ['mark_assistive_launch_requested', ['p_reservation_token', 'p_generation'], ['uuid', 'bigint']],
    ['record_assistive_launch_outcome', ['p_reservation_token', 'p_generation', 'p_outcome', 'p_execution_reference'], ['uuid', 'bigint', 'text', 'text']],
    ['reserve_assistive_launch', ['p_dispatcher_instance_id', 'p_deployment_version', 'p_image_digest', 'p_lease_seconds'], ['text', 'text', 'text', 'integer']],
  ] as const) {
    functions.push({ schema: 'assistive_execution_control', name, kind: 'function',
      argumentNames: [...argumentNames], argumentTypes: [...argumentTypes], returnType: 'jsonb',
      securityDefiner: true, configuration: ['search_path='],
      executeGrants: [{ role: 'capstone_assistive_dispatcher', grantable: false }], classification: 'dispatcher_control' });
  }
  return {
    formatVersion: GATE4_EVIDENCE_FORMAT,
    roles: ['anon', 'authenticated', 'service_role', 'capstone_assistive_dispatcher'].map((name) => ({
      name: name as Gate4SchemaEvidence['roles'][number]['name'], exists: true,
      canLogin: name === 'capstone_assistive_dispatcher', inherits: name !== 'capstone_assistive_dispatcher',
      bypassRls: name === 'service_role', superuser: false,
    })), migrations, tables, functions,
    columns: [['projects', 'poster_text_public'], ['projects', 'accessibility_text_public'],
      ['projects', 'participant_contact_email'], ['media_assets', 'alt_text_public'], ['admin_users', 'auth_user_id']]
      .map(([table, name], index) => ({ schema: 'public', table, name, ordinal: index + 1,
        dataType: 'text', arrayElementType: null, nullable: true, identity: '', generated: '', defaultExpression: null })),
    constraints: [], policies: [],
    rls: tables.map((table) => ({ schema: table.schema, table: table.name, enabled: true, forced: table.schema !== 'public' })),
    tableGrants: [
      ...ALL_REQUIRED_TABLES.flatMap((table) => (['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const)
        .map((privilege) => ({ schema: 'public', table, privilege, role: 'service_role' as const, grantable: false }))),
      ...historicalHighTables.flatMap((table) => highPrivileges
        .map((privilege) => ({ schema: 'public', table, privilege, role: 'service_role' as const, grantable: false }))),
    ],
    schemaGrants: [{ schema: 'assistive_execution_control', role: 'capstone_assistive_dispatcher', privilege: 'USAGE', grantable: false }],
    storageBuckets: REQUIRED_STORAGE_BUCKETS.map((id) => ({ id, name: id, public: false, fileSizeLimit: null, allowedMimeTypes: null })),
  };
}

function extra(change: Record<string, unknown> = {}): Gate4TableGrantEvidence {
  return { schema: 'public', table: 'admin_users', role: 'anon', privilege: 'MAINTAIN', grantable: false, ...change } as Gate4TableGrantEvidence;
}

afterEach(() => vi.restoreAllMocks());

describe('recovery-only table grant subtraction', () => {
  it('uses source evidence that passes the real repository contract', () => {
    expect(validateCurrentRepositoryGate4Contract(evidence(), migrations)).toEqual([]);
  });

  it.each(['MAINTAIN', 'REFERENCES', 'TRIGGER', 'TRUNCATE'])('revokes only the exact non-grantable target-extra %s', (privilege) => {
    const source = evidence();
    const target = structuredClone(source);
    target.tableGrants.push(extra({ privilege }));
    const raw = compareGate4Evidence(target, source);
    expect(raw.differences).toEqual([{ category: 'TABLE_GRANTS', kind: 'MISSING', key: `public.admin_users.anon.${privilege}` }]);
    const plan = planTableGrantPortabilityCompatibility(source, target, migrations);
    expect(plan).toEqual({ action: 'REVOKED_KNOWN_TARGET_DEFAULT_ACL_OVERGRANTS', revokeCount: 1,
      sql: `REVOKE ${privilege} ON TABLE "public"."admin_users" FROM "anon";` });
    expect(source.tableGrants.filter((grant) => highPrivileges.includes(grant.privilege as typeof highPrivileges[number]))).toHaveLength(15);
    expect(plan.sql).not.toMatch(/GRANT|ALL|CASCADE/);
  });

  it('preserves all 15 historical service_role high privileges and any required MAINTAIN', () => {
    const source = evidence();
    source.tableGrants.push(extra({ role: 'service_role' }));
    const before = JSON.stringify(source);
    const target = structuredClone(source);
    target.tableGrants.push(extra());
    const plan = planTableGrantPortabilityCompatibility(source, target, migrations);
    expect(plan.revokeCount).toBe(1);
    expect(plan.sql).not.toContain('service_role');
    expect(JSON.stringify(source)).toBe(before);
  });

  it.each([
    ...['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'UNKNOWN'].map((privilege) => ({ privilege })),
    { grantable: true }, { role: 'unexpected' }, { role: 'public' }, { role: 'capstone_assistive_dispatcher' },
    { schema: 'auth' }, { schema: 'storage' }, { schema: 'assistive_execution_control' },
    { table: 'unknown_table' }, { table: 'admin_users"; GRANT ALL TO public; --' },
  ])('refuses an unclassified target extra %j', (change) => {
    const source = evidence();
    const target = structuredClone(source);
    target.tableGrants.push(extra(), extra({ ...change, table: 'table' in change ? change.table : 'projects' }));
    expect(() => planTableGrantPortabilityCompatibility(source, target, migrations))
      .toThrowError(/^TABLE_GRANT_PORTABILITY_COMPATIBILITY_/);
  });

  it.each(['missing', 'grantability'])('never adds or changes a required source grant: %s', (kind) => {
    const source = evidence();
    const target = structuredClone(source);
    if (kind === 'missing') target.tableGrants.shift();
    else target.tableGrants[0].grantable = true;
    target.tableGrants.push(extra());
    expect(() => planTableGrantPortabilityCompatibility(source, target, migrations))
      .toThrowError('TABLE_GRANT_PORTABILITY_COMPATIBILITY_SOURCE_REQUIRED_GRANT_MISMATCH');
  });

  it.each(['malformed', 'incomplete-contract', 'unknown-table', 'missing-target-table', 'duplicate-grant'])('rejects invalid evidence: %s', (kind) => {
    const source = evidence();
    const target = structuredClone(source);
    if (kind === 'malformed') (source as unknown as Record<string, unknown>).tableGrants = 'private-input';
    if (kind === 'incomplete-contract') source.migrations = [];
    if (kind === 'unknown-table') {
      source.tables.push({ schema: 'public', name: 'unknown_table', kind: 'table' });
      target.tables.push({ schema: 'public', name: 'unknown_table', kind: 'table' });
    }
    if (kind === 'missing-target-table') target.tables.pop();
    if (kind === 'duplicate-grant') target.tableGrants.push(target.tableGrants[0]);
    expect(() => planTableGrantPortabilityCompatibility(source, target, migrations))
      .toThrowError(/^TABLE_GRANT_PORTABILITY_COMPATIBILITY_/);
  });
});

const identity: stack.DisposableStackIdentity = { projectId: 'capstone-pp1-recovery-source-1234abcd',
  workdir: path.join(repositoryRoot, 'unused-unit-source'), databaseContainer: 'unused-unit-container',
  networkName: 'unused-unit-network', portBase: 54820 };

describe('table grant normalization execution boundary', () => {
  function mockTarget(target: Gate4SchemaEvidence) {
    vi.spyOn(stack, 'assertDisposableOwnership').mockImplementation(() => {});
    const query = vi.spyOn(collector, 'collectLocalGate4Evidence').mockReturnValue(target);
    const sql = vi.spyOn(stack, 'runDisposablePsql').mockReturnValue('');
    return { query, sql };
  }

  it('does no SQL on MATCH', () => {
    const source = evidence();
    const { sql, query } = mockTarget(structuredClone(source));
    expect(alignTableGrantPortability(repositoryRoot, identity, source).action).toBe('MATCH');
    expect(sql).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('re-queries exact source parity after a transactional revoke', () => {
    const source = evidence();
    const target = structuredClone(source);
    target.tableGrants.push(extra());
    const { sql, query } = mockTarget(target);
    query.mockReturnValueOnce(target).mockReturnValueOnce(structuredClone(source));
    expect(alignTableGrantPortability(repositoryRoot, identity, source).revokeCount).toBe(1);
    expect(query).toHaveBeenCalledTimes(2);
    expect(sql).toHaveBeenCalledExactlyOnceWith(identity, {
      singleTransaction: true, stdinSql: 'REVOKE MAINTAIN ON TABLE "public"."admin_users" FROM "anon";',
    });
  });

  it.each(['unchanged', 'missing-required', 'new-extra'])('fails if the re-query is %s', (kind) => {
    const source = evidence();
    const target = structuredClone(source);
    target.tableGrants.push(extra());
    const after = structuredClone(kind === 'unchanged' ? target : source);
    if (kind === 'missing-required') after.tableGrants.shift();
    if (kind === 'new-extra') after.tableGrants.push(extra({ privilege: 'SELECT' }));
    const { query } = mockTarget(target);
    query.mockReturnValueOnce(target).mockReturnValueOnce(after);
    expect(() => alignTableGrantPortability(repositoryRoot, identity, source))
      .toThrowError(/^TABLE_GRANT_PORTABILITY_COMPATIBILITY_/);
  });

  it('refuses all SQL when safe and unsafe extras coexist', () => {
    const source = evidence();
    const target = structuredClone(source);
    target.tableGrants.push(extra(), extra({ privilege: 'SELECT' }));
    const { sql } = mockTarget(target);
    expect(() => alignTableGrantPortability(repositoryRoot, identity, source)).toThrow();
    expect(sql).not.toHaveBeenCalled();
  });

  it('sanitizes SQL/query failures and classifies the stage distinctly', () => {
    const source = evidence();
    const target = structuredClone(source);
    target.tableGrants.push(extra());
    const { sql } = mockTarget(target);
    sql.mockImplementation(() => { throw new Error('private SQL and values'); });
    expect(() => alignTableGrantPortability(repositoryRoot, identity, source))
      .toThrowError('TABLE_GRANT_PORTABILITY_COMPATIBILITY_REVOKE_FAILED');
    const failure = new RecoveryGuardError('TABLE_GRANT_PORTABILITY_COMPATIBILITY_REVOKE_FAILED');
    expect(classifyRestoreFailure(failure)).toBe('TABLE_GRANT_PORTABILITY_COMPATIBILITY_FAILED');
    expect(resolveClassification([classifyRestoreFailure(failure), 'GATE4_DRIFT']))
      .toBe('TABLE_GRANT_PORTABILITY_COMPATIBILITY_FAILED');
    expect(resolveClassification([classifyRestoreFailure(failure), 'CLEANUP_FAILED'])).toBe('CLEANUP_FAILED');
  });
});

describe('synthetic default ACL fixture ownership', () => {
  it.each(['hosted', 'ordinary-local', 'mismatched-workdir', 'missing-marker', 'unowned-container'])('cannot activate for %s', (kind) => {
    const ownership = vi.spyOn(stack, 'assertDisposableOwnership').mockImplementation(() => {});
    const container = vi.spyOn(stack, 'assertDatabaseContainerOwned').mockImplementation(() => {});
    const sql = vi.spyOn(stack, 'runDisposablePsql');
    const query = vi.spyOn(collector, 'collectLocalGate4Evidence');
    if (kind === 'missing-marker') ownership.mockImplementation(() => { throw new Error('private path'); });
    if (kind === 'unowned-container') container.mockImplementation(() => { throw new Error('private identity'); });
    expect(() => installSyntheticTableDefaultAclFixture({ repositoryRoot,
      sourceKind: kind === 'hosted' ? 'hosted-staging' : 'disposable-local-synthetic',
      sourceProjectRef: kind === 'ordinary-local' ? 'operator-local' : identity.projectId,
      target: kind === 'hosted' ? { kind: 'hosted-linked', workdir: identity.workdir }
        : { kind: 'local', workdir: kind === 'mismatched-workdir' ? repositoryRoot : identity.workdir },
    }, identity)).toThrowError(/^SYNTHETIC_TABLE_DEFAULT_ACL_/);
    expect(sql).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});

function constraintEvidence() {
  const source = evidence();
  source.constraints = REVIEWED_CONSTRAINT_RENDERING_PAIRS.map((pair) => {
    const [schema, table, name] = pair.key.split('.');
    return { schema, table, name, type: 'check', definition: pair.sourceDefinition,
      deferrable: false, initiallyDeferred: false, validated: true };
  });
  const restored = structuredClone(source);
  restored.constraints.forEach((constraint, index) => {
    constraint.definition = REVIEWED_CONSTRAINT_RENDERING_PAIRS[index].restoredDefinition;
  });
  return { source, restored };
}

describe('exact migration-to-dump-replay constraint rendering pairs', () => {
  it('keeps the core comparator strict and accepts only the five observed pairs in recovery', () => {
    const { source, restored } = constraintEvidence();
    const before = JSON.stringify([source, restored]);
    const raw = compareGate4Evidence(restored, source);
    expect(raw.classification).toBe('GATE4_DRIFT');
    expect(raw.totalDifferences).toBe(5);
    expect(raw.categoryMatches.TABLE_GRANTS).toBe(true);
    vi.spyOn(collector, 'collectLocalGate4Evidence').mockReturnValue(restored);
    const result = runGate4(repositoryRoot, identity, source);
    expect(result.selfCheckClassification).toBe('GATE4_MATCH');
    expect(result.sourceComparisonClassification).toBe('GATE4_MATCH_CONSTRAINT_RENDERING_PORTABLE');
    expect(result.constraintRenderingPairCount).toBe(5);
    expect(JSON.stringify([source, restored])).toBe(before);
  });

  it.each(REVIEWED_CONSTRAINT_RENDERING_PAIRS.map((pair, index) => [pair.key, index] as const))(
    'accepts the exact pair independently: %s', (_key, index) => {
      const { source, restored } = constraintEvidence();
      restored.constraints = structuredClone(source.constraints);
      restored.constraints[index].definition = REVIEWED_CONSTRAINT_RENDERING_PAIRS[index].restoredDefinition;
      expect(constraintRenderingDifferencesAreExpected({ sourceEvidence: source, restoredEvidence: restored,
        comparison: compareGate4Evidence(restored, source) })).toBe(true);
    },
  );

  for (const side of ['source', 'restored'] as const) {
    it.each([
      ['regex', 1, '^[A-Za-z0-9_-]+$', '^[A-Z]+$'],
      ['numeric bound', 0, '<= 200', '<= 201'],
      ['role value', 4, "'editor'", "'owner'"],
      ['column', 1, 'public_id', 'private_id'],
      ['operator', 2, '>= 1', '> 1'],
      ['cast', 2, '::text', '::citext'],
      ['boolean structure', 3, ' AND ', ' OR '],
      ['null check', 0, 'IS NULL', 'IS NOT NULL'],
    ] as const)(`rejects changed ${side} %s with GATE4_DRIFT`, (_label, index, from, to) => {
      const pair = constraintEvidence();
      pair[side].constraints[index].definition = pair[side].constraints[index].definition.replace(from, to);
      vi.spyOn(collector, 'collectLocalGate4Evidence').mockReturnValue(pair.restored);
      expect(runGate4(repositoryRoot, identity, pair.source).sourceComparisonClassification).toBe('GATE4_DRIFT');
    });
  }

  it.each(['sixth-change', 'missing', 'missing-both', 'extra', 'metadata', 'table-grant', 'source-contract'])('rejects %s', (kind) => {
    const { source, restored } = constraintEvidence();
    if (kind === 'sixth-change') {
      source.constraints.push({ ...source.constraints[0], name: 'unreviewed_check', definition: 'CHECK (true)' });
      restored.constraints.push({ ...source.constraints.at(-1)!, definition: 'CHECK (false)' });
    }
    if (kind === 'missing' || kind === 'missing-both') restored.constraints.shift();
    if (kind === 'missing-both') source.constraints.shift();
    if (kind === 'extra') restored.constraints.push({ ...restored.constraints[0], name: 'unreviewed_check' });
    if (kind === 'metadata') restored.constraints[0].validated = false;
    if (kind === 'table-grant') restored.tableGrants.push(extra());
    if (kind === 'source-contract') source.migrations = [];
    vi.spyOn(collector, 'collectLocalGate4Evidence').mockReturnValue(restored);
    expect(runGate4(repositoryRoot, identity, source).sourceComparisonClassification).toBe('GATE4_DRIFT');
  });

  it('rejects truncated comparisons, other changedFields and reversed pairs', () => {
    const { source, restored } = constraintEvidence();
    const comparison = compareGate4Evidence(restored, source);
    for (const rejected of [
      { ...comparison, differences: comparison.differences.slice(0, 1) },
      { ...comparison, differences: comparison.differences.map(d => ({ ...d, changedFields: ['validated'] })) },
    ]) {
      expect(constraintRenderingDifferencesAreExpected({ sourceEvidence: source, restoredEvidence: restored, comparison: rejected })).toBe(false);
    }
    expect(constraintRenderingDifferencesAreExpected({ sourceEvidence: restored, restoredEvidence: source,
      comparison: compareGate4Evidence(source, restored) })).toBe(false);
  });

  it('permits only existing safe catalog canonicalization and never exposes definition values', () => {
    const { source, restored } = constraintEvidence();
    source.constraints[0].definition = source.constraints[0].definition.replaceAll('length(', 'pg_catalog.length(\n');
    vi.spyOn(collector, 'collectLocalGate4Evidence').mockReturnValue(restored);
    expect(runGate4(repositoryRoot, identity, source).constraintRenderingPairCount).toBe(5);
    source.constraints[0].definition = "CHECK (private_marker_function('PRIVATE_DEFINITION_VALUE'))";
    const result = runGate4(repositoryRoot, identity, source);
    expect(result.sourceComparisonClassification).toBe('GATE4_DRIFT');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_DEFINITION_VALUE');
  });
});
