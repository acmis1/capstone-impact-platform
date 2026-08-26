import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../../..');
const migrations = path.join(root, 'infra/supabase/migrations');
const migrationName = '20260826090000_public_feed_activation_authority_guard.sql';
const source = fs.readFileSync(path.join(migrations, migrationName), 'utf8').replace(/\r\n/g, '\n');

describe('public-feed activation authority migration', () => {
  it('is the sole new forward migration after the reviewed 43-migration baseline', () => {
    const files = fs.readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort();
    expect(files).toHaveLength(44);
    expect(files.at(-1)).toBe(migrationName);

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

  it('serializes activation phase changes and dependency mutations on one transaction lock', () => {
    expect(source.match(/hashtext\('public_feed_activation_projection'\)/g)).toHaveLength(2);
    expect(source).toMatch(
      /BEFORE UPDATE OF state ON public\.public_feed_operations[\s\S]*?lock_public_feed_activation_authority_transition/,
    );
    expect(source).toContain("NEW.kind = 'activation'");
    expect(source).toContain('NEW.state IS DISTINCT FROM OLD.state');
  });

  it('freezes only bound pre-write activation authority, including PREPARED recovery', () => {
    expect(source).toContain("o.kind = 'activation'");
    expect(source).toContain('o.storage_request_generation = 0');
    expect(source).toContain("o.state = 'PREPARED'");
    expect(source).toContain("o.state = 'RECOVERY_REQUIRED'");
    expect(source).toContain("o.recovery_from_state = 'PREPARED'");
    expect(source).toContain("RAISE EXCEPTION 'PUBLIC_FEED_ACTIVATION_AUTHORITY_FROZEN'");
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

  it('is a pinned trigger-only boundary with no direct execution or Storage I/O', () => {
    for (const helper of [
      'lock_public_feed_activation_authority_transition',
      'guard_public_feed_activation_projection',
    ]) {
      expect(source).toMatch(new RegExp(
        `CREATE OR REPLACE FUNCTION public\\.${helper}\\(\\)[\\s\\S]*?SECURITY DEFINER[\\s\\S]*?SET search_path = ''`,
      ));
      expect(source).toContain(
        `REVOKE ALL ON FUNCTION public.${helper}()\nFROM PUBLIC, anon, authenticated, service_role;`,
      );
    }
    expect(source).not.toMatch(/GRANT EXECUTE|storage\.|supabase\.storage|http_|net\./i);
  });
});
