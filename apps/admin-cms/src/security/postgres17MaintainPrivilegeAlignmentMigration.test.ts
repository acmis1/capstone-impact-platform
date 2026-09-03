import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  EXPECTED_REPOSITORY_MIGRATION_COUNT,
  EXPECTED_REPOSITORY_MIGRATIONS,
} from '../deployment/hostedDeploymentReadiness';
import { EXPECTED_MIGRATION_FILENAMES } from '../scripts/onboardingCheck';

/**
 * Migration 0048 exists only to keep one reviewed privilege contract identical across PostgreSQL
 * engine versions. These tests hold it to that narrow purpose: exactly one privilege, exactly one
 * role, exactly five tables, and no schema, policy, routine or role-membership change at all.
 */
describe('PostgreSQL 17 MAINTAIN privilege alignment migration', () => {
  const root = path.resolve(__dirname, '../../../..');
  const migrationsDirectory = path.join(root, 'infra/supabase/migrations');
  const filename = '20260831090000_postgres17_maintain_privilege_alignment.sql';
  const migrationRepositoryPath = `infra/supabase/migrations/${filename}`;
  const source = fs.readFileSync(path.join(migrationsDirectory, filename), 'utf8').replace(/\r\n/g, '\n');
  const executable = source.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
  const compact = executable.replace(/\s+/g, ' ');

  /** The five tables whose historical `GRANT ALL ... TO service_role` predates PostgreSQL 17. */
  const ALIGNED_TABLES = [
    'browser_import_commits',
    'browser_import_media_commits',
    'participant_previews',
    'participant_preview_confirmations',
    'participant_preview_correction_requests',
  ];

  /** The five migrations that issued those grants. None of them may be edited. */
  const GRANTING_MIGRATIONS = [
    '20260810090000_atomic_browser_import_metadata_stage.sql',
    '20260810120000_atomic_browser_import_media_stage.sql',
    '20260810180000_participant_preview_links.sql',
    '20260811090000_participant_preview_confirmations.sql',
    '20260811120000_participant_preview_correction_requests.sql',
  ];

  /**
   * Resolves the commit immediately before Migration 0048 first entered the checked-out history.
   * This remains meaningful both on a feature branch and after squash-merge to `main`, unlike
   * comparing to `origin/main` (which necessarily contains the migration after merge).
   */
  function migrationIntroductionBaseline(): {
    introductionCommit: string;
    parentCommit: string;
    files: string[];
    introducedFiles: string[];
  } {
    const introductionCommit = execFileSync('git', [
      'log', '-1', '--diff-filter=A', '--format=%H', '--', migrationRepositoryPath,
    ], { cwd: root, encoding: 'utf8' }).trim();
    expect(introductionCommit).toMatch(/^[a-f0-9]{40}$/);

    const parentCommit = execFileSync('git', ['rev-parse', `${introductionCommit}^`], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    expect(parentCommit).toMatch(/^[a-f0-9]{40}$/);

    const files = execFileSync('git', [
      'ls-tree', '-r', '--name-only', parentCommit, 'infra/supabase/migrations/',
    ], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map((entry) => path.posix.basename(entry))
      .sort();

    const introducedFiles = execFileSync('git', [
      'diff-tree', '--no-commit-id', '--name-only', '--diff-filter=A', '-r', introductionCommit,
      '--', 'infra/supabase/migrations/',
    ], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map((entry) => path.posix.basename(entry))
      .sort();

    return { introductionCommit, parentCommit, files, introducedFiles };
  }

  it('remains in the forward migration sequence and does not renumber or replace anything', () => {
    const files = fs.readdirSync(migrationsDirectory).filter((file) => file.endsWith('.sql')).sort();

    expect(files).toEqual([...EXPECTED_MIGRATION_FILENAMES]);
    expect(files).toEqual([...EXPECTED_REPOSITORY_MIGRATIONS]);
    expect(files).toHaveLength(EXPECTED_REPOSITORY_MIGRATION_COUNT);
    expect(EXPECTED_REPOSITORY_MIGRATION_COUNT).toBe(50);
    expect(files.at(-1)).toBe('20260903120000_participant_preview_controlled_links.sql');
    expect(files.at(-2)).toBe('20260902010606_controlled_project_links_import.sql');
    expect(files.at(-3)).toBe(filename);
    expect(files.at(-4)).toBe('20260828170000_assistive_execution_control.sql');

    // Forward-only: every migration that existed immediately before 0048 was introduced remains
    // present in the same ordered prefix. This works before and after merge and catches deletion,
    // renumbering or replacement without making `origin/main` an impossible post-merge baseline.
    const baseline = migrationIntroductionBaseline();
    expect(baseline.files).not.toContain(filename);
    expect(files.slice(0, baseline.files.length)).toEqual(baseline.files);
    expect(baseline.introducedFiles).toEqual([
      '20260828170000_assistive_execution_control.sql',
      filename,
    ]);

    expect(files.slice(baseline.files.length)).toEqual([
      ...baseline.introducedFiles,
      '20260902010606_controlled_project_links_import.sql',
      '20260903120000_participant_preview_controlled_links.sql',
    ]);
  });

  it('leaves every migration through 0048 byte-identical to its introduction baseline', () => {
    const baseline = migrationIntroductionBaseline();

    for (const historical of baseline.files) {
      const repositoryPath = `infra/supabase/migrations/${historical}`;
      const committed = execFileSync('git', ['show', `${baseline.parentCommit}:${repositoryPath}`], {
        cwd: root,
        encoding: 'utf8',
      }).replace(/\r\n/g, '\n');
      expect(fs.readFileSync(path.join(root, repositoryPath), 'utf8').replace(/\r\n/g, '\n')).toBe(committed);
    }

    // Migrations introduced in the same squash-merge as 0048 are now historical as well. Pin their
    // bytes to the introduction commit so a future PR cannot mutate 0047 or 0048 in place.
    for (const introduced of baseline.introducedFiles) {
      const repositoryPath = `infra/supabase/migrations/${introduced}`;
      const committed = execFileSync('git', ['show', `${baseline.introductionCommit}:${repositoryPath}`], {
        cwd: root,
        encoding: 'utf8',
      }).replace(/\r\n/g, '\n');
      expect(fs.readFileSync(path.join(root, repositoryPath), 'utf8').replace(/\r\n/g, '\n')).toBe(committed);
    }

    // The five grant-issuing migrations are named explicitly so a future edit to one of them fails
    // here even if the sweeping check above were ever narrowed.
    for (const historical of GRANTING_MIGRATIONS) {
      expect(baseline.files).toContain(historical);
      const repositoryPath = `infra/supabase/migrations/${historical}`;
      const committed = execFileSync('git', ['show', `${baseline.parentCommit}:${repositoryPath}`], {
        cwd: root,
        encoding: 'utf8',
      }).replace(/\r\n/g, '\n');
      expect(fs.readFileSync(path.join(root, repositoryPath), 'utf8').replace(/\r\n/g, '\n')).toBe(committed);
      expect(committed).toMatch(/GRANT ALL ON public\.[a-z_]+ TO service_role;/);
    }
  });

  it('guards the MAINTAIN statement behind a deterministic server-version branch', () => {
    expect(compact).toContain("pg_catalog.current_setting('server_version_num')::integer >= 170000");

    // PostgreSQL 15 and 16 cannot parse the MAINTAIN keyword, so it must never appear outside a
    // string literal that only a PostgreSQL 17+ server ever executes.
    expect([...executable.matchAll(/REVOKE\s+MAINTAIN/g)]).toHaveLength(1);
    expect(executable).toMatch(/EXECUTE\s+'REVOKE MAINTAIN ON TABLE '/);
    expect(executable).not.toMatch(/^\s*REVOKE\s+MAINTAIN/mi);

    // The version branch must not be configurable, and failures must not be swallowed.
    expect(executable).not.toMatch(/\bEXCEPTION\s+WHEN\b/i);
    expect(executable).not.toMatch(/current_setting\(\s*'[a-z_]*\.[a-z_]+'/i);
    expect(compact).toContain('RAISE EXCEPTION');
  });

  it('revokes MAINTAIN from service_role on exactly the five aligned tables', () => {
    const revoke = compact.match(/EXECUTE 'REVOKE MAINTAIN ON TABLE '(.*?)'FROM service_role';/)?.[0];
    expect(revoke).toBeDefined();

    for (const table of ALIGNED_TABLES) {
      expect(revoke).toContain(`public.${table}`);
    }

    const revokedTables = [...(revoke ?? '').matchAll(/public\.([a-z_]+)/g)].map((match) => match[1]);
    expect(revokedTables.sort()).toEqual([...ALIGNED_TABLES].sort());
    expect(revoke).toContain('FROM service_role');
  });

  it('names service_role as the only affected role', () => {
    const roles = new Set([...executable.matchAll(/\b(service_role|anon|authenticated|PUBLIC|capstone_assistive_dispatcher|postgres|supabase_admin)\b/g)]
      .map((match) => match[1]));
    expect([...roles]).toEqual(['service_role']);
  });

  it('revokes no other table privilege and grants nothing', () => {
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'ALL', 'EXECUTE', 'USAGE']) {
      expect(executable).not.toMatch(new RegExp(`REVOKE[^']*\\b${privilege}\\b`, 'i'));
    }
    expect(executable).not.toMatch(/\bGRANT\b/i);
    expect(executable).not.toMatch(/\bALTER\s+DEFAULT\s+PRIVILEGES\b/i);
  });

  it('does not touch pg_maintain role membership or any role definition', () => {
    expect(executable).not.toMatch(/\bpg_maintain\b/i);
    expect(executable).not.toMatch(/\b(CREATE|ALTER|DROP)\s+ROLE\b/i);
    expect(executable).not.toMatch(/\bGRANT\s+[a-z_]+\s+TO\b/i);
    expect(executable).not.toMatch(/\bREVOKE\s+[a-z_]+\s+FROM\s+[a-z_]+\s*;/i);
    expect(executable).not.toMatch(/\bOWNER\s+TO\b/i);
  });

  it('contains no schema, table, policy, RLS, routine, trigger or Storage mutation', () => {
    for (const forbidden of [
      /\bCREATE\s+(TABLE|SCHEMA|POLICY|FUNCTION|PROCEDURE|TRIGGER|INDEX|VIEW|TYPE|EXTENSION)\b/i,
      /\bALTER\s+(TABLE|SCHEMA|POLICY|FUNCTION|PROCEDURE|TYPE|INDEX|VIEW)\b/i,
      /\bDROP\s+(TABLE|SCHEMA|POLICY|FUNCTION|PROCEDURE|TRIGGER|INDEX|VIEW|COLUMN)\b/i,
      /\bROW\s+LEVEL\s+SECURITY\b/i,
      /\b(INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|TRUNCATE)\b/i,
      /\bstorage\.\w/i,
      /\bauth\.\w/i,
      /\bpublic\.(projects|media_assets|approval_records|published_snapshots|validation_flags|import_batches|public_feed_\w+)\b/i,
    ]) {
      expect(executable).not.toMatch(forbidden);
    }

    // Reads of the system catalogs are the only queries the migration performs.
    expect(compact).toContain('FROM pg_catalog.pg_roles');
    expect(compact).toContain('FROM pg_catalog.pg_class');
  });

  it('fails closed on PostgreSQL 17 when an expected role or table is missing', () => {
    expect(compact).toContain(
      "RAISE EXCEPTION 'PostgreSQL 17 MAINTAIN alignment refused: expected role service_role does not exist.'",
    );
    expect(compact).toContain(
      "RAISE EXCEPTION 'PostgreSQL 17 MAINTAIN alignment refused: expected table public.% does not exist.'",
    );
    // Both guards precede the single REVOKE, so alignment is never claimed without being performed.
    expect(compact.indexOf('RAISE EXCEPTION')).toBeLessThan(compact.indexOf('EXECUTE \'REVOKE MAINTAIN'));
  });

  it('keeps the exact migration manifest, count and latest-migration contracts in step', () => {
    expect(EXPECTED_MIGRATION_FILENAMES).toHaveLength(50);
    expect(EXPECTED_MIGRATION_FILENAMES.at(-1)).toBe('20260903120000_participant_preview_controlled_links.sql');
    expect(EXPECTED_MIGRATION_FILENAMES.at(-2)).toBe('20260902010606_controlled_project_links_import.sql');
    expect(EXPECTED_MIGRATION_FILENAMES.at(-3)).toBe(filename);
    expect(EXPECTED_REPOSITORY_MIGRATIONS.at(-1)).toBe('20260903120000_participant_preview_controlled_links.sql');
    expect(EXPECTED_REPOSITORY_MIGRATIONS.at(-2)).toBe('20260902010606_controlled_project_links_import.sql');
    expect(EXPECTED_REPOSITORY_MIGRATIONS.at(-3)).toBe(filename);
    expect(EXPECTED_REPOSITORY_MIGRATION_COUNT).toBe(EXPECTED_REPOSITORY_MIGRATIONS.length);

    const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain(
      "test \"$(find infra/supabase/migrations -name '*.sql' | wc -l)\" -eq 50",
    );
  });

  it('leaves the Gate 4 evidence contract able to observe MAINTAIN drift', () => {
    // The comparator must keep recognising MAINTAIN: before this migration reaches a PostgreSQL 17
    // server, MAINTAIN drift is exactly what Gate 4 has to be able to report.
    const parser = fs.readFileSync(path.join(root, 'apps/admin-cms/src/deployment/gate4SchemaEvidence.ts'), 'utf8');
    expect(parser).toContain("'TRIGGER', 'MAINTAIN'");

    const collector = fs.readFileSync(path.join(root, 'infra/supabase/gate4-schema-evidence.sql'), 'utf8');
    expect(collector).toContain('table_acl.privilege_type');
    expect(collector).not.toMatch(/privilege_type\s*(<>|!=|NOT\s+IN)[^\n]*MAINTAIN/i);
  });

  it('keeps Local Supabase on PostgreSQL 15 so the guard is exercised, not bypassed', () => {
    const config = fs.readFileSync(path.join(root, 'infra/supabase/config.toml'), 'utf8');
    expect(config).toMatch(/^major_version = 15$/m);
  });
});
