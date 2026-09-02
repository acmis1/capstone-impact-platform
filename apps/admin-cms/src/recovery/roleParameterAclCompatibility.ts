import { RecoveryGuardError } from './zeroCostRecoveryContract';

/**
 * Bounded provider-global role compatibility for logical role-dump restores.
 *
 * A hosted Supabase cluster carries platform-owned `pg_parameter_acl` state. `pg_dumpall
 * --roles-only` reproduces it (`dumpRoleGUCPrivs`), so the captured `roles.sql` contains a
 * cluster-global parameter grant that Local's intentionally non-superuser `postgres` cannot
 * replay: PostgreSQL rejects it with SQLSTATE 42501 before `schema.sql` is reached.
 *
 * Supabase's own delta tooling classifies exactly these `log_min_messages` grants as platform
 * state and drops them for non-superuser replay, so the reviewed compatibility action is to
 * neutralize the one statement in a verifier-owned staged copy. The provider ACL is never
 * recreated by privilege escalation, and the captured bundle is never modified.
 *
 * Source requirements come only from the checksum-validated role artifact. Nothing here builds
 * executable SQL from bundle text: the compatibility action is a removal, and the only SQL this
 * module emits is a fixed read-only catalog query.
 */

/**
 * The only approved provider-global role compatibility difference.
 *
 * `canonicalStatements` are the two forms `pg_dumpall` can emit for it. The pinned Supabase CLI
 * 2.109.1 role-only dump passes `--quote-all-identifier`, which sets `quote_all_identifiers` and
 * makes `fmtId` quote every identifier, so the quoted form is what a real capture contains. The
 * unquoted form is the same statement from a plain `pg_dumpall` without that flag. No other
 * spelling, spacing, privilege, parameter, or grantee is accepted.
 */
export const KNOWN_PLATFORM_PARAMETER_ACL = Object.freeze({
  parameter: 'log_min_messages',
  grantee: 'supabase_realtime_admin',
  privilege: 'SET',
  canonicalStatements: Object.freeze([
    'GRANT SET ON PARAMETER "log_min_messages" TO "supabase_realtime_admin";',
    'GRANT SET ON PARAMETER log_min_messages TO supabase_realtime_admin;',
  ] as const),
});

/** Fixed repository-owned replacement. It carries no bundle-derived text. */
export const NORMALIZED_PLATFORM_PARAMETER_ACL_COMMENT =
  '-- capstone-recovery: provider-managed parameter ACL normalized for self-hosted restore';

/** Container-visible name of the verifier-owned normalized artifact. */
export const NORMALIZED_ROLE_ARTIFACT = 'roles.normalized.sql';

export type RoleParameterAclCompatibilityAction = 'MATCH' | 'NORMALIZE_KNOWN_PLATFORM_ACL';

export interface RoleParameterAclCompatibilityPlan {
  action: RoleParameterAclCompatibilityAction;
  /** Statements the bounded detector classified as parameter ACLs. 0 for MATCH, 1 otherwise. */
  parameterAclStatementCount: number;
  /**
   * Structurally rebuilt role dump for NORMALIZE_KNOWN_PLATFORM_ACL: identical to the source
   * except that the one reviewed statement is replaced by a fixed comment. Null for MATCH, where
   * the original artifact replays unchanged.
   */
  normalizedRolesSql: string | null;
}

export interface RoleCompatibilityTargetRole {
  role: string;
  super: boolean;
  createRole: boolean;
}

export interface RoleCompatibilityTargetBaseline {
  roles: RoleCompatibilityTargetRole[];
  /** Row count only. Provider ACL contents never enter this evidence. */
  knownParameterAclRowCount: number;
}

/**
 * The bounded fresh-target identity this compatibility action depends on: a non-superuser
 * `postgres` that cannot replay a cluster-global grant, a superuser `supabase_admin` that owns
 * platform state, and a `supabase_realtime_admin` that the provider — not this repository —
 * defines. Nothing further about the provider is encoded.
 */
export const EXPECTED_ROLE_COMPATIBILITY_TARGET_ROLES: readonly RoleCompatibilityTargetRole[] =
  Object.freeze([
    Object.freeze({ role: 'postgres', super: false, createRole: true }),
    Object.freeze({ role: 'supabase_admin', super: true, createRole: true }),
    Object.freeze({ role: 'supabase_realtime_admin', super: false, createRole: false }),
  ]);

