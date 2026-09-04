import {
  ALL_REQUIRED_TABLES,
  REQUIRED_RPC_NAMES,
  REQUIRED_RPC_SIGNATURES,
  REQUIRED_STORAGE_BUCKETS,
} from './hostedDeploymentReadiness';

export const GATE4_EVIDENCE_FORMAT = 'gate4-schema-evidence/v1' as const;

const EXECUTION_CONTROL_SCHEMA = 'assistive_execution_control';
const DISPATCHER_ROLE = 'capstone_assistive_dispatcher';
const EXECUTION_CONTROL_TABLES = [
  'executor_registrations',
  'launch_budget_guard',
  'launch_reservations',
] as const;
const RELEVANT_ROLES = ['public', 'anon', 'authenticated', 'service_role', DISPATCHER_ROLE] as const;
const MAX_VALIDATION_ERRORS = 50;
const MAX_REPORTED_DIFFERENCES = 50;

type RelevantRole = (typeof RELEVANT_ROLES)[number];

export interface Gate4RoleEvidence {
  name: Exclude<RelevantRole, 'public'>;
  exists: boolean;
  canLogin: boolean;
  inherits: boolean;
  bypassRls: boolean;
  superuser: boolean;
}

export interface Gate4TableEvidence {
  schema: string;
  name: string;
  kind: 'table' | 'partitioned_table';
}

export interface Gate4ColumnEvidence {
  schema: string;
  table: string;
  name: string;
  ordinal: number;
  dataType: string;
  arrayElementType: string | null;
  nullable: boolean;
  identity: '' | 'a' | 'd';
  generated: '' | 's';
  defaultExpression: string | null;
}

export interface Gate4ConstraintEvidence {
  schema: string;
  table: string;
  name: string;
  type: 'primary_key' | 'unique' | 'foreign_key' | 'check';
  definition: string;
  deferrable: boolean;
  initiallyDeferred: boolean;
  validated: boolean;
}

export interface Gate4RlsEvidence {
  schema: string;
  table: string;
  enabled: boolean;
  forced: boolean;
}

export interface Gate4PolicyEvidence {
  schema: string;
  table: string;
  name: string;
  permissive: boolean;
  command: 'all' | 'select' | 'insert' | 'update' | 'delete';
  roles: string[];
  usingExpression: string | null;
  withCheckExpression: string | null;
}

export interface Gate4TableGrantEvidence {
  schema: string;
  table: string;
  role: RelevantRole;
  privilege: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE' | 'REFERENCES' | 'TRIGGER' | 'MAINTAIN';
  grantable: boolean;
}

export interface Gate4SchemaGrantEvidence {
  schema: string;
  role: RelevantRole;
  privilege: 'USAGE' | 'CREATE';
  grantable: boolean;
}

export interface Gate4ExecuteGrantEvidence {
  role: RelevantRole;
  grantable: boolean;
}

export interface Gate4FunctionEvidence {
  schema: string;
  name: string;
  kind: 'function' | 'procedure';
  argumentNames: string[];
  argumentTypes: string[];
  returnType: string;
  securityDefiner: boolean;
  configuration: string[];
  executeGrants: Gate4ExecuteGrantEvidence[];
  classification: 'application_rpc' | 'canonical_helper' | 'dispatcher_control' | 'other_exposed_routine';
}

export interface Gate4StorageBucketEvidence {
  id: string;
  name: string;
  public: boolean;
  fileSizeLimit: number | null;
  allowedMimeTypes: string[] | null;
}

export interface Gate4SchemaEvidence {
  formatVersion: typeof GATE4_EVIDENCE_FORMAT;
  roles: Gate4RoleEvidence[];
  migrations: string[];
  tables: Gate4TableEvidence[];
  columns: Gate4ColumnEvidence[];
  constraints: Gate4ConstraintEvidence[];
  rls: Gate4RlsEvidence[];
  policies: Gate4PolicyEvidence[];
  tableGrants: Gate4TableGrantEvidence[];
  schemaGrants: Gate4SchemaGrantEvidence[];
  functions: Gate4FunctionEvidence[];
  storageBuckets: Gate4StorageBucketEvidence[];
}

export type Gate4Classification = 'GATE4_MATCH' | 'GATE4_DRIFT' | 'EVIDENCE_INVALID';

export interface Gate4Difference {
  category: Gate4Category;
  key: string;
  kind: 'MISSING' | 'UNEXPECTED' | 'CHANGED';
  changedFields?: string[];
}

export type Gate4Category =
  | 'ROLES'
  | 'MIGRATIONS'
  | 'TABLES'
  | 'COLUMNS'
  | 'CONSTRAINTS'
  | 'RLS'
  | 'POLICIES'
  | 'TABLE_GRANTS'
  | 'SCHEMA_GRANTS'
  | 'FUNCTIONS'
  | 'STORAGE_BUCKETS';

export interface Gate4EvidenceStats {
  migrations: number;
  tables: number;
  columns: number;
  constraints: number;
  policies: number;
  applicationRpcSignatures: number;
  applicationRpcNames: number;
  canonicalStaffRoleHelpers: number;
  dispatcherControlRoutines: number;
  storageBuckets: number;
}

export interface Gate4ComparisonResult {
  classification: Gate4Classification;
  validationErrors: string[];
  differences: Gate4Difference[];
  totalDifferences: number;
  expectedStats?: Gate4EvidenceStats;
  actualStats?: Gate4EvidenceStats;
  categoryMatches: Partial<Record<Gate4Category, boolean>>;
}

