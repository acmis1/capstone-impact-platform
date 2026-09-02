import { RecoveryGuardError } from './zeroCostRecoveryContract';

/**
 * Bounded provider-schema compatibility for logical Auth data restores.
 *
 * Source requirements come only from pg_dump COPY headers in the checksum-validated data
 * artifact. Executable SQL is fixed in this repository and never assembled from bundle text.
 */

export interface ManagedAuthCopyRequirement {
  table: string;
  columns: string[];
}

export interface ManagedAuthCatalogColumn {
  table: string;
  column: string;
  formattedType: string;
  notNull: boolean;
  defaultExpression: string | null;
}

export type ManagedAuthCompatibilityAction = 'MATCH' | 'ADD_CUSTOM_CLAIMS_ALLOWLIST';

export interface ManagedAuthCompatibilityPlan {
  action: ManagedAuthCompatibilityAction;
  requiredTableCount: number;
  requiredColumnCount: number;
}

const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const AUTH_REFERENCE = /(?:\bauth|"auth")\s*\./i;
// Supabase 2.109.1 --data-only --use-copy uses pg_dump's single-line table COPY form.
// Ordinary quoted names may contain punctuation and doubled quotes. Unicode-escape identifiers,
// comments between tokens, query COPY, options and trailing statements are outside this contract.
const COPY_IDENTIFIER = String.raw`(?:"(?:[^"\r\n]|"")+"|[a-z_][a-z0-9_$]*)`;
const COPY_HEADER = new RegExp(
  String.raw`^COPY[ \t]+(${COPY_IDENTIFIER})\.(${COPY_IDENTIFIER})[ \t]+\((${COPY_IDENTIFIER}(?:,[ \t]*${COPY_IDENTIFIER})*)\)[ \t]+FROM[ \t]+stdin;$`,
  'i',
);
const SAFE_DATA_DUMP_STATEMENTS = [
  /^SET\s+[a-z_]+\s*=\s*[^;]+;$/i,
  /^RESET\s+(?:[a-z_]+|ALL);$/i,
  /^SELECT\s+pg_catalog\.set_config\s*\([^;]+\);$/i,
  /^SELECT\s+pg_catalog\.setval\s*\([^;]+\);$/i,
  /^\\(?:restrict|unrestrict)\s+\S+$/i,
];

export const CUSTOM_CLAIMS_ALLOWLIST_COMPATIBILITY = Object.freeze({
  table: 'custom_oauth_providers',
  column: 'custom_claims_allowlist',
  formattedType: 'text[]',
  notNull: true,
  defaultExpression: "'{}'::text[]",
});

/** Exact upstream Auth migration 20260625000000 with the namespace fixed to auth. */
export const ADD_CUSTOM_CLAIMS_ALLOWLIST_SQL = `
alter table auth.custom_oauth_providers
    add column if not exists custom_claims_allowlist text[] not null default '{}';
`.trim();

/** Synthetic-only setup for reproducing the pre-20260625000000 disposable target baseline. */
export const REMOVE_CUSTOM_CLAIMS_ALLOWLIST_FOR_SYNTHETIC_TARGET_SQL = `
alter table auth.custom_oauth_providers
    drop column if exists custom_claims_allowlist;
`.trim();

function parseIdentifier(raw: string): string {
  // PostgreSQL folds unquoted names to lowercase and preserves quoted names exactly.
  return raw.startsWith('"') ? raw.slice(1, -1).replaceAll('""', '"') : raw.toLowerCase();
}

function parseCopyHeader(line: string): {
  schema: string;
  table: string;
  columns: string[];
} {
  const match = COPY_HEADER.exec(line);
  if (!match || line.includes('\0')) {
    throw new RecoveryGuardError('MANAGED_AUTH_COMPATIBILITY_COPY_HEADER_UNSUPPORTED');
  }
  return {
    schema: parseIdentifier(match[1]),
    table: parseIdentifier(match[2]),
    // Match complete identifier tokens; a comma inside a quoted name is not a separator.
    columns: [...match[3].matchAll(new RegExp(COPY_IDENTIFIER, 'gi'))]
      .map(([identifier]) => parseIdentifier(identifier)),
  };
}

/**
 * Reads only COPY structure. COPY row bodies are skipped so private Auth records can never enter
 * an error, diagnostic, or compatibility decision.
 */