/** SQLSTATE a non-superuser replay of the provider grant must produce. */
export const PLATFORM_PARAMETER_ACL_DENIED_SQLSTATE = '42501';

const PARAMETER_KEYWORD = /\bparameter\b/i;
const SESSION_AUTHORIZATION = /\bsession\s+authorization\b/i;
/** PostgreSQL `ident_cont`: what continues an identifier and so cannot begin a new token. */
const IDENTIFIER_CHARACTER = /[A-Za-z0-9_$\u0080-\uffff]/;
/** PostgreSQL dollar-quote tag: empty, or `ident_start` then `ident_cont` without the dollar. */
const DOLLAR_QUOTE_TAG = /\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/y;

/**
 * One complete top-level SQL statement of the role dump.
 *
 * `start` is the first character that is neither whitespace nor a comment, so the section banners
 * `pg_dumpall` writes above the parameter-ACL block are never part of a statement. `end` is just
 * past the terminating semicolon, or the end of the dump for a trailing unterminated statement.
 * `masked` is that same span with every string, escape string, dollar-quoted body, quoted
 * identifier and comment blanked, so keyword detection can never be steered by their contents.
 */
interface TopLevelStatement {
  start: number;
  end: number;
  masked: string;
  terminated: boolean;
}

function unterminatedLexicalState(): never {
  throw new RecoveryGuardError('ROLE_PLATFORM_ACL_COMPATIBILITY_UNTERMINATED_LITERAL');
}

/** Consecutive backslashes ending immediately before `index`. */
function backslashRunLength(sql: string, index: number): number {
  let run = 0;
  while (index - run - 1 >= 0 && sql[index - run - 1] === '\\') run += 1;
  return run;
}

/**
 * Splits a role dump into top-level statements under a bounded PostgreSQL lexical model.
 *
 * Modelled, because each one can move a statement boundary or hide a token: ordinary strings with
 * doubled-quote escaping; `E` escape strings with backslash escaping; quoted identifiers with
 * doubled-quote escaping; line comments; nested block comments; and dollar-quoted strings with
 * both the empty tag and a named tag, recognized only where a token can start (PostgreSQL's
 * `ident_cont` includes the dollar sign, so `x$$` is one identifier, not a quote). Every one of
 * these may span physical lines, and CR, LF and CRLF dumps are handled, so the scanner works on
 * source offsets and never on lines. A semicolon inside any of them is data, not a terminator.
 *
 * Deliberately outside the model, and refused rather than guessed at: an ordinary string whose
 * quote is preceded by an odd backslash run. That is the only construct whose containment depends
 * on `standard_conforming_strings`, so refusing it is what makes the setting irrelevant here
 * instead of letting a dump that turns it off shift a string boundary across a real statement.
 * Unicode, bit-string and hex-string literals need no special case: their prefixes lex as ordinary
 * tokens and their bodies follow the ordinary doubled-quote rule.
 *
 * Unterminated lexical state — a block comment, string, escape string, quoted identifier or
 * dollar-quoted body still open at the end of the dump — always refuses. Malformed input can never
 * produce MATCH.
 */
