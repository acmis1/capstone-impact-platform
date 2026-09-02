import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync, execSync } from 'node:child_process';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

import { isLoopbackUrl, parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';

const DB_CONTAINER = 'supabase_db_capstone-impact-platform';
const PIPELINE = 'assistive-deterministic-checks/v1';
const LANGUAGE_PIPELINE = 'assistive-deterministic-checks/v3';
const FINDING = {
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
    evidenceExcerpt: 'Synthetic  spacing',
    pageNumber: null,
    boundingBox: null,
    metadataValue: null,
    normalizedMetadataValue: null,
    candidateValue: null,
    normalizedCandidateValue: null,
    explanation: 'Synthetic bounded Phase 4 runtime finding.',
  },
};

const languageFinding = (inputHash: string) => ({
  checkType: 'LANGUAGE_SUGGESTION', outcome: 'REVIEW', classification: 'NON_BLOCKING',
  reasonCode: 'LANGUAGE_SPELLING', affectedField: 'summary', origin: 'LOCAL_LANGUAGE_PROVIDER',
  scoreKind: null, scoreValue: null,
  evidence: {
    version: 'assistive-finding-evidence/v3', startOffset: 2, endOffset: 9,
    offsetUnit: 'UNICODE_CODE_POINTS', originalSourceSpan: 'recieve',
    contextExcerpt: 'A recieve update.', languageCategory: 'TYPOS',
    ruleId: 'MORFOLOGIK_RULE_EN_AU', providerId: 'LANGUAGETOOL', providerVersion: '6.6',
    suggestions: ['receive'], explanation: 'Review this possible spelling issue.',
    inputHash, pipelineVersion: LANGUAGE_PIPELINE,
    policySha256: '3984b958741a5103791524d48ba262a81ef829695ddc122a728c12cc3e689148',
  },
});

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function main(): Promise<void> {
  console.log('=== Assistive Validation Job Coordination Local Runtime Verification ===');
  const root = path.resolve(__dirname, '../../../..');
  const cli = path.resolve(root, 'node_modules/.bin/supabase');
  const cliEnv = parseSupabaseCliEnv(execSync(
    `"${cli}" status --workdir "${path.resolve(root, 'infra')}" -o env`,
    { cwd: root, encoding: 'utf8', stdio: 'pipe' },
  ));
  assert(
    cliEnv.API_URL && cliEnv.ANON_KEY && cliEnv.SERVICE_ROLE_KEY && isLoopbackUrl(cliEnv.API_URL),
    'Verifier requires loopback Local Supabase.',
  );
  const psql = (sql: string): string => execFileSync(
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

  const prefix = `assistive-job-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const actorEmail = `${prefix}@capstone.test`;
  let actorId = '';
  let projectId = '';
  let passed = 0;
  let primaryFailure: unknown = null;
  let cleanupFailure: unknown = null;
  const scenario = async (number: number, name: string, body: () => Promise<void> | void) => {
    await body();
    passed += 1;
    console.log(`PASS: Scenario ${number} - ${name}`);
  };

  try {
    const actor = await service.from('admin_users').insert({
      email: actorEmail,
      full_name: 'Synthetic Assistive Coordinator',
    }).select('id').single();
    assert.ifError(actor.error);
    actorId = String(actor.data!.id);
    assert.ifError((await service.from('user_roles').insert({ user_id: actorId, role: 'editor' })).error);
    const project = await service.from('projects').insert({
      public_id: `2026-${prefix}`,
      title: 'Synthetic Async Assistive Project',
      summary: 'Disposable local Phase 4 runtime fixture.',
      status: 'draft',
      year: 2026,
      program_name: 'Synthetic Software Engineering',
      discipline: 'Software Engineering',
      group_name: `Group ${prefix}`,
      team_members: ['Synthetic Member'],
    }).select('id').single();
    assert.ifError(project.error);
    projectId = String(project.data!.id);
    const projectBefore = psql(`SELECT to_jsonb(p)::text FROM public.projects p WHERE p.id = '${projectId}'::uuid;`);
    const approvalBefore = psql(`SELECT count(*) FROM public.approval_records WHERE project_id = '${projectId}'::uuid;`);
    const flagsBefore = psql(`SELECT count(*) FROM public.validation_flags WHERE project_id = '${projectId}'::uuid;`);
    const snapshotsBefore = psql('SELECT count(*) FROM public.published_snapshots;');

    await scenario(1, 'migrations 0031-0033 and all three assistive tables are live', () => {
      assert.equal(psql('SELECT count(*) FROM supabase_migrations.schema_migrations;'), '49');
      assert.equal(
        psql("SELECT string_agg(table_name, ',' ORDER BY table_name) FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'assistive_validation_%';"),
        'assistive_validation_findings,assistive_validation_jobs,assistive_validation_runs',
      );
    });

    await scenario(2, 'job RLS, restrictive policy, and revoked table privileges fail closed', async () => {
      assert.equal(
        psql("SELECT relrowsecurity::text FROM pg_catalog.pg_class WHERE relname = 'assistive_validation_jobs';"),
        'true',
      );
      assert.equal(
        psql("SELECT permissive || ':' || qual FROM pg_catalog.pg_policies WHERE tablename = 'assistive_validation_jobs';"),
        'RESTRICTIVE:false',
      );
      assert.equal(
        psql("SELECT count(*) FROM information_schema.role_table_grants WHERE table_name = 'assistive_validation_jobs' AND grantee IN ('PUBLIC','anon','authenticated','service_role');"),
        '0',
      );
      assert((await anonymous.from('assistive_validation_jobs').select('*')).error);
      assert((await service.from('assistive_validation_jobs').select('*')).error);
    });

    await scenario(3, 'anonymous callers cannot invoke coordination RPCs', async () => {
      for (const name of [
        'enqueue_assistive_validation_run', 'claim_next_assistive_validation_job',
        'heartbeat_assistive_validation_job', 'finalize_assistive_validation_job',
        'request_assistive_validation_cancellation', 'get_assistive_validation_job_health',
      ]) {
        assert((await anonymous.rpc(name, {})).error, `anonymous caller executed ${name}`);
      }
    });

    const sameHash = hash(`${prefix}:same`);
    await scenario(4, 'twenty concurrent identical enqueues converge on one run and one job', async () => {
      const results = await Promise.all(Array.from({ length: 20 }, () => rpc('enqueue_assistive_validation_run', {
        p_project_id: projectId,
        p_actor_admin_id: actorId,
        p_input_hash: sameHash,
        p_pipeline_version: PIPELINE,
      })));
      assert.equal(results.filter((value) => value.resultCode === 'ENQUEUED').length, 1);
      assert.equal(results.filter((value) => value.resultCode === 'ALREADY_QUEUED').length, 19);
      assert.equal(new Set(results.map((value) => value.runId)).size, 1);
      assert.equal(
        psql(`SELECT count(*) || ':' || count(j.id) FROM public.assistive_validation_runs r JOIN public.assistive_validation_jobs j ON j.run_id = r.id WHERE r.project_id = '${projectId}'::uuid AND r.input_hash = '${sameHash}';`),
        '1:1',
      );
    });

    const bulkHashes = Array.from({ length: 99 }, (_, index) => hash(`${prefix}:bulk:${index}`));
    await scenario(5, 'ninety-nine additional identities enqueue without loss or duplicate jobs', async () => {
      const results = await Promise.all(bulkHashes.map((inputHash) => rpc('enqueue_assistive_validation_run', {
        p_project_id: projectId,
        p_actor_admin_id: actorId,
        p_input_hash: inputHash,
        p_pipeline_version: PIPELINE,
      })));
      assert(results.every((value) => value.resultCode === 'ENQUEUED'));
      assert.equal(
        psql(`SELECT count(*) || ':' || count(DISTINCT j.id) FROM public.assistive_validation_runs r JOIN public.assistive_validation_jobs j ON j.run_id = r.id WHERE r.project_id = '${projectId}'::uuid AND r.status = 'QUEUED';`),
        '100:100',
      );
    });

    let claims: Record<string, unknown>[] = [];
    await scenario(6, 'one hundred parallel claimers receive one unique job each', async () => {
      claims = await Promise.all(Array.from({ length: 100 }, () => rpc('claim_next_assistive_validation_job', {
        p_worker_id: crypto.randomUUID(), p_lease_seconds: 180,
      })));
      assert(claims.every((value) => value.resultCode === 'CLAIMED'));
      assert.equal(new Set(claims.map((value) => value.jobId)).size, 100);
      assert.equal(new Set(claims.map((value) => value.runId)).size, 100);
      assert.equal(psql(`SELECT count(*) FROM public.assistive_validation_jobs j JOIN public.assistive_validation_runs r ON r.id = j.run_id WHERE r.project_id = '${projectId}'::uuid AND j.attempt_count = 1 AND j.status = 'EXTRACTING';`), '100');
    });

    await scenario(7, 'a live lease heartbeat extends only the exact current claim', async () => {
      const claim = claims[1];
      const heartbeat = await rpc('heartbeat_assistive_validation_job', {
        p_job_id: claim.jobId, p_claim_token: claim.claimToken, p_lease_seconds: 180,
      });
      assert.equal(heartbeat.resultCode, 'HEARTBEAT');
      const stale = await rpc('heartbeat_assistive_validation_job', {
        p_job_id: claim.jobId, p_claim_token: crypto.randomUUID(), p_lease_seconds: 180,
      });
      assert.equal(stale.resultCode, 'CLAIM_LOST');
    });

    let reclaimed: Record<string, unknown>;
    await scenario(8, 'an expired lease is reclaimed with a rotated fencing token', async () => {
      const original = claims[0];
      psql(`UPDATE public.assistive_validation_jobs SET lease_until = pg_catalog.now() - interval '1 second' WHERE id = '${original.jobId}'::uuid;`);
      reclaimed = await rpc('claim_next_assistive_validation_job', {
        p_worker_id: crypto.randomUUID(), p_lease_seconds: 180,
      });
      assert.equal(reclaimed.resultCode, 'CLAIMED');
      assert.equal(reclaimed.jobId, original.jobId);
      assert.notEqual(reclaimed.claimToken, original.claimToken);
      assert.equal(reclaimed.attemptCount, 2);
      const fenced = await rpc('heartbeat_assistive_validation_job', {
        p_job_id: original.jobId, p_claim_token: original.claimToken, p_lease_seconds: 180,
      });
      assert.equal(fenced.resultCode, 'CLAIM_LOST');
    });

    await scenario(9, 'a second expired lease reaches the terminal two-attempt bound', async () => {
      psql(`UPDATE public.assistive_validation_jobs SET lease_until = pg_catalog.now() - interval '1 second' WHERE id = '${reclaimed!.jobId}'::uuid;`);
      const empty = await rpc('claim_next_assistive_validation_job', {
        p_worker_id: crypto.randomUUID(), p_lease_seconds: 180,
      });
      assert.equal(empty.resultCode, 'EMPTY');
      assert.equal(
        psql(`SELECT r.status || ':' || j.status || ':' || j.attempt_count::text FROM public.assistive_validation_runs r JOIN public.assistive_validation_jobs j ON j.run_id = r.id WHERE j.id = '${reclaimed!.jobId}'::uuid;`),
        'FAILED:FAILED:2',
      );
    });

    await scenario(10, 'stage advancement and finalization commit findings with the terminal pair', async () => {
      const claim = claims[1];
      assert.equal((await rpc('advance_assistive_validation_job_stage', {
        p_job_id: claim.jobId, p_claim_token: claim.claimToken,
      })).resultCode, 'ADVANCED');
      const result = await rpc('finalize_assistive_validation_job', {
        p_job_id: claim.jobId, p_claim_token: claim.claimToken,
        p_input_hash: claim.inputHash, p_status: 'COMPLETED', p_completion_code: null,
        p_findings: [FINDING],
      });
      assert.equal(result.resultCode, 'FINALIZED');
      assert.equal(
        psql(`SELECT r.status || ':' || j.status || ':' || count(f.id)::text FROM public.assistive_validation_runs r JOIN public.assistive_validation_jobs j ON j.run_id = r.id LEFT JOIN public.assistive_validation_findings f ON f.run_id = r.id WHERE r.id = '${claim.runId}'::uuid GROUP BY r.status,j.status;`),
        'COMPLETED:COMPLETED:1',
      );
    });

    await scenario(11, 'cancellation requested before finalization wins on the locked job row', async () => {
      const claim = claims[2];
      assert.equal((await rpc('request_assistive_validation_cancellation', {
        p_run_id: claim.runId, p_actor_admin_id: actorId,
      })).resultCode, 'CANCELLATION_REQUESTED');
      assert.equal((await rpc('finalize_assistive_validation_job', {
        p_job_id: claim.jobId, p_claim_token: claim.claimToken,
        p_input_hash: claim.inputHash, p_status: 'COMPLETED', p_completion_code: null,
        p_findings: [FINDING],
      })).resultCode, 'CANCELLED');
      assert.equal(
        psql(`SELECT r.status || ':' || j.status || ':' || count(f.id)::text FROM public.assistive_validation_runs r JOIN public.assistive_validation_jobs j ON j.run_id = r.id LEFT JOIN public.assistive_validation_findings f ON f.run_id = r.id WHERE r.id = '${claim.runId}'::uuid GROUP BY r.status,j.status;`),
        'CANCELLED:CANCELLED:0',
      );
    });

    await scenario(12, 'finalization before cancellation stays terminal and immutable', async () => {
      const claim = claims[3];
      assert.equal((await rpc('finalize_assistive_validation_job', {
        p_job_id: claim.jobId, p_claim_token: claim.claimToken,
        p_input_hash: claim.inputHash, p_status: 'COMPLETED', p_completion_code: null,
        p_findings: [FINDING],
      })).resultCode, 'FINALIZED');
      assert.equal((await rpc('request_assistive_validation_cancellation', {
        p_run_id: claim.runId, p_actor_admin_id: actorId,
      })).resultCode, 'ALREADY_TERMINAL');
      assert.equal(psql(`SELECT status FROM public.assistive_validation_runs WHERE id = '${claim.runId}'::uuid;`), 'COMPLETED');
    });

    await scenario(13, 'retryable failure requeues once and rotates the next claim token', async () => {
      const claim = claims[4];
      assert.equal((await rpc('record_assistive_validation_job_failure', {
        p_job_id: claim.jobId, p_claim_token: claim.claimToken, p_failure_code: 'WORKER_TIMEOUT',
      })).resultCode, 'RETRY_QUEUED');
      psql(`UPDATE public.assistive_validation_jobs SET available_at = pg_catalog.now() WHERE id = '${claim.jobId}'::uuid;`);
      const retry = await rpc('claim_next_assistive_validation_job', {
        p_worker_id: crypto.randomUUID(), p_lease_seconds: 180,
      });
      assert.equal(retry.jobId, claim.jobId);
      assert.equal(retry.attemptCount, 2);
      assert.notEqual(retry.claimToken, claim.claimToken);
      assert.equal((await rpc('record_assistive_validation_job_failure', {
        p_job_id: retry.jobId, p_claim_token: retry.claimToken, p_failure_code: 'EXTRACTION_FAILED',
      })).resultCode, 'FAILED');
    });

    await scenario(14, 'OCR-required output persists as a non-authoritative PARTIAL terminal result', async () => {
      const claim = claims[5];
      assert.equal((await rpc('advance_assistive_validation_job_stage', {
        p_job_id: claim.jobId, p_claim_token: claim.claimToken,
      })).resultCode, 'ADVANCED');
      assert.equal((await rpc('finalize_assistive_validation_job', {
        p_job_id: claim.jobId, p_claim_token: claim.claimToken,
        p_input_hash: claim.inputHash, p_status: 'PARTIAL', p_completion_code: 'OCR_REQUIRED',
        p_findings: [FINDING],
      })).resultCode, 'FINALIZED');
      assert.equal(
        psql(`SELECT r.status || ':' || r.failure_code || ':' || j.status FROM public.assistive_validation_runs r JOIN public.assistive_validation_jobs j ON j.run_id = r.id WHERE r.id = '${claim.runId}'::uuid;`),
        'PARTIAL:OCR_REQUIRED:PARTIAL',
      );
    });

    await scenario(15, 'input mismatch is refused and the current token may supersede the run', async () => {
      const claim = claims[6];
      assert.equal((await rpc('finalize_assistive_validation_job', {
        p_job_id: claim.jobId, p_claim_token: claim.claimToken,
        p_input_hash: hash(`${prefix}:changed`), p_status: 'COMPLETED', p_completion_code: null,
        p_findings: [FINDING],
      })).resultCode, 'INPUT_CHANGED');
      assert.equal((await rpc('supersede_assistive_validation_job', {
        p_job_id: claim.jobId, p_claim_token: claim.claimToken,
      })).resultCode, 'SUPERSEDED');
    });

    await scenario(16, 'a real cancellation/finalization race cannot create a mixed terminal pair', async () => {
      const claim = claims[7];
      const [cancel, finalize] = await Promise.all([
        rpc('request_assistive_validation_cancellation', {
          p_run_id: claim.runId, p_actor_admin_id: actorId,
        }),
        rpc('finalize_assistive_validation_job', {
          p_job_id: claim.jobId, p_claim_token: claim.claimToken,
          p_input_hash: claim.inputHash, p_status: 'COMPLETED', p_completion_code: null,
          p_findings: [FINDING],
        }),
      ]);
      assert(['CANCELLATION_REQUESTED', 'ALREADY_TERMINAL'].includes(String(cancel.resultCode)));
      assert(['FINALIZED', 'CANCELLED'].includes(String(finalize.resultCode)));
      const state = psql(`SELECT r.status || ':' || j.status || ':' || count(f.id)::text FROM public.assistive_validation_runs r JOIN public.assistive_validation_jobs j ON j.run_id = r.id LEFT JOIN public.assistive_validation_findings f ON f.run_id = r.id WHERE r.id = '${claim.runId}'::uuid GROUP BY r.status,j.status;`);
      assert(['COMPLETED:COMPLETED:1', 'CANCELLED:CANCELLED:0'].includes(state), state);
    });

    await scenario(17, 'strict finalization rejects unknown finding fields without partial writes', async () => {
      const claim = claims[8];
      const invalid = { ...FINDING, unknown: true };
      assert.equal((await rpc('finalize_assistive_validation_job', {
        p_job_id: claim.jobId, p_claim_token: claim.claimToken,
        p_input_hash: claim.inputHash, p_status: 'COMPLETED', p_completion_code: null,
        p_findings: [invalid],
      })).resultCode, 'VALIDATION_FAILED');
      assert.equal(psql(`SELECT count(*) FROM public.assistive_validation_findings WHERE run_id = '${claim.runId}'::uuid;`), '0');
      assert.equal(psql(`SELECT status FROM public.assistive_validation_jobs WHERE id = '${claim.jobId}'::uuid;`), 'EXTRACTING');
    });

    const legacyHash = hash(`${prefix}:legacy`);
    let legacyRunId = '';
    await scenario(18, 'the unchanged Phase 3 RPC creates a coherent terminal job automatically', async () => {
      const result = await rpc('persist_assistive_validation_run', {
        p_project_id: projectId, p_actor_admin_id: actorId, p_input_hash: legacyHash,
        p_pipeline_version: PIPELINE, p_status: 'COMPLETED', p_failure_code: null,
        p_findings: [FINDING],
      });
      assert.equal(result.resultCode, 'PERSISTED');
      legacyRunId = String(result.runId);
      assert.equal(
        psql(`SELECT r.status || ':' || j.status || ':' || j.attempt_count::text FROM public.assistive_validation_runs r JOIN public.assistive_validation_jobs j ON j.run_id = r.id WHERE r.id = '${result.runId}'::uuid;`),
        'COMPLETED:COMPLETED:0',
      );
    });

    await scenario(19, 'the legacy latest-result reader ignores newer nonterminal Phase 4 runs', async () => {
      const newerHash = hash(`${prefix}:newer-queued`);
      assert.equal((await rpc('enqueue_assistive_validation_run', {
        p_project_id: projectId, p_actor_admin_id: actorId, p_input_hash: newerHash,
        p_pipeline_version: PIPELINE,
      })).resultCode, 'ENQUEUED');
      const latest = await rpc('get_latest_assistive_validation_run', {
        p_project_id: projectId, p_pipeline_version: PIPELINE,
      });
      assert.equal(latest.resultCode, 'FOUND');
      assert.equal((latest.run as Record<string, unknown>).status, 'COMPLETED');
      assert.equal((latest.run as Record<string, unknown>).runId, legacyRunId);

      const newerClaim = await rpc('claim_next_assistive_validation_job', {
        p_worker_id: crypto.randomUUID(), p_lease_seconds: 180,
      });
      assert.equal(newerClaim.inputHash, newerHash);
      assert.equal((await rpc('record_assistive_validation_job_failure', {
        p_job_id: newerClaim.jobId, p_claim_token: newerClaim.claimToken, p_failure_code: 'MEDIA_INVALID',
      })).resultCode, 'FAILED');
      const afterFailure = await rpc('get_latest_assistive_validation_run', {
        p_project_id: projectId, p_pipeline_version: PIPELINE,
      });
      assert.equal((afterFailure.run as Record<string, unknown>).runId, legacyRunId);
    });

    await scenario(20, 'v3 language evidence enforces run identity and persists closed bounded fields', async () => {
      const inputHash = hash(`${prefix}:language`);
      assert.equal((await rpc('enqueue_assistive_validation_run', {
        p_project_id: projectId, p_actor_admin_id: actorId, p_input_hash: inputHash,
        p_pipeline_version: LANGUAGE_PIPELINE,
      })).resultCode, 'ENQUEUED');
      const claim = await rpc('claim_next_assistive_validation_job', {
        p_worker_id: crypto.randomUUID(), p_lease_seconds: 180,
      });
      assert.equal(claim.inputHash, inputHash);
      assert.equal((await rpc('advance_assistive_validation_job_stage', {
        p_job_id: claim.jobId, p_claim_token: claim.claimToken,
      })).resultCode, 'ADVANCED');
      assert.equal((await rpc('finalize_assistive_validation_job', {
        p_job_id: claim.jobId, p_claim_token: claim.claimToken,
        p_input_hash: inputHash, p_status: 'COMPLETED', p_completion_code: null,
        p_findings: [languageFinding(hash(`${prefix}:wrong-language-identity`))],
      })).resultCode, 'VALIDATION_FAILED');
      const base = languageFinding(inputHash);
      const malformed = [
        { ...base, evidence: { ...base.evidence, endOffset: 10 } },
        { ...base, evidence: { ...base.evidence, contextExcerpt: 'x'.repeat(501) } },
        { ...base, evidence: { ...base.evidence, suggestions: [] } },
        { ...base, evidence: { ...base.evidence, suggestions: ['receive', 'received', 'receiver', 'receives'] } },
        { ...base, evidence: { ...base.evidence, suggestions: ['   '] } },
        { ...base, evidence: { ...base.evidence, ruleId: 'invalid rule' } },
        { ...base, evidence: { ...base.evidence, providerId: 'REMOTE_PROVIDER' } },
        { ...base, evidence: { ...base.evidence, rawProviderResponse: 'forbidden' } },
      ];
      for (const finding of malformed) {
        assert.equal((await rpc('finalize_assistive_validation_job', {
          p_job_id: claim.jobId, p_claim_token: claim.claimToken,
          p_input_hash: inputHash, p_status: 'COMPLETED', p_completion_code: null,
          p_findings: [finding],
        })).resultCode, 'VALIDATION_FAILED');
      }
      const grammarWithoutReplacement = {
        ...base,
        reasonCode: 'LANGUAGE_GRAMMAR',
        evidence: {
          ...base.evidence,
          languageCategory: 'GRAMMAR', ruleId: 'SUBJECT_VERB_AGREEMENT', suggestions: [],
        },
      };
      assert.equal((await rpc('finalize_assistive_validation_job', {
        p_job_id: claim.jobId, p_claim_token: claim.claimToken,
        p_input_hash: inputHash, p_status: 'COMPLETED', p_completion_code: null,
        p_findings: [base, grammarWithoutReplacement],
      })).resultCode, 'FINALIZED');
      assert.equal(
        psql(`SELECT check_type || ':' || affected_field || ':' || (evidence ->> 'providerVersion') || ':' || (evidence ->> 'offsetUnit') FROM public.assistive_validation_findings WHERE run_id = '${claim.runId}'::uuid AND reason_code = 'LANGUAGE_SPELLING';`),
        'LANGUAGE_SUGGESTION:summary:6.6:UNICODE_CODE_POINTS',
      );
      assert.equal(
        psql(`SELECT count(*)::text || ':' || count(*) FILTER (WHERE reason_code = 'LANGUAGE_GRAMMAR' AND pg_catalog.jsonb_array_length(evidence -> 'suggestions') = 0)::text FROM public.assistive_validation_findings WHERE run_id = '${claim.runId}'::uuid;`),
        '2:1',
      );
    });

    await scenario(21, 'language-provider degradation preserves other findings as PARTIAL', async () => {
      const inputHash = hash(`${prefix}:language-partial`);
      assert.equal((await rpc('enqueue_assistive_validation_run', {
        p_project_id: projectId, p_actor_admin_id: actorId, p_input_hash: inputHash,
        p_pipeline_version: LANGUAGE_PIPELINE,
      })).resultCode, 'ENQUEUED');
      const claim = await rpc('claim_next_assistive_validation_job', {
        p_worker_id: crypto.randomUUID(), p_lease_seconds: 180,
      });
      assert.equal((await rpc('advance_assistive_validation_job_stage', {
        p_job_id: claim.jobId, p_claim_token: claim.claimToken,
      })).resultCode, 'ADVANCED');
      assert.equal((await rpc('finalize_assistive_validation_job', {
        p_job_id: claim.jobId, p_claim_token: claim.claimToken,
        p_input_hash: inputHash, p_status: 'PARTIAL',
        p_completion_code: 'LANGUAGE_PROVIDER_UNAVAILABLE', p_findings: [FINDING],
      })).resultCode, 'FINALIZED');
      assert.equal(
        psql(`SELECT status || ':' || failure_code FROM public.assistive_validation_runs WHERE id = '${claim.runId}'::uuid;`),
        'PARTIAL:LANGUAGE_PROVIDER_UNAVAILABLE',
      );
    });

    await scenario(22, 'health reports bounded queue, active, lease, and cancellation counts', async () => {
      const health = await rpc('get_assistive_validation_job_health');
      assert.equal(health.resultCode, 'HEALTHY');
      for (const field of ['queuedCount', 'activeCount', 'expiredLeaseCount', 'cancellationPendingCount']) {
        assert.equal(typeof health[field], 'number');
        assert(Number(health[field]) >= 0);
      }
    });

    await scenario(23, 'all surviving run/job rows remain one-to-one and lifecycle-coherent', () => {
      assert.equal(
        psql(`SELECT count(*) FROM public.assistive_validation_runs r LEFT JOIN public.assistive_validation_jobs j ON j.run_id = r.id WHERE r.project_id = '${projectId}'::uuid AND (j.id IS NULL OR NOT ((r.status = 'QUEUED' AND j.status = 'QUEUED') OR (r.status = 'RUNNING' AND j.status IN ('EXTRACTING','CHECKING')) OR (r.status IN ('PARTIAL','COMPLETED','FAILED','CANCELLED','SUPERSEDED') AND r.status = j.status)));`),
        '0',
      );
      assert.equal(
        psql(`SELECT count(*) - count(DISTINCT j.run_id) FROM public.assistive_validation_jobs j JOIN public.assistive_validation_runs r ON r.id = j.run_id WHERE r.project_id = '${projectId}'::uuid;`),
        '0',
      );
    });

    await scenario(24, 'coordination created no authoritative workflow or publication side effect', () => {
      assert.equal(psql(`SELECT to_jsonb(p)::text FROM public.projects p WHERE p.id = '${projectId}'::uuid;`), projectBefore);
      assert.equal(psql(`SELECT count(*) FROM public.approval_records WHERE project_id = '${projectId}'::uuid;`), approvalBefore);
      assert.equal(psql(`SELECT count(*) FROM public.validation_flags WHERE project_id = '${projectId}'::uuid;`), flagsBefore);
      assert.equal(psql('SELECT count(*) FROM public.published_snapshots;'), snapshotsBefore);
    });
  } catch (error) {
    primaryFailure = error;
  } finally {
    try {
      if (projectId) assert.ifError((await service.from('projects').delete().eq('id', projectId)).error);
      if (actorId) assert.ifError((await service.from('admin_users').delete().eq('id', actorId)).error);
      assert.equal(psql(`SELECT count(*) FROM public.projects WHERE public_id = '2026-${prefix}';`), '0');
      assert.equal(psql(`SELECT count(*) FROM public.admin_users WHERE email = '${actorEmail}';`), '0');
      console.log('PASS: Scenario 25 - all verifier-owned fixtures were removed');
      passed += 1;
    } catch (error) {
      cleanupFailure = error;
    }
  }

  if (primaryFailure || cleanupFailure) {
    console.error('Assistive job coordination runtime verification failed.');
    console.error(primaryFailure ?? cleanupFailure);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS: Assistive job coordination Local runtime verification complete (${passed} scenarios).`);
}

void main();
