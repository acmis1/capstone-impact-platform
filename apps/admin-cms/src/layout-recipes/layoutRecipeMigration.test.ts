import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = path.resolve(__dirname, '../../../../infra/supabase/migrations/20260914100000_layout_recipe_library.sql');
const migration = fs.readFileSync(migrationPath, 'utf8');

describe('layout recipe persistence migration', () => {
  it('keeps recipe versions append-only behind RLS and service-role-only audited RPCs', () => {
    expect(migration).toContain('CREATE TABLE public.layout_recipe_versions');
    expect(migration).toContain('CREATE TABLE public.layout_recipe_audit_events');
    expect(migration).toContain('ALTER TABLE public.layout_recipe_versions ENABLE ROW LEVEL SECURITY;');
    expect(migration).toContain('REVOKE ALL ON TABLE public.layout_recipe_versions FROM PUBLIC, anon, authenticated, service_role;');
    expect(migration).toContain('REVOKE ALL ON TABLE public.layout_recipe_audit_events FROM PUBLIC, anon, authenticated, service_role;');
    expect(migration).toContain('GRANT SELECT ON TABLE public.layout_recipe_versions TO service_role;');
    expect(migration).toContain('GRANT SELECT ON TABLE public.layout_recipe_audit_events TO service_role;');
    expect(migration).not.toMatch(/GRANT (?:INSERT|UPDATE|DELETE|ALL).*layout_recipe_versions TO service_role/);
    expect(migration).toContain('public.layout_recipe_actor_can_manage(p_actor_admin_id)');
    expect(migration).toContain("role_row.role = 'admin'");
    expect(migration).toContain("actor.lifecycle_status = 'active'");
    expect(migration).toContain("request.status = 'pending_activation'");
    expect(migration).not.toMatch(/DELETE\s+FROM\s+public\.layout_recipe_versions/i);
    for (const internalSignature of [
      'public.layout_recipe_actor_can_manage(uuid)',
      'public.get_project_publication_readiness_without_layout_recipe(text, uuid, text)',
      'public.get_project_reconciliation_readiness_without_layout_recipe(text, uuid, text)',
    ]) {
      expect(migration).toContain(`REVOKE ALL ON FUNCTION ${internalSignature} FROM PUBLIC, anon, authenticated, service_role;`);
      expect(migration).not.toContain(`GRANT EXECUTE ON FUNCTION ${internalSignature} TO service_role;`);
    }
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.layout_recipe_config_valid(jsonb) FROM PUBLIC, anon, authenticated, service_role;');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.layout_recipe_config_valid(jsonb) TO service_role;');
    expect(migration).not.toContain('GRANT EXECUTE ON FUNCTION public.layout_recipe_config_valid(jsonb) TO anon');
    expect(migration).not.toContain('GRANT EXECUTE ON FUNCTION public.layout_recipe_config_valid(jsonb) TO authenticated');
    for (const signature of [
      'public.create_layout_recipe(uuid, text, jsonb, uuid)',
      'public.version_layout_recipe(uuid, uuid, integer, text, jsonb)',
      'public.retire_layout_recipe(uuid, uuid, integer)',
    ]) {
      expect(migration).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, anon, authenticated;`);
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO service_role;`);
    }
  });

  it('validates the exact existing wire and never stores arbitrary presentation code', () => {
    expect(migration).toContain("p_config - ARRAY['templateId', 'featuredMedia', 'sectionOrder', 'hiddenSections'] <> '{}'::jsonb");
    expect(migration).toContain("p_config->>'templateId' NOT IN ('poster_showcase', 'technical_detail', 'media_rich')");
    expect(migration).toContain('v_section_count <> 8');
    expect(migration).toContain('v_distinct_section_count <> 8');
    expect(migration).toContain('v_hidden_count > 5');
    expect(migration).toContain("section.value NOT IN ('background', 'solution', 'video', 'links', 'citations')");
    expect(migration).not.toContain("section.value NOT IN ('background', 'solution', 'snapshots', 'video', 'links', 'citations')");
    expect(migration).not.toMatch(/\b(?:html|css|javascript|iframe|font_url)\b/i);
  });

  it('captures resolved layout values immutably while grandfathering historical previews', () => {
    expect(migration).toContain('ADD COLUMN layout_config_snapshot jsonb NULL');
    expect(migration).toContain('BEFORE INSERT ON public.participant_previews');
    expect(migration).toContain('BEFORE UPDATE OF layout_config_snapshot ON public.participant_previews');
    expect(migration).toContain('WHEN public.layout_recipe_config_valid(v_layout_config) THEN v_layout_config');
    expect(migration).toContain('WHEN public.layout_recipe_config_valid(v_layout_config) THEN v_layout_config');
    expect(migration).toContain('v_confirmed_layout IS NOT NULL');
    expect(migration).toContain("'resultCode', 'PROJECT_SNAPSHOT_STALE'");
    expect(migration).toContain('get_project_reconciliation_readiness_without_layout_recipe');
  });

  it('advances the exact release capability sentinel at the new migration head', () => {
    expect(migration).toContain("20260914100000_layout_recipe_library|active_staff_catalog_rls_v1|staff_lifecycle_v1|staging_feed_rollback_capability_v1|preview_response_observation_v1|assistive_worker_environment_identity_v1|gallery_text_equivalent_v1|layout_recipe_library_v1");
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.get_release_capability_sentinel() TO service_role;');
  });
});
