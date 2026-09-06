import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../../..');
const filename = '20260906120000_public_removal_completion_reconciliation.sql';
const migration = fs.readFileSync(path.join(root, 'infra/supabase/migrations', filename), 'utf8');
const completion = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION public.complete_public_feed_operation('),
  migration.indexOf('-- Reconcile only historical project rows'),
);
const reconciliation = migration.slice(migration.indexOf('-- Reconcile only historical project rows'));

describe('public-removal completion reconciliation migration', () => {
  it('replaces only the existing completion authority with the same security boundary', () => {
    expect(migration.match(/CREATE OR REPLACE FUNCTION public\./g)).toHaveLength(1);
    expect(migration).not.toMatch(/CREATE TABLE|ALTER TABLE|DROP TABLE|TRUNCATE|DELETE FROM/i);
    expect(completion).toContain('public.complete_public_feed_operation(');
    expect(completion).toContain('SECURITY DEFINER');
    expect(completion).toContain("SET search_path = ''");
    expect(completion).toContain('public.public_feed_actor_is_admin(p_actor_id)');
    expect(completion).toContain("pg_advisory_xact_lock(pg_catalog.hashtext('public_feed_canonical_writer'))");
    expect(completion).toContain('public.public_feed_owner_valid(');
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.complete_public_feed_operation(uuid,bigint,text,uuid,text,integer)',
    );
    expect(migration).toContain('FROM PUBLIC, anon, authenticated;');
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.complete_public_feed_operation(uuid,bigint,text,uuid,text,integer)',
    );
    expect(migration).toContain('TO service_role;');
  });

  it('keeps removal pending until exact head observation and bound target state are proved', () => {
    const observation = completion.indexOf("v_head_version.feed_hash IS DISTINCT FROM p_observed_hash");
    const targetLock = completion.indexOf('FROM public.projects');
    const projectUpdate = completion.indexOf('UPDATE public.projects');
    const operationUpdate = completion.indexOf('UPDATE public.public_feed_operations');

    expect(observation).toBeGreaterThan(0);
    expect(targetLock).toBeGreaterThan(observation);
    expect(projectUpdate).toBeGreaterThan(targetLock);
    expect(operationUpdate).toBeGreaterThan(projectUpdate);
    expect(completion).toContain("v_operation.state <> 'DB_FINALIZED'");
    expect(completion).toContain("v_project.status <> 'archived'");
    expect(completion).toContain("v_project.archived_from_status IS DISTINCT FROM 'published'");
    expect(completion).toContain('v_project_was_pending := v_project.pending_removal_from_public IS TRUE');
    expect(completion).toContain('AND v_project.public_removal_completed_at IS NULL');
    expect(completion).toContain('v_project.public_id IS DISTINCT FROM v_operation.public_id');
    expect(completion).toContain('m.version_id = v_operation.baseline_version_id');
    expect(completion).toContain('IF NOT v_project_was_pending');
    expect(completion).toContain('v_operation_version.id IS NULL');
    expect(completion).toContain('v_project.pending_removal_from_public IS DISTINCT FROM false');
    expect(completion).toContain("pg_catalog.set_config('app.public_feed_operation_id', v_operation.id::text, true)");
    expect(completion).toContain('pending_removal_from_public = false');
    expect(completion).toContain('public_removal_completed_at = v_completed_at');
    expect(completion).toContain("SET state = 'COMPLETED'");
    expect(completion).toContain('completed_at = v_completed_at');
    expect(completion).toContain("'INVALID_PROJECT_STATE'");
    expect(completion).toContain("'ARTIFACT_MISMATCH'");
  });

  it('preserves completed replay idempotency without a second project, event, or head transition', () => {
    const completedReplay = completion.indexOf("v_operation.state = 'COMPLETED'");
    expect(completedReplay).toBeGreaterThan(0);
    expect(completedReplay).toBeLessThan(completion.indexOf('public.public_feed_owner_valid('));
    expect(completion.match(/UPDATE public\.public_feed_head/g)).toBeNull();
    expect(completion.match(/INSERT INTO public\.public_feed_versions/g)).toBeNull();
    expect(completion.match(/INSERT INTO public\.approval_records/g)).toBeNull();
  });

  it('backfills only one exactly evidenced completed removal and reports ambiguity', () => {
    for (const evidence of [
      "p.status = 'archived'",
      "p.archived_from_status = 'published'",
      'p.pending_removal_from_public = true',
      'p.public_removal_completed_at IS NULL',
      "o.kind = 'removal'",
      "o.state = 'COMPLETED'",
      'o.completed_at IS NOT NULL',
      "e.from_state = 'DB_FINALIZED'",
      "e.to_state = 'COMPLETED'",
      'v_operation.candidate_byte_count IS NOT NULL',
      "v_version.operation = 'removal'",
      'v_version.previous_version_id IS NOT DISTINCT FROM v_operation.baseline_version_id',
      'v_version.project_id IS NOT DISTINCT FROM v_project.id',
      'v_version.affected_public_id IS NOT DISTINCT FROM v_project.public_id',
      'v_version.feed_hash = pg_catalog.encode(',
      'later.version_number > v_version.version_number',
      "later.operation = 'publication'",
      'JOIN public.public_feed_version_members m ON m.version_id = h.current_version_id',
      'public_removal_completed_at = v_operation.completed_at',
    ]) {
      expect(reconciliation).toContain(evidence);
    }
    expect(reconciliation).toContain('v_completed_removal_count <> 1');
    expect(reconciliation).toContain('v_proof_valid IS DISTINCT FROM true');
    expect(reconciliation).toContain('PUBLIC_REMOVAL_RECONCILIATION_AMBIGUOUS');
    expect(reconciliation).not.toContain('2025-energy-aware-classrooms');
    expect(reconciliation).not.toContain('2024-industry-collaboration-hub');
  });
});
