import fs from 'node:fs';
import path from 'node:path';
import { RecoveryGuardError } from './zeroCostRecoveryContract';

/**
 * Narrow application-owned recovery boundary inside Supabase-managed schemas.
 *
 * The provider owns the auth and storage schemas. PP1 owns only the objects listed here; recovery
 * must never dump or replace either managed schema wholesale.
 */

export const MANAGED_SCHEMA_CUSTOMIZATION_FORMAT =
  'pp1-managed-schema-customizations/v1' as const;

export type ManagedSchemaName = 'auth' | 'storage';
export type ManagedTriggerTiming = 'BEFORE' | 'AFTER' | 'INSTEAD OF';
export type ManagedTriggerEvent = 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE';
export type ManagedTriggerEnabledState = 'O' | 'D' | 'R' | 'A';

export interface ManagedTriggerEvidence {
  schema: ManagedSchemaName;
  table: string;
  name: string;
  timing: ManagedTriggerTiming;
  events: ManagedTriggerEvent[];
  updateColumns: string[];
  rowLevel: boolean;
  enabled: ManagedTriggerEnabledState;
  functionSchema: string;
  functionName: string;
  internal: false;
  definition: string;
}

export interface ManagedSchemaCustomizationEvidence {
  formatVersion: typeof MANAGED_SCHEMA_CUSTOMIZATION_FORMAT;
  triggers: ManagedTriggerEvidence[];
}

function canonicalTriggerDefinition(definition: string): string {
  return definition
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\bEXECUTE\s+PROCEDURE\b/gi, 'EXECUTE FUNCTION')
    .toLowerCase()
    // pg_get_triggerdef may omit the public qualification under the target search_path. The
    // separately captured functionSchema/functionName fields still prove the exact function OID.
    .replace(/\bexecute function public\./g, 'execute function ');
}

const AUTH_INSERT_TRIGGER: ManagedTriggerEvidence = {
  schema: 'auth',
  table: 'users',
  name: 'claim_staff_provisioning_auth_insert_before_insert',
  timing: 'BEFORE',
  events: ['INSERT'],
  updateColumns: [],
  rowLevel: true,
  enabled: 'O',
  functionSchema: 'public',
  functionName: 'claim_staff_provisioning_auth_insert',
  internal: false,
  definition: canonicalTriggerDefinition(`
    CREATE TRIGGER claim_staff_provisioning_auth_insert_before_insert
    BEFORE INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.claim_staff_provisioning_auth_insert()
  `),
};

const AUTH_METADATA_UPDATE_TRIGGER: ManagedTriggerEvidence = {
  schema: 'auth',
  table: 'users',
  name: 'claim_staff_provisioning_auth_insert_before_metadata_update',
  timing: 'BEFORE',
  events: ['UPDATE'],
  updateColumns: ['raw_user_meta_data'],
  rowLevel: true,
  enabled: 'O',
  functionSchema: 'public',
  functionName: 'claim_staff_provisioning_auth_insert',
  internal: false,
  definition: canonicalTriggerDefinition(`
    CREATE TRIGGER claim_staff_provisioning_auth_insert_before_metadata_update
    BEFORE UPDATE OF raw_user_meta_data ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.claim_staff_provisioning_auth_insert()
  `),
};

export const REPOSITORY_MANAGED_SCHEMA_EXPECTATION: ManagedSchemaCustomizationEvidence = {
  formatVersion: MANAGED_SCHEMA_CUSTOMIZATION_FORMAT,
  triggers: [AUTH_INSERT_TRIGGER, AUTH_METADATA_UPDATE_TRIGGER],
};

export const EXPECTED_MANAGED_AUTH_CUSTOMIZATION_COUNT = 2;
export const EXPECTED_MANAGED_STORAGE_CUSTOMIZATION_COUNT = 0;

const EXPECTED_TRIGGER_NAMES = REPOSITORY_MANAGED_SCHEMA_EXPECTATION.triggers
  .map((trigger) => `'${trigger.name}'`)
  .join(', ');

/**
 * One SELECT-only catalog statement. It reads no Auth identities or Storage rows and returns only
 * the repository-governed trigger names, their structural semantics, enabled state, and function
 * identity.
 */