function scanTopLevelStatements(sql: string): TopLevelStatement[] {
  // Starts as an exact copy, so anything the scanner does not blank stays byte-aligned with the
  // source and one span indexes both strings identically.
  const masked = sql.split('');
  const spans: Array<Omit<TopLevelStatement, 'masked'>> = [];
  let index = 0;
  let start = -1;

  const blank = (from: number, to: number): void => {
    for (let cursor = from; cursor < to; cursor += 1) {
      const character = sql[cursor];
      masked[cursor] = character === '\n' || character === '\r' ? character : ' ';
    }
  };

  /** End of an ordinary string or quoted identifier, given the index after its opening quote. */
  const closeQuoted = (from: number, delimiter: string): number => {
    let cursor = from;
    while (cursor < sql.length) {
      if (sql[cursor] === delimiter) {
        if (delimiter === "'" && backslashRunLength(sql, cursor) % 2 === 1) {
          throw new RecoveryGuardError('ROLE_PLATFORM_ACL_COMPATIBILITY_LEXICAL_MODE_UNSUPPORTED');
        }
        if (sql[cursor + 1] === delimiter) {
          cursor += 2;
          continue;
        }
        return cursor + 1;
      }
      cursor += 1;
    }
    return unterminatedLexicalState();
  };

  /** End of an escape string, given the index after its opening quote. */
  const closeEscapeString = (from: number): number => {
    let cursor = from;
    while (cursor < sql.length) {
      if (sql[cursor] === '\\') {
        cursor += 2;
        continue;
      }
      if (sql[cursor] === "'") {
        if (sql[cursor + 1] === "'") {
          cursor += 2;
          continue;
        }
        return cursor + 1;
      }
      cursor += 1;
    }
    return unterminatedLexicalState();
  };

  while (index < sql.length) {
    const character = sql[index];
    const following = sql[index + 1];

    if (character === '-' && following === '-') {
      let end = index + 2;
      while (end < sql.length && sql[end] !== '\r' && sql[end] !== '\n') end += 1;
      blank(index, end);
      index = end;
      continue;
    }
    if (character === '/' && following === '*') {
      let depth = 0;
      let cursor = index;
      while (cursor < sql.length) {
        if (sql[cursor] === '/' && sql[cursor + 1] === '*') {
          depth += 1;
          cursor += 2;
          continue;
        }
        if (sql[cursor] === '*' && sql[cursor + 1] === '/') {
          depth -= 1;
          cursor += 2;
          if (depth === 0) break;
          continue;
        }
        cursor += 1;
      }
      if (depth !== 0) unterminatedLexicalState();
      blank(index, cursor);
      index = cursor;
      continue;
    }
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }

    if (start < 0) start = index;

    if (character === ';') {
      spans.push({ start, end: index + 1, terminated: true });
      start = -1;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      const end = closeQuoted(index + 1, character);
      blank(index, end);
      index = end;
      continue;
    }
    const previous = index > 0 ? sql[index - 1] : '';
    if ((character === 'E' || character === 'e')
      && following === "'"
      && !IDENTIFIER_CHARACTER.test(previous)) {
      const end = closeEscapeString(index + 2);
      blank(index, end);
      index = end;
      continue;
    }
    if (character === '$' && !IDENTIFIER_CHARACTER.test(previous)) {
      DOLLAR_QUOTE_TAG.lastIndex = index;
      const opener = DOLLAR_QUOTE_TAG.exec(sql);
      if (opener !== null) {
        const tag = opener[0];
        const closer = sql.indexOf(tag, index + tag.length);
        if (closer < 0) unterminatedLexicalState();
        blank(index, closer + tag.length);
        index = closer + tag.length;
        continue;
      }
    }
    index += 1;
  }
  if (start >= 0) spans.push({ start, end: sql.length, terminated: false });

  const maskedSql = masked.join('');
  return spans.map((span) => ({ ...span, masked: maskedSql.slice(span.start, span.end) }));
}