export function deriveManagedAuthCopyRequirements(dataSql: string): ManagedAuthCopyRequirement[] {
  const requirements: ManagedAuthCopyRequirement[] = [];
  const tables = new Set<string>();
  let inCopyData = false;

  for (const rawLine of dataSql.split(/\r?\n/)) {
    if (inCopyData) {
      if (rawLine === '\\.') inCopyData = false;
      continue;
    }
    const line = rawLine.trim();
    if (!line || line.startsWith('--')) continue;

    if (/^COPY\b/i.test(line)) {
      // Validate the entire header before any schema can be ignored by Auth planning.
      const parsed = parseCopyHeader(line);
      inCopyData = true;
      if (parsed.schema !== 'auth') continue;
      if (!SAFE_IDENTIFIER.test(parsed.table)
        || parsed.columns.some((column) => !SAFE_IDENTIFIER.test(column))
        || new Set(parsed.columns).size !== parsed.columns.length) {
        throw new RecoveryGuardError('MANAGED_AUTH_COMPATIBILITY_COPY_HEADER_INVALID');
      }
      if (tables.has(parsed.table)) {
        throw new RecoveryGuardError('MANAGED_AUTH_COMPATIBILITY_COPY_HEADER_DUPLICATE');
      }
      tables.add(parsed.table);
      requirements.push({ table: parsed.table, columns: parsed.columns });
      continue;
    }

    // Accept only the bounded statement forms emitted around COPY bodies by pg_dump --data-only.
    // This also refuses unqualified managed DDL hidden behind a changed search_path.
    if (!SAFE_DATA_DUMP_STATEMENTS.some((pattern) => pattern.test(line))) {
      throw new RecoveryGuardError(
        AUTH_REFERENCE.test(line)
          ? 'MANAGED_AUTH_COMPATIBILITY_UNSAFE_AUTH_STATEMENT'
          : 'MANAGED_AUTH_COMPATIBILITY_DATA_DUMP_STATEMENT_UNSUPPORTED',
      );
    }
  }

  if (inCopyData) {
    throw new RecoveryGuardError('MANAGED_AUTH_COMPATIBILITY_COPY_DATA_TRUNCATED');
  }
  if (requirements.length === 0) {
    throw new RecoveryGuardError('MANAGED_AUTH_COMPATIBILITY_SOURCE_REQUIREMENTS_MISSING');
  }
  return requirements.sort((left, right) => left.table.localeCompare(right.table));
}

/** Fixed catalog-only query; it reads no Auth rows or identity values. */
export function buildManagedAuthCatalogEvidenceSql(): string {
  return `
SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
  'table', relation.relname,
  'column', attribute.attname,
  'formattedType', pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
  'notNull', attribute.attnotnull,
  'defaultExpression', pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid)
) ORDER BY relation.relname, attribute.attnum), '[]'::jsonb)::text
FROM pg_catalog.pg_attribute AS attribute
JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
LEFT JOIN pg_catalog.pg_attrdef AS default_value
  ON default_value.adrelid = attribute.attrelid
 AND default_value.adnum = attribute.attnum
WHERE namespace.nspname = 'auth'
  AND relation.relkind IN ('r', 'p')
  AND attribute.attnum > 0
  AND NOT attribute.attisdropped;
  `.trim();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseManagedAuthCatalogEvidence(output: string): ManagedAuthCatalogColumn[] {
  const start = output.indexOf('[');
  const end = output.lastIndexOf(']');
  if (start < 0 || end < start) {
    throw new RecoveryGuardError('MANAGED_AUTH_COMPATIBILITY_CATALOG_INVALID');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.slice(start, end + 1)) as unknown;
  } catch {
    throw new RecoveryGuardError('MANAGED_AUTH_COMPATIBILITY_CATALOG_INVALID');
  }
  if (!Array.isArray(parsed)) {
    throw new RecoveryGuardError('MANAGED_AUTH_COMPATIBILITY_CATALOG_INVALID');
  }

  const columns: ManagedAuthCatalogColumn[] = [];
  const identities = new Set<string>();
  for (const entry of parsed) {
    if (!isObject(entry)
      || Object.keys(entry).sort().join(',') !== 'column,defaultExpression,formattedType,notNull,table'
      || typeof entry.table !== 'string'
      || typeof entry.column !== 'string'
      || !SAFE_IDENTIFIER.test(entry.table)
      || !SAFE_IDENTIFIER.test(entry.column)
      || typeof entry.formattedType !== 'string'
      || entry.formattedType.length === 0
      || typeof entry.notNull !== 'boolean'
      || (entry.defaultExpression !== null && typeof entry.defaultExpression !== 'string')) {
      throw new RecoveryGuardError('MANAGED_AUTH_COMPATIBILITY_CATALOG_INVALID');
    }
    const identity = `${entry.table}.${entry.column}`;
    if (identities.has(identity)) {
      throw new RecoveryGuardError('MANAGED_AUTH_COMPATIBILITY_CATALOG_INVALID');
    }
    identities.add(identity);
    columns.push({
      table: entry.table,
      column: entry.column,
      formattedType: entry.formattedType,
      notNull: entry.notNull,
      defaultExpression: entry.defaultExpression as string | null,
    });
  }
  return columns;
}