type ParseResult =
  | { ok: true; evidence: Gate4SchemaEvidence }
  | { ok: false; errors: string[] };

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function extractQuotedSqlSegments(input: string): { masked: string; literals: string[] } {
  const literals: string[] = [];
  let masked = '';
  let index = 0;

  while (index < input.length) {
    const quote = input[index];
    if (quote !== "'" && quote !== '"') {
      masked += quote;
      index += 1;
      continue;
    }

    const start = index;
    index += 1;
    while (index < input.length) {
      if (input[index] !== quote) {
        index += 1;
        continue;
      }
      if (input[index + 1] === quote) {
        index += 2;
        continue;
      }
      index += 1;
      break;
    }
    const marker = `\u0000${literals.length}\u0000`;
    literals.push(input.slice(start, index));
    masked += marker;
  }

  return { masked, literals };
}

function restoreQuotedSqlSegments(masked: string, literals: readonly string[]): string {
  return masked.replace(/\u0000(\d+)\u0000/g, (_match, rawIndex: string) => literals[Number(rawIndex)] ?? '');
}

function hasSingleOuterParentheses(value: string): boolean {
  if (!value.startsWith('(') || !value.endsWith(')')) return false;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '(') depth += 1;
    if (value[index] === ')') depth -= 1;
    if (depth === 0 && index < value.length - 1) return false;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/** Narrow SQL normalization used only for catalog-rendered expressions. */
export function canonicalizeSqlExpression(expression: string): string {
  const { masked, literals } = extractQuotedSqlSegments(expression.trim());
  let normalized = masked
    .toLowerCase()
    .replace(/\bpg_catalog\./g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*::\s*/g, '::')
    .replace(/\s*([(),=<>+*/-])\s*/g, '$1')
    .replace(/::int2\b/g, '::smallint')
    .replace(/::int4\b/g, '::integer')
    .replace(/::int8\b/g, '::bigint')
    .replace(/::bool\b/g, '::boolean')
    .replace(/::timestamptz\b/g, '::timestamp with time zone')
    .trim();

  while (hasSingleOuterParentheses(normalized)) normalized = normalized.slice(1, -1).trim();
  return restoreQuotedSqlSegments(normalized, literals);
}

/** PostgreSQL catalog and API aliases are normalized only when they name the same built-in type. */
export function canonicalizePostgresType(type: string): string {
  const normalized = type.trim().toLowerCase().replace(/^pg_catalog\./, '').replace(/\s+/g, ' ');
  const arrayMatch = normalized.match(/^(.*?)(\[\])$/);
  const base = arrayMatch?.[1] ?? normalized;
  const suffix = arrayMatch?.[2] ?? '';
  const aliases: Record<string, string> = {
    int2: 'smallint',
    int4: 'integer',
    int8: 'bigint',
    float4: 'real',
    float8: 'double precision',
    bool: 'boolean',
    varchar: 'character varying',
    timestamptz: 'timestamp with time zone',
    timestamp: 'timestamp without time zone',
  };
  const varchar = base.match(/^varchar\((\d+)\)$/);
  const canonicalBase = varchar ? `character varying(${varchar[1]})` : aliases[base] ?? base;
  return `${canonicalBase}${suffix}`;
}

function canonicalizeEvidence(evidence: Gate4SchemaEvidence): Gate4SchemaEvidence {
  return {
    ...evidence,
    roles: [...evidence.roles].sort((left, right) => left.name.localeCompare(right.name)),
    migrations: [...evidence.migrations].sort((left, right) => left.localeCompare(right)),
    tables: [...evidence.tables].sort((left, right) => tableKey(left).localeCompare(tableKey(right))),
    columns: evidence.columns
      .map((column) => ({
        ...column,
        dataType: canonicalizePostgresType(column.dataType),
        arrayElementType: column.arrayElementType === null ? null : canonicalizePostgresType(column.arrayElementType),
        defaultExpression: column.defaultExpression === null ? null : canonicalizeSqlExpression(column.defaultExpression),
      }))
      .sort((left, right) => columnKey(left).localeCompare(columnKey(right))),
    constraints: evidence.constraints
      .map((constraint) => ({ ...constraint, definition: canonicalizeSqlExpression(constraint.definition) }))
      .sort((left, right) => constraintKey(left).localeCompare(constraintKey(right))),
    rls: [...evidence.rls].sort((left, right) => rlsKey(left).localeCompare(rlsKey(right))),
    policies: evidence.policies
      .map((policy) => ({
        ...policy,
        roles: sortedUnique(policy.roles.map((role) => role.toLowerCase())),
        usingExpression: policy.usingExpression === null ? null : canonicalizeSqlExpression(policy.usingExpression),
        withCheckExpression: policy.withCheckExpression === null ? null : canonicalizeSqlExpression(policy.withCheckExpression),
      }))
      .sort((left, right) => policyKey(left).localeCompare(policyKey(right))),
    tableGrants: evidence.tableGrants
      .map((grant) => ({ ...grant, role: grant.role.toLowerCase() as RelevantRole, privilege: grant.privilege.toUpperCase() as Gate4TableGrantEvidence['privilege'] }))
      .sort((left, right) => tableGrantKey(left).localeCompare(tableGrantKey(right))),
    schemaGrants: evidence.schemaGrants
      .map((grant) => ({ ...grant, role: grant.role.toLowerCase() as RelevantRole, privilege: grant.privilege.toUpperCase() as Gate4SchemaGrantEvidence['privilege'] }))
      .sort((left, right) => schemaGrantKey(left).localeCompare(schemaGrantKey(right))),
    functions: evidence.functions
      .map((routine) => ({
        ...routine,
        argumentTypes: routine.argumentTypes.map(canonicalizePostgresType),
        returnType: canonicalizePostgresType(routine.returnType),
        configuration: [...routine.configuration].map((entry) => entry.trim()).sort((left, right) => left.localeCompare(right)),
        executeGrants: [...routine.executeGrants]
          .map((grant) => ({ ...grant, role: grant.role.toLowerCase() as RelevantRole }))
          .sort((left, right) => left.role.localeCompare(right.role)),
      }))
      .sort((left, right) => functionKey(left).localeCompare(functionKey(right))),
    storageBuckets: evidence.storageBuckets
      .map((bucket) => ({
        ...bucket,
        allowedMimeTypes: bucket.allowedMimeTypes === null
          ? null
          : sortedUnique(bucket.allowedMimeTypes.map((mimeType) => mimeType.trim().toLowerCase())),
      }))
      .sort((left, right) => bucketKey(left).localeCompare(bucketKey(right))),
  };
}