/** Physical line content without its terminator; a CRLF capture keeps replaying byte-for-byte. */
function lineContent(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * A parameter ACL is accepted only when one complete top-level statement is byte-identical to a
 * reviewed canonical spelling and occupies a whole physical line of the dump. Indentation, a
 * trailing comment, trailing SQL, an embedded comment, a different spelling, and the same
 * statement wrapped across lines all fall outside the reviewed grammar and are therefore refused,
 * not normalized. Whole-line containment is also what lets normalization replace the statement
 * span and leave every other byte, including the line terminator, exactly as captured.
 */
function isAcceptedKnownPlatformParameterAcl(sql: string, statement: TopLevelStatement): boolean {
  if (!statement.terminated) return false;
  if (statement.start !== 0 && sql[statement.start - 1] !== '\n') return false;
  const trailing = sql[statement.end];
  if (trailing !== undefined
    && trailing !== '\n'
    && !(trailing === '\r' && sql[statement.end + 1] === '\n')) {
    return false;
  }
  return (KNOWN_PLATFORM_PARAMETER_ACL.canonicalStatements as readonly string[])
    .includes(sql.slice(statement.start, statement.end));
}

/**
 * Classifies a checksum-validated role dump.
 *
 * The detector is deliberately broader than the acceptor: any top-level statement the masked token
 * stream shows to be a parameter ACL is classified, and only the exact reviewed grant is accepted.
 * Unknown parameters, grantees, privileges, `ALTER SYSTEM`, `WITH GRANT OPTION`, `REVOKE`,
 * duplicates, trailing SQL, and comment or token tricks all fail closed rather than replaying or
 * being silently ignored. A grantor switch is refused outright: `buildACLCommands` only emits
 * `SET SESSION AUTHORIZATION` to replay a grant made by someone other than the parameter owner, a
 * role-only dump has no other use for it, and it would silently change the grantor of everything
 * that follows. Both checks read complete top-level statements, so neither can be evaded by moving
 * tokens onto another line or separating them with a comment.
 *
 * Every other statement is preserved exactly, so ordinary and custom roles replay unchanged, and
 * anything inside a string, escape string, dollar-quoted body, quoted identifier or comment stays
 * ordinary role data no matter what SQL it spells.
 */
export function planRoleParameterAclCompatibility(
  rolesSql: string,
): RoleParameterAclCompatibilityPlan {
  const statements = scanTopLevelStatements(rolesSql);
  if (statements.some((statement) => SESSION_AUTHORIZATION.test(statement.masked))) {
    throw new RecoveryGuardError('ROLE_PLATFORM_ACL_COMPATIBILITY_GRANTOR_SWITCH_UNSUPPORTED');
  }

  const parameterAclStatements: TopLevelStatement[] = [];
  for (const statement of statements) {
    if (!PARAMETER_KEYWORD.test(statement.masked)) continue;
    if (!isAcceptedKnownPlatformParameterAcl(rolesSql, statement)) {
      throw new RecoveryGuardError('ROLE_PLATFORM_ACL_COMPATIBILITY_STATEMENT_UNSUPPORTED');
    }
    parameterAclStatements.push(statement);
  }

  if (parameterAclStatements.length === 0) {
    return { action: 'MATCH', parameterAclStatementCount: 0, normalizedRolesSql: null };
  }
  if (parameterAclStatements.length > 1) {
    throw new RecoveryGuardError('ROLE_PLATFORM_ACL_COMPATIBILITY_DUPLICATE');
  }

  const [target] = parameterAclStatements;
  return {
    action: 'NORMALIZE_KNOWN_PLATFORM_ACL',
    parameterAclStatementCount: 1,
    normalizedRolesSql: rolesSql.slice(0, target.start)
      + NORMALIZED_PLATFORM_PARAMETER_ACL_COMMENT
      + rolesSql.slice(target.end),
  };
}

/** Fixed catalog-only query. It reads no role passwords, memberships, or ACL contents. */
export function buildRoleCompatibilityTargetBaselineSql(): string {
  return `
SELECT pg_catalog.jsonb_build_object(
  'roles', COALESCE((
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'role', role_entry.rolname,
      'super', role_entry.rolsuper,
      'createRole', role_entry.rolcreaterole
    ) ORDER BY role_entry.rolname)
    FROM pg_catalog.pg_roles AS role_entry
    WHERE role_entry.rolname IN ('postgres', 'supabase_admin', 'supabase_realtime_admin')
  ), '[]'::jsonb),
  'knownParameterAclRowCount', (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_parameter_acl AS parameter_acl
    WHERE parameter_acl.parname = '${KNOWN_PLATFORM_PARAMETER_ACL.parameter}'
  )
)::text;
  `.trim();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseRoleCompatibilityTargetBaseline(
  output: string,
): RoleCompatibilityTargetBaseline {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end < start) {
    throw new RecoveryGuardError('ROLE_PLATFORM_ACL_COMPATIBILITY_TARGET_BASELINE_INVALID');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.slice(start, end + 1)) as unknown;
  } catch {
    throw new RecoveryGuardError('ROLE_PLATFORM_ACL_COMPATIBILITY_TARGET_BASELINE_INVALID');
  }
  if (!isObject(parsed)
    || !Array.isArray(parsed.roles)
    || !Number.isSafeInteger(parsed.knownParameterAclRowCount)
    || (parsed.knownParameterAclRowCount as number) < 0) {
    throw new RecoveryGuardError('ROLE_PLATFORM_ACL_COMPATIBILITY_TARGET_BASELINE_INVALID');
  }
  const roles: RoleCompatibilityTargetRole[] = [];
  for (const entry of parsed.roles) {
    if (!isObject(entry)
      || Object.keys(entry).sort().join(',') !== 'createRole,role,super'
      || typeof entry.role !== 'string'
      || typeof entry.super !== 'boolean'
      || typeof entry.createRole !== 'boolean') {
      throw new RecoveryGuardError('ROLE_PLATFORM_ACL_COMPATIBILITY_TARGET_BASELINE_INVALID');
    }
    roles.push({ role: entry.role, super: entry.super, createRole: entry.createRole });
  }
  return { roles, knownParameterAclRowCount: parsed.knownParameterAclRowCount as number };
}

