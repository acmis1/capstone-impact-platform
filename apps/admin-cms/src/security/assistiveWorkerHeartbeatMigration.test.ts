import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { EXPECTED_MIGRATION_FILENAMES } from '../scripts/onboardingCheck';

describe('assistive worker heartbeat migration and deployment boundary', () => {
  const root = path.resolve(__dirname, '../../../..');
  const migrations = path.join(root, 'infra/supabase/migrations');
  const filename = '20260828120000_assistive_worker_heartbeat.sql';
  const source = fs.readFileSync(path.join(migrations, filename), 'utf8').replace(/\r\n/g, '\n');
  const executable = source.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
  const compact = executable.replace(/\s+/g, ' ');

  it('remains byte-identical to current main in the combined migration inventory', () => {
    const files = fs.readdirSync(migrations).filter((file) => file.endsWith('.sql')).sort();
    expect(files).toEqual([...EXPECTED_MIGRATION_FILENAMES]);
    expect(files).toHaveLength(51);
    expect(files).toContain(filename);
    expect(() => execFileSync('git', [
      'diff', '--exit-code', 'origin/main', '--',
      ...files.filter((file) => file !== '20260902010606_controlled_project_links_import.sql'
                && file !== '20260903120000_participant_preview_controlled_links.sql' && file !== '20260903130000_participant_owned_corrections.sql')
              .map((file) => `infra/supabase/migrations/${file}`)
    ], { cwd: root, stdio: 'pipe' })).not.toThrow();
  });

  it('exposes only fixed, bounded service-role heartbeat RPCs', () => {
    expect(compact).toContain('CREATE FUNCTION public.upsert_assistive_worker_heartbeat');
    expect(compact).toContain('CREATE FUNCTION public.get_assistive_worker_availability');
    expect(executable.match(/SECURITY DEFINER/g)).toHaveLength(2);
    expect(executable.match(/SET search_path = ''/g)).toHaveLength(2);
    expect(executable.match(/TO service_role;/g)).toHaveLength(2);
    expect(executable).not.toMatch(/GRANT[^;]*TO\s+(PUBLIC|anon|authenticated)/i);
    expect(executable).not.toMatch(/\b(EXECUTE\s+['"]|format\s*\(|quote_ident|quote_literal)\b/i);
    expect(compact).toContain("p_freshness_seconds NOT BETWEEN 30 AND 120");
    expect(compact).toContain("health_state IN ('READY', 'STOPPING')");
  });

  it('cannot mutate projects, workflow, review, publication, or feed state', () => {
    expect(executable).not.toMatch(
      /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+public\.(projects|media_assets|validation_flags|approval_records|published_snapshots|public_feed_operations|public_feed_head|import_batches)\b/i,
    );
    expect(executable).not.toMatch(/publication|approval|workflow|duda/i);
    expect(compact).toContain('ALTER TABLE public.assistive_worker_heartbeats FORCE ROW LEVEL SECURITY');
    expect(compact).toContain('REVOKE ALL ON TABLE public.assistive_worker_heartbeats FROM PUBLIC, anon, authenticated, service_role');
  });

  it('no longer offers the paid background-worker hosting path', () => {
    // Render documents no free instance type for background workers, so the blueprint that
    // declared one is deleted rather than left available to a future maintainer.
    expect(fs.existsSync(path.join(root, 'render.yaml'))).toBe(false);
  });

  it('exposes no public request endpoint from any worker entrypoint', () => {
    for (const entrypointPath of [
      'apps/admin-cms/src/scripts/runHostedAssistiveCoordinator.ts',
      'apps/admin-cms/src/scripts/runOnDemandAssistiveCoordinator.ts',
    ]) {
      const entrypoint = fs.readFileSync(path.join(root, entrypointPath), 'utf8');
      expect(entrypoint).not.toMatch(/createServer|listen\(|POST|route/i);
    }
  });
});
