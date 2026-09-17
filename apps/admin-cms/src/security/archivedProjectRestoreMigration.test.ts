import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = path.resolve(
  __dirname,
  '../../../../infra/supabase/migrations/20260916120000_archived_project_restore.sql',
);
const migration = fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');

describe('archived project restore migration', () => {
  it('is forward-only and keeps the existing review implementation behind a revoked helper', () => {
    expect(migration).toContain('RENAME TO perform_project_review_action_without_restore');
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.perform_project_review_action_without_restore(text, text, text, uuid)',
    );
    expect(migration).toContain('RETURN public.perform_project_review_action_without_restore(');
    expect(migration).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE FROM)\b/i);
    expect(migration).not.toMatch(/\b(?:CREATE|ALTER|DROP) TABLE\b/i);
  });

  it('restores only verified archive origins and never restores directly to published', () => {
    expect(migration).toContain("WHEN 'submitted' THEN 'submitted'");
    expect(migration).toContain("WHEN 'in_review' THEN 'in_review'");
    expect(migration).toContain("WHEN 'approved' THEN 'approved'");
    expect(migration).toContain("WHEN 'published' THEN 'approved'");
    expect(migration).not.toContain("WHEN 'published' THEN 'published'");
    expect(migration).toContain("'ARCHIVE_PROVENANCE_AMBIGUOUS'");
    expect(migration).toContain("audit.action_taken = 'archive'");
    expect(migration).toContain('audit.created_at IS NOT DISTINCT FROM v_archived_at');
    expect(migration).toContain('IF v_archive_audit_count <> 1 OR NOT EXISTS (');
    expect(migration).toContain('matching.from_status IS NOT DISTINCT FROM v_archive_origin');
    expect(migration).toContain("matching.to_status IS NOT DISTINCT FROM 'archived'");
  });

  it('serializes with feed writers and requires completed removal proof for published origins', () => {
    const lock = migration.indexOf("pg_catalog.hashtext('public_feed_canonical_writer')");
    const rowLock = migration.indexOf('FOR UPDATE;');
    expect(lock).toBeGreaterThan(0);
    expect(rowLock).toBeGreaterThan(lock);
    expect(migration).toContain("operation.state IN (\n       'RESERVED', 'PREPARED', 'WRITE_STARTED', 'CANDIDATE_OBSERVED',");
    expect(migration).toContain('JOIN public.public_feed_version_members member');
    expect(migration).toContain("'RESTORE_PUBLIC_FEED_UNSAFE'");
    expect(migration).toContain("IF v_archive_origin = 'published' THEN");
    expect(migration).toContain('v_public_removal_completed_at IS NULL');
    expect(migration).toContain("operation.kind = 'removal'");
    expect(migration).toContain("operation.state = 'COMPLETED'");
    expect(migration).toContain('operation.completed_at IS NOT DISTINCT FROM v_public_removal_completed_at');
    expect(migration).toContain('v_public_removal_completed_at < v_archived_at');
    expect(migration).toContain('operation.finalized_at IS NOT NULL');
    expect(migration).toContain('operation.completed_at >= operation.finalized_at');
    expect(migration).toContain('operation.finalized_at >= v_archived_at');
    expect(migration).toContain('FROM public.public_feed_operation_events event');
    expect(migration).toContain('IF v_completed_removal_count <> 1 OR NOT EXISTS (');
  });

  it('clears archive fields atomically and records a restore audit without rewriting feed history', () => {
    expect(migration).toContain('SET status = v_restore_status,');
    expect(migration).toContain('archived_at = NULL,');
    expect(migration).toContain('archived_from_status = NULL,');
    expect(migration).toContain('archive_reason = NULL,');
    expect(migration).toContain("'restore',\n    'archived',");
    expect(migration).toContain("'republishRequired', v_archive_origin = 'published'");
    expect(migration).not.toMatch(/(?:INSERT INTO|UPDATE|DELETE FROM) public\.public_feed_(?:versions|version_members|head)/i);
  });

  it('keeps restore service-role-only and advances the release capability sentinel', () => {
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.perform_project_review_action(text, text, text, uuid)\nFROM PUBLIC, anon, authenticated;',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.perform_project_review_action(text, text, text, uuid)\nTO service_role;',
    );
    expect(migration).toContain(
      '20260916120000_archived_project_restore|active_staff_catalog_rls_v1|staff_lifecycle_v1|staging_feed_rollback_capability_v1|preview_response_observation_v1|assistive_worker_environment_identity_v1|gallery_text_equivalent_v1|layout_recipe_library_v1|archived_project_restore_v1',
    );
  });
});