function tableKey(row: Gate4TableEvidence): string {
  return `${row.schema}.${row.name}`;
}

function columnKey(row: Gate4ColumnEvidence): string {
  return `${row.schema}.${row.table}.${String(row.ordinal).padStart(5, '0')}:${row.name}`;
}

function constraintKey(row: Gate4ConstraintEvidence): string {
  return `${row.schema}.${row.table}.${row.name}`;
}

function rlsKey(row: Gate4RlsEvidence): string {
  return `${row.schema}.${row.table}`;
}

function policyKey(row: Gate4PolicyEvidence): string {
  return `${row.schema}.${row.table}.${row.name}`;
}

function tableGrantKey(row: Gate4TableGrantEvidence): string {
  return `${row.schema}.${row.table}.${row.role}.${row.privilege}`;
}

function schemaGrantKey(row: Gate4SchemaGrantEvidence): string {
  return `${row.schema}.${row.role}.${row.privilege}`;
}

function functionKey(row: Gate4FunctionEvidence): string {
  return `${row.schema}.${row.name}(${row.argumentTypes.map(canonicalizePostgresType).join(',')})`;
}

function bucketKey(row: Gate4StorageBucketEvidence): string {
  return row.id;
}

function addError(errors: string[], message: string): void {
  if (errors.length < MAX_VALIDATION_ERRORS) errors.push(message);
}

function exactKeys(value: JsonObject, keys: readonly string[], path: string, errors: string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    addError(errors, `${path} has missing or unknown fields.`);
  }
}

function requireString(value: unknown, path: string, errors: string[], allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    addError(errors, `${path} must be ${allowEmpty ? 'a string' : 'a non-empty string'}.`);
    return '';
  }
  return value;
}

function requireBoolean(value: unknown, path: string, errors: string[]): boolean {
  if (typeof value !== 'boolean') {
    addError(errors, `${path} must be a boolean.`);
    return false;
  }
  return value;
}

function requireStringArray(value: unknown, path: string, errors: string[], unique = true): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    addError(errors, `${path} must be a string array.`);
    return [];
  }
  const entries = value as string[];
  if (unique && new Set(entries).size !== entries.length) addError(errors, `${path} contains duplicate values.`);
  return [...entries];
}

function requireNullableString(value: unknown, path: string, errors: string[]): string | null {
  if (value !== null && typeof value !== 'string') {
    addError(errors, `${path} must be a string or null.`);
    return null;
  }
  return value;
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], path: string, errors: string[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    addError(errors, `${path} has an unsupported value.`);
    return allowed[0];
  }
  return value as T;
}

function requireRows(value: unknown, path: string, errors: string[]): unknown[] {
  if (!Array.isArray(value)) {
    addError(errors, `${path} must be an array.`);
    return [];
  }
  return value;
}

function requireObject(value: unknown, path: string, errors: string[]): JsonObject {
  if (!isObject(value)) {
    addError(errors, `${path} must be an object.`);
    return {};
  }
  return value;
}

function checkDuplicateKeys<T>(rows: readonly T[], keyOf: (row: T) => string, path: string, errors: string[]): void {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = keyOf(row);
    if (seen.has(key)) addError(errors, `${path} contains duplicate key ${key}.`);
    seen.add(key);
  }
}

