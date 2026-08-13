import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('project metadata audit history migration contract', () => {
  const root = path.resolve(__dirname, '../../../..');
  const migrations = path.join(root, 'infra/supabase/migrations');
  const filename = '20260813002154_project_metadata_audit_history.sql';
  const content = fs.readFileSync(path.join(migrations, filename), 'utf8');

  it('is the twenty-first append-only migration and leaves prior migration files present', () => {
    const files = fs.readdirSync(migrations).filter((file) => file.endsWith('.sql')).sort();
    expect(files).toHaveLength(21);
    expect(files).toContain(filename);
  });

  it('uses an atomic locked, service-role-only security-definer RPC', () => {
    expect(content).toContain('CREATE OR REPLACE FUNCTION public.update_project_metadata(');
    expect(content).toContain('p_admin_id uuid');
    expect(content).toContain('SECURITY DEFINER');
    expect(content).toContain("SET search_path = ''");
    expect(content).toContain('FOR UPDATE');

    // Authorization
    expect(content).toContain("role IN ('admin', 'editor')");

    // Security boundaries
    expect(content).toContain("REVOKE ALL ON FUNCTION public.update_project_metadata(");
    expect(content).toContain('FROM PUBLIC, anon, authenticated;');
    expect(content).toContain('TO service_role;');
    expect(content).not.toMatch(/\bEXECUTE\s+['"]/);
  });

  it('audits the exact state transitions in the same transaction', () => {
    expect(content).toContain('INSERT INTO public.approval_records');
    expect(content).toContain('update_metadata');
  });

  it('normalizes text input and array comparisons to prevent false mutations', () => {
    // Normalizes input strings
    expect(content).toContain("p_title := pg_catalog.btrim(COALESCE(p_title, ''));");
    
    // Fallbacks array changes gracefully
    expect(content).toContain("v_old_disciplines IS NOT DISTINCT FROM v_new_disciplines");
    expect(content).toContain("v_old_industries IS NOT DISTINCT FROM v_new_industries");
  });

  it('short-circuits unmodified saves and returns NO_CHANGES', () => {
    expect(content).toContain("IF array_length(v_changed_fields, 1) IS NULL THEN");
    expect(content).toContain("'resultCode', 'NO_CHANGES'");
  });
});