export function buildManagedSchemaCustomizationEvidenceSql(): string {
  return `
SELECT pg_catalog.jsonb_build_object(
  'formatVersion', '${MANAGED_SCHEMA_CUSTOMIZATION_FORMAT}',
  'triggers', COALESCE((
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'schema', relation_namespace.nspname,
      'table', relation.relname,
      'name', trigger_definition.tgname,
      'timing', CASE
        WHEN (trigger_definition.tgtype::integer & 64) <> 0 THEN 'INSTEAD OF'
        WHEN (trigger_definition.tgtype::integer & 2) <> 0 THEN 'BEFORE'
        ELSE 'AFTER'
      END,
      'events', pg_catalog.to_jsonb(pg_catalog.array_remove(ARRAY[
        CASE WHEN (trigger_definition.tgtype::integer & 4) <> 0 THEN 'INSERT'::text END,
        CASE WHEN (trigger_definition.tgtype::integer & 16) <> 0 THEN 'UPDATE'::text END,
        CASE WHEN (trigger_definition.tgtype::integer & 8) <> 0 THEN 'DELETE'::text END,
        CASE WHEN (trigger_definition.tgtype::integer & 32) <> 0 THEN 'TRUNCATE'::text END
      ], NULL)),
      'updateColumns', COALESCE((
        SELECT pg_catalog.jsonb_agg(attribute.attname ORDER BY trigger_column.ordinality)
        FROM pg_catalog.unnest(trigger_definition.tgattr::smallint[])
          WITH ORDINALITY AS trigger_column(attribute_number, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = trigger_definition.tgrelid
         AND attribute.attnum = trigger_column.attribute_number
      ), '[]'::jsonb),
      'rowLevel', (trigger_definition.tgtype::integer & 1) <> 0,
      'enabled', trigger_definition.tgenabled::text,
      'functionSchema', function_namespace.nspname,
      'functionName', trigger_function.proname,
      'internal', trigger_definition.tgisinternal,
      'definition', pg_catalog.pg_get_triggerdef(trigger_definition.oid, false)
    ) ORDER BY relation_namespace.nspname, relation.relname, trigger_definition.tgname)
    FROM pg_catalog.pg_trigger AS trigger_definition
    JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger_definition.tgrelid
    JOIN pg_catalog.pg_namespace AS relation_namespace
      ON relation_namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_proc AS trigger_function
      ON trigger_function.oid = trigger_definition.tgfoid
    JOIN pg_catalog.pg_namespace AS function_namespace
      ON function_namespace.oid = trigger_function.pronamespace
    WHERE relation_namespace.nspname IN ('auth', 'storage')
      AND trigger_definition.tgname IN (${EXPECTED_TRIGGER_NAMES})
      AND NOT trigger_definition.tgisinternal
  ), '[]'::jsonb)
) AS doc
FROM (
  SELECT set_config('transaction_read_only', 'on', true) AS read_only,
         set_config('statement_timeout', '120000', true) AS statement_timeout
) AS pinned`.trim();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  field: string,
  errors: string[],
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    errors.push(`${field} has missing or unknown fields.`);
  }
}

function stringField(value: unknown, field: string, errors: string[]): string {
  if (typeof value !== 'string' || value.length === 0) {
    errors.push(`${field} must be a non-empty string.`);
    return '';
  }
  return value;
}

function stringArray(value: unknown, field: string, errors: string[]): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    errors.push(`${field} must be a string array.`);
    return [];
  }
  return [...value] as string[];
}

export type ManagedSchemaEvidenceParseResult =
  | { ok: true; evidence: ManagedSchemaCustomizationEvidence }
  | { ok: false; errors: string[] };

