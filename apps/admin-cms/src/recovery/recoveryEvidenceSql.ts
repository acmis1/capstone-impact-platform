import {
  sha256,
  type AuthRecoveryEvidence,
  type BucketConfigurationEvidence,
  type ExecutionControlEvidence,
  type TableDataEvidence,
} from './recoveryBundle';

/**
 * One read-only evidence statement, used unchanged against the hosted source and the restored
 * disposable target so both sides are directly comparable.
 *
 * It must remain a single statement: `supabase db query` sends it as a prepared statement, which
 * rejects multiple commands. Session rendering settings are therefore pinned in the FROM clause,
 * which PostgreSQL evaluates before the select list, and the same clause marks the transaction
 * read-only so the statement cannot mutate the source even if it were altered.
 */

export const EVIDENCE_SCHEMAS = ['public', 'assistive_execution_control'] as const;

const MUTATING_KEYWORDS = [
  'insert', 'update', 'delete', 'upsert', 'truncate', 'drop', 'alter', 'create',
  'grant', 'revoke', 'comment', 'reindex', 'vacuum', 'refresh', 'copy', 'call', 'do',
];

/**
 * Defence in depth against an edited or injected evidence statement reaching a hosted source.
 * The evidence query is a single read-only SELECT and must stay that way.
 */
export function assertReadOnlyEvidenceSql(sql: string): void {
  const withoutStrings = sql
    .replace(/\$q\$[\s\S]*?\$q\$/g, ' ')
    .replace(/'(?:[^']|'')*'/g, ' ');
  if (/;\s*\S/.test(withoutStrings)) throw new Error('EVIDENCE_SQL_NOT_SINGLE_STATEMENT');
  if (!/^\s*select\b/i.test(withoutStrings)) throw new Error('EVIDENCE_SQL_NOT_A_SELECT');
  for (const keyword of MUTATING_KEYWORDS) {
    if (new RegExp(`\\b${keyword}\\b`, 'i').test(withoutStrings)) {
      throw new Error(`EVIDENCE_SQL_CONTAINS_${keyword.toUpperCase()}`);
    }
  }
}

const PINNED_SESSION = `
  FROM (
    SELECT set_config('transaction_read_only', 'on', true) AS read_only,
           set_config('timezone', 'UTC', true) AS tz,
           set_config('DateStyle', 'ISO, MDY', true) AS date_style,
           set_config('IntervalStyle', 'postgres', true) AS interval_style,
           set_config('extra_float_digits', '3', true) AS float_digits,
           set_config('bytea_output', 'hex', true) AS bytea_output,
           set_config('statement_timeout', '120000', true) AS statement_timeout
  ) AS pinned`;

/**
 * Reads a scalar from a query that is only parsed if the relation exists, so the same statement
 * works against a fully restored catalog and against a bare foundation that has none of it yet.
 */
function guardedScalar(relation: string, presentQuery: string, absentValue: string): string {
  return `(xpath('/row/c/text()', query_to_xml(
        CASE WHEN to_regclass('${relation}') IS NULL
             THEN $q$SELECT ${absentValue} AS c$q$
             ELSE $q$${presentQuery}$q$ END, false, true, '')))[1]::text`;
}

const ROW_CHECKSUM_TEMPLATE =
  'SELECT coalesce(encode(sha256(convert_to(string_agg(h, %L ORDER BY h), %L)), %L), %L) AS c '
  + 'FROM (SELECT md5(r::text) AS h FROM %I.%I r) s';

