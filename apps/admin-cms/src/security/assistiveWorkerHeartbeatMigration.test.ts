import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { EXPECTED_MIGRATION_FILENAMES } from '../scripts/onboardingCheck';
import { readGitMigrationObjects } from '../test-support/gitBatchParser';

describe('assistive worker heartbeat migration and deployment boundary', () => {
  const root = path.resolve(__dirname, '../../../..');
  const migrations = path.join(root, 'infra/supabase/migrations');
  const filename = '20260828120000_assistive_worker_heartbeat.sql';
  const forwardFilename = '20260910120200_assistive_worker_production_identity.sql';
  const source = fs.readFileSync(path.join(migrations, filename), 'utf8').replace(/\r\n/g, '\n');
  const executable = source.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
  const compact = executable.replace(/\s+/g, ' ');
  const forwardSource = fs.readFileSync(path.join(migrations, forwardFilename), 'utf8').replace(/\r\n/g, '\n');
  const forwardExecutable = forwardSource.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
  const forwardCompact = forwardExecutable.replace(/\s+/g, ' ');

  it('preserves the exact migration 1-55 byte manifest before additive migration 56', () => {
    const files = fs.readdirSync(migrations).filter((file) => file.endsWith('.sql')).sort();
    expect(files).toEqual([...EXPECTED_MIGRATION_FILENAMES]);
    expect(files).toHaveLength(57);
    expect(files).toContain(filename);
    // Migrations 1-55 are exactly the files that precede this migration's forward file.
    const historical = files.slice(0, files.indexOf(forwardFilename));
    expect(historical).toHaveLength(55);
    const historicalObjects = readGitMigrationObjects(
      root,
      historical.map((file) => `HEAD:infra/supabase/migrations/${file}`),
    );
    const historicalManifest = historical.map((file, index) => {
      const digest = createHash('sha256').update(historicalObjects[index]).digest('hex');
      return `${file}:${digest}`;
    }).join('\n');
    expect(createHash('sha256').update(historicalManifest).digest('hex'))
      .toBe('3d74bbe01e433a6f35935fb29ad7c150274b455ce5304fe1560d731a90079058');
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

  it('adds exact staging and production identity without changing either RPC signature', () => {
    expect(forwardCompact).toContain("CHECK (environment IN ('staging', 'production'))");
    expect(forwardCompact).toContain("p_environment NOT IN ('staging', 'production')");
    expect(forwardCompact).toContain('AND environment <> p_environment');
    expect(forwardCompact).toContain('WHERE current_heartbeat.environment = EXCLUDED.environment');
    expect(forwardExecutable.match(/CREATE OR REPLACE FUNCTION public\.upsert_assistive_worker_heartbeat/g))
      .toHaveLength(1);
    expect(forwardExecutable.match(/CREATE OR REPLACE FUNCTION public\.get_assistive_worker_availability/g))
      .toHaveLength(1);
    expect(forwardExecutable.match(/SECURITY DEFINER/g)).toHaveLength(2);
    expect(forwardExecutable.match(/SET search_path = ''/g)).toHaveLength(3);
    expect(forwardExecutable.match(/TO service_role;/g)).toHaveLength(3);
    expect(forwardExecutable).not.toMatch(/GRANT[^;]*TO\s+(PUBLIC|anon|authenticated)/i);
    expect(forwardCompact).toContain('DELETE FROM public.assistive_worker_heartbeats WHERE heartbeat_at < v_now - pg_catalog.make_interval(days => 7)');
    expect(forwardCompact).toContain('preview_response_observation_v1|assistive_worker_environment_identity_v1');
  });

  it('preserves heartbeat rows and all application workflow authorities', () => {
    const migrationDataStatements = forwardExecutable.split('CREATE OR REPLACE FUNCTION')[0];
    expect(migrationDataStatements).not.toMatch(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i);
    expect(forwardExecutable).not.toMatch(
      /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+public\.(projects|media_assets|validation_flags|approval_records|published_snapshots|public_feed_operations|public_feed_head|import_batches)\b/i,
    );
    expect(forwardExecutable).not.toMatch(/ALTER TABLE public\.assistive_worker_heartbeats\s+(DISABLE|NO FORCE) ROW LEVEL SECURITY/i);
    expect(forwardExecutable).not.toMatch(/GRANT[^;]*ON TABLE public\.assistive_worker_heartbeats/i);
  });

  it('carries runtime identity through the producer and every Admin/CMS consumer', () => {
    for (const relativePath of [
      'apps/admin-cms/src/app/admin/projects/[publicId]/assistiveActions.ts',
      'apps/admin-cms/src/app/admin/projects/[publicId]/page.tsx',
      'apps/admin-cms/src/app/api/projects/bulk-assistive/preflight/route.ts',
      'apps/admin-cms/src/app/api/projects/bulk-assistive/execute/route.ts',
    ]) {
      const consumer = fs.readFileSync(path.join(root, relativePath), 'utf8');
      expect(consumer).toMatch(/new SupabaseAssistiveWorkerHeartbeatRepository\([\s\S]*?resolveAssistiveWorkerRuntimeIdentity\(process\.env\)/);
    }
    for (const relativePath of [
      'apps/admin-cms/src/scripts/runHostedAssistiveCoordinator.ts',
      'apps/admin-cms/src/scripts/runOnDemandAssistiveCoordinator.ts',
    ]) {
      const producer = fs.readFileSync(path.join(root, relativePath), 'utf8');
      expect(producer).toContain('environment: config.runtimeEnvironment');
    }
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