/** Missing fields, unknown fields, duplicate identities, and unsupported catalog states fail. */
export function parseManagedSchemaCustomizationEvidence(
  input: unknown,
): ManagedSchemaEvidenceParseResult {
  const errors: string[] = [];
  if (!isObject(input)) return { ok: false, errors: ['Managed-schema evidence root is not an object.'] };
  exactKeys(input, ['formatVersion', 'triggers'], 'managedSchemaEvidence', errors);
  if (input.formatVersion !== MANAGED_SCHEMA_CUSTOMIZATION_FORMAT) {
    errors.push('Managed-schema evidence format is unsupported.');
  }
  if (!Array.isArray(input.triggers)) {
    errors.push('Managed-schema trigger evidence must be an array.');
  }
  const triggers = (Array.isArray(input.triggers) ? input.triggers : []).map((raw, index) => {
    if (!isObject(raw)) {
      errors.push(`managedSchemaEvidence.triggers[${index}] is not an object.`);
      return null;
    }
    exactKeys(raw, [
      'schema', 'table', 'name', 'timing', 'events', 'updateColumns', 'rowLevel', 'enabled',
      'functionSchema', 'functionName', 'internal', 'definition',
    ], `managedSchemaEvidence.triggers[${index}]`, errors);
    const schema = stringField(raw.schema, `triggers[${index}].schema`, errors);
    const timing = stringField(raw.timing, `triggers[${index}].timing`, errors);
    const enabled = stringField(raw.enabled, `triggers[${index}].enabled`, errors);
    const events = stringArray(raw.events, `triggers[${index}].events`, errors);
    const updateColumns = stringArray(raw.updateColumns, `triggers[${index}].updateColumns`, errors);
    if (!['auth', 'storage'].includes(schema)) errors.push(`triggers[${index}].schema is unsupported.`);
    if (!['BEFORE', 'AFTER', 'INSTEAD OF'].includes(timing)) {
      errors.push(`triggers[${index}].timing is unsupported.`);
    }
    if (events.some((event) => !['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'].includes(event))) {
      errors.push(`triggers[${index}].events contains an unsupported event.`);
    }
    if (!['O', 'D', 'R', 'A'].includes(enabled)) errors.push(`triggers[${index}].enabled is unsupported.`);
    if (typeof raw.rowLevel !== 'boolean') errors.push(`triggers[${index}].rowLevel must be boolean.`);
    if (raw.internal !== false) errors.push(`triggers[${index}].internal must be false.`);
    const table = stringField(raw.table, `triggers[${index}].table`, errors);
    const name = stringField(raw.name, `triggers[${index}].name`, errors);
    const functionSchema = stringField(raw.functionSchema, `triggers[${index}].functionSchema`, errors);
    const functionName = stringField(raw.functionName, `triggers[${index}].functionName`, errors);
    for (const [field, value] of [
      ['table', table], ['name', name], ['functionSchema', functionSchema],
      ['functionName', functionName], ...updateColumns.map((column) => ['updateColumn', column]),
    ] as Array<[string, string]>) {
      if (!/^[a-z_][a-z0-9_]*$/.test(value)) errors.push(`triggers[${index}].${field} is unsafe.`);
    }
    return {
      schema: schema as ManagedSchemaName,
      table,
      name,
      timing: timing as ManagedTriggerTiming,
      events: events as ManagedTriggerEvent[],
      updateColumns,
      rowLevel: raw.rowLevel === true,
      enabled: enabled as ManagedTriggerEnabledState,
      functionSchema,
      functionName,
      internal: false as const,
      definition: canonicalTriggerDefinition(
        stringField(raw.definition, `triggers[${index}].definition`, errors),
      ),
    };
  }).filter((trigger): trigger is ManagedTriggerEvidence => trigger !== null);

  const identities = triggers.map((trigger) => `${trigger.schema}.${trigger.table}.${trigger.name}`);
  if (new Set(identities).size !== identities.length) {
    errors.push('Managed-schema trigger evidence contains duplicate identities.');
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    evidence: {
      formatVersion: MANAGED_SCHEMA_CUSTOMIZATION_FORMAT,
      triggers: triggers.sort((left, right) => (
        `${left.schema}.${left.table}.${left.name}`.localeCompare(
          `${right.schema}.${right.table}.${right.name}`,
        )
      )),
    },
  };
}

export interface ManagedSchemaCustomizationDifference {
  kind: 'MISSING' | 'UNEXPECTED' | 'CHANGED' | 'INVALID';
  identity: string;
  changedFields?: string[];
}