/** Strictly validates a raw snapshot. Missing categories and duplicate catalog identities fail closed. */
export function parseGate4Evidence(input: unknown): ParseResult {
  const errors: string[] = [];
  if (!isObject(input)) return { ok: false, errors: ['Evidence root must be an object.'] };
  exactKeys(input, [
    'formatVersion', 'roles', 'migrations', 'tables', 'columns', 'constraints', 'rls', 'policies',
    'tableGrants', 'schemaGrants', 'functions', 'storageBuckets',
  ], 'evidence', errors);

  if (input.formatVersion !== GATE4_EVIDENCE_FORMAT) addError(errors, 'evidence.formatVersion is unsupported.');

  const roles = requireRows(input.roles, 'evidence.roles', errors).map((raw, index): Gate4RoleEvidence => {
    const row = requireObject(raw, `evidence.roles[${index}]`, errors);
    exactKeys(row, ['name', 'exists', 'canLogin', 'inherits', 'bypassRls', 'superuser'], `evidence.roles[${index}]`, errors);
    return {
      name: requireEnum(row.name, ['anon', 'authenticated', 'service_role', DISPATCHER_ROLE] as const, `evidence.roles[${index}].name`, errors),
      exists: requireBoolean(row.exists, `evidence.roles[${index}].exists`, errors),
      canLogin: requireBoolean(row.canLogin, `evidence.roles[${index}].canLogin`, errors),
      inherits: requireBoolean(row.inherits, `evidence.roles[${index}].inherits`, errors),
      bypassRls: requireBoolean(row.bypassRls, `evidence.roles[${index}].bypassRls`, errors),
      superuser: requireBoolean(row.superuser, `evidence.roles[${index}].superuser`, errors),
    };
  });

  const migrations = requireStringArray(input.migrations, 'evidence.migrations', errors);
  migrations.forEach((version, index) => {
    if (!/^\d{14}$/.test(version)) addError(errors, `evidence.migrations[${index}] must be a 14-digit version.`);
  });

  const tables = requireRows(input.tables, 'evidence.tables', errors).map((raw, index): Gate4TableEvidence => {
    const row = requireObject(raw, `evidence.tables[${index}]`, errors);
    exactKeys(row, ['schema', 'name', 'kind'], `evidence.tables[${index}]`, errors);
    return {
      schema: requireString(row.schema, `evidence.tables[${index}].schema`, errors),
      name: requireString(row.name, `evidence.tables[${index}].name`, errors),
      kind: requireEnum(row.kind, ['table', 'partitioned_table'] as const, `evidence.tables[${index}].kind`, errors),
    };
  });

  const columns = requireRows(input.columns, 'evidence.columns', errors).map((raw, index): Gate4ColumnEvidence => {
    const row = requireObject(raw, `evidence.columns[${index}]`, errors);
    exactKeys(row, ['schema', 'table', 'name', 'ordinal', 'dataType', 'arrayElementType', 'nullable', 'identity', 'generated', 'defaultExpression'], `evidence.columns[${index}]`, errors);
    const ordinal = typeof row.ordinal === 'number' && Number.isInteger(row.ordinal) && row.ordinal > 0 ? row.ordinal : 0;
    if (ordinal === 0) addError(errors, `evidence.columns[${index}].ordinal must be a positive integer.`);
    return {
      schema: requireString(row.schema, `evidence.columns[${index}].schema`, errors),
      table: requireString(row.table, `evidence.columns[${index}].table`, errors),
      name: requireString(row.name, `evidence.columns[${index}].name`, errors),
      ordinal,
      dataType: requireString(row.dataType, `evidence.columns[${index}].dataType`, errors),
      arrayElementType: requireNullableString(row.arrayElementType, `evidence.columns[${index}].arrayElementType`, errors),
      nullable: requireBoolean(row.nullable, `evidence.columns[${index}].nullable`, errors),
      identity: requireEnum(row.identity, ['', 'a', 'd'] as const, `evidence.columns[${index}].identity`, errors),
      generated: requireEnum(row.generated, ['', 's'] as const, `evidence.columns[${index}].generated`, errors),
      defaultExpression: requireNullableString(row.defaultExpression, `evidence.columns[${index}].defaultExpression`, errors),
    };
  });

  const constraints = requireRows(input.constraints, 'evidence.constraints', errors).map((raw, index): Gate4ConstraintEvidence => {
    const row = requireObject(raw, `evidence.constraints[${index}]`, errors);
    exactKeys(row, ['schema', 'table', 'name', 'type', 'definition', 'deferrable', 'initiallyDeferred', 'validated'], `evidence.constraints[${index}]`, errors);
    return {
      schema: requireString(row.schema, `evidence.constraints[${index}].schema`, errors),
      table: requireString(row.table, `evidence.constraints[${index}].table`, errors),
      name: requireString(row.name, `evidence.constraints[${index}].name`, errors),
      type: requireEnum(row.type, ['primary_key', 'unique', 'foreign_key', 'check'] as const, `evidence.constraints[${index}].type`, errors),
      definition: requireString(row.definition, `evidence.constraints[${index}].definition`, errors),
      deferrable: requireBoolean(row.deferrable, `evidence.constraints[${index}].deferrable`, errors),
      initiallyDeferred: requireBoolean(row.initiallyDeferred, `evidence.constraints[${index}].initiallyDeferred`, errors),
      validated: requireBoolean(row.validated, `evidence.constraints[${index}].validated`, errors),
    };
  });

  const rls = requireRows(input.rls, 'evidence.rls', errors).map((raw, index): Gate4RlsEvidence => {
    const row = requireObject(raw, `evidence.rls[${index}]`, errors);
    exactKeys(row, ['schema', 'table', 'enabled', 'forced'], `evidence.rls[${index}]`, errors);
    return {
      schema: requireString(row.schema, `evidence.rls[${index}].schema`, errors),
      table: requireString(row.table, `evidence.rls[${index}].table`, errors),
      enabled: requireBoolean(row.enabled, `evidence.rls[${index}].enabled`, errors),
      forced: requireBoolean(row.forced, `evidence.rls[${index}].forced`, errors),
    };
  });

  const policies = requireRows(input.policies, 'evidence.policies', errors).map((raw, index): Gate4PolicyEvidence => {
    const row = requireObject(raw, `evidence.policies[${index}]`, errors);
    exactKeys(row, ['schema', 'table', 'name', 'permissive', 'command', 'roles', 'usingExpression', 'withCheckExpression'], `evidence.policies[${index}]`, errors);
    return {
      schema: requireString(row.schema, `evidence.policies[${index}].schema`, errors),
      table: requireString(row.table, `evidence.policies[${index}].table`, errors),
      name: requireString(row.name, `evidence.policies[${index}].name`, errors),
      permissive: requireBoolean(row.permissive, `evidence.policies[${index}].permissive`, errors),
      command: requireEnum(row.command, ['all', 'select', 'insert', 'update', 'delete'] as const, `evidence.policies[${index}].command`, errors),
      roles: requireStringArray(row.roles, `evidence.policies[${index}].roles`, errors),
      usingExpression: requireNullableString(row.usingExpression, `evidence.policies[${index}].usingExpression`, errors),
      withCheckExpression: requireNullableString(row.withCheckExpression, `evidence.policies[${index}].withCheckExpression`, errors),
    };
  });

  const tableGrants = requireRows(input.tableGrants, 'evidence.tableGrants', errors).map((raw, index): Gate4TableGrantEvidence => {
    const row = requireObject(raw, `evidence.tableGrants[${index}]`, errors);
    exactKeys(row, ['schema', 'table', 'role', 'privilege', 'grantable'], `evidence.tableGrants[${index}]`, errors);
    return {
      schema: requireString(row.schema, `evidence.tableGrants[${index}].schema`, errors),
      table: requireString(row.table, `evidence.tableGrants[${index}].table`, errors),
      role: requireEnum(row.role, RELEVANT_ROLES, `evidence.tableGrants[${index}].role`, errors),
      privilege: requireEnum(row.privilege, ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] as const, `evidence.tableGrants[${index}].privilege`, errors),
      grantable: requireBoolean(row.grantable, `evidence.tableGrants[${index}].grantable`, errors),
    };
  });

  const schemaGrants = requireRows(input.schemaGrants, 'evidence.schemaGrants', errors).map((raw, index): Gate4SchemaGrantEvidence => {
    const row = requireObject(raw, `evidence.schemaGrants[${index}]`, errors);
    exactKeys(row, ['schema', 'role', 'privilege', 'grantable'], `evidence.schemaGrants[${index}]`, errors);
    return {
      schema: requireString(row.schema, `evidence.schemaGrants[${index}].schema`, errors),
      role: requireEnum(row.role, RELEVANT_ROLES, `evidence.schemaGrants[${index}].role`, errors),
      privilege: requireEnum(row.privilege, ['USAGE', 'CREATE'] as const, `evidence.schemaGrants[${index}].privilege`, errors),
      grantable: requireBoolean(row.grantable, `evidence.schemaGrants[${index}].grantable`, errors),
    };
  });

  const functions = requireRows(input.functions, 'evidence.functions', errors).map((raw, index): Gate4FunctionEvidence => {
    const row = requireObject(raw, `evidence.functions[${index}]`, errors);
    exactKeys(row, ['schema', 'name', 'kind', 'argumentNames', 'argumentTypes', 'returnType', 'securityDefiner', 'configuration', 'executeGrants', 'classification'], `evidence.functions[${index}]`, errors);
    const executeGrants = requireRows(row.executeGrants, `evidence.functions[${index}].executeGrants`, errors).map((rawGrant, grantIndex): Gate4ExecuteGrantEvidence => {
      const grant = requireObject(rawGrant, `evidence.functions[${index}].executeGrants[${grantIndex}]`, errors);
      exactKeys(grant, ['role', 'grantable'], `evidence.functions[${index}].executeGrants[${grantIndex}]`, errors);
      return {
        role: requireEnum(grant.role, RELEVANT_ROLES, `evidence.functions[${index}].executeGrants[${grantIndex}].role`, errors),
        grantable: requireBoolean(grant.grantable, `evidence.functions[${index}].executeGrants[${grantIndex}].grantable`, errors),
      };
    });
    checkDuplicateKeys(executeGrants, (grant) => grant.role, `evidence.functions[${index}].executeGrants`, errors);
    const argumentNames = requireStringArray(row.argumentNames, `evidence.functions[${index}].argumentNames`, errors, false);
    const argumentTypes = requireStringArray(row.argumentTypes, `evidence.functions[${index}].argumentTypes`, errors, false);
    if (argumentNames.length !== argumentTypes.length) addError(errors, `evidence.functions[${index}] argument name/type counts differ.`);
    return {
      schema: requireString(row.schema, `evidence.functions[${index}].schema`, errors),
      name: requireString(row.name, `evidence.functions[${index}].name`, errors),
      kind: requireEnum(row.kind, ['function', 'procedure'] as const, `evidence.functions[${index}].kind`, errors),
      argumentNames,
      argumentTypes,
      returnType: requireString(row.returnType, `evidence.functions[${index}].returnType`, errors),
      securityDefiner: requireBoolean(row.securityDefiner, `evidence.functions[${index}].securityDefiner`, errors),
      configuration: requireStringArray(row.configuration, `evidence.functions[${index}].configuration`, errors),
      executeGrants,
      classification: requireEnum(row.classification, ['application_rpc', 'canonical_helper', 'dispatcher_control', 'other_exposed_routine'] as const, `evidence.functions[${index}].classification`, errors),
    };
  });

  const storageBuckets = requireRows(input.storageBuckets, 'evidence.storageBuckets', errors).map((raw, index): Gate4StorageBucketEvidence => {
    const row = requireObject(raw, `evidence.storageBuckets[${index}]`, errors);
    exactKeys(row, ['id', 'name', 'public', 'fileSizeLimit', 'allowedMimeTypes'], `evidence.storageBuckets[${index}]`, errors);
    let fileSizeLimit: number | null = null;
    if (row.fileSizeLimit !== null) {
      if (typeof row.fileSizeLimit !== 'number' || !Number.isSafeInteger(row.fileSizeLimit) || row.fileSizeLimit < 0) {
        addError(errors, `evidence.storageBuckets[${index}].fileSizeLimit must be a non-negative integer or null.`);
      } else {
        fileSizeLimit = row.fileSizeLimit;
      }
    }
    return {
      id: requireString(row.id, `evidence.storageBuckets[${index}].id`, errors),
      name: requireString(row.name, `evidence.storageBuckets[${index}].name`, errors),
      public: requireBoolean(row.public, `evidence.storageBuckets[${index}].public`, errors),
      fileSizeLimit,
      allowedMimeTypes: row.allowedMimeTypes === null
        ? null
        : requireStringArray(row.allowedMimeTypes, `evidence.storageBuckets[${index}].allowedMimeTypes`, errors),
    };
  });

  checkDuplicateKeys(roles, (row) => row.name, 'evidence.roles', errors);
  checkDuplicateKeys(tables, tableKey, 'evidence.tables', errors);
  checkDuplicateKeys(columns, columnKey, 'evidence.columns', errors);
  checkDuplicateKeys(constraints, constraintKey, 'evidence.constraints', errors);
  checkDuplicateKeys(rls, rlsKey, 'evidence.rls', errors);
  checkDuplicateKeys(policies, policyKey, 'evidence.policies', errors);
  checkDuplicateKeys(tableGrants, tableGrantKey, 'evidence.tableGrants', errors);
  checkDuplicateKeys(schemaGrants, schemaGrantKey, 'evidence.schemaGrants', errors);
  checkDuplicateKeys(functions, functionKey, 'evidence.functions', errors);
  checkDuplicateKeys(storageBuckets, bucketKey, 'evidence.storageBuckets', errors);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    evidence: {
      formatVersion: GATE4_EVIDENCE_FORMAT,
      roles,
      migrations,
      tables,
      columns,
      constraints,
      rls,
      policies,
      tableGrants,
      schemaGrants,
      functions,
      storageBuckets,
    },
  };
}

