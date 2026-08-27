import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../../..');
const migrations = path.join(root, 'infra/supabase/migrations');
const auditedStreamKHead = 'eaefc2417880646baacb6581ddee02fca4fb7d22';
const read = (name: string) => fs.readFileSync(path.join(migrations, name), 'utf8').replace(/\r\n/g, '\n');
const guard = read('20260825030000_public_feed_taxonomy_operation_guard.sql');
const protocol = read('20260824183000_public_feed_writer_protocol.sql');

function activeStateLists(source: string): string[][] {
  return [...source.matchAll(/o\.state IN \(\s*([^)]*?)\s*\)/g)].map((match) =>
    [...match[1].matchAll(/'([A-Z_]+)'/g)].map((state) => state[1]),
  );
}

describe('public-feed taxonomy operation guard migration', () => {
  it('is a new forward migration and leaves both earlier Stream K migrations byte-identical', () => {
    const files = fs.readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort();
    expect(files.at(-2)).toBe('20260825030000_public_feed_taxonomy_operation_guard.sql');
    expect(files.at(-1)).toBe('20260828090000_assistive_language_findings.sql');
    expect(files).toHaveLength(44);

    const historicalMigrations = [
      '20260824180000_public_feed_deployment_ledger.sql',
      '20260824183000_public_feed_writer_protocol.sql',
    ];
    for (const file of historicalMigrations) {
      const migrationPath = `infra/supabase/migrations/${file}`;
      const currentBlob = execFileSync('git', ['rev-parse', `HEAD:${migrationPath}`], {
        cwd: root,
        encoding: 'utf8',
      }).trim();
      const auditedBlob = execFileSync('git', ['rev-parse', `${auditedStreamKHead}:${migrationPath}`], {
        cwd: root,
        encoding: 'utf8',
      }).trim();
      expect(currentBlob).toBe(auditedBlob);
    }
  });

  it('installs UPDATE/DELETE-only triggers on both participant-evidence lookup tables', () => {
    expect(guard).toMatch(
      /CREATE TRIGGER guard_discipline_lookup_during_public_feed_operation\s+BEFORE UPDATE OR DELETE ON public\.disciplines/,
    );
    expect(guard).toMatch(
      /CREATE TRIGGER guard_industry_category_lookup_during_public_feed_operation\s+BEFORE UPDATE OR DELETE ON public\.industry_categories/,
    );
    expect(guard).not.toMatch(/BEFORE INSERT[^;]*ON public\.(?:disciplines|industry_categories)/);
  });

  it('blocks only lookup rows referenced by a project with the canonical active-state family', () => {
    expect(guard).toContain('FROM public.project_disciplines pd');
    expect(guard).toContain('WHERE pd.discipline_id = OLD.id');
    expect(guard).toContain('FROM public.project_industry_categories pic');
    expect(guard).toContain('WHERE pic.industry_category_id = OLD.id');
    expect(guard.match(/JOIN public\.public_feed_operations o ON o\.project_id = (?:pd|pic)\.project_id/g))
      .toHaveLength(2);
    expect(guard).toContain("RAISE EXCEPTION 'PUBLIC_FEED_OPERATION_IN_PROGRESS'");

    const canonical = activeStateLists(protocol)[0];
    expect(canonical).toEqual([
      'RESERVED', 'PREPARED', 'WRITE_STARTED',
      'CANDIDATE_OBSERVED', 'DB_FINALIZED', 'RECOVERY_REQUIRED',
    ]);
    expect(activeStateLists(guard)).toEqual([canonical, canonical]);
  });

  it('is a pinned SECURITY DEFINER trigger helper with no caller bypass or direct execution', () => {
    expect(guard).toMatch(
      /CREATE OR REPLACE FUNCTION public\.guard_active_public_feed_taxonomy\(\)[\s\S]*?RETURNS trigger[\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path = ''/,
    );
    expect(guard).toContain(
      'REVOKE ALL ON FUNCTION public.guard_active_public_feed_taxonomy()\nFROM PUBLIC, anon, authenticated, service_role;',
    );
    expect(guard).not.toMatch(/GRANT EXECUTE/);
    expect(guard).not.toContain('app.public_feed_operation_id');
    expect(guard).not.toMatch(/EXECUTE\s+(?:FORMAT|IMMEDIATE)|storage\.|supabase\.storage|http_|net\./i);
  });
});
