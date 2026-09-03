import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync, execSync } from 'node:child_process';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';

import { assistiveInspectionResponseSchema } from '../assistive-validation';

import { isLoopbackUrl, parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';

const DB_CONTAINER = 'supabase_db_capstone-impact-platform';
const PIPELINE = 'assistive-deterministic-checks/v1';

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function main(): Promise<void> {
  console.log('=== Assistive Validation Staff Inspection Local Runtime Verification ===');
  const root = path.resolve(__dirname, '../../../..');
  const cli = path.resolve(root, 'node_modules/.bin/supabase');
  const cliEnv = parseSupabaseCliEnv(
    execSync(`"${cli}" status --workdir "${path.resolve(root, 'infra')}" -o env`, {
      cwd: root,
      encoding: 'utf8',
      stdio: 'pipe',
    }),
  );

  assert(
    cliEnv.API_URL && cliEnv.ANON_KEY && cliEnv.SERVICE_ROLE_KEY && isLoopbackUrl(cliEnv.API_URL),
    'Verifier requires loopback Local Supabase.',
  );

  const psql = (sql: string): string =>
    execFileSync(
      'docker',
      ['exec', '-i', DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();

  const service = createClient(cliEnv.API_URL, cliEnv.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anonymous = createClient(cliEnv.API_URL, cliEnv.ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const rpc = async (name: string, parameters: Record<string, unknown> = {}) => {
    const result = await service.rpc(name, parameters);
    assert.ifError(result.error);
    return result.data as Record<string, unknown>;
  };

  const prefix = `assistive-insp-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const actorEmail = `${prefix}@capstone.test`;
  let actorId = '';
  let projectIdA = '';
  let projectIdB = '';
  let seededShapeProjectId = '';
  let passed = 0;
  let primaryFailure: unknown = null;
  let cleanupFailure: unknown = null;

  const scenario = async (number: number, name: string, body: () => Promise<void> | void) => {
    await body();
    passed += 1;
    console.log(`PASS: Scenario ${number} - ${name}`);
  };

  try {
    // Setup synthetic admin actor and projects
    const actor = await service.from('admin_users').insert({
      email: actorEmail,
      full_name: 'Synthetic Assistive Staff Reviewer',
    }).select('id').single();
    assert.ifError(actor.error);
    actorId = String(actor.data!.id);
    assert.ifError((await service.from('user_roles').insert({ user_id: actorId, role: 'reviewer' })).error);

    const projectA = await service.from('projects').insert({
      public_id: `2026-${prefix}-a`,
      title: 'Synthetic Inspection Project A',
      summary: 'Disposable local Phase 5 runtime fixture A.',
      status: 'submitted',
      year: 2026,
      program_name: 'Synthetic Software Engineering',
      discipline: 'Software Engineering',
      group_name: `Group A ${prefix}`,
      team_members: ['Synthetic Reviewer Member A'],
    }).select('id').single();
    assert.ifError(projectA.error);
    projectIdA = String(projectA.data!.id);

    const projectB = await service.from('projects').insert({
      public_id: `2026-${prefix}-b`,
      title: 'Synthetic Inspection Project B',
      summary: 'Disposable local Phase 5 runtime fixture B.',
      status: 'submitted',
      year: 2026,
      program_name: 'Synthetic Software Engineering',
      discipline: 'Software Engineering',
      group_name: `Group B ${prefix}`,
      team_members: ['Synthetic Reviewer Member B'],
    }).select('id').single();
    assert.ifError(projectB.error);
    projectIdB = String(projectB.data!.id);

    const projectBefore = psql(`SELECT to_jsonb(p)::text FROM public.projects p WHERE p.id = '${projectIdA}'::uuid;`);

    // Scenario 1: Exactly 51 migrations are applied
    await scenario(1, 'exactly 51 migrations are applied', () => {
      const count = Number(psql('SELECT count(*) FROM supabase_migrations.schema_migrations;'));
      assert.equal(count, 51, `Expected exactly 51 applied migrations, got ${count}`);
    });

    // Scenario 2: Migration 32 function exists with SECURITY DEFINER, search_path='', exact signature
    await scenario(2, 'Migration 32 function metadata satisfies security invariants', () => {
      const meta = psql(`
        SELECT p.prosecdef::text || '|' || COALESCE(array_to_string(p.proconfig, ','), '')
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname = 'get_project_assistive_validation_inspection';
      `);
      assert.equal(meta, 'true|search_path=""', `Unexpected function metadata: ${meta}`);
    });

    // Scenario 3: PUBLIC cannot EXECUTE
    await scenario(3, 'PUBLIC execute grant is revoked', () => {
      const hasPublic = psql(`
        SELECT has_function_privilege('public', 'public.get_project_assistive_validation_inspection(uuid,text,uuid)', 'EXECUTE');
      `);
      assert.equal(hasPublic, 'f');
    });

    // Scenario 4: anon cannot EXECUTE
    await scenario(4, 'anon execute grant is denied', async () => {
      const anonResult = await anonymous.rpc('get_project_assistive_validation_inspection', {
        p_project_id: projectIdA,
        p_pipeline_version: PIPELINE,
      });
      assert(anonResult.error, 'Anon RPC call unexpectedly succeeded.');
    });

    // Scenario 5: Authenticated browser cannot direct EXECUTE
    await scenario(5, 'authenticated execute grant is denied', () => {
      const hasAuth = psql(`
        SELECT has_function_privilege('authenticated', 'public.get_project_assistive_validation_inspection(uuid,text,uuid)', 'EXECUTE');
      `);
      assert.equal(hasAuth, 'f');
    });

    // Scenario 6: service_role can load project inspection
    await scenario(6, 'service_role can execute inspection RPC', async () => {
      const emptyResult = await rpc('get_project_assistive_validation_inspection', {
        p_project_id: projectIdA,
        p_pipeline_version: PIPELINE,
      });
      assert.equal(emptyResult.resultCode, 'NOT_FOUND');
    });

    // Create queued run for Project A
    const queuedEnqueue = await rpc('enqueue_assistive_validation_run', {
      p_project_id: projectIdA,
      p_actor_admin_id: actorId,
      p_input_hash: hash(`${prefix}-input-1`),
      p_pipeline_version: PIPELINE,
    });
    assert.equal(queuedEnqueue.resultCode, 'ENQUEUED');
    const queuedRunId = queuedEnqueue.runId as string;

    // Scenario 7: Latest QUEUED run is readable
    await scenario(7, 'latest QUEUED run is readable with job status QUEUED', async () => {
      const result = await rpc('get_project_assistive_validation_inspection', {
        p_project_id: projectIdA,
        p_pipeline_version: PIPELINE,
      });
      assert.equal(result.resultCode, 'FOUND');
      const run = result.run as Record<string, unknown>;
      assert.equal(run.runId, queuedRunId);
      assert.equal(run.runStatus, 'QUEUED');
      assert.equal(run.jobStatus, 'QUEUED');
      assert.equal(run.attemptCount, 0);
      assert.deepEqual(result.findings, []);
    });

    // Transition run to RUNNING / EXTRACTING
    const workerId = crypto.randomUUID();
    const claim = await rpc('claim_next_assistive_validation_job', {
      p_worker_id: workerId,
      p_lease_seconds: 120,
    });
    assert.equal(claim.resultCode, 'CLAIMED');
    const claimToken = claim.claimToken as string;

    // Scenario 8: RUNNING / EXTRACTING state is readable
    await scenario(8, 'RUNNING/EXTRACTING state is readable', async () => {
      const result = await rpc('get_project_assistive_validation_inspection', {
        p_project_id: projectIdA,
        p_pipeline_version: PIPELINE,
      });
      assert.equal(result.resultCode, 'FOUND');
      const run = result.run as Record<string, unknown>;
      assert.equal(run.runStatus, 'RUNNING');
      assert.equal(run.jobStatus, 'EXTRACTING');
      assert.equal(run.attemptCount, 1);
    });

    // Complete run with findings
    const findingsPayload = [
      {
        checkType: 'TITLE_CONSISTENCY',
        outcome: 'MISMATCH',
        classification: 'NON_BLOCKING',
        reasonCode: 'MATERIAL_TOKEN_DIFFERENCE',
        affectedField: 'title',
        origin: 'DETERMINISTIC_HELPER',
        scoreKind: 'LEXICAL_SIMILARITY',
        scoreValue: 0.35,
        evidence: {
          version: 'assistive-finding-evidence/v1',
          evidenceExcerpt: 'Deep Reinforcement Learning in Robotics',
          pageNumber: 1,
          boundingBox: null,
          metadataValue: 'Synthetic Inspection Project A',
          normalizedMetadataValue: 'synthetic inspection project a',
          candidateValue: 'Deep Reinforcement Learning in Robotics',
          normalizedCandidateValue: 'deep reinforcement learning in robotics',
          explanation: 'Candidate title differs significantly from project title.',
        },
      },
      {
        checkType: 'FORMATTING',
        outcome: 'INFORMATION',
        classification: 'NON_BLOCKING',
        reasonCode: 'REPEATED_WHITESPACE',
        affectedField: 'extraction_text',
        origin: 'DETERMINISTIC_HELPER',
        scoreKind: null,
        scoreValue: null,
        evidence: {
          version: 'assistive-finding-evidence/v1',
          evidenceExcerpt: 'Multiple   spaces',
          pageNumber: 1,
          boundingBox: null,
          metadataValue: null,
          normalizedMetadataValue: null,
          candidateValue: null,
          normalizedCandidateValue: null,
          explanation: 'Multiple spaces detected.',
        },
      },
    ];

    const completeResult = await rpc('finalize_assistive_validation_job', {
      p_job_id: claim.jobId,
      p_claim_token: claimToken,
      p_input_hash: claim.inputHash,
      p_status: 'COMPLETED',
      p_completion_code: null,
      p_findings: findingsPayload,
    });
    assert.equal(completeResult.resultCode, 'FINALIZED');

    // Scenario 9: COMPLETED run + findings is readable
    await scenario(9, 'COMPLETED run + findings is readable', async () => {
      const result = await rpc('get_project_assistive_validation_inspection', {
        p_project_id: projectIdA,
        p_pipeline_version: PIPELINE,
      });
      assert.equal(result.resultCode, 'FOUND');
      const run = result.run as Record<string, unknown>;
      assert.equal(run.runStatus, 'COMPLETED');
      assert.equal(run.jobStatus, 'COMPLETED');
      const findings = result.findings as Array<Record<string, unknown>>;
      assert.equal(findings.length, 2);
    });

    // Scenario 10: PARTIAL run + findings is readable
    const partialEnqueue = await rpc('enqueue_assistive_validation_run', {
      p_project_id: projectIdA,
      p_actor_admin_id: actorId,
      p_input_hash: hash(`${prefix}-input-2`),
      p_pipeline_version: PIPELINE,
    });
    assert.equal(partialEnqueue.resultCode, 'ENQUEUED');
    const partialRunId = partialEnqueue.runId as string;
    const partialClaim = await rpc('claim_next_assistive_validation_job', {
      p_worker_id: crypto.randomUUID(),
      p_lease_seconds: 120,
    });
    assert.equal(partialClaim.resultCode, 'CLAIMED');
    const partialFinalize = await rpc('finalize_assistive_validation_job', {
      p_job_id: partialClaim.jobId,
      p_claim_token: partialClaim.claimToken,
      p_input_hash: partialClaim.inputHash,
      p_status: 'PARTIAL',
      p_completion_code: 'OCR_REQUIRED',
      p_findings: [findingsPayload[1]],
    });
    assert.equal(partialFinalize.resultCode, 'FINALIZED');

    await scenario(10, 'PARTIAL run + failure code is readable', async () => {
      const result = await rpc('get_project_assistive_validation_inspection', {
        p_project_id: projectIdA,
        p_pipeline_version: PIPELINE,
        p_run_id: partialRunId,
      });
      assert.equal(result.resultCode, 'FOUND');
      const run = result.run as Record<string, unknown>;
      assert.equal(run.runStatus, 'PARTIAL');
      assert.equal(run.jobStatus, 'PARTIAL');
      assert.equal(run.failureCode, 'OCR_REQUIRED');
    });

    // Scenario 11: FAILED run is readable
    const failedEnqueue = await rpc('enqueue_assistive_validation_run', {
      p_project_id: projectIdA,
      p_actor_admin_id: actorId,
      p_input_hash: hash(`${prefix}-input-3`),
      p_pipeline_version: PIPELINE,
    });
    assert.equal(failedEnqueue.resultCode, 'ENQUEUED');
    const failedRunId = failedEnqueue.runId as string;
    const failedClaim = await rpc('claim_next_assistive_validation_job', {
      p_worker_id: crypto.randomUUID(),
      p_lease_seconds: 120,
    });
    assert.equal(failedClaim.resultCode, 'CLAIMED');
    const failResult = await rpc('record_assistive_validation_job_failure', {
      p_job_id: failedClaim.jobId,
      p_claim_token: failedClaim.claimToken,
      p_failure_code: 'EXTRACTION_FAILED',
    });
    assert.equal(failResult.resultCode, 'FAILED');

    await scenario(11, 'FAILED run is readable with failure code', async () => {
      const result = await rpc('get_project_assistive_validation_inspection', {
        p_project_id: projectIdA,
        p_pipeline_version: PIPELINE,
        p_run_id: failedRunId,
      });
      assert.equal(result.resultCode, 'FOUND');
      const run = result.run as Record<string, unknown>;
      assert.equal(run.runStatus, 'FAILED');
      assert.equal(run.jobStatus, 'FAILED');
      assert.equal(run.failureCode, 'EXTRACTION_FAILED');
    });

    // Scenario 12: Explicit valid runId belonging to project returns FOUND
    await scenario(12, 'explicit valid runId returns FOUND', async () => {
      const result = await rpc('get_project_assistive_validation_inspection', {
        p_project_id: projectIdA,
        p_pipeline_version: PIPELINE,
        p_run_id: queuedRunId,
      });
      assert.equal(result.resultCode, 'FOUND');
      const run = result.run as Record<string, unknown>;
      assert.equal(run.runId, queuedRunId);
    });

    // Scenario 13: runId belonging to another project returns NOT_FOUND
    await scenario(13, 'runId belonging to another project returns NOT_FOUND', async () => {
      const result = await rpc('get_project_assistive_validation_inspection', {
        p_project_id: projectIdB,
        p_pipeline_version: PIPELINE,
        p_run_id: queuedRunId,
      });
      assert.equal(result.resultCode, 'NOT_FOUND');
    });

    // Scenario 14: Pipeline mismatch returns NOT_FOUND
    await scenario(14, 'pipeline version mismatch returns NOT_FOUND', async () => {
      const result = await rpc('get_project_assistive_validation_inspection', {
        p_project_id: projectIdA,
        p_pipeline_version: 'assistive-deterministic-checks/v2',
        p_run_id: queuedRunId,
      });
      assert.equal(result.resultCode, 'NOT_FOUND');
    });

    // Scenario 15: Findings are returned in ordinal order
    await scenario(15, 'findings are returned in strict ordinal order', async () => {
      const result = await rpc('get_project_assistive_validation_inspection', {
        p_project_id: projectIdA,
        p_pipeline_version: PIPELINE,
        p_run_id: queuedRunId,
      });
      const findings = result.findings as Array<Record<string, unknown>>;
      assert.equal(findings.length, 2);
      assert.equal(findings[0].ordinal, 1);
      assert.equal(findings[1].ordinal, 2);
    });

    // Scenario 16, 17, 18, 19, 20: Secrets & Internal Token Omission & Privacy Invariant
    await scenario(16, 'no claimToken is returned in inspection JSON', async () => {
      const json = JSON.stringify(await rpc('get_project_assistive_validation_inspection', {
        p_project_id: projectIdA,
        p_pipeline_version: PIPELINE,
        p_run_id: queuedRunId,
      }));
      assert.equal(json.includes('claimToken'), false);
      assert.equal(json.includes(claimToken), false);
    });

    await scenario(17, 'no workerId is returned', async () => {
      const json = JSON.stringify(await rpc('get_project_assistive_validation_inspection', {
        p_project_id: projectIdA,
        p_pipeline_version: PIPELINE,
        p_run_id: queuedRunId,
      }));
      assert.equal(json.includes(workerId), false);
      assert.equal(json.includes('workerId'), false);
    });

    await scenario(18, 'no lease timestamp is returned', async () => {
      const json = JSON.stringify(await rpc('get_project_assistive_validation_inspection', {
        p_project_id: projectIdA,
        p_pipeline_version: PIPELINE,
        p_run_id: queuedRunId,
      }));
      assert.equal(json.includes('lease_until'), false);
      assert.equal(json.includes('leaseUntil'), false);
    });

    await scenario(19, 'no private bucket or storage path is returned', async () => {
      const json = JSON.stringify(await rpc('get_project_assistive_validation_inspection', {
        p_project_id: projectIdA,
        p_pipeline_version: PIPELINE,
        p_run_id: queuedRunId,
      }));
      assert.equal(json.includes('synthetic/poster1.pdf'), false);
      assert.equal(json.includes('posterDocumentPath'), false);
    });

    await scenario(20, 'no reviewedBy or reviewedAt audit data is returned (Privacy Invariant)', async () => {
      // Record disposition first to put both durable audit fields into the Phase 3 table.
      const rawFindings = psql(`SELECT id FROM public.assistive_validation_findings WHERE run_id = '${queuedRunId}'::uuid LIMIT 1;`);
      const findingId = rawFindings.trim();
      assert(findingId);
      await rpc('record_assistive_finding_disposition', {
        p_finding_id: findingId,
        p_actor_admin_id: actorId,
        p_disposition: 'REVIEWED',
      });
      const durableAudit = psql(`SELECT (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)::text FROM public.assistive_validation_findings WHERE id = '${findingId}'::uuid;`);
      assert.equal(durableAudit, 'true', 'Phase 3 reviewer attribution was not durably recorded.');

      const inspection = await rpc('get_project_assistive_validation_inspection', {
        p_project_id: projectIdA,
        p_pipeline_version: PIPELINE,
        p_run_id: queuedRunId,
      });
      const json = JSON.stringify(inspection);
      assert.equal(json.includes('reviewedBy'), false, 'reviewedBy unexpectedly returned in JSON');
      assert.equal(json.includes('reviewedAt'), false, 'reviewedAt unexpectedly returned in JSON');
      assert.equal(json.includes(actorId), false, 'actorId UUID unexpectedly returned in JSON');
    });

    // Scenario 21: Direct table grants remain denied
    await scenario(21, 'direct table grants remain denied for anon and authenticated', () => {
      const tables = ['assistive_validation_runs', 'assistive_validation_jobs', 'assistive_validation_findings'];
      for (const t of tables) {
        const anonSelect = psql(`SELECT has_table_privilege('anon', 'public.${t}', 'SELECT');`);
        const authSelect = psql(`SELECT has_table_privilege('authenticated', 'public.${t}', 'SELECT');`);
        assert.equal(anonSelect, 'f', `anon has select on ${t}`);
        assert.equal(authSelect, 'f', `authenticated has select on ${t}`);
      }
    });

    // Scenario 22: Read performs no project or workflow mutation
    await scenario(22, 'read performs zero project/workflow mutations', async () => {
      await rpc('get_project_assistive_validation_inspection', {
        p_project_id: projectIdA,
        p_pipeline_version: PIPELINE,
      });
      const projectAfter = psql(`SELECT to_jsonb(p)::text FROM public.projects p WHERE p.id = '${projectIdA}'::uuid;`);
      assert.equal(projectBefore, projectAfter, 'Project row unexpectedly mutated by inspection read.');
    });

    // Scenario 23: Data integrity invariants - missing job returns INVARIANT_VIOLATION
    await scenario(23, 'missing job row returns INVARIANT_VIOLATION (no fabricated job state)', async () => {
      // Temporarily insert a run without a job via direct superuser with triggers disabled
      const orphanRunId = crypto.randomUUID();
      psql(`
        ALTER TABLE public.assistive_validation_runs DISABLE TRIGGER USER;
        INSERT INTO public.assistive_validation_runs (id, project_id, input_hash, pipeline_version, status, requested_by)
        VALUES ('${orphanRunId}'::uuid, '${projectIdA}'::uuid, '${hash('orphan')}', '${PIPELINE}', 'QUEUED', '${actorId}'::uuid);
        ALTER TABLE public.assistive_validation_runs ENABLE TRIGGER USER;
      `);
      const result = await rpc('get_project_assistive_validation_inspection', {
        p_project_id: projectIdA,
        p_pipeline_version: PIPELINE,
        p_run_id: orphanRunId,
      });
      assert.equal(result.resultCode, 'INVARIANT_VIOLATION');
    });

    // Scenario 24: The database itself refuses a 51st finding, which is what makes the RPC bound
    // real rather than merely defensive. Forcing 51 committed rows would require dropping a CHECK
    // constraint on a shared local database, so the write-side guarantee is asserted instead.
    await scenario(24, 'database refuses a finding beyond the bounded fifty per run', () => {
      let rejected = false;
      try {
        psql(`
          INSERT INTO public.assistive_validation_findings
            (run_id, check_type, outcome, classification, reason_code, affected_field, origin, ordinal, evidence)
          VALUES ('${queuedRunId}'::uuid, 'TITLE_CONSISTENCY', 'REVIEW', 'NON_BLOCKING',
                  'POSSIBLE_OCR_OR_SPELLING_VARIANT', 'title', 'PHASE_1_EXTRACTION', 51,
                  '{"version":"assistive-finding-evidence/v1","explanation":"over the bound"}'::jsonb);
        `);
      } catch {
        rejected = true;
      }
      assert.equal(rejected, true, 'Ordinal 51 was accepted; the fifty-finding bound is not enforced.');
      assert.equal(
        psql(`SELECT count(*) > 50 FROM public.assistive_validation_findings WHERE run_id = '${queuedRunId}'::uuid;`),
        'f',
      );
    });

    // Scenario 25: A retryable failure re-queues the run with a NULL failure_code while the job
    // keeps last_error_code as attempt telemetry. The inspection must report the run's own state
    // rather than coalescing the two, or a healthy in-flight retry reads as a failure to staff.
    await scenario(25, 'retry-queued run reports no failure code', async () => {
      const retryEnqueue = await rpc('enqueue_assistive_validation_run', {
        p_project_id: projectIdB,
        p_actor_admin_id: actorId,
        p_input_hash: hash(`${prefix}-retry`),
        p_pipeline_version: PIPELINE,
      });
      assert.equal(retryEnqueue.resultCode, 'ENQUEUED');
      const retryClaim = await rpc('claim_next_assistive_validation_job', {
        p_worker_id: crypto.randomUUID(),
        p_lease_seconds: 120,
      });
      assert.equal(retryClaim.resultCode, 'CLAIMED');
      const retried = await rpc('record_assistive_validation_job_failure', {
        p_job_id: retryClaim.jobId,
        p_claim_token: retryClaim.claimToken,
        p_failure_code: 'WORKER_TIMEOUT',
      });
      assert.equal(retried.resultCode, 'RETRY_QUEUED');

      const jobError = psql(`SELECT COALESCE(last_error_code, '<null>') FROM public.assistive_validation_jobs WHERE id = '${retryClaim.jobId}'::uuid;`);
      assert.equal(jobError, 'WORKER_TIMEOUT', 'Job attempt telemetry was expected to retain the error.');

      const result = await rpc('get_project_assistive_validation_inspection', {
        p_project_id: projectIdB,
        p_pipeline_version: PIPELINE,
        p_run_id: retryEnqueue.runId,
      });
      assert.equal(result.resultCode, 'FOUND');
      const run = result.run as Record<string, unknown>;
      assert.equal(run.runStatus, 'QUEUED');
      assert.equal(run.jobStatus, 'QUEUED');
      assert.equal(run.failureCode, null, 'A re-queued run must not advertise a failure code.');
    });

    // Scenario 26: End-to-end through the TypeScript contract using a project identifier shaped
    // like the repository seed (canonical UUID text with no RFC version nibble). Every other
    // scenario asserts raw RPC JSON and inserts fixtures that receive gen_random_uuid(), so none of
    // them exercise the parsing layer the browser actually depends on.
    await scenario(26, 'seeded-shape project id parses through the browser-facing contract', async () => {
      const seededShapeId = 'e0000000-0000-0000-0000-0000000000ff';
      seededShapeProjectId = seededShapeId;
      assert.equal(
        z.uuid().safeParse(seededShapeId).success,
        false,
        'Fixture no longer represents the seed shape this scenario exists to cover.',
      );

      psql(`
        INSERT INTO public.projects (id, public_id, title, summary, status, year, program_name, discipline, group_name, team_members)
        VALUES ('${seededShapeId}'::uuid, '2026-${prefix}-seedshape', 'Synthetic Seed-Shape Project',
                'Disposable fixture mirroring infra/supabase/seed.sql identity shape.', 'submitted', 2026,
                'Synthetic Software Engineering', 'Software Engineering', 'Seed Shape ${prefix}',
                ARRAY['Synthetic Member']);
      `);

      const seededEnqueue = await rpc('enqueue_assistive_validation_run', {
        p_project_id: seededShapeId,
        p_actor_admin_id: actorId,
        p_input_hash: hash(`${prefix}-seedshape`),
        p_pipeline_version: PIPELINE,
      });
      assert.equal(seededEnqueue.resultCode, 'ENQUEUED');

      const raw = await rpc('get_project_assistive_validation_inspection', {
        p_project_id: seededShapeId,
        p_pipeline_version: PIPELINE,
      });
      const parsed = assistiveInspectionResponseSchema.safeParse(raw);
      assert.equal(
        parsed.success,
        true,
        `Browser-facing contract rejected a seeded-shape project: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`,
      );
      assert.equal(parsed.success && parsed.data.resultCode, 'FOUND');
      if (parsed.success && parsed.data.resultCode === 'FOUND') {
        assert.equal(parsed.data.run.projectId, seededShapeId);
      }
    });

  } catch (error: unknown) {
    primaryFailure = error;
  } finally {
    try {
      if (projectIdA) {
        psql(`
          DELETE FROM public.assistive_validation_findings WHERE run_id IN (SELECT id FROM public.assistive_validation_runs WHERE project_id = '${projectIdA}'::uuid);
          DELETE FROM public.assistive_validation_jobs WHERE run_id IN (SELECT id FROM public.assistive_validation_runs WHERE project_id = '${projectIdA}'::uuid);
          DELETE FROM public.assistive_validation_runs WHERE project_id = '${projectIdA}'::uuid;
          DELETE FROM public.projects WHERE id = '${projectIdA}'::uuid;
        `);
      }
      if (projectIdB) {
        psql(`
          DELETE FROM public.assistive_validation_findings WHERE run_id IN (SELECT id FROM public.assistive_validation_runs WHERE project_id = '${projectIdB}'::uuid);
          DELETE FROM public.assistive_validation_jobs WHERE run_id IN (SELECT id FROM public.assistive_validation_runs WHERE project_id = '${projectIdB}'::uuid);
          DELETE FROM public.assistive_validation_runs WHERE project_id = '${projectIdB}'::uuid;
          DELETE FROM public.projects WHERE id = '${projectIdB}'::uuid;
        `);
      }
      if (seededShapeProjectId) {
        psql(`
          DELETE FROM public.assistive_validation_findings WHERE run_id IN (SELECT id FROM public.assistive_validation_runs WHERE project_id = '${seededShapeProjectId}'::uuid);
          DELETE FROM public.assistive_validation_jobs WHERE run_id IN (SELECT id FROM public.assistive_validation_runs WHERE project_id = '${seededShapeProjectId}'::uuid);
          DELETE FROM public.assistive_validation_runs WHERE project_id = '${seededShapeProjectId}'::uuid;
          DELETE FROM public.projects WHERE id = '${seededShapeProjectId}'::uuid;
        `);
      }
      if (actorId) {
        psql(`
          DELETE FROM public.user_roles WHERE user_id = '${actorId}'::uuid;
          DELETE FROM public.admin_users WHERE id = '${actorId}'::uuid;
        `);
      }
    } catch (cleanupErr: unknown) {
      cleanupFailure = cleanupErr;
    }
  }

  if (primaryFailure) {
    console.error('FAIL: Assistive staff inspection runtime verification failed:', primaryFailure);
    process.exit(1);
  }
  if (cleanupFailure) {
    console.error('FAIL: Assistive staff inspection cleanup failed:', cleanupFailure);
    process.exit(1);
  }

  console.log(`\nALL ${passed} SCENARIOS PASSED for Assistive Validation Staff Inspection local runtime verification.`);
}

main().catch((err) => {
  console.error('Unexpected fatal error:', err);
  process.exit(1);
});