function changedFields(expected: JsonObject, actual: JsonObject): string[] {
  return sortedUnique([...Object.keys(expected), ...Object.keys(actual)]).filter(
    (field) => JSON.stringify(expected[field]) !== JSON.stringify(actual[field]),
  );
}

function compareRows<T extends JsonObject>(
  category: Gate4Category,
  expected: readonly T[],
  actual: readonly T[],
  keyOf: (row: T) => string,
): Gate4Difference[] {
  const expectedByKey = new Map(expected.map((row) => [keyOf(row), row]));
  const actualByKey = new Map(actual.map((row) => [keyOf(row), row]));
  const keys = sortedUnique([...expectedByKey.keys(), ...actualByKey.keys()]);
  const differences: Gate4Difference[] = [];
  for (const key of keys) {
    const expectedRow = expectedByKey.get(key);
    const actualRow = actualByKey.get(key);
    if (!actualRow) differences.push({ category, key, kind: 'MISSING' });
    else if (!expectedRow) differences.push({ category, key, kind: 'UNEXPECTED' });
    else if (JSON.stringify(expectedRow) !== JSON.stringify(actualRow)) {
      differences.push({ category, key, kind: 'CHANGED', changedFields: changedFields(expectedRow, actualRow) });
    }
  }
  return differences;
}

