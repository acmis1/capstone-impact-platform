import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { EXPECTED_MIGRATION_FILENAMES } from '../scripts/onboardingCheck';
import {
  EXPECTED_REPOSITORY_MIGRATIONS,
  EXPECTED_REPOSITORY_MIGRATION_COUNT,
} from '../deployment/hostedDeploymentReadiness';

const root = path.resolve(__dirname, '../../../..');
const migrations = path.join(root, 'infra/supabase/migrations');

const IMPORT_MIGRATION = '20260902010606_controlled_project_links_import.sql';
const FILENAME = '20260903120000_participant_preview_controlled_links.sql';

const read = (name: string) =>
  fs.readFileSync(path.join(migrations, name), 'utf8').split('\r\n').join('\n');

const source = read(FILENAME);

/** The three latest authoritative definitions this migration replaces. */
const AUTHORITIES = [
  {
    fn: 'generate_participant_preview',
    origin: '20260824070000_multi_image_gallery_participant_preview.sql',
    comparesSnapshots: false,
  },
  {
    fn: 'get_project_publication_readiness',
    origin: '20260824080000_multi_image_gallery_publication_readiness.sql',
    comparesSnapshots: true,
  },
  {
    fn: 'get_project_reconciliation_readiness',
    origin: '20260824183000_public_feed_writer_protocol.sql',
    comparesSnapshots: true,
  },
] as const;

/** Extracts the body of `CREATE OR REPLACE FUNCTION public.<fn>(` through its closing `$$;`. */
function functionBody(sql: string, fn: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
  expect(start, `${fn} definition present`).toBeGreaterThan(-1);

  const end = sql.indexOf('$$;', start);
  expect(end, `${fn} terminator present`).toBeGreaterThan(start);

  return sql.slice(start, end + 3);
}

const ADDED_SNAPSHOT_KEYS = [
  "      'videoUrl', p.video_url,",
  "      'demoUrl', p.demo_url,",
  "      'repositoryUrl', p.repository_url,",
].join('\n');

const SNAPSHOT_ANCHOR = "      'accessibilityText', p.accessibility_text_public,";

const COMPAT_DECLARATION = '  v_comparable_snapshot jsonb;';
const ORIGINAL_COMPARISON = '  IF v_current_snapshot IS DISTINCT FROM v_active_preview.snapshot THEN';
const NEW_COMPARISON = '  IF v_comparable_snapshot IS DISTINCT FROM v_active_preview.snapshot THEN';

