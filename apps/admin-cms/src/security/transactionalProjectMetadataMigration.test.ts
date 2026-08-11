import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('transactional project metadata migration contract', () => {
  const root = path.resolve(__dirname, '../../../..');
  const migrations = path.join(root, 'infra/supabase/migrations');
  const filename = '20260808170000_transactional_project_metadata_update.sql';
  const content = fs.readFileSync(path.join(migrations, filename), 'utf8');
  it('is the ninth append-only migration and leaves prior migration files present', () => {
    const files = fs.readdirSync(migrations).filter((file) => file.endsWith('.sql')).sort();
    expect(files).toHaveLength(16); expect(files).toContain(filename);
    expect(files.slice(0, 8)).toContain('20260803180000_transactional_review_actions.sql');
  });
  it('uses an atomic locked, service-role-only security-definer RPC', () => {
    expect(content).toContain('CREATE OR REPLACE FUNCTION public.update_project_metadata(');
    expect(content).toContain('SECURITY DEFINER'); expect(content).toContain("SET search_path = ''"); expect(content).toContain('FOR UPDATE');
    expect(content).toContain('UPDATE public.projects'); expect(content).toContain('DELETE FROM public.project_disciplines'); expect(content).toContain('DELETE FROM public.project_industry_categories');
    expect(content).toContain("REVOKE ALL ON FUNCTION public.update_project_metadata(text, text, text, text, text, integer, uuid, uuid[], uuid[], timestamptz) FROM PUBLIC;");
    expect(content).toContain('FROM anon;'); expect(content).toContain('FROM authenticated;'); expect(content).toContain('TO service_role;');
    expect(content).not.toMatch(/\bEXECUTE\s+['"]/); expect(content).not.toContain('ALTER DEFAULT PRIVILEGES');
  });
  it('validates stale versions and uses no unrelated writes or audit insertion', () => {
    expect(content).toContain('IS DISTINCT FROM p_expected_updated_at'); expect(content).toContain("'STALE_VERSION'");
    expect(content).not.toContain('approval_records'); expect(content).not.toContain('status ='); expect(content).not.toContain('layout_config');
  });
});