function compareStrings(category: Gate4Category, expected: readonly string[], actual: readonly string[]): Gate4Difference[] {
  return compareRows(
    category,
    expected.map((value) => ({ value })),
    actual.map((value) => ({ value })),
    (row) => row.value,
  );
}

export function gate4EvidenceStats(evidence: Gate4SchemaEvidence): Gate4EvidenceStats {
  const applicationRpcs = evidence.functions.filter((routine) => routine.classification === 'application_rpc');
  return {
    migrations: evidence.migrations.length,
    tables: evidence.tables.length,
    columns: evidence.columns.length,
    constraints: evidence.constraints.length,
    policies: evidence.policies.length,
    applicationRpcSignatures: applicationRpcs.length,
    applicationRpcNames: new Set(applicationRpcs.map((routine) => routine.name)).size,
    canonicalStaffRoleHelpers: evidence.functions.filter((routine) => routine.classification === 'canonical_helper').length,
    dispatcherControlRoutines: evidence.functions.filter((routine) => routine.classification === 'dispatcher_control').length,
    storageBuckets: evidence.storageBuckets.length,
  };
}

/** Compares two complete snapshots and never converts malformed evidence into a match. */
export function compareGate4Evidence(
  expectedInput: unknown,
  actualInput: unknown,
  maxReportedDifferences = MAX_REPORTED_DIFFERENCES,
): Gate4ComparisonResult {
  if (!Number.isSafeInteger(maxReportedDifferences)
    || maxReportedDifferences < 1
    || maxReportedDifferences > 5_000) {
    throw new Error('GATE4_DIFFERENCE_LIMIT_INVALID');
  }
  const expectedParsed = parseGate4Evidence(expectedInput);
  const actualParsed = parseGate4Evidence(actualInput);
  const validationErrors = [
    ...(expectedParsed.ok ? [] : expectedParsed.errors.map((error) => `expected: ${error}`)),
    ...(actualParsed.ok ? [] : actualParsed.errors.map((error) => `actual: ${error}`)),
  ];
  if (!expectedParsed.ok || !actualParsed.ok) {
    return {
      classification: 'EVIDENCE_INVALID',
      validationErrors: validationErrors.slice(0, MAX_VALIDATION_ERRORS),
      differences: [],
      totalDifferences: 0,
      categoryMatches: {},
    };
  }

  const expected = canonicalizeEvidence(expectedParsed.evidence);
  const actual = canonicalizeEvidence(actualParsed.evidence);
  const byCategory: Array<[Gate4Category, Gate4Difference[]]> = [
    ['ROLES', compareRows('ROLES', expected.roles as unknown as JsonObject[], actual.roles as unknown as JsonObject[], (row) => String(row.name))],
    ['MIGRATIONS', compareStrings('MIGRATIONS', expected.migrations, actual.migrations)],
    ['TABLES', compareRows('TABLES', expected.tables as unknown as JsonObject[], actual.tables as unknown as JsonObject[], (row) => `${String(row.schema)}.${String(row.name)}`)],
    ['COLUMNS', compareRows('COLUMNS', expected.columns as unknown as JsonObject[], actual.columns as unknown as JsonObject[], (row) => `${String(row.schema)}.${String(row.table)}.${String(row.ordinal).padStart(5, '0')}:${String(row.name)}`)],
    ['CONSTRAINTS', compareRows('CONSTRAINTS', expected.constraints as unknown as JsonObject[], actual.constraints as unknown as JsonObject[], (row) => `${String(row.schema)}.${String(row.table)}.${String(row.name)}`)],
    ['RLS', compareRows('RLS', expected.rls as unknown as JsonObject[], actual.rls as unknown as JsonObject[], (row) => `${String(row.schema)}.${String(row.table)}`)],
    ['POLICIES', compareRows('POLICIES', expected.policies as unknown as JsonObject[], actual.policies as unknown as JsonObject[], (row) => `${String(row.schema)}.${String(row.table)}.${String(row.name)}`)],
    ['TABLE_GRANTS', compareRows('TABLE_GRANTS', expected.tableGrants as unknown as JsonObject[], actual.tableGrants as unknown as JsonObject[], (row) => `${String(row.schema)}.${String(row.table)}.${String(row.role)}.${String(row.privilege)}`)],
    ['SCHEMA_GRANTS', compareRows('SCHEMA_GRANTS', expected.schemaGrants as unknown as JsonObject[], actual.schemaGrants as unknown as JsonObject[], (row) => `${String(row.schema)}.${String(row.role)}.${String(row.privilege)}`)],
    ['FUNCTIONS', compareRows('FUNCTIONS', expected.functions as unknown as JsonObject[], actual.functions as unknown as JsonObject[], (row) => `${String(row.schema)}.${String(row.name)}(${(row.argumentTypes as string[]).join(',')})`)],
    ['STORAGE_BUCKETS', compareRows('STORAGE_BUCKETS', expected.storageBuckets as unknown as JsonObject[], actual.storageBuckets as unknown as JsonObject[], (row) => String(row.id))],
  ];
  const allDifferences = byCategory.flatMap(([, differences]) => differences);
  const categoryMatches = Object.fromEntries(byCategory.map(([category, differences]) => [category, differences.length === 0]));
  return {
    classification: allDifferences.length === 0 ? 'GATE4_MATCH' : 'GATE4_DRIFT',
    validationErrors: [],
    differences: allDifferences.slice(0, maxReportedDifferences),
    totalDifferences: allDifferences.length,
    expectedStats: gate4EvidenceStats(expected),
    actualStats: gate4EvidenceStats(actual),
    categoryMatches,
  };
}