describe('participant-preview controlled-links migration (0050)', () => {
  it('is the newest forward-only migration and every manifest agrees', () => {
    const files = fs.readdirSync(migrations).filter((file) => file.endsWith('.sql')).sort();

    expect(files).toHaveLength(50);
    expect(files.at(-1)).toBe(FILENAME);
    expect(files.at(-2)).toBe(IMPORT_MIGRATION);

    expect([...EXPECTED_MIGRATION_FILENAMES]).toEqual(files);
    expect([...EXPECTED_REPOSITORY_MIGRATIONS]).toEqual(files);
    expect(EXPECTED_REPOSITORY_MIGRATION_COUNT).toBe(50);

    const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain("test \"$(find infra/supabase/migrations -name '*.sql' | wc -l)\" -eq 50");
  });

  it('edits no migration that already exists on origin/main', () => {
    const files = fs.readdirSync(migrations).filter((file) => file.endsWith('.sql')).sort();

    expect(() => execFileSync('git', [
      'diff', '--exit-code', 'origin/main', '--',
      ...files
        .filter((file) => file !== IMPORT_MIGRATION && file !== FILENAME)
        .map((file) => `infra/supabase/migrations/${file}`),
    ], { cwd: root, stdio: 'pipe' })).not.toThrow();
  });

  it('replaces exactly the three snapshot authorities and nothing else', () => {
    const replaced = [...source.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z_]+)\(/g)]
      .map((match) => match[1]);

    expect(replaced).toEqual(AUTHORITIES.map((authority) => authority.fn));
    expect(source).not.toContain('DROP FUNCTION');
    expect(source).not.toContain('ALTER TABLE');
    // Stored snapshots are never rewritten or backfilled to satisfy the new contract. The only
    // UPDATE the migration carries is the pre-existing correction-request resolution inside
    // preview issuance, reproduced unchanged from main.
    expect(source).not.toMatch(/\bUPDATE\b[^;]*\bsnapshot\b/i);

    const updates = [...source.matchAll(/^\s*UPDATE\s+(public\.\w+)/gm)].map((match) => match[1]);
    expect(updates).toEqual(['public.participant_preview_correction_requests']);
  });

  it.each(AUTHORITIES)('reproduces $fn exactly, plus only the documented additions', (authority) => {
    const actual = functionBody(source, authority.fn);
    let expected = functionBody(read(authority.origin), authority.fn);

    // Addition 1: the three controlled links join the canonical participant snapshot.
    expect(expected.split(SNAPSHOT_ANCHOR)).toHaveLength(2);
    expected = expected.replace(
      `${SNAPSHOT_ANCHOR}\n`,
      `${SNAPSHOT_ANCHOR}\n${ADDED_SNAPSHOT_KEYS}\n`,
    );

    if (authority.comparesSnapshots) {
      // Addition 2: historical-snapshot compatibility, applied only to the comparison gates.
      expected = expected.replace(
        '  v_current_snapshot jsonb;\n',
        `  v_current_snapshot jsonb;\n${COMPAT_DECLARATION}\n`,
      );

      const compatBlock = actual.slice(
        actual.indexOf('  -- Historical-snapshot compatibility for controlled project links.'),
        actual.indexOf(NEW_COMPARISON) + NEW_COMPARISON.length,
      );

      expect(compatBlock).toContain("v_comparable_snapshot := v_current_snapshot;");
      expect(compatBlock).toContain("NOT (v_active_preview.snapshot ? 'videoUrl')");
      expect(compatBlock).toContain("NOT (v_active_preview.snapshot ? 'demoUrl')");
      expect(compatBlock).toContain("NOT (v_active_preview.snapshot ? 'repositoryUrl')");
      expect(compatBlock).toContain("v_current_snapshot->>'videoUrl' IS NULL");
      expect(compatBlock).toContain("v_current_snapshot->>'demoUrl' IS NULL");
      expect(compatBlock).toContain("v_current_snapshot->>'repositoryUrl' IS NULL");
      expect(compatBlock).toContain(
        "v_comparable_snapshot := v_comparable_snapshot - 'videoUrl' - 'demoUrl' - 'repositoryUrl';",
      );

      expected = expected.replace(`${ORIGINAL_COMPARISON}\n`, `${compatBlock}\n`);
    } else {
      expect(actual).not.toContain(COMPAT_DECLARATION);
    }

    // Everything else — advisory locking, permission checks, media snapshotting, blockers,
    // exception handling — is byte-for-byte the definition already on main.
    expect(actual).toBe(expected);
  });

  it.each(AUTHORITIES)('preserves the $fn security contract', (authority) => {
    const body = functionBody(source, authority.fn);

    expect(body).toContain('SECURITY DEFINER');
    expect(body).toContain("SET search_path = ''");
    expect(body).toContain('LANGUAGE plpgsql');

    for (const role of ['PUBLIC', 'anon', 'authenticated']) {
      expect(source).toMatch(
        new RegExp(`REVOKE EXECUTE ON FUNCTION\\s+public\\.${authority.fn}\\([^)]*\\)\\s+FROM ${role};`),
      );
    }

    expect(source).toMatch(
      new RegExp(`GRANT EXECUTE ON FUNCTION\\s+public\\.${authority.fn}\\([^)]*\\)\\s+TO service_role;`),
    );
  });

  it('re-asserts privileges on the legacy five-argument preview wrapper', () => {
    const fiveArgument = /public\.generate_participant_preview\(\s*text,\s*uuid,\s*text,\s*integer,\s*text\s*\)/g;

    expect(source.match(fiveArgument)).toHaveLength(4); // three REVOKEs and one GRANT
  });

  it('captures an absent controlled link as JSON null rather than omitting the key', () => {
    // jsonb_build_object emits the key with a JSON null when the column is NULL, so every newly
    // issued snapshot has one deterministic shape regardless of which links a project has.
    const body = functionBody(source, 'generate_participant_preview');

    expect(body).toContain("'videoUrl', p.video_url,");
    expect(body).toContain("'demoUrl', p.demo_url,");
    expect(body).toContain("'repositoryUrl', p.repository_url,");
    expect(body).not.toContain('COALESCE(p.video_url');
    expect(body).not.toMatch(/CASE\s+WHEN\s+p\.video_url/);
  });

  it('drops the compatibility keys only when the project has no controlled link at all', () => {
    for (const authority of AUTHORITIES.filter((entry) => entry.comparesSnapshots)) {
      const body = functionBody(source, authority.fn);
      const compat = body.slice(body.indexOf('  -- Historical-snapshot compatibility'));

      // The three "key absent" conditions and the three "value is NULL" conditions are joined by
      // AND, so a populated controlled URL on a pre-contract preview can never be grandfathered.
      const guard = compat.slice(0, compat.indexOf('  THEN'));

      expect(guard.match(/\bAND\b/g)).toHaveLength(5);
      expect(guard).not.toMatch(/\bOR\b/);
    }
  });

  it('keeps one canonical snapshot projection shared by all three authorities', () => {
    const projections = AUTHORITIES.map((authority) => {
      const body = functionBody(source, authority.fn);
      const start = body.indexOf("'title', p.title,");
      const end = body.indexOf("'industryCategories'", start);

      // Whitespace is stripped entirely: issuance pretty-prints the projection across several
      // lines while the two gates keep it compact, and only the projected content matters here.
      return body.slice(start, end).replace(/\s+/g, '');
    });

    // Divergence between issuance and either gate is exactly the defect this migration fixes,
    // so the three projections must stay identical once whitespace is normalized away.
    expect(new Set(projections).size).toBe(1);
    for (const projection of projections) {
      expect(projection).toContain("'videoUrl',p.video_url,");
      expect(projection).toContain("'demoUrl',p.demo_url,");
      expect(projection).toContain("'repositoryUrl',p.repository_url,");
    }
  });
});
