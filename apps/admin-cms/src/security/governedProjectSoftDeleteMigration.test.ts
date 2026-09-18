import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = path.resolve(
  __dirname,
  '../../../../infra/supabase/migrations/20260917120000_governed_project_soft_delete.sql',
);
const migration = fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');
const executableMigration = migration.replace(/--[^\n]*/g, '');
const decision = migration.slice(
  migration.indexOf('CREATE FUNCTION public.project_soft_delete_decision'),
  migration.indexOf('CREATE FUNCTION public.get_project_soft_delete_preflight'),
);

describe('governed project soft delete migration', () => {
  it('is forward-only, non-destructive, and enforces paired lifecycle/tombstone writes without backfill', () => {
    expect(migration).toContain('-- Migration 0061: governed project soft delete.');
    expect(migration).toContain('ADD CONSTRAINT projects_soft_delete_state_coherent');
    expect(migration).toContain("CHECK ((status = 'deleted') = (deleted_at IS NOT NULL)) NOT VALID");
    expect(executableMigration).not.toMatch(/\b(?:TRUNCATE|DELETE FROM|DROP TABLE)\b/i);
    expect(executableMigration).not.toMatch(/UPDATE public\.projects\s+SET status = 'deleted'[\s\S]*WHERE deleted_at IS NOT NULL/i);
  });

  it('allows private lifecycle states but blocks direct published, current-feed, pending, and ambiguous states', () => {
    expect(migration).toContain("p_status NOT IN ('draft', 'submitted', 'in_review', 'changes_requested', 'approved', 'archived')");
    expect(migration).toContain("IF p_status = 'published' THEN");
    expect(migration).toContain("'PUBLISHED_REQUIRES_ARCHIVE'");
    expect(migration).toContain("'CURRENTLY_PUBLIC'");
    expect(migration).toContain("'PUBLICATION_OR_REMOVAL_PENDING'");
    expect(migration).toContain("'REMOVAL_EVIDENCE_REQUIRED'");
    expect(migration).toContain("'REMOVAL_EVIDENCE_AMBIGUOUS'");
    expect(migration).toContain('JOIN public.public_feed_version_members member');
  });

  it('requires exact canonical removal proof for any prior-publication evidence', () => {
    expect(migration).toContain("audit.action_taken = 'publish'");
    expect(migration).toContain("attempt.state = 'completed'");
    expect(migration).toContain("version.operation IN ('publication', 'removal')");
    expect(migration).toContain("operation.kind = 'removal'");
    expect(migration).toContain("operation.state = 'COMPLETED'");
    expect(migration).toContain('operation.completed_at IS NOT DISTINCT FROM p_public_removal_completed_at');
    expect(migration).toContain('v_operation.observed_storage_hash IS DISTINCT FROM v_operation.candidate_feed_hash');
    expect(migration).toContain("event.from_state = 'DB_FINALIZED'");
    expect(migration).toContain("event.to_state = 'COMPLETED'");
  });

  it('isolates malformed historical JSON and validates bounded arrays and safe member ordinals', () => {
    expect(migration).toContain('CREATE FUNCTION public.parse_project_soft_delete_evidence_json');
    expect(migration).toContain('EXCEPTION WHEN others THEN\n  RETURN NULL;');
    expect(decision).not.toContain('candidate_feed_content::jsonb');
    expect(decision).toContain("pg_catalog.jsonb_typeof(v_candidate) IS DISTINCT FROM 'array'");
    expect(decision).toContain('pg_catalog.jsonb_array_length(v_candidate) <> v_operation.candidate_record_count');
    expect(decision).toContain('pg_catalog.jsonb_array_length(v_baseline) <> v_operation.baseline_record_count');
    expect(decision).toContain("~ '^[0-9]{1,10}$'");
    expect(decision).toContain("(member.value->>'ordinal')::bigint > 2147483647");
  });

  it('proves exact baseline subtraction, manifest members, and changed versus no-change version shape', () => {
    expect(decision).toContain("WHERE item.value->>'publicId' <> p_public_id");
    expect(decision).toContain('v_candidate IS DISTINCT FROM v_expected_candidate');
    expect(decision).toContain('v_baseline_version.artifact_content IS DISTINCT FROM');
    expect(decision).toContain("member.record_hash = manifest.value->>'recordHash'");
    expect(decision).toContain('(v_no_feed_change AND v_operation_version_count <> 0)');
    expect(decision).toContain('(NOT v_no_feed_change AND v_operation_version_count <> 1)');
    expect(decision).toContain("v_removal_version.operation IS DISTINCT FROM 'removal'");
    expect(decision).toContain('v_removal_version.previous_version_id IS DISTINCT FROM v_baseline_version.id');
    expect(decision).toContain('v_removal_version.completion_actor_id IS DISTINCT FROM v_finalization_actor_id');
  });

  it('accepts repeated history by selecting the current completion and rejects contradictory later target evidence', () => {
    expect(decision).toMatch(/operation\.state = 'COMPLETED'[\s\S]*operation\.completed_at IS NOT DISTINCT FROM p_public_removal_completed_at/);
    expect(decision).toContain("later_operation.kind IN ('publication', 'removal')");
    expect(decision).toContain('later_operation.completed_at >= v_operation.completed_at');
    expect(decision).toContain("later_version.operation IN ('publication', 'removal')");
    expect(decision).toContain("audit.action_taken = 'publish'");
  });

  it('requires a coherent complete event chain and permits unrelated newer canonical heads', () => {
    expect(decision).toContain('pg_catalog.lag(event.to_state) OVER (ORDER BY event.sequence)');
    expect(decision).toContain("chain.code = 'OWNER_CLAIMED'");
    expect(decision).toContain("event.code = 'RECOVERY_CANDIDATE_OBSERVED'");
    expect(decision).toContain('event.created_at IS NOT DISTINCT FROM v_operation.finalized_at');
    expect(decision).toContain('event.created_at IS NOT DISTINCT FROM v_operation.completed_at');
    expect(decision).toContain('WITH RECURSIVE lineage(id, previous_version_id) AS');
    expect(decision).not.toContain('v_head_version.id IS DISTINCT FROM v_removal_version.id');
  });

  it('serializes with feed writers before the project lock and fences the expected version', () => {
    const execution = migration.indexOf('CREATE FUNCTION public.soft_delete_project_if_current');
    const lock = migration.indexOf("pg_catalog.hashtext('public_feed_canonical_writer')", execution);
    const rowLock = migration.indexOf('FOR UPDATE;', lock);
    expect(lock).toBeGreaterThan(execution);
    expect(rowLock).toBeGreaterThan(lock);
    expect(migration).toContain('v_project.updated_at IS DISTINCT FROM p_expected_updated_at');
    expect(migration).toContain("'STALE_VERSION'");
  });

  it('uses the established active-admin authority before taking the canonical writer lock', () => {
    for (const functionName of [
      'CREATE FUNCTION public.get_project_soft_delete_preflight',
      'CREATE FUNCTION public.soft_delete_project_if_current',
    ]) {
      const entryPoint = migration.indexOf(functionName);
      const authority = migration.indexOf('public.public_feed_actor_is_admin(p_admin_id)', entryPoint);
      const canonicalLock = migration.indexOf("pg_catalog.hashtext('public_feed_canonical_writer')", entryPoint);
      expect(authority).toBeGreaterThan(entryPoint);
      expect(canonicalLock).toBeGreaterThan(authority);
    }
  });

  it('updates status and deleted_at together and records one atomic immutable exact transition audit', () => {
    expect(migration).toContain("SET status = 'deleted',\n         deleted_at = v_deleted_at");
    expect(migration).toContain("'soft_delete',\n    v_project.status,\n    'deleted'");
    expect(migration).toContain("'type', 'project_soft_delete'");
    expect(migration).toContain("IF v_project.status = 'deleted' AND v_project.deleted_at IS NOT NULL THEN");
    expect(migration).toContain("'ALREADY_DELETED'");
    expect(migration).toContain('CREATE TRIGGER soft_delete_audit_immutable');
    expect(migration).toContain("RAISE EXCEPTION 'SOFT_DELETE_AUDIT_IMMUTABLE'");
  });

  it('keeps both authorities service-role-only and advances the release sentinel', () => {
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.get_project_soft_delete_preflight(text[], uuid)\nTO service_role;');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.soft_delete_project_if_current(text, timestamptz, uuid)\nTO service_role;');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.parse_project_soft_delete_evidence_json(text)\nFROM PUBLIC, anon, authenticated, service_role;');
    expect(migration).toContain('20260917120000_governed_project_soft_delete');
    expect(migration).toContain('governed_project_soft_delete_v1');
  });
});
