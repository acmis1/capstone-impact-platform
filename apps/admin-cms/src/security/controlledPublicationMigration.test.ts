import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../../..');
const migrationDir = path.join(root, 'infra/supabase/migrations');
const migration = '20260812120000_controlled_publication_execution.sql';
const content = fs.readFileSync(path.join(migrationDir, migration), 'utf8').replace(/\r\n/g, '\n');

describe('Migration 0019 controlled publication execution security contract', () => {
  it('is exactly migration 0019 and leaves migrations 0001-0018 byte-for-byte unchanged from inherited main', () => {
    const files = fs.readdirSync(migrationDir).filter((file) => file.endsWith('.sql')).sort();
    expect(files).toHaveLength(19);
    expect(files[18]).toBe(migration);
    for (const file of files.slice(0, 18)) {
      const local = fs.readFileSync(path.join(migrationDir, file), 'utf8').replace(/\r\n/g, '\n');
      const inherited = execFileSync('git', ['show', `83e8fbcda747cf57a8ac45c53f540a59a16fb814:infra/supabase/migrations/${file}`], { cwd: root, encoding: 'utf8' }).replace(/\r\n/g, '\n');
      expect(crypto.createHash('sha256').update(local).digest('hex')).toBe(crypto.createHash('sha256').update(inherited).digest('hex'));
    }
  });

  it('defines a strongly constrained durable attempt ledger and exact evidence binding', () => {
    expect(content).toContain('CREATE TABLE public.publication_attempts');
    for (const field of ['project_id', 'public_id', 'admin_id', 'confirmed_preview_id', 'confirmed_at', 'candidate_record_count', 'candidate_feed_hash', 'candidate_feed_content', 'media_manifest', 'published_snapshot_id', 'failure_code']) {
      expect(content).toContain(field);
    }
    expect(content).toContain("state IN ('prepared', 'storage_written', 'completed', 'failed', 'compensation_failed')");
    expect(content).toContain("candidate_feed_hash ~ '^[0-9a-f]{64}$'");
    expect(content).toContain('publication_attempt_terminal_state_coherent');
  });

  it('globally serializes active attempts with a database-backed partial unique invariant and consistent locks', () => {
    expect(content).toMatch(/CREATE UNIQUE INDEX publication_attempts_one_active_global_idx[\s\S]*?ON public\.publication_attempts \(\(true\)\)[\s\S]*?WHERE state IN \('prepared', 'storage_written', 'compensation_failed'\)/);
    const globalLock = "pg_advisory_xact_lock(pg_catalog.hashtext('controlled_publication_global'))";
    expect(content.split(globalLock).length - 1).toBeGreaterThanOrEqual(5);
    const begin = content.indexOf('CREATE OR REPLACE FUNCTION public.begin_publication_attempt');
    const lock = content.indexOf(globalLock, begin);
    const readiness = content.indexOf('public.get_project_publication_readiness', begin);
    expect(lock).toBeGreaterThan(begin);
    expect(readiness).toBeGreaterThan(lock);
  });

  it('uses service-role-only hardened RPCs and prevents direct attempt mutations', () => {
    for (const fn of ['begin_publication_attempt', 'claim_publication_attempt', 'mark_publication_attempt_storage_written', 'finalize_publication_attempt', 'fail_publication_attempt']) {
      expect(content).toContain(`CREATE OR REPLACE FUNCTION public.${fn}`);
      expect(content).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([\\s\\S]*?FROM PUBLIC, anon, authenticated;`));
      expect(content).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([\\s\\S]*?TO service_role;`));
    }
    expect(content).toContain("SET search_path = ''");
    expect(content).toContain('REVOKE ALL PRIVILEGES ON TABLE public.publication_attempts FROM PUBLIC, anon, authenticated, service_role;');
    expect(content).toContain('GRANT SELECT ON TABLE public.publication_attempts TO service_role;');
    expect(content).toContain('REVOKE ALL ON FUNCTION public.normalize_public_media_mapping() FROM PUBLIC, anon, authenticated, service_role;');
    expect(content).toContain('REVOKE ALL ON FUNCTION public.guard_active_publication_attempt() FROM PUBLIC, anon, authenticated, service_role;');
  });

  it('freezes every readiness-sensitive mutation path while an attempt is active', () => {
    for (const table of ['projects', 'media_assets', 'participant_previews', 'participant_preview_confirmations', 'participant_preview_correction_requests', 'project_disciplines', 'project_industry_categories']) {
      expect(content).toMatch(new RegExp(`BEFORE INSERT OR UPDATE OR DELETE ON public\\.${table}|BEFORE UPDATE OR DELETE ON public\\.${table}`));
    }
    expect(content).toContain("RAISE EXCEPTION 'PUBLICATION_IN_PROGRESS'");
  });

  it('atomically finalizes exact publish audit, snapshot, media mapping, project status, and completed attempt', () => {
    const finalize = content.slice(content.indexOf('CREATE OR REPLACE FUNCTION public.finalize_publication_attempt'));
    expect(finalize).toContain("SET status = 'published'");
    expect(finalize).toContain("'publish', 'approved', 'published'");
    expect(finalize).toContain('INSERT INTO public.published_snapshots');
    expect(finalize).toContain("SET state = 'completed'");
    expect(finalize).toContain('published_snapshot_id = v_snapshot_id');
    expect(finalize).toContain('publish_audit_record_id = v_audit_id');
    expect(finalize).toContain('public_storage_bucket');
    expect(finalize).toContain('public_storage_path');
  });
});
