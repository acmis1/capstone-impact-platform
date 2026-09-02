import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RecoveryGuardError } from './zeroCostRecoveryContract';
import {
  EXPECTED_ROLE_COMPATIBILITY_TARGET_ROLES,
  KNOWN_PLATFORM_PARAMETER_ACL,
  NORMALIZED_PLATFORM_PARAMETER_ACL_COMMENT,
  PLATFORM_PARAMETER_ACL_DENIED_SQLSTATE,
  assertRoleCompatibilityTargetBaseline,
  buildRoleCompatibilityTargetBaselineSql,
  buildSyntheticPlatformParameterAclRoleDump,
  extractSqlState,
  parseRoleCompatibilityTargetBaseline,
  planRoleParameterAclCompatibility,
} from './roleParameterAclCompatibility';

const [QUOTED_KNOWN_GRANT, UNQUOTED_KNOWN_GRANT] = KNOWN_PLATFORM_PARAMETER_ACL.canonicalStatements;

/**
 * Shape of a Supabase CLI 2.109.1 `db dump --role-only` artifact: `pg_dumpall --roles-only
 * --quote-all-identifier`, reserved-role statements commented out by the CLI's sed pipeline, and a
 * trailing `RESET ALL;`. The reporting role deliberately carries a setting whose quoted name and
 * string value both contain the word "parameter" and a fake grant, so masking is exercised by an
 * ordinary line that must replay untouched.
 */
function roleDump(parameterAclStatements: readonly string[] = []): string {
  return [
    '--',
    '-- PostgreSQL database cluster dump',
    '--',
    '',
    '-- \\restrict aBcDeF0123456789',
    'SET default_transaction_read_only = off;',
    '',
    "SET client_encoding = 'UTF8';",
    'SET standard_conforming_strings = on;',
    '',
    '--',
    '-- Roles',
    '--',
    '',
    '-- CREATE ROLE "anon";',
    '-- ALTER ROLE "anon" WITH INHERIT NOCREATEROLE NOCREATEDB NOLOGIN NOBYPASSRLS;',
    'CREATE ROLE "capstone_reporting";',
    'ALTER ROLE "capstone_reporting" WITH INHERIT NOCREATEROLE NOCREATEDB LOGIN;',
    'ALTER ROLE "capstone_reporting" SET "statement_timeout" TO \'5min\';',
    'ALTER ROLE "capstone_reporting" SET "pgrst.db_parameter_notes" TO '
      + '\'parameter -- GRANT SET ON PARAMETER "x" TO "y";\';',
    '',
    '--',
    '-- Role memberships',
    '--',
    '',
    'GRANT "anon" TO "authenticator" WITH INHERIT FALSE GRANTED BY "supabase_admin";',
    '',
    ...(parameterAclStatements.length > 0
      ? [
        '--',
        '-- Role privileges on configuration parameters',
        '--',
        '',
        ...parameterAclStatements,
        '',
        '',
      ]
      : []),
    '-- \\unrestrict aBcDeF0123456789',
    'RESET ALL;',
    '',
  ].join('\n');
}

function guardCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error instanceof RecoveryGuardError).toBe(true);
    const failure = error as RecoveryGuardError;
    // Boolean assertions so a regression cannot print captured role text.
    expect(failure.message === failure.code).toBe(true);
    return failure.code;
  }
  throw new Error('EXPECTED_ROLE_COMPATIBILITY_REFUSAL');
}