function signatureContractKey(name: string, argumentNames: readonly string[], argumentTypes: readonly string[]): string {
  return `${name}(${argumentTypes.map(canonicalizePostgresType).join(',')}):${argumentNames.join(',')}`;
}

/**
 * Checks that the freshly generated Local snapshot is the current repository release contract.
 * Full database detail still comes from the migrated catalog rather than a checked-in duplicate.
 */
export function validateCurrentRepositoryGate4Contract(
  input: unknown,
  repositoryMigrationVersions: readonly string[],
): string[] {
  const parsed = parseGate4Evidence(input);
  if (!parsed.ok) return parsed.errors;
  const evidence = canonicalizeEvidence(parsed.evidence);
  const errors: string[] = [];
  const tableNames = evidence.tables.filter((table) => table.schema === 'public').map((table) => table.name).sort();
  const requiredTables = [...ALL_REQUIRED_TABLES].sort();
  if (JSON.stringify(tableNames) !== JSON.stringify(requiredTables)) errors.push(`Local table set does not match the authoritative ${ALL_REQUIRED_TABLES.length}-table inventory.`);
  const executionControlTables = evidence.tables
    .filter((table) => table.schema === EXECUTION_CONTROL_SCHEMA)
    .map((table) => table.name)
    .sort();
  if (JSON.stringify(executionControlTables) !== JSON.stringify([...EXECUTION_CONTROL_TABLES].sort())) {
    errors.push('Local execution-control table set does not match the authoritative three-table inventory.');
  }
  if (evidence.tables.some((table) => table.schema !== 'public' && table.schema !== EXECUTION_CONTROL_SCHEMA)) {
    errors.push('Local Gate 4 evidence contains a table outside the authoritative schemas.');
  }
  if (JSON.stringify(evidence.migrations) !== JSON.stringify([...repositoryMigrationVersions].sort())) errors.push('Local migration history does not match the repository migration manifest.');

  const actualApplication = evidence.functions
    .filter((routine) => routine.classification === 'application_rpc')
    .map((routine) => signatureContractKey(routine.name, routine.argumentNames, routine.argumentTypes))
    .sort();
  const requiredApplication = REQUIRED_RPC_SIGNATURES
    .map((routine) => signatureContractKey(routine.name, routine.parameterNames, routine.parameterTypes))
    .sort();
  if (JSON.stringify(actualApplication) !== JSON.stringify(requiredApplication)) {
    errors.push(`Local application RPC signatures do not match the authoritative ${REQUIRED_RPC_SIGNATURES.length}/${REQUIRED_RPC_NAMES.length} inventory.`);
  }
  if (new Set(evidence.functions.filter((routine) => routine.classification === 'application_rpc').map((routine) => routine.name)).size !== REQUIRED_RPC_NAMES.length) {
    errors.push('Local application RPC name count does not match the authoritative inventory.');
  }

  const canonicalHelpers = evidence.functions.filter((routine) => routine.classification === 'canonical_helper');
  if (canonicalHelpers.length !== 1 || signatureContractKey(canonicalHelpers[0].name, canonicalHelpers[0].argumentNames, canonicalHelpers[0].argumentTypes) !== 'canonical_staff_roles(text[]):p_roles') {
    errors.push('canonical_staff_roles is missing, duplicated, or incorrectly classified.');
  }

  const dispatcherRoutines = evidence.functions.filter((routine) => routine.classification === 'dispatcher_control');
  const dispatcherRoutineSignatures = dispatcherRoutines.map((routine) => (
    signatureContractKey(routine.name, routine.argumentNames, routine.argumentTypes)
  )).sort();
  const requiredDispatcherRoutineSignatures = [
    'inspect_assistive_launch_eligibility():',
    'mark_assistive_launch_requested(uuid,bigint):p_reservation_token,p_generation',
    'record_assistive_launch_outcome(uuid,bigint,text,text):p_reservation_token,p_generation,p_outcome,p_execution_reference',
    'reserve_assistive_launch(text,text,text,integer):p_dispatcher_instance_id,p_deployment_version,p_image_digest,p_lease_seconds',
  ].sort();
  if (JSON.stringify(dispatcherRoutineSignatures) !== JSON.stringify(requiredDispatcherRoutineSignatures)) {
    errors.push('Local dispatcher routine signatures do not match the authoritative four-routine inventory.');
  }
  if (dispatcherRoutines.some((routine) => (
    routine.schema !== EXECUTION_CONTROL_SCHEMA
      || routine.kind !== 'function'
      || !routine.securityDefiner
      || !routine.configuration.some((configuration) => configuration.startsWith('search_path='))
      || JSON.stringify(routine.executeGrants) !== JSON.stringify([{ role: DISPATCHER_ROLE, grantable: false }])
  ))) {
    errors.push('Every dispatcher routine must be a search-path-pinned SECURITY DEFINER function executable only by the dispatcher role.');
  }

  const bucketNames = evidence.storageBuckets.map((bucket) => bucket.id).sort();
  if (JSON.stringify(bucketNames) !== JSON.stringify([...REQUIRED_STORAGE_BUCKETS].sort())) errors.push(`Local Storage buckets do not match the authoritative ${REQUIRED_STORAGE_BUCKETS.length}-bucket release inventory.`);
  if (evidence.roles.some((role) => !role.exists)) errors.push('A required runtime role is missing from Local Supabase.');
  const dispatcher = evidence.roles.find((role) => role.name === DISPATCHER_ROLE);
  if (!dispatcher || !dispatcher.canLogin || dispatcher.inherits || dispatcher.bypassRls || dispatcher.superuser) {
    errors.push('The dispatcher role must be LOGIN, NOINHERIT, NOBYPASSRLS, and NOSUPERUSER.');
  }
  if (evidence.rls.length !== evidence.tables.length || evidence.rls.some((table) => !table.enabled)) {
    errors.push('Every required Local catalog table must have RLS enabled.');
  }
  const executionControlRls = evidence.rls.filter((table) => table.schema === EXECUTION_CONTROL_SCHEMA);
  if (executionControlRls.length !== EXECUTION_CONTROL_TABLES.length || executionControlRls.some((table) => !table.forced)) {
    errors.push('Every execution-control table must have forced RLS.');
  }
  if (evidence.tableGrants.some((grant) => grant.schema === EXECUTION_CONTROL_SCHEMA)) {
    errors.push('Execution-control tables must expose no privileges to any relevant runtime role.');
  }
  const executionControlSchemaGrants = evidence.schemaGrants.filter((grant) => grant.schema === EXECUTION_CONTROL_SCHEMA);
  if (JSON.stringify(executionControlSchemaGrants) !== JSON.stringify([{
    schema: EXECUTION_CONTROL_SCHEMA,
    role: DISPATCHER_ROLE,
    privilege: 'USAGE',
    grantable: false,
  }])) {
    errors.push('The execution-control schema must grant only non-grantable USAGE to the dispatcher role.');
  }

  for (const [table, column] of [
    ['projects', 'poster_text_public'],
    ['projects', 'accessibility_text_public'],
    ['projects', 'participant_contact_email'],
    ['media_assets', 'alt_text_public'],
    ['admin_users', 'auth_user_id'],
  ] as const) {
    if (!evidence.columns.some((candidate) => candidate.schema === 'public' && candidate.table === table && candidate.name === column)) {
      errors.push(`Critical Local column public.${table}.${column} is missing.`);
    }
  }
  return errors;
}

