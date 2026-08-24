import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { EXPECTED_MIGRATION_FILENAMES } from '../scripts/onboardingCheck';

describe('assistive validation job coordination migration contract', () => {
  const root = path.resolve(__dirname, '../../../..');
  const migrations = path.join(root, 'infra/supabase/migrations');
  const filename = '20260820160000_assistive_validation_job_coordination.sql';
  const content = fs.readFileSync(path.join(migrations, filename), 'utf8').replace(/\r\n/g, '\n');
  const executable = content.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
  const compact = executable.replace(/\s+/g, ' ');

  it('is exactly migration 0031 and preserves all thirty inherited migrations byte-for-byte', () => {
    const files = fs.readdirSync(migrations).filter((file) => file.endsWith('.sql')).sort();
    expect(files).toEqual([...EXPECTED_MIGRATION_FILENAMES]);
    expect(files).toHaveLength(35);
    expect(files[30]).toBe(filename);
    expect(() => execFileSync(
      'git',
      ['diff', '--exit-code', 'origin/main', '--', ...files.slice(0, 30).map(
        (inherited) => `infra/supabase/migrations/${inherited}`,
      )],
      { cwd: root, stdio: 'pipe' },
    )).not.toThrow();
  });

  it('documents the exact canonical Migration 0031 filename and hash', () => {
    const digest = crypto.createHash('sha256').update(content).digest('hex');
    const documentation = fs.readFileSync(
      path.join(root, 'docs/assistive-validation/phase-4-async-job-coordination.md'),
      'utf8',
    );
    expect(documentation).toContain(filename);
    expect(documentation).toContain(digest);
  });

  it('keeps the side domain non-authoritative and uses PostgreSQL as its only queue', () => {
    expect(executable).not.toMatch(
      /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+public\.(projects|media_assets|approval_records|published_snapshots|validation_flags|import_batches)\b/i,
    );
    expect(executable).not.toMatch(/\b(NOTIFY|LISTEN|pg_cron|rabbit|kafka|redis|sqs|pubsub)\b/i);
    expect(compact).toContain('CREATE TABLE public.assistive_validation_jobs');
  });

  it('defines the complete bounded run and job lifecycle', () => {
    for (const state of ['QUEUED', 'RUNNING', 'PARTIAL', 'COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED']) {
      expect(executable).toContain(`'${state}'`);
    }
    expect(compact).toContain('CONSTRAINT uq_assistive_validation_jobs_run UNIQUE (run_id)');
    expect(compact).toContain('CREATE UNIQUE INDEX uq_assistive_validation_runs_active_identity');
    expect(compact).toContain("WHERE status IN ('QUEUED', 'RUNNING')");
    expect(compact).toContain('CREATE CONSTRAINT TRIGGER assistive_validation_runs_job_pair');
    expect(compact).toContain('CREATE CONSTRAINT TRIGGER assistive_validation_jobs_run_pair');
    expect(compact).toContain("RAISE EXCEPTION 'assistive run/job lifecycle mismatch'");
  });

  it('creates exactly one matching job even for the unchanged Phase 3 insert path', () => {
    expect(compact).toContain('CREATE TRIGGER assistive_validation_runs_create_job AFTER INSERT ON public.assistive_validation_runs');
    expect(compact).toContain('INSERT INTO public.assistive_validation_jobs');
    expect(compact).toContain('NEW.status');
    expect(compact).toContain('NEW.failure_code');
    expect(compact).toContain('REFERENCES public.assistive_validation_runs(id) ON DELETE CASCADE');
  });

  it('backfills every pre-existing Phase 3 run before pair coherence becomes authoritative', () => {
    const table = compact.indexOf('CREATE TABLE public.assistive_validation_jobs');
    const backfill = compact.indexOf('INSERT INTO public.assistive_validation_jobs', table);
    const insertTrigger = compact.indexOf('CREATE OR REPLACE FUNCTION public.create_assistive_validation_job_for_run');
    const pairConstraints = compact.indexOf('CREATE CONSTRAINT TRIGGER assistive_validation_runs_job_pair');
    const statement = compact.slice(backfill, insertTrigger);

    expect(table).toBeGreaterThan(-1);
    expect(backfill).toBeGreaterThan(table);
    expect(insertTrigger).toBeGreaterThan(backfill);
    expect(pairConstraints).toBeGreaterThan(insertTrigger);
    expect(statement).toContain('SELECT r.id, r.status, 0, r.created_at, r.failure_code, NULL, NULL FROM public.assistive_validation_runs AS r');
    expect(statement).not.toContain('ON CONFLICT');
  });

  it('claims fairly with skip-locked leases, two attempts, and rotating database tokens', () => {
    expect(compact).toContain('FOR UPDATE SKIP LOCKED LIMIT 1');
    expect(compact).toContain('ORDER BY j.available_at, j.created_at, j.id');
    expect(compact).toContain('p_lease_seconds integer DEFAULT 120');
    expect(compact).toContain('v_lease_seconds NOT BETWEEN 30 AND 180');
    expect(compact).toContain('attempt_count BETWEEN 0 AND 2');
    expect(compact).toContain('IF v_job.attempt_count >= 2 THEN');
    expect(compact).toContain('v_token := gen_random_uuid()');
    expect(compact).toContain('claim_token = v_token');
    expect(compact).toContain('attempt_count = attempt_count + 1');
  });

  it('fences every claimed mutation by token, active state, row lock, and unexpired lease', () => {
    for (const signature of [
      'heartbeat_assistive_validation_job',
      'advance_assistive_validation_job_stage',
      'supersede_assistive_validation_job',
      'record_assistive_validation_job_failure',
      'finalize_assistive_validation_job',
    ]) {
      const start = executable.indexOf(`CREATE OR REPLACE FUNCTION public.${signature}`);
      const end = executable.indexOf('\n$$;', start);
      const body = executable.slice(start, end).replace(/\s+/g, ' ');
      expect(start).toBeGreaterThan(-1);
      expect(body).toContain('FOR UPDATE');
      expect(body).toContain('claim_token IS DISTINCT FROM p_claim_token');
      expect(body).toContain('lease_until <= v_now');
      if (signature === 'advance_assistive_validation_job_stage') {
        expect(body).toContain("status <> 'EXTRACTING'");
      } else {
        expect(body).toContain("status NOT IN ('EXTRACTING', 'CHECKING')");
      }
    }
  });

  it('serializes cancellation and finalization on the same job row', () => {
    const cancellation = compact.indexOf('CREATE OR REPLACE FUNCTION public.request_assistive_validation_cancellation');
    const finalization = compact.indexOf('CREATE OR REPLACE FUNCTION public.finalize_assistive_validation_job');
    expect(compact.slice(cancellation, finalization)).toContain('FOR UPDATE');
    expect(compact.slice(finalization)).toContain('FOR UPDATE');
    expect(compact.slice(finalization)).toContain('v_job.cancellation_requested_at IS NOT NULL');
    expect(compact.slice(finalization)).toContain("SET status = 'CANCELLED'");
  });

  it('validates then atomically stores findings and the terminal pair', () => {
    expect(compact).toContain('public.is_valid_assistive_validation_findings(p_findings)');
    expect(compact).toContain("(v_finding - v_finding_keys) <> '{}'::jsonb");
    expect(compact).toContain("(v_evidence - v_evidence_keys) <> '{}'::jsonb");
    expect(compact).toContain('INSERT INTO public.assistive_validation_findings');
    expect(compact).toContain('pg_advisory_xact_lock');
    expect(compact).toContain("'resultCode', 'IDENTITY_CONFLICT'");
    expect(compact).toContain("'resultCode', 'ALREADY_COMPLETED'");
    for (const field of [
      'metadataValue', 'normalizedMetadataValue', 'candidateValue', 'normalizedCandidateValue',
    ]) {
      expect(compact).toContain(`(v_evidence ->> '${field}') ~ U&'[\\0001-\\0008\\000B\\000C\\000E-\\001F\\007F]'`);
    }
  });

  it('fails direct access closed and grants only bounded RPC execution to service_role', () => {
    expect(compact).toContain('ALTER TABLE public.assistive_validation_jobs ENABLE ROW LEVEL SECURITY');
    expect(compact).toContain('CREATE POLICY deny_assistive_validation_jobs_direct_access');
    expect(compact).toContain('REVOKE ALL PRIVILEGES ON TABLE public.assistive_validation_jobs FROM PUBLIC, anon, authenticated, service_role');
    expect(executable).not.toMatch(/GRANT\s+(SELECT|INSERT|UPDATE|DELETE|ALL)[^;]*assistive_validation_jobs/i);
    expect(executable).not.toMatch(/GRANT\s+EXECUTE[^;]*TO\s+(PUBLIC|anon|authenticated)/i);
    expect(executable.match(/GRANT EXECUTE ON FUNCTION/g)).toHaveLength(11);
  });

  it('keeps the legacy latest-run reader on its original terminal result states', () => {
    const start = compact.indexOf('CREATE OR REPLACE FUNCTION public.get_latest_assistive_validation_run');
    expect(compact.slice(start)).toContain("r.status = 'COMPLETED' OR (r.status = 'FAILED' AND r.failure_code IN ( 'EXTRACTION_CONTRACT_REJECTED', 'EXTRACTION_FAILED', 'INTERNAL_FAILURE' ))");
  });
});