describe('role platform parameter ACL compatibility', () => {
  it('matches a role dump that carries no parameter ACL', () => {
    expect(planRoleParameterAclCompatibility(roleDump())).toEqual({
      action: 'MATCH',
      parameterAclStatementCount: 0,
      normalizedRolesSql: null,
    });
  });

  it.each([
    ['pinned CLI quoted form', QUOTED_KNOWN_GRANT],
    ['plain pg_dumpall unquoted form', UNQUOTED_KNOWN_GRANT],
  ])('normalizes exactly one reviewed platform grant: %s', (_label, statement) => {
    const source = roleDump([statement]);
    const plan = planRoleParameterAclCompatibility(source);
    expect(plan.action).toBe('NORMALIZE_KNOWN_PLATFORM_ACL');
    expect(plan.parameterAclStatementCount).toBe(1);

    const sourceLines = source.split('\n');
    const normalizedLines = (plan.normalizedRolesSql as string).split('\n');
    expect(normalizedLines).toHaveLength(sourceLines.length);
    const changed = sourceLines
      .map((line, index) => (line === normalizedLines[index] ? -1 : index))
      .filter((index) => index >= 0);
    // Exactly one statement is neutralized; every other byte replays unchanged.
    expect(changed).toHaveLength(1);
    expect(sourceLines[changed[0]]).toBe(statement);
    expect(normalizedLines[changed[0]]).toBe(NORMALIZED_PLATFORM_PARAMETER_ACL_COMMENT);
    // No executable parameter ACL survives; the only remaining mention is an inert string body.
    expect(normalizedLines.some((line) => (
      (KNOWN_PLATFORM_PARAMETER_ACL.canonicalStatements as readonly string[]).includes(line)
    ))).toBe(false);
    expect(planRoleParameterAclCompatibility(plan.normalizedRolesSql as string).action)
      .toBe('MATCH');
    expect(plan.normalizedRolesSql).toContain('CREATE ROLE "capstone_reporting";');
    expect(plan.normalizedRolesSql).toContain(
      'GRANT "anon" TO "authenticator" WITH INHERIT FALSE GRANTED BY "supabase_admin";',
    );
  });

  it('preserves CRLF line terminators in the normalized copy', () => {
    const source = roleDump([QUOTED_KNOWN_GRANT]).replace(/\n/g, '\r\n');
    const plan = planRoleParameterAclCompatibility(source);
    expect(plan.action).toBe('NORMALIZE_KNOWN_PLATFORM_ACL');
    expect(plan.normalizedRolesSql).toContain(`${NORMALIZED_PLATFORM_PARAMETER_ACL_COMMENT}\r\n`);
    expect((plan.normalizedRolesSql as string).split('\r\n'))
      .toHaveLength(source.split('\r\n').length);
  });

  it.each([
    ['standalone CR', '\r'],
    ['LF', '\n'],
    ['CRLF', '\r\n'],
    ['repeated standalone CR', '\r\r'],
    ['mixed CR/LF ending in LF', '\r\n\r\r\n\n'],
    ['mixed CR/LF ending in CR', '\n\r\n\r\r'],
  ])('detects executable SQL after a line comment ending with %s', (_label, terminator) => {
    expect(guardCode(() => planRoleParameterAclCompatibility(
      '-- heading' + terminator
        + 'GRANT ALTER SYSTEM ON PARAMETER "log_min_messages" TO "supabase_realtime_admin";\n',
    ))).toBe('ROLE_PLATFORM_ACL_COMPATIBILITY_STATEMENT_UNSUPPORTED');
    expect(guardCode(() => planRoleParameterAclCompatibility(
      '-- heading' + terminator + 'SET SESSION AUTHORIZATION "postgres";\n',
    ))).toBe('ROLE_PLATFORM_ACL_COMPATIBILITY_GRANTOR_SWITCH_UNSUPPORTED');
    expect(guardCode(() => planRoleParameterAclCompatibility(
      'SET SESSION -- heading' + terminator + 'AUTHORIZATION "postgres";\n',
    ))).toBe('ROLE_PLATFORM_ACL_COMPATIBILITY_GRANTOR_SWITCH_UNSUPPORTED');
  });

  it.each([
    ['ordinary string', "'", "'"],
    ['E escape string', "E'", "'"],
    ['e escape string', "e'", "'"],
    ['dollar string', '$$', '$$'],
    ['tagged dollar string', '$body$', '$body$'],
  ])('starts a %s after bare CR and preserves its literal bytes', (_label, opener, closer) => {
    const literal = '-- heading\rALTER ROLE "capstone_reporting" SET "note" TO ' + opener
      + ';\n' + QUOTED_KNOWN_GRANT + '\n-- literal\r' + UNQUOTED_KNOWN_GRANT
      + '\rSET SESSION AUTHORIZATION "postgres";\r' + closer + ';';
    expect(planRoleParameterAclCompatibility(literal + '\n')).toEqual({
      action: 'MATCH',
      parameterAclStatementCount: 0,
      normalizedRolesSql: null,
    });

    // The same grant occurs in literal data and at top level. Only the latter may change, even
    // after repeated mixed terminators; both LF and CRLF and all other bytes must survive.
    for (const newline of ['\n', '\r\n']) {
      const prefix = literal + '\r\r\n\r\n' + '-- before grant' + newline;
      const suffix = newline + '-- after grant\rRESET ALL;\r\n\r';
      const plan = planRoleParameterAclCompatibility(prefix + QUOTED_KNOWN_GRANT + suffix);
      expect(plan.action).toBe('NORMALIZE_KNOWN_PLATFORM_ACL');
      expect(plan.parameterAclStatementCount).toBe(1);
      expect(Buffer.from(plan.normalizedRolesSql as string).equals(Buffer.from(
        prefix + NORMALIZED_PLATFORM_PARAMETER_ACL_COMMENT + suffix,
      ))).toBe(true);
      expect(planRoleParameterAclCompatibility(plan.normalizedRolesSql as string).action)
        .toBe('MATCH');
    }
    expect(guardCode(() => planRoleParameterAclCompatibility(
      '-- heading\rALTER ROLE "capstone_reporting" SET "note" TO ' + opener
        + ';\n' + QUOTED_KNOWN_GRANT + '\n-- literal\r',
    ))).toBe('ROLE_PLATFORM_ACL_COMPATIBILITY_UNTERMINATED_LITERAL');
  });

  it('never treats an ordinary role setting that mentions the word parameter as an ACL', () => {
    const plan = planRoleParameterAclCompatibility(roleDump());
    expect(plan.action).toBe('MATCH');
    // The masked detector ignores quoted identifiers, string bodies and comments.
    expect(roleDump()).toContain('GRANT SET ON PARAMETER "x" TO "y";');
  });

  it.each([
    ['duplicate exact known grant', [QUOTED_KNOWN_GRANT, QUOTED_KNOWN_GRANT],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_DUPLICATE'],
    ['duplicate across quoted and unquoted forms', [QUOTED_KNOWN_GRANT, UNQUOTED_KNOWN_GRANT],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_DUPLICATE'],
    ['SET on another parameter',
      ['GRANT SET ON PARAMETER "statement_timeout" TO "supabase_realtime_admin";'],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_STATEMENT_UNSUPPORTED'],
    ['same parameter to another role',
      ['GRANT SET ON PARAMETER "log_min_messages" TO "supabase_admin";'],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_STATEMENT_UNSUPPORTED'],
    ['ALTER SYSTEM',
      ['GRANT ALTER SYSTEM ON PARAMETER "log_min_messages" TO "supabase_realtime_admin";'],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_STATEMENT_UNSUPPORTED'],
    ['SET and ALTER SYSTEM together',
      ['GRANT SET,ALTER SYSTEM ON PARAMETER "log_min_messages" TO "supabase_realtime_admin";'],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_STATEMENT_UNSUPPORTED'],
    ['collapsed ALL privileges',
      ['GRANT ALL ON PARAMETER "log_min_messages" TO "supabase_realtime_admin";'],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_STATEMENT_UNSUPPORTED'],
    ['WITH GRANT OPTION',
      [`${QUOTED_KNOWN_GRANT.slice(0, -1)} WITH GRANT OPTION;`],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_STATEMENT_UNSUPPORTED'],
    ['REVOKE SET ON PARAMETER',
      ['REVOKE SET ON PARAMETER "log_min_messages" FROM "supabase_realtime_admin";'],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_STATEMENT_UNSUPPORTED'],
    ['REVOKE ALL ON PARAMETER FROM PUBLIC',
      ['REVOKE ALL ON PARAMETER "log_min_messages" FROM PUBLIC;'],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_STATEMENT_UNSUPPORTED'],
    ['unknown parameter ACL statement',
      ['GRANT SET ON PARAMETER "wal_level" TO "postgres";'],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_STATEMENT_UNSUPPORTED'],
    ['known grant plus an unknown parameter ACL',
      [QUOTED_KNOWN_GRANT, 'GRANT SET ON PARAMETER "wal_level" TO "postgres";'],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_STATEMENT_UNSUPPORTED'],
    ['trailing SQL after the known grant',
      [`${QUOTED_KNOWN_GRANT} DROP ROLE "capstone_reporting";`],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_STATEMENT_UNSUPPORTED'],
    ['mixed quoted and bare identifiers',
      ['GRANT SET ON PARAMETER "log_min_messages" TO supabase_realtime_admin;'],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_STATEMENT_UNSUPPORTED'],
    ['string literal in place of a quoted identifier',
      ["GRANT SET ON PARAMETER 'log_min_messages' TO \"supabase_realtime_admin\";"],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_STATEMENT_UNSUPPORTED'],
    ['lower-case spelling',
      ['grant set on parameter "log_min_messages" to "supabase_realtime_admin";'],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_STATEMENT_UNSUPPORTED'],
    ['block comment inside the statement',
      ['GRANT/**/SET ON PARAMETER "log_min_messages" TO "supabase_realtime_admin";'],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_STATEMENT_UNSUPPORTED'],
    ['block comment before the parameter name',
      ['GRANT SET ON PARAMETER /* platform */ "log_min_messages" TO "supabase_realtime_admin";'],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_STATEMENT_UNSUPPORTED'],
    ['trailing line comment',
      [`${QUOTED_KNOWN_GRANT} -- provider managed`],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_STATEMENT_UNSUPPORTED'],
    ['leading indentation',
      [`  ${QUOTED_KNOWN_GRANT}`],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_STATEMENT_UNSUPPORTED'],
    ['statement wrapped across lines',
      ['GRANT SET ON PARAMETER "log_min_messages"', '    TO "supabase_realtime_admin";'],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_STATEMENT_UNSUPPORTED'],
    ['grantor switch around the known grant',
      ['SET SESSION AUTHORIZATION "supabase_admin";', QUOTED_KNOWN_GRANT,
        'RESET SESSION AUTHORIZATION;'],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_GRANTOR_SWITCH_UNSUPPORTED'],
    // A non-nesting comment scanner ends the outer comment at the first close, leaves the quote
    // that follows at top level, and the string it opens then swallows the real grant.
    ['a real parameter ACL hidden behind nested block comments',
      ["/* outer /* inner */ ' */",
        'GRANT SET ON PARAMETER "statement_timeout"',
        '  TO "supabase_realtime_admin";',
        "/* ' */"],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_STATEMENT_UNSUPPORTED'],
    // A scanner that ignores backslash escaping closes the first escape string early and reads the
    // grant as string content.
    ['a real parameter ACL between valid escape-string literals',
      ["ALTER ROLE \"capstone_reporting\" SET \"note_a\" TO E'can\\'t';",
        'GRANT SET ON PARAMETER "wal_level" TO "postgres";',
        "ALTER ROLE \"capstone_reporting\" SET \"note_b\" TO E'can\\'t';"],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_STATEMENT_UNSUPPORTED'],
    ['a real parameter ACL after dollar-quoted role data',
      ['ALTER ROLE "capstone_reporting" SET "note_c" TO $$one; two;$$;',
        'GRANT SET ON PARAMETER "wal_level" TO "postgres";'],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_STATEMENT_UNSUPPORTED'],
    ['a real parameter ACL before tagged dollar-quoted role data',
      ['GRANT SET ON PARAMETER "wal_level" TO "postgres";',
        'ALTER ROLE "capstone_reporting" SET "note_d" TO $body$one; two;$body$;'],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_STATEMENT_UNSUPPORTED'],
    ['an unsupported parameter ACL split across physical lines',
      ['GRANT SET ON PARAMETER "wal_level"', '  TO "postgres";'],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_STATEMENT_UNSUPPORTED'],
    ['a grantor switch split across physical lines',
      ['SET SESSION', 'AUTHORIZATION "postgres";', QUOTED_KNOWN_GRANT],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_GRANTOR_SWITCH_UNSUPPORTED'],
    ['a grantor switch separated by a block comment',
      ['SET SESSION', '/* provider */', 'AUTHORIZATION "postgres";', QUOTED_KNOWN_GRANT],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_GRANTOR_SWITCH_UNSUPPORTED'],
    ['a grantor switch separated by a line comment',
      ['SET SESSION -- provider', 'AUTHORIZATION "postgres";'],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_GRANTOR_SWITCH_UNSUPPORTED'],
    // Whether this closes the string depends on standard_conforming_strings, which is exactly the
    // ambiguity the scanner refuses instead of guessing at.
    ['a backslash-terminated ordinary string literal',
      ["ALTER ROLE \"capstone_reporting\" SET \"note_e\" TO 'trailing\\';"],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_LEXICAL_MODE_UNSUPPORTED'],
  ])('fails closed for %s', (_label, statements, expectedCode) => {
    expect(guardCode(() => planRoleParameterAclCompatibility(roleDump(statements))))
      .toBe(expectedCode);
  });

  it.each([
    ['unterminated string literal', "ALTER ROLE \"capstone_reporting\" SET \"x\" TO 'open"],
    ['unterminated block comment', '/* open'],
    ['unterminated nested block comment', '/* outer /* inner */'],
    ['unterminated escape string', "ALTER ROLE \"capstone_reporting\" SET \"x\" TO E'open"],
    ['unterminated escape string ending in a backslash',
      "ALTER ROLE \"capstone_reporting\" SET \"x\" TO E'open\\'"],
    ['unterminated dollar-quoted string',
      'ALTER ROLE "capstone_reporting" SET "x" TO $$open'],
    ['unterminated tagged dollar-quoted string',
      'ALTER ROLE "capstone_reporting" SET "x" TO $body$open'],
    ['unterminated dollar-quoted string carrying the known grant',
      `ALTER ROLE "capstone_reporting" SET "x" TO $body$${QUOTED_KNOWN_GRANT}`],
    ['unbalanced quoted identifier in a parameter grant',
      'GRANT SET ON PARAMETER "log_min_messages TO "supabase_realtime_admin";'],
  ])('fails closed for an %s', (_label, tail) => {
    expect(guardCode(() => planRoleParameterAclCompatibility(`${roleDump()}${tail}`)))
      .toBe('ROLE_PLATFORM_ACL_COMPATIBILITY_UNTERMINATED_LITERAL');
  });

  it.each([
    ['an ordinary string literal',
      `ALTER ROLE "capstone_reporting" SET "note" TO '${QUOTED_KNOWN_GRANT}';`],
    ['an escape-string literal',
      `ALTER ROLE "capstone_reporting" SET "note" TO E'${QUOTED_KNOWN_GRANT}';`],
    ['an untagged dollar-quoted literal',
      `ALTER ROLE "capstone_reporting" SET "note" TO $$${QUOTED_KNOWN_GRANT}$$;`],
    ['a tagged dollar-quoted literal',
      `ALTER ROLE "capstone_reporting" SET "note" TO $body$${QUOTED_KNOWN_GRANT}$body$;`],
    ['a line comment', `-- ${QUOTED_KNOWN_GRANT}`],
    ['a block comment', `/* ${QUOTED_KNOWN_GRANT} */`],
    ['a nested block comment', `/* outer /* ${QUOTED_KNOWN_GRANT} */ */`],
  ])('never normalizes canonical grant text carried inside %s', (_label, line) => {
    const source = roleDump([line]);
    expect(source).toContain(QUOTED_KNOWN_GRANT);
    expect(planRoleParameterAclCompatibility(source)).toEqual({
      action: 'MATCH',
      parameterAclStatementCount: 0,
      normalizedRolesSql: null,
    });
  });

  it('never normalizes canonical grant text carried inside a quoted identifier', () => {
    // The whole statement is spelled inside one identifier, doubled quotes and all.
    const embedded = QUOTED_KNOWN_GRANT.replace(/"/g, '""');
    const source = roleDump([`ALTER ROLE "capstone_reporting" SET "${embedded}" TO '1';`]);
    expect(source).toContain(embedded);
    expect(planRoleParameterAclCompatibility(source).action).toBe('MATCH');
  });

  it('keeps a multi-line dollar-quoted role setting as ordinary role data', () => {
    const source = roleDump([
      'ALTER ROLE "capstone_reporting" SET "pgrst.db_pre_request" TO',
      '$$',
      'GRANT SET ON PARAMETER "log_min_messages"',
      'TO "supabase_realtime_admin";',
      '$$;',
    ]);
    expect(planRoleParameterAclCompatibility(source).action).toBe('MATCH');
  });

  it('treats semicolons inside literals as data rather than statement terminators', () => {
    const source = roleDump([
      "ALTER ROLE \"capstone_reporting\" SET \"a\" TO 'one; GRANT SET ON PARAMETER \"p\" TO \"q\";';",
      "ALTER ROLE \"capstone_reporting\" SET \"b\" TO E'one; GRANT SET ON PARAMETER \"p\" TO \"q\";';",
      'ALTER ROLE "capstone_reporting" SET "c" TO $$one; GRANT SET ON PARAMETER "p" TO "q";$$;',
    ]);
    expect(planRoleParameterAclCompatibility(source).action).toBe('MATCH');
  });

  it('normalizes only the top-level grant when literals spell the same statement', () => {
    const literals = [
      `-- ${QUOTED_KNOWN_GRANT}`,
      `ALTER ROLE "capstone_reporting" SET "note_a" TO '${QUOTED_KNOWN_GRANT}';`,
      `ALTER ROLE "capstone_reporting" SET "note_b" TO E'${QUOTED_KNOWN_GRANT}';`,
      `ALTER ROLE "capstone_reporting" SET "note_c" TO $body$${QUOTED_KNOWN_GRANT}$body$;`,
    ];
    const source = roleDump([...literals, QUOTED_KNOWN_GRANT]);
    const plan = planRoleParameterAclCompatibility(source);
    expect(plan.action).toBe('NORMALIZE_KNOWN_PLATFORM_ACL');
    expect(plan.parameterAclStatementCount).toBe(1);

    const sourceLines = source.split('\n');
    const normalizedLines = (plan.normalizedRolesSql as string).split('\n');
    const changed = sourceLines
      .map((line, index) => (line === normalizedLines[index] ? -1 : index))
      .filter((index) => index >= 0);
    expect(changed).toHaveLength(1);
    expect(sourceLines[changed[0]]).toBe(QUOTED_KNOWN_GRANT);
    expect(normalizedLines[changed[0]]).toBe(NORMALIZED_PLATFORM_PARAMETER_ACL_COMMENT);
    // Every literal that merely spells the statement is still byte-for-byte role data.
    for (const literal of literals) expect(normalizedLines).toContain(literal);
  });

  it('keeps sensitive role and parameter tokens out of every refusal', () => {
    const sensitiveToken = `SECRETTOKEN_${randomBytes(16).toString('hex').toUpperCase()}`;
    const code = guardCode(() => planRoleParameterAclCompatibility(roleDump([
      `GRANT SET ON PARAMETER "${sensitiveToken}" TO "${sensitiveToken}";`,
    ])));
    expect(code.includes(sensitiveToken)).toBe(false);
    expect(code).toBe('ROLE_PLATFORM_ACL_COMPATIBILITY_STATEMENT_UNSUPPORTED');
  });

  it('keeps sensitive dollar-quoted and grantor-switch text out of every refusal', () => {
    const sensitiveToken = `SECRETTOKEN_${randomBytes(16).toString('hex').toUpperCase()}`;
    expect(guardCode(() => planRoleParameterAclCompatibility(roleDump([
      `ALTER ROLE "capstone_reporting" SET "note" TO $${sensitiveToken}$one;`,
    ])))).toBe('ROLE_PLATFORM_ACL_COMPATIBILITY_UNTERMINATED_LITERAL');
    expect(guardCode(() => planRoleParameterAclCompatibility(roleDump([
      'SET SESSION', `AUTHORIZATION "${sensitiveToken}";`,
    ])))).toBe('ROLE_PLATFORM_ACL_COMPATIBILITY_GRANTOR_SWITCH_UNSUPPORTED');
  });
});

describe('role compatibility target baseline', () => {
  const baselineOutput = JSON.stringify({
    roles: EXPECTED_ROLE_COMPATIBILITY_TARGET_ROLES,
    knownParameterAclRowCount: 0,
  });

  it('builds a read-only catalog query that reads no ACL contents', () => {
    const sql = buildRoleCompatibilityTargetBaselineSql();
    expect(sql.startsWith('SELECT')).toBe(true);
    expect(/\b(insert|update|delete|grant|revoke|alter|create|drop|copy)\b/i.test(sql)).toBe(false);
    expect(sql).toContain('pg_catalog.pg_parameter_acl');
    expect(sql).not.toContain('paracl');
  });

  it('accepts the reviewed fresh disposable baseline', () => {
    const baseline = parseRoleCompatibilityTargetBaseline(`  ${baselineOutput}\n(1 row)\n`);
    expect(baseline.knownParameterAclRowCount).toBe(0);
    expect(baseline.roles).toHaveLength(3);
    expect(() => assertRoleCompatibilityTargetBaseline(baseline)).not.toThrow();
  });

  it.each([
    ['a superuser postgres', { roles: [
      { role: 'postgres', super: true, createRole: true },
      { role: 'supabase_admin', super: true, createRole: true },
      { role: 'supabase_realtime_admin', super: false, createRole: false },
    ], knownParameterAclRowCount: 0 }, 'ROLE_PLATFORM_ACL_COMPATIBILITY_TARGET_ROLE_UNEXPECTED'],
    ['a missing provider role', { roles: [
      { role: 'postgres', super: false, createRole: true },
      { role: 'supabase_admin', super: true, createRole: true },
    ], knownParameterAclRowCount: 0 }, 'ROLE_PLATFORM_ACL_COMPATIBILITY_TARGET_ROLE_UNEXPECTED'],
    ['an existing target parameter ACL', {
      roles: EXPECTED_ROLE_COMPATIBILITY_TARGET_ROLES,
      knownParameterAclRowCount: 1,
    }, 'ROLE_PLATFORM_ACL_COMPATIBILITY_TARGET_PARAMETER_ACL_PRESENT'],
  ])('refuses to normalize against %s', (_label, document, expectedCode) => {
    const baseline = parseRoleCompatibilityTargetBaseline(JSON.stringify(document));
    expect(guardCode(() => assertRoleCompatibilityTargetBaseline(baseline))).toBe(expectedCode);
  });

  it.each([
    ['no JSON at all', 'ERROR: permission denied'],
    ['a non-object payload', '[]'],
    ['a malformed role entry', '{"roles":[{"role":"postgres"}],"knownParameterAclRowCount":0}'],
    ['a negative row count', '{"roles":[],"knownParameterAclRowCount":-1}'],
  ])('fails closed for %s', (_label, output) => {
    expect(guardCode(() => parseRoleCompatibilityTargetBaseline(output)))
      .toBe('ROLE_PLATFORM_ACL_COMPATIBILITY_TARGET_BASELINE_INVALID');
  });
});

describe('replay evidence and synthetic fixture', () => {
  it('retains only the fixed-width SQLSTATE from a failed replay', () => {
    const stderr = 'psql:/tmp/capstone-recovery/roles.sql:42: ERROR:  42501: permission denied '
      + 'to set parameter "log_min_messages"\nDETAIL:  private detail\n';
    expect(extractSqlState(stderr)).toBe(PLATFORM_PARAMETER_ACL_DENIED_SQLSTATE);
    expect(extractSqlState('ERROR:  permission denied')).toBeNull();
    expect(extractSqlState(undefined)).toBeNull();
  });

  it('reproduces the provider grant ahead of the trailing reset anchor', () => {
    const injected = buildSyntheticPlatformParameterAclRoleDump(roleDump());
    const plan = planRoleParameterAclCompatibility(injected);
    expect(plan.action).toBe('NORMALIZE_KNOWN_PLATFORM_ACL');
    expect(injected).toContain(`${QUOTED_KNOWN_GRANT}\n`);
    expect(injected.indexOf(QUOTED_KNOWN_GRANT)).toBeLessThan(injected.lastIndexOf('RESET ALL;'));
    expect(plan.normalizedRolesSql).toBe(
      injected.replace(QUOTED_KNOWN_GRANT, NORMALIZED_PLATFORM_PARAMETER_ACL_COMMENT),
    );
  });

  it('refuses to reproduce the grant twice or without the reset anchor', () => {
    expect(guardCode(() => buildSyntheticPlatformParameterAclRoleDump(
      buildSyntheticPlatformParameterAclRoleDump(roleDump()),
    ))).toBe('SYNTHETIC_PLATFORM_PARAMETER_ACL_ALREADY_PRESENT');
    expect(guardCode(() => buildSyntheticPlatformParameterAclRoleDump('CREATE ROLE "x";\n')))
      .toBe('SYNTHETIC_PLATFORM_PARAMETER_ACL_ANCHOR_MISSING');
  });
});