function knownColumnShapeMatches(column: ManagedAuthCatalogColumn): boolean {
  return column.table === CUSTOM_CLAIMS_ALLOWLIST_COMPATIBILITY.table
    && column.column === CUSTOM_CLAIMS_ALLOWLIST_COMPATIBILITY.column
    && column.formattedType === CUSTOM_CLAIMS_ALLOWLIST_COMPATIBILITY.formattedType
    && column.notNull === CUSTOM_CLAIMS_ALLOWLIST_COMPATIBILITY.notNull
    && column.defaultExpression === CUSTOM_CLAIMS_ALLOWLIST_COMPATIBILITY.defaultExpression;
}

/** Unknown source-ahead columns and malformed known columns fail before any compatibility SQL. */
export function planManagedAuthSchemaCompatibility(
  requirements: readonly ManagedAuthCopyRequirement[],
  targetColumns: readonly ManagedAuthCatalogColumn[],
): ManagedAuthCompatibilityPlan {
  const targetByIdentity = new Map(
    targetColumns.map((column) => [`${column.table}.${column.column}`, column]),
  );
  const targetTables = new Set(targetColumns.map((column) => column.table));
  const missing: Array<{ table: string; column: string }> = [];

  for (const requirement of requirements) {
    if (!targetTables.has(requirement.table)) {
      throw new RecoveryGuardError('MANAGED_AUTH_COMPATIBILITY_UNKNOWN_DRIFT');
    }
    for (const column of requirement.columns) {
      const observed = targetByIdentity.get(`${requirement.table}.${column}`);
      if (!observed) missing.push({ table: requirement.table, column });
    }
  }

  const knownRequired = requirements.some((requirement) => (
    requirement.table === CUSTOM_CLAIMS_ALLOWLIST_COMPATIBILITY.table
    && requirement.columns.includes(CUSTOM_CLAIMS_ALLOWLIST_COMPATIBILITY.column)
  ));
  const observedKnown = targetByIdentity.get(
    `${CUSTOM_CLAIMS_ALLOWLIST_COMPATIBILITY.table}.${CUSTOM_CLAIMS_ALLOWLIST_COMPATIBILITY.column}`,
  );
  if (knownRequired && observedKnown && !knownColumnShapeMatches(observedKnown)) {
    throw new RecoveryGuardError('MANAGED_AUTH_COMPATIBILITY_KNOWN_DELTA_SHAPE_MISMATCH');
  }

  if (missing.length > 0) {
    const onlyKnownDelta = missing.length === 1
      && missing[0].table === CUSTOM_CLAIMS_ALLOWLIST_COMPATIBILITY.table
      && missing[0].column === CUSTOM_CLAIMS_ALLOWLIST_COMPATIBILITY.column;
    if (!onlyKnownDelta) {
      throw new RecoveryGuardError('MANAGED_AUTH_COMPATIBILITY_UNKNOWN_DRIFT');
    }
    return {
      action: 'ADD_CUSTOM_CLAIMS_ALLOWLIST',
      requiredTableCount: requirements.length,
      requiredColumnCount: requirements.reduce((count, requirement) => count + requirement.columns.length, 0),
    };
  }

  return {
    action: 'MATCH',
    requiredTableCount: requirements.length,
    requiredColumnCount: requirements.reduce((count, requirement) => count + requirement.columns.length, 0),
  };
}
