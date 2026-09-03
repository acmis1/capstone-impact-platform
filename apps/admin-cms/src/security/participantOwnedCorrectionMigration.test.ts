// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(__dirname, '../../../../infra/supabase/migrations/20260903130000_participant_owned_corrections.sql'), 'utf8');
describe('participant correction migration authority', () => {
  it('limits retirement to project media and project taxonomy mappings', () => {
    const targets = [...sql.matchAll(/DELETE FROM\s+([\w.]+)/g)].map((match) => match[1]);
    expect(targets).toEqual(['public.project_disciplines', 'public.project_industry_categories', 'public.media_assets']);
    for (const statement of sql.matchAll(/DELETE FROM[^;]+;/g)) {
      expect(statement[0]).toMatch(/project_id=p\.id/);
      expect(statement[0]).toMatch(/to_jsonb\([dim]\)=old_row/);
    }
  });
  it('records recoverable rows before applying metadata or retiring any row', () => {
    const recovery = sql.indexOf('INSERT INTO public.participant_correction_recovery_rows');
    expect(recovery).toBeGreaterThan(sql.indexOf('INSERT INTO public.participant_correction_prior_revisions'));
    expect(recovery).toBeLessThan(sql.indexOf('UPDATE public.projects SET title='));
    expect(recovery).toBeLessThan(sql.indexOf('DELETE FROM'));
    expect(sql).toMatch(/EXCEPTION WHEN OTHERS THEN[\s\S]*UNAVAILABLE/);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
  });
  it('exposes no mutation authority to participant or ordinary authenticated roles', () => {
    expect(sql).not.toMatch(/GRANT (?:ALL|INSERT|UPDATE|DELETE|EXECUTE)[^;]+ TO (?:PUBLIC|anon|authenticated)/i);
    expect((sql.match(/ENABLE ROW LEVEL SECURITY/g) ?? []).length).toBe(4);
    expect((sql.match(/GRANT EXECUTE ON FUNCTION/g) ?? []).length).toBe(5);
  });
  it('preserves historical snapshot and confirmation evidence and forbids Storage deletion', () => {
    expect(sql).not.toMatch(/(?:DELETE FROM|UPDATE)\s+storage\./i);
    expect(sql).not.toMatch(/UPDATE public\.participant_previews SET[^;]*(?:snapshot|token_hash)/i);
    expect(sql).not.toMatch(/(?:UPDATE|DELETE FROM) public\.participant_preview_confirmations/i);
    expect(sql).not.toMatch(/UPDATE public\.participant_preview_correction_requests SET[^;]*\bcomment\s*=/i);
  });
});