function matchLabel(result: Gate4ComparisonResult, categories: readonly Gate4Category[]): 'MATCH' | 'DRIFT' {
  return categories.every((category) => result.categoryMatches[category]) ? 'MATCH' : 'DRIFT';
}

export function formatGate4Comparison(result: Gate4ComparisonResult, repositoryGitSha?: string): string {
  const lines = [
    `GATE4_CLASSIFICATION=${result.classification}`,
    ...(repositoryGitSha ? [`REPOSITORY_GIT_SHA=${repositoryGitSha}`] : []),
  ];
  if (result.classification === 'EVIDENCE_INVALID') {
    lines.push(...result.validationErrors.map((error) => `INVALID=${error}`));
    return lines.join('\n');
  }

  const expected = result.expectedStats!;
  const actual = result.actualStats!;
  lines.push(
    `MIGRATIONS=${actual.migrations}/${expected.migrations}`,
    `TABLES=${actual.tables}/${expected.tables}`,
    `COLUMNS=${matchLabel(result, ['COLUMNS'])}`,
    `CONSTRAINTS=${matchLabel(result, ['CONSTRAINTS'])}`,
    `RLS=${matchLabel(result, ['RLS'])}`,
    `POLICIES=${matchLabel(result, ['POLICIES'])}`,
    `GRANTS=${matchLabel(result, ['ROLES', 'TABLE_GRANTS', 'SCHEMA_GRANTS'])}`,
    `RPC_SIGNATURES=${actual.applicationRpcSignatures}/${expected.applicationRpcSignatures}`,
    `RPC_NAMES=${actual.applicationRpcNames}/${expected.applicationRpcNames}`,
    `CANONICAL_STAFF_ROLES_HELPERS=${actual.canonicalStaffRoleHelpers}/${expected.canonicalStaffRoleHelpers}`,
    `DISPATCHER_CONTROL_ROUTINES=${actual.dispatcherControlRoutines}/${expected.dispatcherControlRoutines}`,
    `STORAGE_BUCKETS=${actual.storageBuckets}/${expected.storageBuckets}`,
  );
  if (result.totalDifferences > 0) {
    lines.push(`DIFFERENCES_REPORTED=${result.differences.length}/${result.totalDifferences}`);
    for (const difference of result.differences) {
      const fields = difference.changedFields?.length ? ` fields=${difference.changedFields.join(',')}` : '';
      lines.push(`DRIFT=${difference.category}:${difference.kind}:${difference.key}${fields}`);
    }
  }
  return lines.join('\n');
}