export function compareManagedSchemaCustomizations(
  expectedInput: unknown,
  actualInput: unknown,
): ManagedSchemaCustomizationDifference[] {
  const expected = parseManagedSchemaCustomizationEvidence(expectedInput);
  const actual = parseManagedSchemaCustomizationEvidence(actualInput);
  if (!expected.ok || !actual.ok) {
    return [...(!expected.ok ? expected.errors : []), ...(!actual.ok ? actual.errors : [])]
      .map((error) => ({ kind: 'INVALID' as const, identity: error }));
  }
  const identity = (trigger: ManagedTriggerEvidence): string => (
    `${trigger.schema}.${trigger.table}.${trigger.name}`
  );
  const expectedByIdentity = new Map(expected.evidence.triggers.map((trigger) => [identity(trigger), trigger]));
  const actualByIdentity = new Map(actual.evidence.triggers.map((trigger) => [identity(trigger), trigger]));
  const identities = [...new Set([...expectedByIdentity.keys(), ...actualByIdentity.keys()])].sort();
  const differences: ManagedSchemaCustomizationDifference[] = [];
  for (const key of identities) {
    const wanted = expectedByIdentity.get(key);
    const observed = actualByIdentity.get(key);
    if (!observed) {
      differences.push({ kind: 'MISSING', identity: key });
      continue;
    }
    if (!wanted) {
      differences.push({ kind: 'UNEXPECTED', identity: key });
      continue;
    }
    const fields = (Object.keys(wanted) as Array<keyof ManagedTriggerEvidence>)
      .filter((field) => JSON.stringify(wanted[field]) !== JSON.stringify(observed[field]));
    if (fields.length > 0) {
      differences.push({ kind: 'CHANGED', identity: key, changedFields: fields });
    }
  }
  return differences;
}

export function validateManagedSchemaCustomizationsAgainstRepository(input: unknown): string[] {
  return compareManagedSchemaCustomizations(REPOSITORY_MANAGED_SCHEMA_EXPECTATION, input)
    .map((difference) => (
      `${difference.kind}:${difference.identity}`
      + (difference.changedFields?.length ? `:${difference.changedFields.join(',')}` : '')
    ));
}

export function managedSchemaCustomizationCounts(input: unknown): {
  auth: number;
  storage: number;
} {
  const parsed = parseManagedSchemaCustomizationEvidence(input);
  if (!parsed.ok) return { auth: 0, storage: 0 };
  return {
    auth: parsed.evidence.triggers.filter((trigger) => trigger.schema === 'auth').length,
    storage: parsed.evidence.triggers.filter((trigger) => trigger.schema === 'storage').length,
  };
}

/**
 * Validates the captured evidence, then returns only fixed repository-reviewed DDL. No SQL or
 * identifier from the bundle is interpolated into the executable restore statement.
 */
export function buildApprovedManagedSchemaCustomizationRestoreSql(capturedEvidence: unknown): string {
  const errors = validateManagedSchemaCustomizationsAgainstRepository(capturedEvidence);
  if (errors.length > 0) {
    throw new RecoveryGuardError(`MANAGED_SCHEMA_CUSTOMIZATION_NOT_APPROVED:${errors[0]}`);
  }
  return `
DO $managed_recovery_guard$
BEGIN
  IF pg_catalog.to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'MANAGED_AUTH_FOUNDATION_MISSING';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname = 'public'
      AND routine.proname = 'claim_staff_provisioning_auth_insert'
      AND routine.pronargs = 0
      AND routine.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
  ) THEN
    RAISE EXCEPTION 'MANAGED_AUTH_TRIGGER_FUNCTION_MISSING_OR_DIFFERENT';
  END IF;
END
$managed_recovery_guard$;

DROP TRIGGER IF EXISTS claim_staff_provisioning_auth_insert_before_insert ON auth.users;
CREATE TRIGGER claim_staff_provisioning_auth_insert_before_insert
BEFORE INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.claim_staff_provisioning_auth_insert();

DROP TRIGGER IF EXISTS claim_staff_provisioning_auth_insert_before_metadata_update ON auth.users;
CREATE TRIGGER claim_staff_provisioning_auth_insert_before_metadata_update
BEFORE UPDATE OF raw_user_meta_data ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.claim_staff_provisioning_auth_insert();
`.trim();
}

