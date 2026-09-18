import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = path.resolve(
  __dirname,
  '../../../../infra/supabase/migrations/20260917090000_archived_project_republish_media_rearm.sql',
);
const migration = fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');

describe('archived-project republish media rearm migration', () => {
  it('is a forward-only wrapper around the unchanged M59 restore authority', () => {
    expect(migration).toContain('RENAME TO perform_project_review_action_without_media_rearm');
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.perform_project_review_action_without_media_rearm(text, text, text, uuid)',
    );
    expect(migration).toContain('v_result := public.perform_project_review_action_without_media_rearm(');
    expect(migration).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE FROM)\b/i);
    expect(migration).not.toMatch(/\b(?:CREATE|ALTER|DROP) TABLE\b/i);
  });

  it('allows media mutation only after successful M59 restore audit evidence', () => {
    const actorGuard = migration.indexOf('IF NOT public.public_feed_actor_is_admin(p_admin_id) THEN');
    const writerLock = migration.indexOf("pg_catalog.hashtext('public_feed_canonical_writer')");
    const restoreCall = migration.indexOf(
      'v_result := public.perform_project_review_action_without_media_rearm(',
    );
    const auditProof = migration.indexOf('FROM public.approval_records audit');
    const mediaUpdate = migration.indexOf('UPDATE public.media_assets');

    expect(actorGuard).toBeGreaterThan(0);
    expect(writerLock).toBeGreaterThan(actorGuard);
    expect(restoreCall).toBeGreaterThan(writerLock);
    expect(auditProof).toBeGreaterThan(restoreCall);
    expect(mediaUpdate).toBeGreaterThan(auditProof);
    expect(migration).toContain("audit.action_taken = 'restore'");
    expect(migration).toContain("audit.event_details->>'type' = 'archived_project_restore'");
    expect(migration).toContain("IF v_archive_origin = 'published' THEN");
    expect(migration).toContain("RAISE EXCEPTION 'RESTORE_AUDIT_EVIDENCE_INVALID'");
    expect(migration).toContain("pg_catalog.hashtext('participant_preview:' || v_public_id)");
  });

  it('demotes only coherent public mappings belonging to the restored target', () => {
    expect(migration).toContain('SET is_public_approved = false,');
    expect(migration).toContain('public_url = NULL,');
    expect(migration).toContain('public_storage_bucket = NULL,');
    expect(migration).toContain('public_storage_path = NULL');
    expect(migration).toContain('WHERE project_id = v_project_id');
    expect(migration).toContain('is_public_approved IS DISTINCT FROM false');

    for (const preserved of [
      'storage_bucket',
      'storage_path',
      'file_name',
      'mime_type',
      'file_size_bytes',
      'alt_text_public',
      'gallery_position',
      'image_content_kind',
      'full_text_public',
    ]) {
      expect(migration).not.toMatch(new RegExp(`^\\s*${preserved}\\s*=`, 'm'));
    }
    expect(migration).not.toMatch(/\bstorage\.(?:objects|buckets)\b/i);
    expect(migration).not.toMatch(/(?:INSERT INTO|UPDATE|DELETE FROM) public\.(?:public_feed_|publication_attempts|public_removal_attempts)/i);
  });

  it('revokes pre-restore preview authority without deleting confirmation evidence', () => {
    expect(migration).toContain('UPDATE public.participant_previews');
    expect(migration).toContain("SET status = 'revoked',");
    expect(migration).toContain('revoked_at = pg_catalog.now(),');
    expect(migration).toContain('revoked_by = p_admin_id');
    expect(migration).not.toMatch(/DELETE FROM public\.participant_preview/i);
  });

  it('reconciles already-restored rows only from unique immutable M59 evidence', () => {
    expect(migration).toContain('CREATE FUNCTION public.reconcile_archived_project_republish_media()');
    expect(migration).toContain("project.status = 'approved'");
    expect(migration).toContain('project.deleted_at IS NULL');
    expect(migration).toContain("restore_count.action_taken = 'restore'");
    expect(migration).toContain("v_restore.from_status IS DISTINCT FROM 'archived'");
    expect(migration).toContain("v_restore.to_status IS DISTINCT FROM 'approved'");
    expect(migration).toContain("'archivedFromStatus', 'published'");
    expect(migration).toContain("'republishRequired', true");
    expect(migration).toContain("v_archive.from_status IS DISTINCT FROM 'published'");
    expect(migration).toContain("v_archive.to_status IS DISTINCT FROM 'archived'");
    expect(migration).toContain('SELECT public.reconcile_archived_project_republish_media();');
  });

  it('requires coherent canonical removal completion and current-feed absence', () => {
    expect(migration).toContain("operation.kind = 'removal'");
    expect(migration).toContain("operation.state = 'COMPLETED'");
    expect(migration).toContain('v_operation.candidate_byte_count IS DISTINCT FROM');
    expect(migration).toContain('public.parse_archived_republish_candidate_json(');
    expect(migration).toContain('operation.candidate_record_count');
    expect(migration).toContain('v_operation.observed_storage_hash IS DISTINCT FROM');
    expect(migration).toContain("event.from_state = 'DB_FINALIZED'");
    expect(migration).toContain("event.to_state = 'COMPLETED'");
    expect(migration).toContain('v_expected_event_count := CASE WHEN v_no_feed_change THEN 5 ELSE 6 END');
    expect(migration).toContain("WHEN NOT v_no_feed_change AND event.sequence = 3 THEN 'WRITE_STARTED'");
    expect(migration).toContain('member.public_id = v_project.public_id');
    expect(migration).toContain('v_operation.baseline_version_id IS NULL');
    expect(migration).toContain('v_candidate IS DISTINCT FROM v_expected_candidate');
    expect(migration).toContain('v_removal_version.previous_version_id IS DISTINCT FROM v_baseline_version.id');
    expect(migration).toContain('baseline_member.record_hash IS DISTINCT FROM candidate_member.record_hash');
    expect(migration).toContain("event.to_state = 'DB_FINALIZED'");
    expect(migration).toContain('v_completed_sequence <> v_finalized_sequence + 1');
    expect(migration).toContain("CASE WHEN v_no_feed_change THEN 'NO_FEED_CHANGE' ELSE NULL END");
  });

  it('validates member ordinals without a throwing integer cast', () => {
    expect(migration).toContain("~ '^[0-9]{1,10}$'");
    expect(migration).toContain("(member.value->>'ordinal')::bigint > 2147483647");
    expect(migration).not.toContain("(member.value->>'ordinal')::integer");
  });

  it('serializes with writers, refuses active state, and is replay-idempotent', () => {
    expect(migration).toContain("pg_catalog.hashtext('public_feed_canonical_writer')");
    for (const state of [
      'RESERVED', 'PREPARED', 'WRITE_STARTED', 'CANDIDATE_OBSERVED',
      'DB_FINALIZED', 'RECOVERY_REQUIRED', 'reserved', 'prepared',
      'storage_written', 'compensation_failed',
    ]) {
      expect(migration).toContain(`'${state}'`);
    }
    expect(migration).toContain('is_public_approved IS DISTINCT FROM false');
    expect(migration).toContain('GET DIAGNOSTICS v_changed_rows = ROW_COUNT;');
    expect(migration).toContain('ORDER BY project.id\n   FOR UPDATE;');
    expect(migration).toContain('ORDER BY media.id\n     FOR UPDATE;');
    expect(migration).toContain('v_project.status <> \'approved\'');
  });

  it('keeps the public RPC service-role-only and advances the capability sentinel', () => {
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.perform_project_review_action(text, text, text, uuid)\nFROM PUBLIC, anon, authenticated;',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.perform_project_review_action(text, text, text, uuid)\nTO service_role;',
    );
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.reconcile_archived_project_republish_media()\nFROM PUBLIC, anon, authenticated, service_role;',
    );
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.parse_archived_republish_candidate_json(text)\nFROM PUBLIC, anon, authenticated, service_role;',
    );
    expect(migration).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.reconcile_archived_project_republish_media/i,
    );
    expect(migration).toContain(
      '20260917090000_archived_project_republish_media_rearm|active_staff_catalog_rls_v1|staff_lifecycle_v1|staging_feed_rollback_capability_v1|preview_response_observation_v1|assistive_worker_environment_identity_v1|gallery_text_equivalent_v1|layout_recipe_library_v1|archived_project_restore_v1|archived_project_republish_media_rearm_v1',
    );
  });
});
