import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../../..');
const migrations = path.join(root, 'infra/supabase/migrations');
const migrationName = '20260826090000_public_feed_activation_authority_guard.sql';
const source = fs.readFileSync(path.join(migrations, migrationName), 'utf8').replace(/\r\n/g, '\n');

describe('public-feed activation authority migration', () => {
  it('leaves every earlier migration byte-identical to current main', () => {
    const files = fs.readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort();
    expect(files).toHaveLength(47);
    expect(files).toContain(migrationName);

    expect(() => execFileSync('git', [
      'diff', '--exit-code', 'origin/main', '--',
      // This migration and the later execution-control migration are both newer than origin/main;
      // every other file must remain byte-identical.
      ...files.filter((file) => file !== migrationName
        && file !== '20260828170000_assistive_execution_control.sql')
        .map((file) => `infra/supabase/migrations/${file}`),
    ], { cwd: root, stdio: 'pipe' })).not.toThrow();

    for (const historical of [
      '20260824180000_public_feed_deployment_ledger.sql',
      '20260824183000_public_feed_writer_protocol.sql',
      '20260825030000_public_feed_taxonomy_operation_guard.sql',
    ]) {
      const repositoryPath = `infra/supabase/migrations/${historical}`;
      const committed = execFileSync('git', ['show', `HEAD:${repositoryPath}`], {
        cwd: root, encoding: 'utf8',
      }).replace(/\r\n/g, '\n');
      expect(fs.readFileSync(path.join(root, repositoryPath), 'utf8').replace(/\r\n/g, '\n'))
        .toBe(committed);
    }
  });

  it('uses durable write/write authority instead of snapshot-visible operation reads', () => {
    for (const table of [
      'public_feed_activation_authority',
      'public_feed_project_projection_authority',
      'public_feed_discipline_projection_authority',
    ]) {
      expect(source).toContain(`CREATE TABLE public.${table}`);
      expect(source).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
    }
    expect(source).toContain('ADD COLUMN activation_authority_generation bigint');
    const projectionGuard = source.slice(
      source.indexOf('CREATE OR REPLACE FUNCTION public.guard_public_feed_activation_projection()'),
    );
    expect(projectionGuard).not.toMatch(/pg_advisory|FROM public\.public_feed_operations o/);
  });

  it('claims PREPARED and atomically verifies the first write or observation boundary', () => {
    expect(source).toMatch(
      /OLD\.state = 'RESERVED' AND NEW\.state = 'PREPARED'[\s\S]*?active_activation_operation_id = NEW\.id/,
    );
    expect(source).toContain('NEW.activation_authority_generation := v_generation');
    expect(source).toContain('OLD.storage_request_generation = 0');
    expect(source).toContain("OLD.state = 'RECOVERY_REQUIRED'");
    expect(source).toContain("OLD.recovery_from_state = 'PREPARED'");
    expect(source).toContain("NEW.state IN ('WRITE_STARTED', 'CANDIDATE_OBSERVED')");
    expect(source).toContain('active_activation_operation_id = OLD.id');
    expect(source).toContain('generation = OLD.activation_authority_generation');
    expect(source).toContain("RAISE EXCEPTION 'PUBLIC_FEED_ACTIVATION_AUTHORITY_FROZEN'");
  });

  it('adopts the one pre-existing pre-write activation and fails closed on ambiguous history', () => {
    expect(source).toContain("o.state = 'PREPARED'");
    expect(source).toContain("o.state = 'RECOVERY_REQUIRED' AND o.recovery_from_state = 'PREPARED'");
    expect(source).toContain('SET activation_authority_generation = 1');
    expect(source).toContain('SET active_activation_operation_id = v_prewrite_operation_id');
    expect(source).toContain("RAISE EXCEPTION 'PUBLIC_FEED_ACTIVATION_AUTHORITY_UPGRADE_AMBIGUOUS'");
  });

  it('takes global authority before local fences for relevant work and never waits into a cycle', () => {
    const globalFence = source.indexOf('FOR UPDATE NOWAIT');
    const projectFence = source.indexOf(
      'INSERT INTO public.public_feed_project_projection_authority AS authority',
    );
    const disciplineFence = source.indexOf(
      'INSERT INTO public.public_feed_discipline_projection_authority AS authority',
    );
    expect(globalFence).toBeGreaterThan(-1);
    expect(projectFence).toBeGreaterThan(-1);
    expect(disciplineFence).toBeGreaterThan(projectFence);
    expect(globalFence).toBeLessThan(projectFence);
    expect(source).toContain('SET generation = authority.generation + 1');
    expect(source).toContain("RAISE EXCEPTION 'PUBLIC_FEED_ACTIVATION_AUTHORITY_LOCKED'");
    expect(source).toContain("RAISE EXCEPTION 'PUBLIC_FEED_ACTIVATION_AUTHORITY_RELEVANCE_CHANGED'");
    expect(source).toContain('v_membership_changed');
    expect(source).toContain('FROM public.project_disciplines pd');
    expect(source).toContain('FOR KEY SHARE');
  });

  it('covers every persisted dependency used by the lifecycle activation projection', () => {
    expect(source).toContain('ON public.projects');
    for (const column of [
      'public_id', 'title', 'summary', 'background', 'solution', 'year', 'program_name',
      'study_program', 'discipline', 'industry', 'industry_partner', 'academic_supervisor',
      'group_name', 'team_members', 'poster_url', 'poster_pdf_url', 'poster_text_public',
      'accessibility_text_public', 'snapshots', 'video_url', 'demo_url', 'repository_url',
      'external_links', 'citations', 'layout_config', 'status', 'deleted_at', 'created_at',
    ]) {
      expect(source).toMatch(new RegExp(`\\b${column}\\b`));
    }

    expect(source).toContain('ON public.media_assets');
    for (const column of [
      'project_id', 'asset_type', 'gallery_position', 'public_url',
      'alt_text_public', 'is_public_approved',
    ]) {
      expect(source).toMatch(new RegExp(`\\b${column}\\b`));
    }
    expect(source).toContain('ON public.project_disciplines');
    expect(source).toContain('ON public.disciplines');
    expect(source).toContain("p.status = 'published'");
    expect(source).toContain('p.deleted_at IS NULL');
  });

  it('is a pinned internal boundary with no direct execution or Storage I/O', () => {
    for (const helper of [
      'guard_public_feed_activation_authority_transition',
      'guard_public_feed_activation_projection',
    ]) {
      expect(source).toMatch(new RegExp(
        `CREATE OR REPLACE FUNCTION public\\.${helper}\\(\\)[\\s\\S]*?SECURITY DEFINER[\\s\\S]*?SET search_path = ''`,
      ));
      expect(source).toContain(
        `REVOKE ALL ON FUNCTION public.${helper}()\nFROM PUBLIC, anon, authenticated, service_role;`,
      );
    }
    expect(source).toMatch(
      /REVOKE ALL ON TABLE[\s\S]*?public_feed_activation_authority[\s\S]*?FROM PUBLIC, anon, authenticated, service_role/,
    );
    expect(source).not.toMatch(/GRANT EXECUTE|storage\.|supabase\.storage|http_|net\./i);
  });
});
