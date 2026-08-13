import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../../..');
const migrationDir = path.join(root, 'infra/supabase/migrations');
const migration = '20260812120000_controlled_publication_execution.sql';
const content = fs.readFileSync(path.join(migrationDir, migration), 'utf8').replace(/\r\n/g, '\n');

const GLOBAL_LOCK = "pg_advisory_xact_lock(pg_catalog.hashtext('controlled_publication_global'))";
const ACTIVE_STATES = "state IN ('reserved', 'prepared', 'storage_written', 'compensation_failed')";

/** Source-order assertions must be scoped to one routine, never to the whole migration text. */
function routine(name: string): string {
  const start = content.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `routine ${name} is missing`).toBeGreaterThan(-1);
  const next = content.indexOf('CREATE OR REPLACE FUNCTION public.', start + 1);
  return content.slice(start, next === -1 ? content.length : next);
}

function orderedWithin(source: string, first: string, second: string): void {
  const a = source.indexOf(first);
  const b = source.indexOf(second);
  expect(a, `missing: ${first}`).toBeGreaterThan(-1);
  expect(b, `missing: ${second}`).toBeGreaterThan(-1);
  expect(a).toBeLessThan(b);
}

describe('Migration 0019 controlled publication execution security contract', () => {
  it('is exactly migration 0019 and leaves migrations 0001-0018 byte-for-byte unchanged from inherited main', () => {
    const files = fs.readdirSync(migrationDir).filter((file) => file.endsWith('.sql')).sort();
    expect(files).toContain(migration);
    expect(files[18]).toBe(migration);
    for (const file of files.slice(0, 18)) {
      const local = fs.readFileSync(path.join(migrationDir, file), 'utf8').replace(/\r\n/g, '\n');
      const inherited = execFileSync('git', ['show', `83e8fbcda747cf57a8ac45c53f540a59a16fb814:infra/supabase/migrations/${file}`], { cwd: root, encoding: 'utf8' }).replace(/\r\n/g, '\n');
      expect(crypto.createHash('sha256').update(local).digest('hex')).toBe(crypto.createHash('sha256').update(inherited).digest('hex'));
    }
  });

  it('defines the corrected two-phase attempt state model with all-or-nothing artifact binding', () => {
    expect(content).toContain('CREATE TABLE public.publication_attempts');
    expect(content).toContain("state IN ('reserved', 'prepared', 'storage_written', 'completed', 'failed', 'compensation_failed')");
    for (const field of ['project_id', 'public_id', 'admin_id', 'confirmed_preview_id', 'confirmed_at', 'candidate_record_count', 'candidate_feed_hash', 'candidate_feed_content', 'media_manifest', 'artifact_bound_at', 'published_snapshot_id', 'failure_code']) {
      expect(content).toContain(field);
    }
    expect(content).toContain("candidate_feed_hash IS NULL OR candidate_feed_hash ~ '^[0-9a-f]{64}$'");
    // A reservation carries no artifact; nothing past reservation may lack one.
    expect(content).toContain('publication_attempt_artifact_binding_coherent');
    expect(content).toContain('publication_attempt_state_binding_coherent');
    expect(content).toMatch(/CONSTRAINT publication_attempt_state_binding_coherent CHECK \(\s*\(state = 'reserved' AND artifact_bound_at IS NULL\)/);
    expect(content).toMatch(/\(state IN \('prepared', 'storage_written', 'completed'\) AND artifact_bound_at IS NOT NULL\)/);
    expect(content).toContain('publication_attempt_terminal_state_coherent');
    expect(content).toContain('publication_attempt_storage_evidence_coherent');
  });

  it('includes every slot-holding state in the global active invariant and the mutation freeze', () => {
    expect(content).toMatch(new RegExp(`CREATE UNIQUE INDEX publication_attempts_one_active_global_idx[\\s\\S]*?ON public\\.publication_attempts \\(\\(true\\)\\)[\\s\\S]*?WHERE ${ACTIVE_STATES.replace(/[()]/g, '\\$&')}`));
    const guard = routine('guard_active_publication_attempt');
    expect(guard.split(ACTIVE_STATES).length - 1).toBe(2);
    expect(guard).toContain("RAISE EXCEPTION 'PUBLICATION_IN_PROGRESS'");
    for (const table of ['projects', 'media_assets', 'participant_previews', 'participant_preview_confirmations', 'participant_preview_correction_requests', 'project_disciplines', 'project_industry_categories']) {
      expect(content).toMatch(new RegExp(`BEFORE INSERT OR UPDATE OR DELETE ON public\\.${table}|BEFORE UPDATE OR DELETE ON public\\.${table}`));
    }
  });

  it('acquires global exclusivity before any durable reservation and binds no artifact at reservation', () => {
    const reserve = routine('reserve_publication_attempt');
    orderedWithin(reserve, GLOBAL_LOCK, ACTIVE_STATES);
    orderedWithin(reserve, GLOBAL_LOCK, 'public.get_project_publication_readiness');
    orderedWithin(reserve, 'public.get_project_publication_readiness', 'INSERT INTO public.publication_attempts');
    orderedWithin(reserve, GLOBAL_LOCK, 'INSERT INTO public.publication_attempts');
    expect(reserve).toContain("'reserved', pg_catalog.now() + interval '5 minutes'");
    expect(reserve).toContain("'resultCode', 'ATTEMPT_RESERVED'");
    // Reservation must not accept or persist any artifact, feed or media evidence.
    for (const artifactField of ['candidate_feed_content', 'candidate_feed_hash', 'previous_feed_content', 'media_manifest', 'feed_storage_bucket']) {
      expect(reserve).not.toContain(artifactField);
    }
  });

  it('binds the artifact only onto an exact reserved attempt holding a valid execution token', () => {
    const prepare = routine('prepare_publication_attempt');
    expect(prepare).toContain(GLOBAL_LOCK);
    expect(prepare).toContain('FROM public.publication_attempts WHERE id = p_attempt_id FOR UPDATE');
    expect(prepare).toContain('v_attempt.execution_token IS DISTINCT FROM p_execution_token');
    expect(prepare).toContain("v_attempt.state <> 'reserved' OR v_attempt.artifact_bound_at IS NOT NULL");
    orderedWithin(prepare, 'ATTEMPT_TOKEN_MISMATCH', 'UPDATE public.publication_attempts');
    orderedWithin(prepare, 'INVALID_ATTEMPT_STATE', 'UPDATE public.publication_attempts');
    // Durable public-media ownership evidence is mandatory for every promoted asset.
    expect(prepare).toContain("pg_catalog.jsonb_typeof(elem->'preExisting') <> 'boolean'");
    expect(prepare).toContain("COALESCE(elem->>'sourceSha256', '') !~ '^[0-9a-f]{64}$'");
    expect(prepare).toContain('artifact_bound_at = pg_catalog.now()');
    expect(prepare).toContain("state = 'prepared'");
    expect(prepare).toContain('previous_feed_content = p_previous_feed_content');
    // Readiness and target state are revalidated at binding time.
    expect(prepare).toContain('public.get_project_publication_readiness');
    expect(prepare).toContain("v_project_status IS DISTINCT FROM 'approved'");
  });

  it('permits expired-attempt recovery only by the original owning admin and rotates the token', () => {
    const claim = routine('claim_publication_attempt');
    expect(claim).toContain(GLOBAL_LOCK);
    expect(claim).toContain('v_attempt.admin_id IS DISTINCT FROM p_admin_id');
    expect(claim).toContain("'resultCode', 'ATTEMPT_OWNER_MISMATCH'");
    // Ownership is enforced before any lease evaluation and before any mutation.
    orderedWithin(claim, 'ATTEMPT_OWNER_MISMATCH', 'lease_expires_at > pg_catalog.now()');
    orderedWithin(claim, 'ATTEMPT_OWNER_MISMATCH', 'UPDATE public.publication_attempts SET execution_token = gen_random_uuid()');
    expect(claim).toContain("state IN ('reserved', 'prepared', 'storage_written', 'compensation_failed')");
    expect(claim).toContain('execution_token = gen_random_uuid()');
  });

  it('rejects stale execution tokens on every post-reservation attempt mutation', () => {
    for (const name of ['prepare_publication_attempt', 'mark_publication_attempt_storage_written', 'finalize_publication_attempt', 'fail_publication_attempt']) {
      const source = routine(name);
      expect(source).toContain('execution_token IS DISTINCT FROM p_execution_token');
      expect(source).toContain('ATTEMPT_TOKEN_MISMATCH');
      orderedWithin(source, 'ATTEMPT_TOKEN_MISMATCH', 'UPDATE public.publication_attempts');
    }
  });

  it('uses service-role-only hardened RPCs and prevents direct attempt mutations', () => {
    for (const fn of ['reserve_publication_attempt', 'prepare_publication_attempt', 'claim_publication_attempt', 'mark_publication_attempt_storage_written', 'finalize_publication_attempt', 'fail_publication_attempt']) {
      expect(content).toContain(`CREATE OR REPLACE FUNCTION public.${fn}`);
      expect(content).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([\\s\\S]*?FROM PUBLIC, anon, authenticated;`));
      expect(content).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([\\s\\S]*?TO service_role;`));
      expect(routine(fn)).toContain("SET search_path = ''");
      expect(routine(fn)).toContain('SECURITY DEFINER');
    }
    expect(content).not.toContain('begin_publication_attempt');
    expect(content).toContain('REVOKE ALL PRIVILEGES ON TABLE public.publication_attempts FROM PUBLIC, anon, authenticated, service_role;');
    expect(content).toContain('GRANT SELECT ON TABLE public.publication_attempts TO service_role;');
    expect(content).toContain('REVOKE ALL ON FUNCTION public.normalize_public_media_mapping() FROM PUBLIC, anon, authenticated, service_role;');
    expect(content).toContain('REVOKE ALL ON FUNCTION public.guard_active_publication_attempt() FROM PUBLIC, anon, authenticated, service_role;');
  });

  it('atomically finalizes exact publish audit, snapshot, media mapping, project status, and completed attempt', () => {
    const finalize = routine('finalize_publication_attempt');
    expect(finalize).toContain("SET status = 'published'");
    expect(finalize).toContain("'publish', 'approved', 'published'");
    expect(finalize).toContain('VALUES (v_attempt.project_id, v_attempt.admin_id');
    expect(finalize).toContain('INSERT INTO public.published_snapshots');
    expect(finalize).toContain('v_attempt.candidate_record_count, v_attempt.candidate_feed_hash, v_attempt.admin_id');
    expect(finalize).toContain("SET state = 'completed'");
    expect(finalize).toContain('published_snapshot_id = v_snapshot_id');
    expect(finalize).toContain('publish_audit_record_id = v_audit_id');
    expect(finalize).toContain('public_storage_bucket');
    expect(finalize).toContain('public_storage_path');
    // One transaction: no COMMIT splits the finalization body.
    expect(finalize).not.toContain('COMMIT;');
    expect(finalize).toContain("v_attempt.state <> 'storage_written'");
  });
});