/**
 * Refuses to normalize against anything but the reviewed fresh disposable baseline, so an
 * unexpected target role identity or a target that already carries the parameter ACL is never
 * silently overwritten.
 */
export function assertRoleCompatibilityTargetBaseline(
  baseline: RoleCompatibilityTargetBaseline,
): void {
  const observed = [...baseline.roles].sort((left, right) => left.role.localeCompare(right.role));
  const expected = EXPECTED_ROLE_COMPATIBILITY_TARGET_ROLES;
  if (observed.length !== expected.length
    || observed.some((role, index) => role.role !== expected[index].role
      || role.super !== expected[index].super
      || role.createRole !== expected[index].createRole)) {
    throw new RecoveryGuardError('ROLE_PLATFORM_ACL_COMPATIBILITY_TARGET_ROLE_UNEXPECTED');
  }
  if (baseline.knownParameterAclRowCount !== 0) {
    throw new RecoveryGuardError('ROLE_PLATFORM_ACL_COMPATIBILITY_TARGET_PARAMETER_ACL_PRESENT');
  }
}

/** Retains only the fixed-width SQLSTATE; no other replay output reaches a diagnostic. */
export function extractSqlState(stderr: unknown): string | null {
  if (typeof stderr !== 'string') return null;
  const match = /(?:^|\s)(?:ERROR|FATAL|PANIC):\s+([0-9A-Z]{5}):/m.exec(stderr);
  return match ? match[1] : null;
}

const SYNTHETIC_PLATFORM_PARAMETER_ACL_SECTION = [
  '--',
  '-- Role privileges on configuration parameters',
  '--',
  '',
  KNOWN_PLATFORM_PARAMETER_ACL.canonicalStatements[0],
  '',
  '',
];

/**
 * Synthetic-only fixture transformation.
 *
 * Only a superuser can `GRANT ... ON PARAMETER`, so a disposable local source cannot produce this
 * provider-global condition naturally, and manufacturing it must never widen production privileged
 * execution. The rehearsal therefore rewrites the captured role artifact before the synthetic
 * manifest and checksums exist, so the final bundle is checksum-valid and reaches the real
 * production restore path. It refuses a dump that already carries a parameter ACL.
 *
 * Exported for the rehearsal's own regressions. Production capture cannot reach it by accident:
 * this function changes no bundle by itself, and its only caller is gated on structural proof that
 * the capture belongs to a running verifier-owned disposable source.
 */
export function buildSyntheticPlatformParameterAclRoleDump(rolesSql: string): string {
  if (planRoleParameterAclCompatibility(rolesSql).action !== 'MATCH') {
    throw new RecoveryGuardError('SYNTHETIC_PLATFORM_PARAMETER_ACL_ALREADY_PRESENT');
  }
  const lines = rolesSql.split('\n');
  const anchor = lines.findLastIndex((line) => lineContent(line) === 'RESET ALL;');
  if (anchor < 0) throw new RecoveryGuardError('SYNTHETIC_PLATFORM_PARAMETER_ACL_ANCHOR_MISSING');
  const terminator = lines[anchor].endsWith('\r') ? '\r' : '';
  lines.splice(anchor, 0, ...SYNTHETIC_PLATFORM_PARAMETER_ACL_SECTION.map(
    (line) => `${line}${terminator}`,
  ));
  return lines.join('\n');
}
