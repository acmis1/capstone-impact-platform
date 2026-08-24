import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { EXPECTED_MIGRATION_FILENAMES } from '../scripts/onboardingCheck';

describe('assistive validation staff inspection migration contract', () => {
  const root = path.resolve(__dirname, '../../../..');
  const migrations = path.join(root, 'infra/supabase/migrations');
  const filename = '20260821090000_assistive_validation_staff_inspection.sql';
  const content = fs.readFileSync(path.join(migrations, filename), 'utf8').replace(/\r\n/g, '\n');
  const executable = content.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
  const compact = executable.replace(/\s+/g, ' ');

  it('is exactly migration 0032 and preserves all thirty-one inherited migrations byte-for-byte', () => {
    const files = fs.readdirSync(migrations).filter((file) => file.endsWith('.sql')).sort();
    expect(files).toEqual([...EXPECTED_MIGRATION_FILENAMES]);
    expect(files).toHaveLength(34);
    expect(files[31]).toBe(filename);
    expect(() => execFileSync(
      'git',
      ['diff', '--exit-code', 'origin/main', '--', ...files.slice(0, 31).map(
        (inherited) => `infra/supabase/migrations/${inherited}`,
      )],
      { cwd: root, stdio: 'pipe' },
    )).not.toThrow();
  });

  it('documents the exact canonical Migration 0032 filename and hash', () => {
    const digest = crypto.createHash('sha256').update(content).digest('hex');
    const documentation = fs.readFileSync(
      path.join(root, 'docs/assistive-validation/phase-5-staff-ui.md'),
      'utf8',
    );
    expect(documentation).toContain(filename);
    expect(documentation).toContain(digest);
  });

  it('defines the bounded read-only get_project_assistive_validation_inspection function', () => {
    expect(compact).toContain('CREATE OR REPLACE FUNCTION public.get_project_assistive_validation_inspection');
    expect(compact).toContain('SECURITY DEFINER');
    expect(compact).toContain("SET search_path = ''");
    expect(executable).not.toMatch(
      /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+public\.(projects|media_assets|approval_records|published_snapshots|validation_flags|import_batches|assistive_validation_runs|assistive_validation_jobs|assistive_validation_findings)\b/i,
    );
    expect(executable).not.toMatch(/\b(EXECUTE\s+['"$]|format\s*\()/i);
  });

  it('restricts execution to service_role only', () => {
    expect(compact).toContain('REVOKE ALL ON FUNCTION public.get_project_assistive_validation_inspection(uuid, text, uuid) FROM PUBLIC, anon, authenticated, service_role;');
    expect(compact).toContain('GRANT EXECUTE ON FUNCTION public.get_project_assistive_validation_inspection(uuid, text, uuid) TO service_role;');
  });

  it('enforces strict project-to-run ownership and fail-closed validation', () => {
    expect(compact).toContain("RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');");
    expect(compact).toContain("RETURN pg_catalog.jsonb_build_object('resultCode', 'NOT_FOUND');");
    expect(compact).toContain("RETURN pg_catalog.jsonb_build_object('resultCode', 'INVARIANT_VIOLATION');");
    expect(compact).toContain('WHERE r.id = p_run_id AND r.project_id = p_project_id AND r.pipeline_version = v_pipeline_version');
    expect(compact).toContain('WHERE r.project_id = p_project_id AND r.pipeline_version = v_pipeline_version ORDER BY r.created_at DESC, r.id DESC LIMIT 1');
  });

  it('strictly bounds finding count to 50 and omits reviewer identity and timestamps', () => {
    expect(compact).toContain('IF v_finding_count > 50 THEN RETURN pg_catalog.jsonb_build_object(\'resultCode\', \'INVARIANT_VIOLATION\');');
    expect(compact).not.toContain('reviewed_by');
    expect(compact).not.toContain('reviewedBy');
    expect(compact).not.toContain('reviewed_at');
    expect(compact).not.toContain('reviewedAt');
  });
});