/** Single evidence statement. Returns one row with one `doc` JSON column. */
export function buildRecoveryEvidenceSql(): string {
  const schemaList = EVIDENCE_SCHEMAS.map((schema) => `'${schema}'`).join(', ');
  const sql = `
SELECT jsonb_build_object(
  'postgres', jsonb_build_object(
    'majorVersion', (current_setting('server_version_num')::int / 10000),
    'reportedVersion', current_setting('server_version')
  ),
  'migrationVersions', ${guardedScalar(
    'supabase_migrations.schema_migrations',
    "SELECT coalesce(json_agg(version ORDER BY version)::text, '[]') AS c FROM supabase_migrations.schema_migrations",
    "'[]'",
  )}::jsonb,
  'auth', jsonb_build_object(
    'userCount', ${guardedScalar('auth.users', 'SELECT count(*)::text AS c FROM auth.users', "'0'")}::bigint,
    'identityCount', ${guardedScalar('auth.identities', 'SELECT count(*)::text AS c FROM auth.identities', "'0'")}::bigint,
    'orphanIdentityCount', ${guardedScalar(
      'auth.identities',
      'SELECT count(*)::text AS c FROM auth.identities i LEFT JOIN auth.users u ON u.id = i.user_id WHERE u.id IS NULL',
      "'0'",
    )}::bigint
  ),
  'buckets', ${guardedScalar(
    'storage.buckets',
    "SELECT coalesce(json_agg(json_build_object('id', b.id, 'name', b.name, 'public', b.public, 'fileSizeLimit', b.file_size_limit, 'allowedMimeTypes', b.allowed_mime_types) ORDER BY b.id)::text, '[]') AS c FROM storage.buckets b",
    "'[]'",
  )}::jsonb,
  'storageTables', (
    SELECT coalesce(jsonb_agg(t.tablename ORDER BY t.tablename), '[]'::jsonb)
    FROM pg_catalog.pg_tables t WHERE t.schemaname = 'storage'
  ),
  'tables', (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'schema', t.schemaname,
      'table', t.tablename,
      'rowCount', (xpath('/row/c/text()', query_to_xml(
        format('SELECT count(*) AS c FROM %I.%I', t.schemaname, t.tablename), false, true, '')))[1]::text::bigint,
      'checksum', (xpath('/row/c/text()', query_to_xml(
        format('${ROW_CHECKSUM_TEMPLATE}', '', 'UTF8', 'hex', repeat('0', 64), t.schemaname, t.tablename),
        false, true, '')))[1]::text
    ) ORDER BY t.schemaname, t.tablename), '[]'::jsonb)
    FROM pg_catalog.pg_tables t
    WHERE t.schemaname IN (${schemaList})
  ),
  'executionControl', jsonb_build_object(
    'budgetGuard', ${guardedScalar(
      'assistive_execution_control.launch_budget_guard',
      "SELECT coalesce((SELECT json_build_object('environment', g.environment, 'launchLimit', g.launch_limit, 'windowDays', g.window_days, 'maxActiveExecutions', g.max_active_executions)::text FROM assistive_execution_control.launch_budget_guard g ORDER BY g.environment LIMIT 1), 'null') AS c",
      "'null'",
    )}::jsonb,
    'launchReservationCount', ${guardedScalar(
      'assistive_execution_control.launch_reservations',
      'SELECT count(*)::text AS c FROM assistive_execution_control.launch_reservations',
      "'0'",
    )}::bigint,
    'executorRegistrationCount', ${guardedScalar(
      'assistive_execution_control.executor_registrations',
      'SELECT count(*)::text AS c FROM assistive_execution_control.executor_registrations',
      "'0'",
    )}::bigint,
    'reservationChecksum', ${guardedScalar(
      'assistive_execution_control.launch_reservations',
      "SELECT coalesce(encode(sha256(convert_to(string_agg(h, '' ORDER BY h), 'UTF8')), 'hex'), repeat('0', 64)) AS c FROM (SELECT md5(r::text) AS h FROM assistive_execution_control.launch_reservations r) s",
      "repeat('0', 64)",
    )},
    'schemaPresent', (to_regclass('assistive_execution_control.launch_reservations') IS NOT NULL)
  )
) AS doc${PINNED_SESSION}`.trim();
  assertReadOnlyEvidenceSql(sql);
  return sql;
}

export interface RecoveryEvidenceSnapshot {
  postgres: { majorVersion: number; reportedVersion: string };
  migrationVersions: string[];
  auth: AuthRecoveryEvidence;
  buckets: BucketConfigurationEvidence[];
  /** Storage tables present at the source, excluded wholesale from the logical data backup. */
  storageTables: string[];
  tables: TableDataEvidence[];
  executionControl: ExecutionControlEvidence & { schemaPresent: boolean };
}

