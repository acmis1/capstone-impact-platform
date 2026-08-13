import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EXPECTED_MIGRATION_FILENAMES } from '../scripts/onboardingCheck';

describe('project metadata audit history migration contract', () => {
  const root = path.resolve(__dirname, '../../../..');
  const migrations = path.join(root, 'infra/supabase/migrations');
  const filename = '20260813002154_project_metadata_audit_history.sql';
  const content = fs.readFileSync(path.join(migrations, filename), 'utf8');
  const squashed = content.replace(/\s+/g, ' ');

  it('is the exact twenty-first append-only migration in the authoritative inventory', () => {
    const files = fs.readdirSync(migrations).filter((file) => file.endsWith('.sql')).sort();
    expect(files).toEqual([...EXPECTED_MIGRATION_FILENAMES]);
    expect(files[20]).toBe(filename);
  });

  it('adds bounded actor snapshots and structured event details', () => {
    expect(content).toContain('ADD COLUMN actor_full_name_snapshot TEXT');
    expect(content).toContain('ADD COLUMN actor_email_snapshot TEXT');
    expect(content).toContain('ADD COLUMN event_details JSONB');
  });

  it('replaces the old signature with the atomic locked eleven-argument function', () => {
    expect(squashed).toContain(
      'CREATE OR REPLACE FUNCTION public.update_project_metadata( p_public_id text, p_title text, p_summary text, p_background text, p_solution text, p_year integer, p_program_id uuid, p_discipline_ids uuid[], p_industry_category_ids uuid[], p_expected_updated_at timestamptz, p_admin_id uuid )',
    );
    expect(content).toContain(
      'DROP FUNCTION IF EXISTS public.update_project_metadata(text,text,text,text,text,integer,uuid,uuid[],uuid[],timestamptz);',
    );
    expect(content).toContain('SECURITY DEFINER');
    expect(content).toContain("SET search_path = ''");
    expect(content).toContain('FOR UPDATE');
    expect(content).toContain("role IN ('admin', 'editor')");
  });

  it('allows only service_role execution of the new signature', () => {
    expect(content).toContain('REVOKE ALL ON FUNCTION public.update_project_metadata(');
    expect(content).toContain('FROM PUBLIC, anon, authenticated;');
    expect(content).toContain('GRANT EXECUTE ON FUNCTION public.update_project_metadata(');
    expect(content).toContain('TO service_role;');
    expect(content).not.toMatch(/\bEXECUTE\s+['"]/);
  });

  it('returns every guarded result code before mutation', () => {
    for (const code of [
      'STALE_VERSION',
      'APPROVAL_REOPEN_REQUIRED',
      'PUBLISHED_PROJECT_LOCKED',
      'PERMISSION_DENIED',
      'NO_CHANGES',
    ]) {
      expect(content).toContain(`'resultCode', '${code}'`);
    }
  });

  it('inserts the metadata audit atomically with same-status transition semantics', () => {
    expect(content).toContain('INSERT INTO public.approval_records');
    expect(content).toContain("VALUES (v_project_id, p_admin_id, 'update_metadata', v_status, v_status");
    expect(content.indexOf('UPDATE public.projects')).toBeLessThan(content.indexOf('INSERT INTO public.approval_records'));
  });

  it('normalizes public ID and every trusted text input without mutating parameters', () => {
    expect(content).toContain("v_public_id text := pg_catalog.btrim(COALESCE(p_public_id, ''));");
    expect(content).toContain("v_title text := pg_catalog.btrim(COALESCE(p_title, ''));");
    expect(content).toContain("v_summary text := pg_catalog.btrim(COALESCE(p_summary, ''));");
    expect(content).toContain("v_background text := pg_catalog.btrim(COALESCE(p_background, ''));");
    expect(content).toContain("v_solution text := pg_catalog.btrim(COALESCE(p_solution, ''));");
    expect(content).toContain('WHERE public_id = v_public_id');
    expect(content).not.toMatch(/p_(?:public_id|title|summary|background|solution)\s*:=/);
  });

  it('prevents reorder-only writes and returns a string-safe normalized NO_CHANGES payload', () => {
    expect(content).toContain('v_old_disciplines IS NOT DISTINCT FROM v_new_disciplines');
    expect(content).toContain('v_old_industries IS NOT DISTINCT FROM v_new_industries');
    expect(content).toContain('IF array_length(v_changed_fields, 1) IS NULL THEN');
    expect(content).toContain("'background', coalesce(v_old_background, '')");
    expect(content).toContain("'solution', coalesce(v_old_solution, '')");
    expect(content).toContain("'publicId', v_public_id");
  });
});
