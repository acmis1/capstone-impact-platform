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
    expect(files).toHaveLength(46);
    expect(files).toContain(filename);
    expect(() => execFileSync('git', [
      'diff', '--exit-code', 'origin/main', '--',
      ...files.filter((file) => file !== '20260826090000_public_feed_activation_authority_guard.sql')
        .map((file) => `infra/supabase/migrations/${file}`),
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

  it('declares a true background worker with no public request endpoint', () => {
    const blueprint = fs.readFileSync(path.join(root, 'render.yaml'), 'utf8');
    const entrypoint = fs.readFileSync(path.join(root, 'apps/admin-cms/src/scripts/runHostedAssistiveCoordinator.ts'), 'utf8');
    expect(blueprint).toMatch(/type:\s*worker/);
    expect(blueprint).toMatch(/plan:\s*2c-4g/);
    expect(blueprint).toMatch(/numInstances:\s*1/);
    expect(blueprint).toMatch(/maxShutdownDelaySeconds:\s*300/);
    expect(blueprint).not.toMatch(/healthCheckPath|type:\s*web/);
    expect(entrypoint).not.toMatch(/createServer|listen\(|fetch\s*\(|POST|route/i);
  });
});