function asInteger(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isSafeInteger(parsed)) throw new Error(`EVIDENCE_FIELD_INVALID:${field}`);
  return parsed;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`EVIDENCE_FIELD_INVALID:${field}`);
  return value;
}

/** Parses the single evidence row into the comparable snapshot both phases use. */
export function parseRecoveryEvidence(document: unknown): RecoveryEvidenceSnapshot {
  if (typeof document !== 'object' || document === null) throw new Error('EVIDENCE_DOCUMENT_INVALID');
  const raw = document as Record<string, unknown>;
  const postgres = (raw.postgres ?? {}) as Record<string, unknown>;
  const auth = (raw.auth ?? {}) as Record<string, unknown>;
  const control = (raw.executionControl ?? {}) as Record<string, unknown>;

  const migrationVersions = Array.isArray(raw.migrationVersions)
    ? raw.migrationVersions.map((version) => asString(version, 'migrationVersions'))
    : [];

  const buckets = (Array.isArray(raw.buckets) ? raw.buckets : []).map((entry) => {
    const bucket = entry as Record<string, unknown>;
    const mimeTypes = bucket.allowedMimeTypes;
    return {
      id: asString(bucket.id, 'bucket.id'),
      name: asString(bucket.name, 'bucket.name'),
      public: Boolean(bucket.public),
      fileSizeLimit: bucket.fileSizeLimit === null || bucket.fileSizeLimit === undefined
        ? null
        : asInteger(bucket.fileSizeLimit, 'bucket.fileSizeLimit'),
      allowedMimeTypes: Array.isArray(mimeTypes)
        ? [...mimeTypes.map((type) => asString(type, 'bucket.allowedMimeTypes'))].sort()
        : null,
    } satisfies BucketConfigurationEvidence;
  });

  const tables = (Array.isArray(raw.tables) ? raw.tables : []).map((entry) => {
    const table = entry as Record<string, unknown>;
    return {
      schema: asString(table.schema, 'table.schema'),
      table: asString(table.table, 'table.table'),
      rowCount: asInteger(table.rowCount, 'table.rowCount'),
      checksum: asString(table.checksum, 'table.checksum'),
    } satisfies TableDataEvidence;
  });

  const guard = control.budgetGuard as Record<string, unknown> | null | undefined;
  return {
    postgres: {
      majorVersion: asInteger(postgres.majorVersion, 'postgres.majorVersion'),
      reportedVersion: asString(postgres.reportedVersion, 'postgres.reportedVersion'),
    },
    migrationVersions,
    storageTables: (Array.isArray(raw.storageTables) ? raw.storageTables : [])
      .map((table) => asString(table, 'storageTables')),
    auth: {
      userCount: asInteger(auth.userCount, 'auth.userCount'),
      identityCount: asInteger(auth.identityCount, 'auth.identityCount'),
      orphanIdentityCount: asInteger(auth.orphanIdentityCount, 'auth.orphanIdentityCount'),
    },
    buckets,
    tables,
    executionControl: {
      budgetGuard: guard
        ? {
            environment: asString(guard.environment, 'budgetGuard.environment'),
            launchLimit: asInteger(guard.launchLimit, 'budgetGuard.launchLimit'),
            windowDays: asInteger(guard.windowDays, 'budgetGuard.windowDays'),
            maxActiveExecutions: asInteger(guard.maxActiveExecutions, 'budgetGuard.maxActiveExecutions'),
          }
        : null,
      launchReservationCount: asInteger(control.launchReservationCount, 'launchReservationCount'),
      executorRegistrationCount: asInteger(control.executorRegistrationCount, 'executorRegistrationCount'),
      reservationChecksum: asString(control.reservationChecksum, 'reservationChecksum'),
      schemaPresent: Boolean(control.schemaPresent),
    },
  };
}

/** Stable serialization so the data-evidence file checksum is reproducible. */
export function serializeTableEvidence(tables: readonly TableDataEvidence[]): string {
  const ordered = [...tables].sort((left, right) => (
    `${left.schema}.${left.table}`.localeCompare(`${right.schema}.${right.table}`)
  ));
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export function tableEvidenceChecksum(tables: readonly TableDataEvidence[]): string {
  return sha256(serializeTableEvidence(tables));
}