export interface ManagedSchemaMigrationOperation {
  migration: string;
  action: 'CREATE_TRIGGER' | 'DROP_TRIGGER' | 'UNREVIEWED_MANAGED_DDL';
  schema: ManagedSchemaName | 'unknown';
  table: string;
  name: string;
  definition: string;
}

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\r\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
}

function maskSingleQuotedSql(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

function normalizedStatement(statement: string): string {
  return canonicalTriggerDefinition(statement.replace(/;\s*$/, ''));
}

/**
 * Focused inventory scanner, deliberately not a general SQL parser. It recognizes PP1's current
 * managed trigger form and fails closed on other direct auth/storage DDL targets. Ordinary SELECTs,
 * function calls, and REFERENCES auth.* foreign keys are not managed-schema customizations.
 */
export function scanManagedSchemaMigrationDdl(
  sql: string,
  migration = 'synthetic.sql',
): ManagedSchemaMigrationOperation[] {
  const withoutComments = stripSqlComments(sql);
  const searchable = maskSingleQuotedSql(withoutComments);
  const operations: ManagedSchemaMigrationOperation[] = [];
  if (/\bEXECUTE\s+(?:format\s*\(\s*)?['$][\s\S]{0,2000}\b(?:auth|storage)\s*\./i
    .test(withoutComments)) {
    operations.push({
      migration,
      action: 'UNREVIEWED_MANAGED_DDL',
      schema: /\bauth\s*\./i.test(withoutComments) ? 'auth' : 'storage',
      table: 'unknown',
      name: 'dynamic-sql',
      definition: 'dynamic managed-schema SQL requires recovery inventory review',
    });
  }
  const spans: Array<[number, number]> = [];
  const triggerPatterns: Array<{
    action: ManagedSchemaMigrationOperation['action'];
    pattern: RegExp;
  }> = [
    {
      action: 'CREATE_TRIGGER',
      pattern: /\bCREATE\s+TRIGGER\s+("?[a-z_][a-z0-9_]*"?)[\s\S]*?\bON\s+(?:ONLY\s+)?"?(auth|storage)"?\s*\.\s*"?([a-z_][a-z0-9_]*)"?[\s\S]*?;/gi,
    },
    {
      action: 'DROP_TRIGGER',
      pattern: /\bDROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?("?[a-z_][a-z0-9_]*"?)\s+ON\s+(?:ONLY\s+)?"?(auth|storage)"?\s*\.\s*"?([a-z_][a-z0-9_]*)"?\s*;/gi,
    },
  ];
  for (const { action, pattern } of triggerPatterns) {
    for (const match of searchable.matchAll(pattern)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      spans.push([start, end]);
      operations.push({
        migration,
        action,
        schema: match[2].toLowerCase() as ManagedSchemaName,
        table: match[3].toLowerCase(),
        name: match[1].replaceAll('"', '').toLowerCase(),
        definition: normalizedStatement(match[0]),
      });
    }
  }

  const remaining = [...searchable].map((character, index) => (
    spans.some(([start, end]) => index >= start && index < end) ? ' ' : character
  )).join('');
  const directManagedTargetPatterns = [
    /\b(?:CREATE|ALTER|DROP)\s+(?:CONSTRAINT\s+)?TRIGGER\b[\s\S]*?\bON\s+(?:ONLY\s+)?"?(?:auth|storage)"?\s*\./i,
    /\b(?:CREATE|ALTER|DROP)\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|MATERIALIZED\s+VIEW|FUNCTION|PROCEDURE|TYPE|SEQUENCE|SCHEMA|INDEX)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?"?(?:auth|storage)"?\s*\./i,
    /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b[\s\S]*?\bON\s+(?:ONLY\s+)?"?(?:auth|storage)"?\s*\./i,
    /\b(?:CREATE|ALTER|DROP)\s+POLICY\b[\s\S]*?\bON\s+(?:ONLY\s+)?"?(?:auth|storage)"?\s*\./i,
    /\b(?:GRANT|REVOKE)\b[\s\S]*?\bON\s+(?:TABLE\s+|FUNCTION\s+|PROCEDURE\s+|SEQUENCE\s+)?"?(?:auth|storage)"?\s*\./i,
    /\b(?:GRANT|REVOKE)\b[\s\S]*?\bON\s+(?:ALL\s+(?:TABLES|FUNCTIONS|SEQUENCES)\s+IN\s+)?SCHEMA\s+"?(?:auth|storage)"?\b/i,
    /\bCOMMENT\s+ON\b[\s\S]*?"?(?:auth|storage)"?\s*\./i,
    /\bALTER\s+DEFAULT\s+PRIVILEGES\b[\s\S]*?\bIN\s+SCHEMA\s+"?(?:auth|storage)"?\b/i,
  ];
  for (const pattern of directManagedTargetPatterns) {
    const match = pattern.exec(remaining);
    if (!match) continue;
    const schema = /\bauth\b/i.test(match[0]) ? 'auth' : /\bstorage\b/i.test(match[0]) ? 'storage' : 'unknown';
    operations.push({
      migration,
      action: 'UNREVIEWED_MANAGED_DDL',
      schema,
      table: 'unknown',
      name: 'unknown',
      definition: normalizedStatement(match[0]),
    });
  }
  return operations.sort((left, right) => (
    `${left.migration}:${left.action}:${left.name}`.localeCompare(
      `${right.migration}:${right.action}:${right.name}`,
    )
  ));
}

const EXPECTED_MIGRATION_OPERATIONS = ([
  {
    migration: '20260813120000_staff_identity_provisioning.sql',
    action: 'CREATE_TRIGGER',
    schema: 'auth',
    table: 'users',
    name: AUTH_INSERT_TRIGGER.name,
    definition: AUTH_INSERT_TRIGGER.definition,
  },
  {
    migration: '20260816144917_staging_uat_direct_account_finalization.sql',
    action: 'CREATE_TRIGGER',
    schema: 'auth',
    table: 'users',
    name: AUTH_METADATA_UPDATE_TRIGGER.name,
    definition: AUTH_METADATA_UPDATE_TRIGGER.definition,
  },
  {
    migration: '20260816144917_staging_uat_direct_account_finalization.sql',
    action: 'DROP_TRIGGER',
    schema: 'auth',
    table: 'users',
    name: AUTH_METADATA_UPDATE_TRIGGER.name,
    definition: canonicalTriggerDefinition(
      'DROP TRIGGER IF EXISTS claim_staff_provisioning_auth_insert_before_metadata_update ON auth.users',
    ),
  },
] satisfies ManagedSchemaMigrationOperation[]).sort((left, right) => (
  `${left.migration}:${left.action}:${left.name}`.localeCompare(
    `${right.migration}:${right.action}:${right.name}`,
  )
));

export function inspectRepositoryManagedSchemaMigrationInventory(
  repositoryRoot: string,
): ManagedSchemaMigrationOperation[] {
  const migrationDirectory = path.join(repositoryRoot, 'infra', 'supabase', 'migrations');
  return fs.readdirSync(migrationDirectory)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .flatMap((migration) => scanManagedSchemaMigrationDdl(
      fs.readFileSync(path.join(migrationDirectory, migration), 'utf8'),
      migration,
    ));
}

/** Any unreviewed managed-schema DDL blocks capture, restore, and the repository check. */
export function assertRepositoryManagedSchemaMigrationInventory(repositoryRoot: string): void {
  const actual = inspectRepositoryManagedSchemaMigrationInventory(repositoryRoot);
  if (JSON.stringify(actual) !== JSON.stringify(EXPECTED_MIGRATION_OPERATIONS)) {
    const unexpected = actual.find((operation, index) => (
      JSON.stringify(operation) !== JSON.stringify(EXPECTED_MIGRATION_OPERATIONS[index])
    ));
    throw new RecoveryGuardError(
      `MANAGED_SCHEMA_MIGRATION_INVENTORY_REVIEW_REQUIRED:${unexpected?.migration ?? 'inventory-count'}`,
    );
  }
}

/** Synthetic proof that the standard provider-boundary schema dump omitted PP1's Auth triggers. */
export function countExpectedManagedTriggersInStandardSchemaDump(schemaSql: string): number {
  return REPOSITORY_MANAGED_SCHEMA_EXPECTATION.triggers.filter((trigger) => (
    new RegExp(`\\bCREATE\\s+TRIGGER\\s+${trigger.name}\\b`, 'i').test(schemaSql)
  )).length;
}
