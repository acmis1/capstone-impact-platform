import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../../..');
const migration = fs.readFileSync(
  path.join(root, 'infra/supabase/migrations/20260918120000_governed_project_maintenance.sql'),
  'utf8',
).replace(/\r\n/g, '\n');
const verifier = fs.readFileSync(
  path.join(root, 'apps/admin-cms/src/scripts/runDisposableStagingMigrationUpgrade.ts'),
  'utf8',
).replace(/\r\n/g, '\n');

describe('governed project maintenance migration (0062)', () => {
  it('is a forward-only schema and authority addition with no installation-time row rewrite', () => {
    const ddl = migration.slice(0, migration.indexOf('CREATE FUNCTION public.update_project_layout_if_current'));
    expect(migration).toContain('-- Migration 0062: governed project maintenance');
    expect(ddl).not.toMatch(/\b(?:UPDATE|DELETE|TRUNCATE)\s+public\.(?:projects|media_assets|participant_previews)\b/i);
    expect(migration).toContain('ADD COLUMN retired_at timestamptz');
    expect(migration).toContain('ADD COLUMN lifecycle_version integer NOT NULL DEFAULT 1');
    expect(migration).toContain('CREATE TABLE public.taxonomy_lifecycle_audit_events');
    expect(migration).toContain('taxonomy_lifecycle_audit_immutable');
  });

  it('keeps layout changes bounded by the existing validator, status/CAS, recipe lock and preview revocation', () => {
    expect(migration).toContain('p_layout_config IS NULL');
    expect(migration).toContain('public.layout_recipe_config_valid(p_layout_config)');
    expect(migration).toContain("v_project.status NOT IN ('draft', 'changes_requested')");
    expect(migration).toContain('v_project.updated_at IS DISTINCT FROM p_expected_updated_at');
    expect(migration).toContain('SELECT recipe.* INTO v_recipe');
    expect(migration).toContain('v_recipe.layout_config IS DISTINCT FROM p_layout_config');
    expect(migration).toContain("SET status = 'revoked', revoked_at = pg_catalog.now(), revoked_by = p_admin_id");
    expect(migration).toContain("'update_layout'");
  });

  it('proves deleted recovery from exact M61 evidence and preserves physical media', () => {
    expect(migration).toContain('public.project_soft_delete_decision(');
    expect(migration).toContain('audit.event_details->\'deletedAt\' = pg_catalog.to_jsonb(v_project.deleted_at)');
    expect(migration).toContain("'RECOVERY_EVIDENCE_REQUIRED'");
    expect(migration).toContain("'ALREADY_RECOVERED'");
    expect(migration).toContain('SET is_public_approved = false');
    expect(migration).toContain('public_storage_bucket = NULL');
    expect(migration.slice(migration.indexOf('CREATE FUNCTION public.recover_deleted_project_if_current'), migration.indexOf('CREATE FUNCTION public.list_deleted_projects'))).not.toMatch(/\b(?:DELETE FROM|storage\.objects)\b/i);
    expect(migration).toContain("'project_recovery'");
    expect(migration).toContain("project.status = 'deleted' OR project.deleted_at IS NOT NULL");
  });

  it('uses exact taxonomy kinds/actions, actual reference counts and immutable audit details', () => {
    expect(migration).toContain("v_kind NOT IN ('program', 'discipline', 'industryCategory')");
    expect(migration).toContain("v_action NOT IN ('retire', 'reactivate', 'rename')");
    expect(migration).toContain('FROM public.projects WHERE program_id = v_id');
    expect(migration).toContain('FROM public.project_disciplines ref WHERE ref.project_id=project.id AND ref.discipline_id=v_id');
    expect(migration).toContain('FROM public.project_industry_categories ref WHERE ref.project_id=project.id AND ref.industry_category_id=v_id');
    expect(migration).toContain('before_lifecycle_version');
    expect(migration).toContain('GRANT SELECT ON public.taxonomy_lifecycle_audit_events TO service_role');
    expect(migration).toContain('governed_project_maintenance_v1');
  });

  it('keeps all new public authorities service-role-only and wires the real 48-to-62 verifier', () => {
    for (const signature of [
      'update_project_layout_if_current(text, timestamptz, jsonb, uuid, uuid)',
      'recover_deleted_project_if_current(text, timestamptz, timestamptz, uuid)',
      'list_deleted_projects(uuid, integer, integer, text)',
      'get_deleted_project_detail(text, uuid)',
      'manage_taxonomy_lifecycle(text, uuid, text, text, integer, uuid)',
    ]) {
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION public.${signature}`);
      expect(migration).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${signature.replace(/[()[\],]/g, '\\$&')}[\\s\\S]*?FROM PUBLIC, anon, authenticated, service_role`));
    }
    expect(verifier).toContain("{ ordinal: 62, version: '20260918120000'");
    expect(verifier).toContain('async function verifyGovernedMaintenanceRuntime');
    expect(verifier).toContain('applyRelease(workdir, networkId, 62)');
    expect(verifier).toContain('assertAfter62(current61Tables, current61TaxonomyRows)');
  });
});
