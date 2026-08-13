import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../../..');
const dir = path.join(root, 'infra/supabase/migrations');
const migration = '20260812150000_controlled_public_removal.sql';
const content = fs.readFileSync(path.join(dir, migration), 'utf8').replace(/\r\n/g, '\n');
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
function routine(name: string): string { const start = content.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`); expect(start).toBeGreaterThan(-1); const next = content.indexOf('CREATE OR REPLACE FUNCTION public.', start + 1); return content.slice(start, next < 0 ? content.length : next); }

describe('Migration 0020 controlled public removal security contract', () => {
  it('is the sole final migration and leaves migrations 0001-0019 byte-identical to inherited main', () => {
    const files = fs.readdirSync(dir).filter((file) => file.endsWith('.sql')).sort(); expect(files).toContain(migration); expect(files[19]).toBe(migration);
    for (const file of files.slice(0, 19)) { const local = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n'); const inherited = execFileSync('git', ['show', `d18cf877e3abf662172366c3f1dd61126da44167:infra/supabase/migrations/${file}`], { cwd: root, encoding: 'utf8' }).replace(/\r\n/g, '\n'); expect(hash(local)).toBe(hash(inherited)); }
  });
  it('defines a separate durable all-or-nothing attempt ledger including zero-record candidates', () => {
    expect(content).toContain('CREATE TABLE public.public_removal_attempts');
    for (const field of ['archive_reason', 'candidate_record_count', 'candidate_feed_hash', 'candidate_feed_content', 'previous_feed_content', 'artifact_bound_at', 'execution_token', 'lease_expires_at', 'storage_verified_at', 'archive_audit_record_id', 'compensation_failure_code']) expect(content).toContain(field);
    expect(content).toContain('candidate_record_count >= 0'); expect(content).toContain('public_removal_artifact_binding_coherent'); expect(content).toContain("state IN ('reserved', 'prepared', 'storage_written', 'completed', 'failed', 'compensation_failed')");
  });
  it('uses fixed search paths, service-role-only RPCs, RLS, and the canonical global lock', () => {
    expect(content).toContain('ENABLE ROW LEVEL SECURITY'); expect(content).toContain('USING (false) WITH CHECK (false)'); expect(content).toContain('REVOKE ALL PRIVILEGES ON TABLE public.public_removal_attempts FROM PUBLIC, anon, authenticated, service_role');
    expect(content.match(/SECURITY DEFINER SET search_path = ''/g)?.length).toBeGreaterThanOrEqual(7); expect(content.match(/controlled_publication_global/g)?.length).toBeGreaterThanOrEqual(7);
    expect(content).toContain('GRANT EXECUTE ON FUNCTION public.finalize_public_removal_attempt(uuid,uuid) TO service_role');
  });
  it('cross-blocks active and compensation-failed publication/removal attempts in both reservation directions', () => {
    const removal = routine('reserve_public_removal_attempt'); const publication = routine('reserve_publication_attempt');
    expect(removal).toContain("FROM public.publication_attempts WHERE state IN ('reserved', 'prepared', 'storage_written', 'compensation_failed')");
    expect(publication).toContain("FROM public.public_removal_attempts WHERE state IN ('reserved', 'prepared', 'storage_written', 'compensation_failed')");
    expect(removal).toContain("v_state = 'compensation_failed'"); expect(publication).toContain("v_removal_state = 'compensation_failed'");
  });
  it('blocks generic published archive without mutation and makes controlled finalization authoritative', () => {
    const review = routine('perform_project_review_action'); const finalize = routine('finalize_public_removal_attempt');
    expect(review).toContain("v_from_status = 'published' AND p_action = 'archive'"); expect(review).toContain("'CONTROLLED_PUBLIC_REMOVAL_REQUIRED'");
    expect(finalize).toContain("SET status = 'archived'"); expect(finalize).toContain("archived_from_status = 'published'"); expect(finalize).toContain('archive_reason = v_attempt.archive_reason'); expect(finalize).toContain('pending_removal_from_public = true'); expect(finalize).toContain('public_removal_completed_at = NULL');
    expect(finalize).toContain("'archive', 'published', 'archived', v_attempt.archive_reason");
    expect(finalize).toContain("EXCEPT SELECT item->>'publicId'");
    expect(finalize).toContain("EXCEPT SELECT p.public_id");
  });
  it('contains no media deletion, Duda, email, or hosted logic', () => {
    expect(content).not.toMatch(/DELETE\s+FROM\s+public\.media_assets|storage\.objects|duda|send.*email|smtp/i);
  });
});
