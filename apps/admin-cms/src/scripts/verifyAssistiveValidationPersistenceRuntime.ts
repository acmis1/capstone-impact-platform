import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { createAssistiveCheckResult } from '../assistive-validation/domain/evidence';
import {
  ASSISTIVE_PIPELINE_VERSION,
  toPersistedAssistiveFinding,
  type PersistedAssistiveFinding,
} from '../assistive-validation/domain/persistenceContract';
import { SupabaseAssistiveValidationRepository } from '../assistive-validation/repositories/assistiveValidationRepository';
import {
  loadLatestAssistiveValidationRun,
  persistAssistiveValidationRun,
  recordAssistiveFindingDisposition,
} from '../assistive-validation/services/assistiveValidationPersistenceService';
import { isLoopbackUrl, parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';

/**
 * Disposable Local Supabase verification for Migration 0030 assistive persistence.
 *
 * It proves the data-integrity and authority invariants that static tests cannot: real grants,
 * real RLS, real transactions, real concurrency, and the absence of any authoritative side effect.
 * It touches loopback Local Supabase only and removes every fixture it creates.
 */

const DB_CONTAINER = 'supabase_db_capstone-impact-platform';

function findingFor(overrides: Parameters<typeof createAssistiveCheckResult>[0]): PersistedAssistiveFinding {
  return toPersistedAssistiveFinding(createAssistiveCheckResult(overrides));
}

/** One realistic Phase 2 result set: a title observation plus formatting and informational hints. */
function phase2Findings(): PersistedAssistiveFinding[] {
  return [
    findingFor({
      checkType: 'TITLE_CONSISTENCY',
      outcome: 'MISMATCH',
      classification: 'NON_BLOCKING',
      reasonCode: 'MATERIAL_TOKEN_DIFFERENCE',
      affectedField: 'title',
      origin: 'PHASE_1_EXTRACTION',
      evidenceExcerpt: 'Fire Resilience Mapping for Coastal Councils',
      pageNumber: 1,
      boundingBox: { left: 52.5, top: 96.25, right: 512, bottom: 140.75, unit: 'PDF_POINTS_TOP_LEFT' },
      metadataValue: 'Flood Resilience Mapping for Coastal Councils',
      normalizedMetadataValue: 'flood resilience mapping for coastal councils',
      candidateValue: 'Fire Resilience Mapping for Coastal Councils',
      normalizedCandidateValue: 'fire resilience mapping for coastal councils',
      lexicalScore: 0.8863636363636364,
      explanation: 'Document title contains a material token difference; it remains non-blocking.',
    }),
    findingFor({
      checkType: 'FORMATTING',
      outcome: 'INFORMATION',
      classification: 'NON_BLOCKING',
      reasonCode: 'REPEATED_WHITESPACE',
      affectedField: 'extraction_text',
      origin: 'DETERMINISTIC_HELPER',
      evidenceExcerpt: 'Fire  Resilience   Mapping',
      pageNumber: null,
      boundingBox: null,
      metadataValue: null,
      normalizedMetadataValue: null,
      candidateValue: null,
      normalizedCandidateValue: null,
      lexicalScore: null,
      explanation: 'Text contains repeated whitespace or excessive blank lines.',
    }),
    findingFor({
      checkType: 'EXTRACTION_INFORMATION',
      outcome: 'INFORMATION',
      classification: 'NON_BLOCKING',
      reasonCode: 'MISSING_GEOMETRY',
      affectedField: 'extraction_text',
      origin: 'PHASE_1_EXTRACTION',
      evidenceExcerpt: 'Completed extraction provided no block geometry.',
      pageNumber: null,
      boundingBox: null,
      metadataValue: null,
      normalizedMetadataValue: null,
      candidateValue: null,
      normalizedCandidateValue: null,
      lexicalScore: null,
      explanation: 'Extraction completed without geometry; positional evidence is unavailable.',
    }),
  ];
}

async function main(): Promise<void> {
  console.log('=== Assistive Validation Persistence Local Runtime Verification ===');

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
  const anon = (): SupabaseClient => createClient(cliEnv.API_URL!, cliEnv.ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const repository = new SupabaseAssistiveValidationRepository(service);

  const prefix = `assistive-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const reviewerEmail = `${prefix}.reviewer@capstone.test`;
  const editorEmail = `${prefix}.editor@capstone.test`;
  const reviewerPassword = `Rev_${crypto.randomBytes(18).toString('hex')}!`;
  const publicId = `2026-${prefix}`;
  const inputHash = crypto.createHash('sha256').update(`${prefix}:poster`).digest('hex');
  const otherHash = crypto.createHash('sha256').update(`${prefix}:poster-v2`).digest('hex');
  const failedOnlyHash = crypto.createHash('sha256').update(`${prefix}:poster-retry`).digest('hex');
  const concurrentHash = crypto.createHash('sha256').update(`${prefix}:concurrent-identical`).digest('hex');
  const conflictingConcurrentHash = crypto.createHash('sha256').update(`${prefix}:concurrent-conflict`).digest('hex');

  const authIds = new Set<string>();
  const adminIds = new Set<string>();
  let projectId = '';
  let softDeletedProjectId = '';
  let passed = 0;
  let primaryFailure: unknown = null;
  let cleanupFailure: unknown = null;

  const scenario = async (number: number, name: string, run: () => Promise<void> | void) => {
    await run();
    passed += 1;
    console.log(`PASS: Scenario ${number} - ${name}`);
  };

  /** PostgREST denies an unreachable relation with either a privilege error or a missing relation. */
  const assertDenied = (label: string, result: { data: unknown; error: { code?: string } | null }) => {
    assert(result.error, `${label} unexpectedly succeeded.`);
    assert(
      result.data === null || (Array.isArray(result.data) && result.data.length === 0),
      `${label} returned data.`,
    );
  };

  const runRow = (hash: string, pipeline = ASSISTIVE_PIPELINE_VERSION): string => psql(
    `SELECT count(*) FROM public.assistive_validation_runs WHERE project_id = '${projectId}'::uuid AND input_hash = '${hash}' AND pipeline_version = '${pipeline}';`,
  );

  const findingCountFor = (hash: string): string => psql(
    `SELECT count(*) FROM public.assistive_validation_findings f JOIN public.assistive_validation_runs r ON r.id = f.run_id WHERE r.project_id = '${projectId}'::uuid AND r.input_hash = '${hash}';`,
  );

  const durableSnapshotFor = (hash: string): string => psql(
    `SELECT pg_catalog.jsonb_build_object(
       'run', to_jsonb(r),
       'findings', COALESCE(pg_catalog.jsonb_agg(to_jsonb(f) ORDER BY f.ordinal)
         FILTER (WHERE f.id IS NOT NULL), '[]'::jsonb)
     )::text
     FROM public.assistive_validation_runs r
     LEFT JOIN public.assistive_validation_findings f ON f.run_id = r.id
     WHERE r.project_id = '${projectId}'::uuid AND r.input_hash = '${hash}'
     GROUP BY r.id;`,
  );

  const durableIdentityFindingsFor = (hash: string): PersistedAssistiveFinding[] => JSON.parse(psql(
    `SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
       'checkType', f.check_type,
       'outcome', f.outcome,
       'classification', f.classification,
       'reasonCode', f.reason_code,
       'affectedField', f.affected_field,
       'origin', f.origin,
       'scoreKind', f.score_kind,
       'scoreValue', f.score_value,
       'evidence', f.evidence
     ) ORDER BY f.ordinal)::text
     FROM public.assistive_validation_findings f
     JOIN public.assistive_validation_runs r ON r.id = f.run_id
     WHERE r.project_id = '${projectId}'::uuid AND r.input_hash = '${hash}';`,
  )) as PersistedAssistiveFinding[];

  try {
    // ---------------------------------------------------------------------
    // Fixtures
    // ---------------------------------------------------------------------
    const reviewerAuth = await service.auth.admin.createUser({
      email: reviewerEmail, password: reviewerPassword, email_confirm: true,
    });
    assert.ifError(reviewerAuth.error);
    assert(reviewerAuth.data.user);
    authIds.add(reviewerAuth.data.user.id);

    const reviewerProfile = await service.from('admin_users')
      .insert({ email: reviewerEmail, full_name: 'Synthetic Assistive Reviewer', auth_user_id: reviewerAuth.data.user.id })
      .select('id').single();
    assert.ifError(reviewerProfile.error);
    const reviewerAdminId = String(reviewerProfile.data!.id);
    adminIds.add(reviewerAdminId);
    assert.ifError((await service.from('user_roles').insert({ user_id: reviewerAdminId, role: 'reviewer' })).error);

    const editorProfile = await service.from('admin_users')
      .insert({ email: editorEmail, full_name: 'Synthetic Assistive Editor' })
      .select('id').single();
    assert.ifError(editorProfile.error);
    const editorAdminId = String(editorProfile.data!.id);
    adminIds.add(editorAdminId);
    assert.ifError((await service.from('user_roles').insert({ user_id: editorAdminId, role: 'editor' })).error);

    const project = await service.from('projects').insert({
      public_id: publicId,
      title: 'Flood Resilience Mapping for Coastal Councils',
      summary: 'Synthetic project fixture for assistive persistence runtime verification.',
      status: 'draft',
      year: 2026,
      program_name: 'Synthetic Software Engineering',
      discipline: 'Software Engineering',
      group_name: `Assistive Group ${prefix}`,
      team_members: ['Synthetic Member'],
    }).select('id').single();
    assert.ifError(project.error);
    projectId = String(project.data!.id);

    // A separate already-soft-deleted fixture, so the project under test is never written by
    // this verifier either. Its updated_at trigger would otherwise mask the byte-for-byte proof.
    const softDeleted = await service.from('projects').insert({
      public_id: `${publicId}-deleted`,
      title: 'Soft-deleted assistive fixture',
      summary: 'Synthetic soft-deleted project fixture.',
      status: 'draft',
      year: 2026,
      deleted_at: new Date().toISOString(),
    }).select('id').single();
    assert.ifError(softDeleted.error);
    softDeletedProjectId = String(softDeleted.data!.id);

    const projectSnapshotBefore = psql(
      `SELECT to_jsonb(p) FROM public.projects p WHERE p.id = '${projectId}'::uuid;`,
    );
    const auditCountBefore = psql(`SELECT count(*) FROM public.approval_records WHERE project_id = '${projectId}'::uuid;`);
    const flagCountBefore = psql(`SELECT count(*) FROM public.validation_flags WHERE project_id = '${projectId}'::uuid;`);
    const snapshotCountBefore = psql('SELECT count(*) FROM public.published_snapshots;');

    // ---------------------------------------------------------------------
    // Schema, constraints, RLS and privileges
    // ---------------------------------------------------------------------
    await scenario(1, 'Local Supabase applied exactly 47 migrations from zero', () => {
      assert.equal(psql('SELECT count(*) FROM supabase_migrations.schema_migrations;'), '47');
    });

    await scenario(2, 'both assistive tables exist and a finding cannot restate run identity', () => {
      assert.equal(
        psql("SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('assistive_validation_runs','assistive_validation_findings');"),
        '2',
      );
      assert.equal(
        psql("SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'assistive_validation_findings' AND column_name IN ('project_id','input_hash','pipeline_version');"),
        '0',
      );
      assert.equal(
        psql("SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'assistive_validation_runs';"),
        'completed_at,created_at,failure_code,id,input_hash,pipeline_version,project_id,requested_by,started_at,status',
      );
    });

    await scenario(3, 'foreign keys cascade from the project and degrade staff attribution', () => {
      assert.equal(
        psql(`SELECT string_agg(c.conname || ':' || c.confdeltype::text, ',' ORDER BY c.conname)
              FROM pg_catalog.pg_constraint c
              JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
              WHERE c.contype = 'f' AND t.relname IN ('assistive_validation_runs','assistive_validation_findings');`),
        'assistive_validation_findings_reviewed_by_fk:n,assistive_validation_findings_run_fk:c,assistive_validation_runs_project_fk:c,assistive_validation_runs_requested_by_fk:n',
      );
    });

    await scenario(4, 'the completed-identity unique index is partial so retry stays possible', () => {
      assert.equal(
        psql("SELECT indexdef FROM pg_catalog.pg_indexes WHERE indexname = 'uq_assistive_validation_runs_completed_identity';"),
        "CREATE UNIQUE INDEX uq_assistive_validation_runs_completed_identity ON public.assistive_validation_runs USING btree (project_id, input_hash, pipeline_version) WHERE (status = 'COMPLETED'::text)",
      );
    });

    await scenario(5, 'every integrity constraint is present in the live schema', () => {
      // Finding order is a database-derived unique position within its run.
      assert.equal(
        psql(`SELECT string_agg(c.conname, ',' ORDER BY c.conname)
              FROM pg_catalog.pg_constraint c
              JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
              WHERE c.contype = 'u' AND t.relname = 'assistive_validation_findings';`),
        'uq_assistive_validation_findings_run_ordinal',
      );
      const expected = [
        'check_assistive_finding_affected_field', 'check_assistive_finding_check_type',
        'check_assistive_finding_classification', 'check_assistive_finding_disposition',
        'check_assistive_finding_disposition_coherence', 'check_assistive_finding_duplicate_coherence',
        'check_assistive_finding_evidence_bounding_box',
        'check_assistive_finding_evidence_excerpt', 'check_assistive_finding_evidence_explanation',
        'check_assistive_finding_evidence_keys', 'check_assistive_finding_evidence_object',
        'check_assistive_finding_evidence_page_number', 'check_assistive_finding_evidence_size',
        'check_assistive_finding_evidence_values', 'check_assistive_finding_evidence_version',
        'check_assistive_finding_language_coherence',
        'check_assistive_finding_ordinal', 'check_assistive_finding_origin',
        'check_assistive_finding_outcome',
        'check_assistive_finding_reason_code', 'check_assistive_finding_score_kind',
        'check_assistive_finding_score_pair', 'check_assistive_finding_score_value',
        'check_assistive_run_failure_code', 'check_assistive_run_failure_coherence',
        'check_assistive_run_input_hash', 'check_assistive_run_pipeline_version',
        'check_assistive_run_status', 'check_assistive_run_timestamps',
      ];
      assert.equal(
        psql(`SELECT string_agg(c.conname, ',' ORDER BY c.conname)
              FROM pg_catalog.pg_constraint c
              JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
              WHERE c.contype = 'c' AND t.relname IN ('assistive_validation_runs','assistive_validation_findings');`),
        expected.join(','),
      );
    });

    await scenario(6, 'RLS is enabled with a restrictive deny-all policy on both tables', () => {
      assert.equal(
        psql("SELECT string_agg(relname || ':' || relrowsecurity::text, ',' ORDER BY relname) FROM pg_catalog.pg_class WHERE relname IN ('assistive_validation_runs','assistive_validation_findings');"),
        'assistive_validation_findings:true,assistive_validation_runs:true',
      );
      assert.equal(
        psql("SELECT string_agg(policyname || ':' || permissive || ':' || qual, ',' ORDER BY policyname) FROM pg_catalog.pg_policies WHERE tablename IN ('assistive_validation_runs','assistive_validation_findings');"),
        'deny_assistive_validation_findings_direct_access:RESTRICTIVE:false,deny_assistive_validation_runs_direct_access:RESTRICTIVE:false',
      );
    });

    await scenario(7, 'no Data API role holds any privilege on either assistive table', () => {
      assert.equal(
        psql(`SELECT count(*) FROM information_schema.role_table_grants
              WHERE table_schema = 'public'
                AND table_name IN ('assistive_validation_runs','assistive_validation_findings')
                AND grantee IN ('PUBLIC','anon','authenticated','service_role');`),
        '0',
      );
    });

    await scenario(8, 'only service_role may execute the three assistive functions', () => {
      assert.equal(
        psql(`SELECT string_agg(p.proname || ':' || COALESCE(a.grantee, 'none'), ',' ORDER BY p.proname, a.grantee)
              FROM pg_catalog.pg_proc p
              JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
              LEFT JOIN information_schema.role_routine_grants a
                ON a.specific_schema = 'public' AND a.routine_name = p.proname
               AND a.grantee IN ('PUBLIC','anon','authenticated','service_role')
              WHERE n.nspname = 'public' AND p.proname IN (
                'persist_assistive_validation_run','record_assistive_finding_disposition','get_latest_assistive_validation_run');`),
        'get_latest_assistive_validation_run:service_role,persist_assistive_validation_run:service_role,record_assistive_finding_disposition:service_role',
      );
      assert.equal(
        psql(`SELECT string_agg(p.proname || ':' || p.prosecdef::text || ':' || COALESCE(array_to_string(p.proconfig, '|'), 'none'), ',' ORDER BY p.proname)
              FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname IN (
                'persist_assistive_validation_run','record_assistive_finding_disposition','get_latest_assistive_validation_run');`),
        'get_latest_assistive_validation_run:true:search_path="",persist_assistive_validation_run:true:search_path="",record_assistive_finding_disposition:true:search_path=""',
      );
    });

    await scenario(9, 'the only finding trigger guards v3 run identity', () => {
      assert.equal(
        psql(`SELECT pg_catalog.string_agg(tg.tgname, ',' ORDER BY tg.tgname) FROM pg_catalog.pg_trigger tg
              JOIN pg_catalog.pg_class t ON t.oid = tg.tgrelid
              WHERE NOT tg.tgisinternal AND t.relname = 'assistive_validation_findings';`),
        'assistive_language_finding_identity_guard',
      );
    });

    // ---------------------------------------------------------------------
    // Anonymous and authenticated denial
    // ---------------------------------------------------------------------
    const anonClient = anon();
    await scenario(10, 'anonymous clients cannot read or write either assistive table', async () => {
      assertDenied('anon run select', await anonClient.from('assistive_validation_runs').select('*'));
      assertDenied('anon finding select', await anonClient.from('assistive_validation_findings').select('*'));
      assertDenied('anon finding insert', await anonClient.from('assistive_validation_findings').insert({ run_id: projectId }));
      assertDenied('anon finding update', await anonClient.from('assistive_validation_findings').update({ disposition: 'REVIEWED' }).eq('disposition', 'UNREVIEWED'));
    });

    await scenario(11, 'anonymous clients cannot execute any assistive function', async () => {
      for (const rpc of [
        'persist_assistive_validation_run', 'record_assistive_finding_disposition', 'get_latest_assistive_validation_run',
      ]) {
        const result = await anonClient.rpc(rpc, {});
        assert(result.error, `anon executed ${rpc}.`);
      }
    });

    const staffClient = anon();
    const staffLogin = await staffClient.auth.signInWithPassword({ email: reviewerEmail, password: reviewerPassword });
    assert.ifError(staffLogin.error);

    await scenario(12, 'an authenticated staff browser session cannot reach either table directly', async () => {
      assertDenied('authenticated run select', await staffClient.from('assistive_validation_runs').select('*'));
      assertDenied('authenticated finding select', await staffClient.from('assistive_validation_findings').select('*'));
      assertDenied('authenticated finding insert', await staffClient.from('assistive_validation_findings').insert({ run_id: projectId }));
      assertDenied('authenticated run insert', await staffClient.from('assistive_validation_runs').insert({ project_id: projectId }));
    });

    await scenario(13, 'an authenticated staff browser session cannot spoof a disposition by RPC', async () => {
      const result = await staffClient.rpc('record_assistive_finding_disposition', {
        p_finding_id: projectId, p_actor_admin_id: reviewerAdminId, p_disposition: 'REVIEWED',
      });
      assert.equal(result.error?.code, '42501');
      const persist = await staffClient.rpc('persist_assistive_validation_run', {
        p_project_id: projectId, p_actor_admin_id: reviewerAdminId, p_input_hash: inputHash,
        p_pipeline_version: ASSISTIVE_PIPELINE_VERSION, p_status: 'COMPLETED', p_failure_code: null,
        p_findings: phase2Findings(),
      });
      assert.equal(persist.error?.code, '42501');
    });

    await scenario(14, 'even service_role cannot reach either table outside the functions', async () => {
      assertDenied('service run select', await service.from('assistive_validation_runs').select('*'));
      assertDenied('service finding select', await service.from('assistive_validation_findings').select('*'));
      assertDenied('service finding insert', await service.from('assistive_validation_findings').insert({ run_id: projectId }));
      assertDenied('service job select', await service.from('assistive_validation_jobs').select('*'));
    });

    // ---------------------------------------------------------------------
    // Trusted persistence
    // ---------------------------------------------------------------------
    const findings = phase2Findings();
    let runId = '';

    await scenario(15, 'the trusted server path persists one run with all of its findings', async () => {
      const result = await persistAssistiveValidationRun(repository, {
        projectId, inputHash, pipelineVersion: ASSISTIVE_PIPELINE_VERSION,
        status: 'COMPLETED', failureCode: null, findings,
      }, reviewerAdminId);
      assert(result.ok, 'Persistence failed.');
      assert.equal(result.alreadyPersisted, false);
      assert.equal(result.findingCount, 3);
      runId = result.runId;
      assert.equal(runRow(inputHash), '1');
      assert.equal(findingCountFor(inputHash), '3');
      assert.equal(
        psql(`SELECT j.status || ':' || j.attempt_count::text FROM public.assistive_validation_jobs j WHERE j.run_id = '${runId}'::uuid;`),
        'COMPLETED:0',
      );
      assert.equal(
        psql(`SELECT string_agg(DISTINCT classification, ',') FROM public.assistive_validation_findings WHERE run_id = '${runId}'::uuid;`),
        'NON_BLOCKING',
      );
      assert.equal(
        psql(`SELECT string_agg(DISTINCT disposition, ',') FROM public.assistive_validation_findings WHERE run_id = '${runId}'::uuid;`),
        'UNREVIEWED',
      );
      assert.equal(
        psql(`SELECT requested_by::text FROM public.assistive_validation_runs WHERE id = '${runId}'::uuid;`),
        reviewerAdminId,
      );
    });

    await scenario(16, 'every persisted value round-trips through the strict contracts unchanged', async () => {
      const loaded = await loadLatestAssistiveValidationRun(repository, projectId, ASSISTIVE_PIPELINE_VERSION);
      assert(loaded.ok && loaded.found, 'Round-trip read failed.');
      assert.equal(loaded.run.runId, runId);
      assert.equal(loaded.run.inputHash, inputHash);
      assert.equal(loaded.run.status, 'COMPLETED');
      assert.equal(loaded.run.failureCode, null);
      assert.equal(loaded.findings.length, 3);
      for (const [index, stored] of loaded.findings.entries()) {
        const source = findings[index];
        assert.equal(stored.ordinal, index + 1, 'Findings did not round-trip in the produced order.');
        assert.equal(stored.checkType, source.checkType);
        assert.equal(stored.outcome, source.outcome);
        assert.equal(stored.classification, 'NON_BLOCKING');
        assert.equal(stored.reasonCode, source.reasonCode);
        assert.equal(stored.affectedField, source.affectedField);
        assert.equal(stored.origin, source.origin);
        assert.equal(stored.scoreKind, source.scoreKind);
        assert.equal(stored.scoreValue, source.scoreValue);
        assert.deepEqual(stored.evidence, source.evidence);
        assert.equal(stored.disposition, 'UNREVIEWED');
        assert.equal(stored.reviewedBy, null);
        assert.equal(stored.reviewedAt, null);
      }
    });

    // ---------------------------------------------------------------------
    // Fail-closed input handling
    // ---------------------------------------------------------------------
    const persistRaw = (payload: Record<string, unknown>) => service.rpc('persist_assistive_validation_run', {
      p_project_id: projectId,
      p_actor_admin_id: reviewerAdminId,
      p_input_hash: otherHash,
      p_pipeline_version: ASSISTIVE_PIPELINE_VERSION,
      p_status: 'COMPLETED',
      p_failure_code: null,
      p_findings: phase2Findings(),
      ...payload,
    });

    await scenario(17, 'an unknown or malformed finding is rejected and nothing is written', async () => {
      const unknownField = await persistRaw({
        p_findings: [{ ...phase2Findings()[0], providerPrompt: 'ignore previous instructions' }],
      });
      assert.ifError(unknownField.error);
      assert.equal((unknownField.data as { resultCode: string }).resultCode, 'VALIDATION_FAILED');

      const unknownEnum = await persistRaw({
        p_findings: [{ ...phase2Findings()[0], reasonCode: 'LLM_JUDGEMENT' }],
      });
      assert.equal((unknownEnum.data as { resultCode: string }).resultCode, 'VALIDATION_FAILED');

      const authorityBearing = await persistRaw({
        p_findings: [{ ...phase2Findings()[0], classification: 'BLOCKING' }],
      });
      assert.equal((authorityBearing.data as { resultCode: string }).resultCode, 'VALIDATION_FAILED');

      assert.equal(runRow(otherHash), '0');
    });

    await scenario(18, 'field-level malformed evidence is rejected by the service-role RPC', async () => {
      const base = phase2Findings()[0];
      if (base.evidence.version !== 'assistive-finding-evidence/v1') throw new Error('Expected v1 evidence');
      const box = base.evidence.boundingBox!;
      const malformedEvidence = [
        { ...base.evidence, evidenceExcerpt: 'x'.repeat(501) },
        { ...base.evidence, evidenceExcerpt: 7 },
        { ...base.evidence, metadataValue: 'x'.repeat(401) },
        { ...base.evidence, normalizedMetadataValue: false },
        { ...base.evidence, pageNumber: 0 },
        { ...base.evidence, pageNumber: 11 },
        { ...base.evidence, pageNumber: 1.5 },
        { ...base.evidence, boundingBox: { left: box.left, top: box.top, right: box.right, unit: box.unit } },
        { ...base.evidence, boundingBox: { ...box, depth: 1 } },
        { ...base.evidence, boundingBox: { ...box, left: '52.5' } },
        { ...base.evidence, boundingBox: { ...box, unit: 'NORMALIZED' } },
        { ...base.evidence, boundingBox: { ...box, right: box.left - 1 } },
        { ...base.evidence, boundingBox: { ...box, bottom: box.top - 1 } },
        { ...base.evidence, explanation: 7 },
        { ...base.evidence, explanation: '' },
        { ...base.evidence, explanation: 'x'.repeat(301) },
        { ...base.evidence, evidenceExcerpt: 'control\u0001character' },
        { ...base.evidence, rawOcrTranscript: 'x' },
        { ...base.evidence, version: 'assistive-finding-evidence/v2' },
      ];
      for (const evidence of malformedEvidence) {
        const rejected = await persistRaw({ p_findings: [{ ...base, evidence }] });
        assert.ifError(rejected.error);
        assert.equal(
          (rejected.data as { resultCode: string }).resultCode,
          'VALIDATION_FAILED',
          `Malformed evidence was accepted: ${JSON.stringify(evidence)}`,
        );
      }

      assert.equal(runRow(otherHash), '0');
      assert.equal(findingCountFor(otherHash), '0');
    });

    await scenario(19, 'invalid run identity and incoherent terminal states are rejected', async () => {
      for (const payload of [
        { p_input_hash: inputHash.toUpperCase() },
        { p_input_hash: 'a'.repeat(63) },
        { p_input_hash: 'not-a-hash' },
        { p_pipeline_version: 'Gemini/v1' },
        { p_pipeline_version: `${'a'.repeat(70)}/v1` },
        { p_status: 'RUNNING' },
        { p_status: 'COMPLETED', p_failure_code: 'EXTRACTION_FAILED' },
        { p_status: 'FAILED', p_failure_code: null, p_findings: [] },
        { p_status: 'FAILED', p_failure_code: 'INTERNAL_FAILURE' },
        { p_status: 'COMPLETED', p_findings: [] },
        { p_findings: 'not-an-array' },
      ]) {
        const result = await persistRaw(payload);
        assert.ifError(result.error);
        assert.equal(
          (result.data as { resultCode: string }).resultCode,
          'VALIDATION_FAILED',
          `Expected rejection for ${JSON.stringify(payload)}.`,
        );
      }
      assert.equal(runRow(otherHash), '0');
    });

    await scenario(20, 'a missing or soft-deleted project and an unauthorized actor fail closed', async () => {
      const missing = await persistRaw({ p_project_id: crypto.randomUUID() });
      assert.equal((missing.data as { resultCode: string }).resultCode, 'PROJECT_NOT_FOUND');

      const strangerActor = await persistRaw({ p_actor_admin_id: crypto.randomUUID() });
      assert.equal((strangerActor.data as { resultCode: string }).resultCode, 'PERMISSION_DENIED');

      const softDeletedTarget = await persistRaw({ p_project_id: softDeletedProjectId });
      assert.equal((softDeletedTarget.data as { resultCode: string }).resultCode, 'PROJECT_NOT_FOUND');
      assert.equal(runRow(otherHash), '0');
    });

    await scenario(21, 'an injected mid-payload failure leaves no partial run and no partial findings', async () => {
      const injected = phase2Findings();
      injected[2] = { ...injected[2], outcome: 'PUBLICATION_READY' as never };
      const result = await persistRaw({ p_findings: injected });
      assert.ifError(result.error);
      assert.equal((result.data as { resultCode: string }).resultCode, 'VALIDATION_FAILED');
      assert.equal(runRow(otherHash), '0');
      assert.equal(findingCountFor(otherHash), '0');
      // The already-durable run from scenario 15 is untouched by the rejected attempt.
      assert.equal(findingCountFor(inputHash), '3');
    });

    // ---------------------------------------------------------------------
    // Idempotency, concurrency and retry
    // ---------------------------------------------------------------------
    await scenario(22, 'an identical retry converges on the existing run without duplicating findings', async () => {
      const retry = await persistAssistiveValidationRun(repository, {
        projectId, inputHash, pipelineVersion: ASSISTIVE_PIPELINE_VERSION,
        status: 'COMPLETED', failureCode: null, findings,
      }, reviewerAdminId);
      assert(retry.ok, 'Retry failed.');
      assert.equal(retry.alreadyPersisted, true);
      assert.equal(retry.runId, runId);
      assert.equal(retry.findingCount, 3);
      assert.equal(runRow(inputHash), '1');
      assert.equal(findingCountFor(inputHash), '3');
    });

    await scenario(23, 'every materially different completed finding set conflicts with zero mutation', async () => {
      const durableBefore = durableSnapshotFor(inputHash);
      const conflicts = [
        findings.slice(0, 2),
        findings.map((finding, index) => index === 0 ? { ...finding, outcome: 'REVIEW' } : finding),
        findings.map((finding, index) => index === 0
          ? { ...finding, reasonCode: 'POSSIBLE_OCR_OR_SPELLING_VARIANT' }
          : finding),
        findings.map((finding, index) => index === 0
          ? { ...finding, evidence: { ...finding.evidence, explanation: 'Conflicting deterministic explanation.' } }
          : finding),
        findings.map((finding, index) => index === 0 ? { ...finding, scoreValue: 0.5 } : finding),
        [findings[1], findings[0], findings[2]],
      ];
      for (const conflictingFindings of conflicts) {
        const conflicting = await persistAssistiveValidationRun(repository, {
          projectId, inputHash, pipelineVersion: ASSISTIVE_PIPELINE_VERSION,
          status: 'COMPLETED', failureCode: null, findings: conflictingFindings,
        }, reviewerAdminId);
        assert(
          !conflicting.ok && conflicting.code === 'IDENTITY_CONFLICT',
          'A conflicting completed result was mislabeled as an exact retry.',
        );
        assert.equal(durableSnapshotFor(inputHash), durableBefore);
      }
      assert.equal(runRow(inputHash), '1');
      assert.equal(findingCountFor(inputHash), '3');
    });

    await scenario(24, 'a failed payload cannot masquerade as a retry of a completed identity', async () => {
      const durableBefore = durableSnapshotFor(inputHash);
      const conflicting = await persistAssistiveValidationRun(repository, {
        projectId, inputHash, pipelineVersion: ASSISTIVE_PIPELINE_VERSION,
        status: 'FAILED', failureCode: 'EXTRACTION_FAILED', findings: [],
      }, reviewerAdminId);
      assert(!conflicting.ok && conflicting.code === 'IDENTITY_CONFLICT');
      assert.equal(durableSnapshotFor(inputHash), durableBefore);
      assert.equal(runRow(inputHash), '1');
    });

    await scenario(25, 'concurrent identical attempts converge on exactly one durable run', async () => {
      const attempts = await Promise.all(Array.from({ length: 4 }, () => persistAssistiveValidationRun(repository, {
        projectId, inputHash: concurrentHash, pipelineVersion: ASSISTIVE_PIPELINE_VERSION,
        status: 'COMPLETED', failureCode: null, findings,
      }, reviewerAdminId)));

      assert(attempts.every((attempt) => attempt.ok), 'A concurrent attempt errored.');
      const successes = attempts.filter((attempt) => attempt.ok && !attempt.alreadyPersisted);
      assert.equal(successes.length, 1, 'More than one concurrent attempt claimed a new run.');
      const ids = new Set(attempts.map((attempt) => (attempt.ok ? attempt.runId : '')));
      assert.equal(ids.size, 1, 'Concurrent attempts returned contradictory run identities.');
      assert.equal(runRow(concurrentHash), '1');
      assert.equal(findingCountFor(concurrentHash), '3');
    });

    await scenario(26, 'concurrent conflicting attempts persist one complete result and reject the other', async () => {
      const variantA = phase2Findings();
      const variantB = variantA.map((finding, index) => index === 0
        ? { ...finding, evidence: { ...finding.evidence, explanation: 'Concurrent conflicting explanation.' } }
        : finding);
      const attempts = await Promise.all([variantA, variantB].map((candidateFindings) => (
        persistAssistiveValidationRun(repository, {
          projectId, inputHash: conflictingConcurrentHash, pipelineVersion: ASSISTIVE_PIPELINE_VERSION,
          status: 'COMPLETED', failureCode: null, findings: candidateFindings,
        }, reviewerAdminId)
      )));

      assert.equal(attempts.filter((attempt) => attempt.ok && !attempt.alreadyPersisted).length, 1);
      assert.equal(attempts.filter((attempt) => !attempt.ok && attempt.code === 'IDENTITY_CONFLICT').length, 1);
      assert.equal(runRow(conflictingConcurrentHash), '1');
      assert.equal(findingCountFor(conflictingConcurrentHash), '3');

      const durableFindings = durableIdentityFindingsFor(conflictingConcurrentHash);
      assert(
        isDeepStrictEqual(durableFindings, variantA) || isDeepStrictEqual(durableFindings, variantB),
        'Concurrent conflicting attempts produced a mixed or partial finding set.',
      );
    });

    await scenario(27, 'a previous failed run never blocks a later successful run of the same identity', async () => {
      const firstFailure = await persistAssistiveValidationRun(repository, {
        projectId, inputHash: failedOnlyHash, pipelineVersion: ASSISTIVE_PIPELINE_VERSION,
        status: 'FAILED', failureCode: 'EXTRACTION_CONTRACT_REJECTED', findings: [],
      }, reviewerAdminId);
      assert(firstFailure.ok && !firstFailure.alreadyPersisted, 'Failed run was not recorded.');

      const secondFailure = await persistAssistiveValidationRun(repository, {
        projectId, inputHash: failedOnlyHash, pipelineVersion: ASSISTIVE_PIPELINE_VERSION,
        status: 'FAILED', failureCode: 'EXTRACTION_FAILED', findings: [],
      }, reviewerAdminId);
      assert(secondFailure.ok && !secondFailure.alreadyPersisted, 'A repeated failure was suppressed.');

      const recovered = await persistAssistiveValidationRun(repository, {
        projectId, inputHash: failedOnlyHash, pipelineVersion: ASSISTIVE_PIPELINE_VERSION,
        status: 'COMPLETED', failureCode: null, findings,
      }, reviewerAdminId);
      assert(recovered.ok && !recovered.alreadyPersisted, 'Retry after failure was blocked.');
      assert.equal(
        psql(`SELECT count(*) FROM public.assistive_validation_runs WHERE project_id = '${projectId}'::uuid AND input_hash = '${failedOnlyHash}' AND status = 'FAILED';`),
        '2',
      );
      assert.equal(
        psql(`SELECT count(*) FROM public.assistive_validation_runs WHERE project_id = '${projectId}'::uuid AND input_hash = '${failedOnlyHash}' AND status = 'COMPLETED';`),
        '1',
      );
    });

    await scenario(28, 'a second completed run of one identity is impossible even by direct insert', () => {
      // Run as the database superuser, which bypasses grants and RLS entirely, so this proves the
      // partial unique index itself rather than the access-control layer in front of it.
      let rejection = '';
      try {
        psql(`INSERT INTO public.assistive_validation_runs (project_id, input_hash, pipeline_version, status) VALUES ('${projectId}'::uuid, '${inputHash}', '${ASSISTIVE_PIPELINE_VERSION}', 'COMPLETED');`);
      } catch (error) {
        rejection = String((error as { stderr?: unknown }).stderr ?? '');
      }
      assert.match(rejection, /duplicate key value violates unique constraint "uq_assistive_validation_runs_completed_identity"/);
      assert.equal(runRow(inputHash), '1');
    });

    // ---------------------------------------------------------------------
    // Reviewer disposition
    // ---------------------------------------------------------------------
    const firstFindingId = psql(
      `SELECT id::text FROM public.assistive_validation_findings WHERE run_id = '${runId}'::uuid ORDER BY created_at, id LIMIT 1;`,
    );

    await scenario(29, 'a reviewer disposition persists with server-side attribution and timestamp', async () => {
      const recorded = await recordAssistiveFindingDisposition(repository, firstFindingId, reviewerAdminId, 'REVIEWED');
      assert(recorded.ok, 'Disposition failed.');
      assert.equal(recorded.changed, true);
      assert.equal(recorded.disposition, 'REVIEWED');
      assert.equal(recorded.reviewedBy, reviewerAdminId);
      assert.equal(
        psql(`SELECT disposition || ':' || reviewed_by::text || ':' || (reviewed_at IS NOT NULL)::text FROM public.assistive_validation_findings WHERE id = '${firstFindingId}'::uuid;`),
        `REVIEWED:${reviewerAdminId}:true`,
      );
      // The reviewed timestamp is generated by the database, never supplied by a caller.
      assert.equal(
        psql(`SELECT (reviewed_at BETWEEN pg_catalog.now() - interval '5 minutes' AND pg_catalog.now())::text FROM public.assistive_validation_findings WHERE id = '${firstFindingId}'::uuid;`),
        'true',
      );
    });

    await scenario(30, 'a repeated identical disposition is idempotent and rewrites nothing', async () => {
      const stampBefore = psql(`SELECT reviewed_at::text FROM public.assistive_validation_findings WHERE id = '${firstFindingId}'::uuid;`);
      const repeat = await recordAssistiveFindingDisposition(repository, firstFindingId, reviewerAdminId, 'REVIEWED');
      assert(repeat.ok, 'Repeat disposition failed.');
      assert.equal(repeat.changed, false);
      assert.equal(
        psql(`SELECT reviewed_at::text FROM public.assistive_validation_findings WHERE id = '${firstFindingId}'::uuid;`),
        stampBefore,
      );
    });

    await scenario(31, 'an editor-only identity and an invalid disposition are both refused', async () => {
      const editorAttempt = await recordAssistiveFindingDisposition(repository, firstFindingId, editorAdminId, 'IGNORED');
      assert(!editorAttempt.ok && editorAttempt.code === 'PERMISSION_DENIED', 'Editor recorded a disposition.');

      const strangerAttempt = await recordAssistiveFindingDisposition(repository, firstFindingId, crypto.randomUUID(), 'IGNORED');
      assert(!strangerAttempt.ok && strangerAttempt.code === 'PERMISSION_DENIED', 'A stranger recorded a disposition.');

      for (const disposition of ['UNREVIEWED', 'ACCEPTED', 'APPLIED', 'APPROVED']) {
        const invalid = await service.rpc('record_assistive_finding_disposition', {
          p_finding_id: firstFindingId, p_actor_admin_id: reviewerAdminId, p_disposition: disposition,
        });
        assert.equal((invalid.data as { resultCode: string }).resultCode, 'VALIDATION_FAILED');
      }

      const missing = await recordAssistiveFindingDisposition(repository, crypto.randomUUID(), reviewerAdminId, 'IGNORED');
      assert(!missing.ok && missing.code === 'FINDING_NOT_FOUND', 'A missing finding was accepted.');

      assert.equal(
        psql(`SELECT disposition FROM public.assistive_validation_findings WHERE id = '${firstFindingId}'::uuid;`),
        'REVIEWED',
      );
    });

    await scenario(32, 'no Data API role can rewrite persisted finding evidence', async () => {
      const evidenceBefore = psql(`SELECT evidence::text FROM public.assistive_validation_findings WHERE id = '${firstFindingId}'::uuid;`);
      for (const [label, client] of [['anon', anonClient], ['authenticated', staffClient], ['service_role', service]] as const) {
        assertDenied(
          `${label} evidence update`,
          await client.from('assistive_validation_findings')
            .update({ evidence: { version: 'assistive-finding-evidence/v1' }, outcome: 'AGREES' })
            .eq('id', firstFindingId),
        );
        assertDenied(
          `${label} finding delete`,
          await client.from('assistive_validation_findings').delete().eq('id', firstFindingId),
        );
      }
      assert.equal(
        psql(`SELECT evidence::text FROM public.assistive_validation_findings WHERE id = '${firstFindingId}'::uuid;`),
        evidenceBefore,
      );
    });

    // ---------------------------------------------------------------------
    // Absence of authoritative side effects
    // ---------------------------------------------------------------------
    await scenario(33, 'the project row is byte-for-byte unchanged by all assistive activity', () => {
      assert.equal(
        psql(`SELECT to_jsonb(p) FROM public.projects p WHERE p.id = '${projectId}'::uuid;`),
        projectSnapshotBefore,
      );
    });

    await scenario(34, 'no approval, validation flag, or publication side effect was created', () => {
      assert.equal(psql(`SELECT count(*) FROM public.approval_records WHERE project_id = '${projectId}'::uuid;`), auditCountBefore);
      assert.equal(psql(`SELECT count(*) FROM public.validation_flags WHERE project_id = '${projectId}'::uuid;`), flagCountBefore);
      assert.equal(psql('SELECT count(*) FROM public.published_snapshots;'), snapshotCountBefore);
      assert.equal(
        psql(`SELECT status || ':' || COALESCE(archived_at::text, 'none') || ':' || COALESCE(public_removal_completed_at::text, 'none') FROM public.projects WHERE id = '${projectId}'::uuid;`),
        'draft:none:none',
      );
    });

    await scenario(35, 'Phase 4 preserves all three Phase 3 RPCs and supplies one coherent job per legacy run', () => {
      assert.equal(
        psql("SELECT string_agg(table_name, ',' ORDER BY table_name) FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'assistive_validation_%';"),
        'assistive_validation_findings,assistive_validation_jobs,assistive_validation_runs',
      );
      assert.equal(
        psql(`SELECT string_agg(p.proname, ',' ORDER BY p.proname)
              FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname IN (
                'get_latest_assistive_validation_run','persist_assistive_validation_run',
                'record_assistive_finding_disposition');`),
        'get_latest_assistive_validation_run,persist_assistive_validation_run,record_assistive_finding_disposition',
      );
      assert.equal(
        psql(`SELECT count(*) FROM public.assistive_validation_runs r
              LEFT JOIN public.assistive_validation_jobs j ON j.run_id = r.id
              WHERE r.project_id = '${projectId}'::uuid
                AND (j.id IS NULL OR j.status <> r.status OR j.attempt_count <> 0);`),
        '0',
      );
    });

    await scenario(36, 'the table constraints reject bad evidence even for the database superuser', () => {
      // Executed as postgres, which bypasses grants and RLS, so this proves the closed evidence
      // contract itself rather than the access-control layer in front of it.
      const rejected = (evidence: Record<string, unknown>): string => {
        const serialized = JSON.stringify(evidence).replace(/'/g, "''");
        try {
          psql(`INSERT INTO public.assistive_validation_findings (run_id, check_type, outcome, reason_code, affected_field, origin, ordinal, evidence) VALUES ('${runId}'::uuid, 'FORMATTING', 'INFORMATION', 'REPEATED_WHITESPACE', 'extraction_text', 'DETERMINISTIC_HELPER', 9, '${serialized}'::jsonb);`);
        } catch (error) {
          return String((error as { stderr?: unknown }).stderr ?? '');
        }
        return '';
      };
      const sourceEvidence = phase2Findings()[0].evidence;
      if (sourceEvidence.version !== 'assistive-finding-evidence/v1') throw new Error('Expected v1 evidence');
      const complete = { ...sourceEvidence, explanation: 'direct insert probe' };
      const box = complete.boundingBox!;
      const missingPageNumber: Record<string, unknown> = { ...complete };
      delete missingPageNumber.pageNumber;
      const missingBottom: Record<string, unknown> = { ...box };
      delete missingBottom.bottom;
      const cases: Array<[Record<string, unknown>, RegExp]> = [
        [{ ...complete, version: 'assistive-finding-evidence/v2' }, /check_assistive_finding_duplicate_coherence/],
        [{ ...complete, rawOcrTranscript: 'x' }, /check_assistive_finding_evidence_keys/],
        [missingPageNumber, /check_assistive_finding_evidence_keys/],
        [{ ...complete, explanation: 'x'.repeat(301) }, /check_assistive_finding_evidence_explanation/],
        [{ ...complete, explanation: 'control\u0001character' }, /check_assistive_finding_evidence_explanation/],
        [{ ...complete, evidenceExcerpt: 'x'.repeat(501) }, /check_assistive_finding_evidence_excerpt/],
        [{ ...complete, evidenceExcerpt: 7 }, /check_assistive_finding_evidence_excerpt/],
        [{ ...complete, metadataValue: 'x'.repeat(401) }, /check_assistive_finding_evidence_values/],
        [{ ...complete, metadataValue: false }, /check_assistive_finding_evidence_values/],
        [{ ...complete, pageNumber: 0 }, /check_assistive_finding_evidence_page_number/],
        [{ ...complete, pageNumber: 11 }, /check_assistive_finding_evidence_page_number/],
        [{ ...complete, pageNumber: 1.5 }, /check_assistive_finding_evidence_page_number/],
        [{ ...complete, boundingBox: missingBottom }, /check_assistive_finding_evidence_bounding_box/],
        [{ ...complete, boundingBox: { ...box, depth: 1 } }, /check_assistive_finding_evidence_bounding_box/],
        [{ ...complete, boundingBox: { ...box, left: '52.5' } }, /check_assistive_finding_evidence_bounding_box/],
        [{ ...complete, boundingBox: { ...box, unit: 'NORMALIZED' } }, /check_assistive_finding_evidence_bounding_box/],
        [{ ...complete, boundingBox: { ...box, right: box.left - 1 } }, /check_assistive_finding_evidence_bounding_box/],
        [{ ...complete, boundingBox: { ...box, bottom: box.top - 1 } }, /check_assistive_finding_evidence_bounding_box/],
      ];
      for (const [evidence, constraint] of cases) {
        assert.match(rejected(evidence), constraint);
      }
      assert.equal(findingCountFor(inputHash), '3');
    });

    await scenario(37, 'removing the reviewing staff account degrades attribution without deleting evidence', async () => {
      // The coherence constraint anchors on reviewed_at precisely so this ON DELETE SET NULL can
      // run. Anchoring on reviewed_by would make the cascade violate the check and block deletion.
      const evidenceBefore = psql(`SELECT evidence::text FROM public.assistive_validation_findings WHERE id = '${firstFindingId}'::uuid;`);
      const reviewedAtBefore = psql(`SELECT reviewed_at::text FROM public.assistive_validation_findings WHERE id = '${firstFindingId}'::uuid;`);
      assert.ifError((await service.from('admin_users').delete().eq('id', reviewerAdminId)).error);
      adminIds.delete(reviewerAdminId);
      assert.equal(
        psql(`SELECT disposition || ':' || COALESCE(reviewed_by::text, 'none') || ':' || reviewed_at::text FROM public.assistive_validation_findings WHERE id = '${firstFindingId}'::uuid;`),
        `REVIEWED:none:${reviewedAtBefore}`,
      );
      assert.equal(
        psql(`SELECT evidence::text FROM public.assistive_validation_findings WHERE id = '${firstFindingId}'::uuid;`),
        evidenceBefore,
      );
      // The run survives the same way, with only its initiating attribution cleared.
      assert.equal(
        psql(`SELECT status || ':' || COALESCE(requested_by::text, 'none') FROM public.assistive_validation_runs WHERE id = '${runId}'::uuid;`),
        'COMPLETED:none',
      );
      assert.equal(findingCountFor(inputHash), '3');
    });

    await scenario(38, 'deleting the project cascades the assistive side domain away completely', () => {
      const runsBefore = psql(`SELECT count(*) FROM public.assistive_validation_runs WHERE project_id = '${projectId}'::uuid;`);
      assert.equal(runsBefore, '6');
      psql(`DELETE FROM public.projects WHERE id = '${projectId}'::uuid;`);
      assert.equal(psql(`SELECT count(*) FROM public.assistive_validation_runs WHERE project_id = '${projectId}'::uuid;`), '0');
      assert.equal(
        psql(`SELECT count(*) FROM public.assistive_validation_findings f WHERE NOT EXISTS (SELECT 1 FROM public.assistive_validation_runs r WHERE r.id = f.run_id);`),
        '0',
      );
      projectId = '';
    });

    assert.ifError((await staffClient.auth.signOut({ scope: 'local' })).error);
  } catch (error) {
    primaryFailure = error;
  } finally {
    try {
      if (projectId) {
        assert.ifError((await service.from('projects').delete().eq('id', projectId)).error);
      }
      if (softDeletedProjectId) {
        assert.ifError((await service.from('projects').delete().eq('id', softDeletedProjectId)).error);
      }
      for (const adminId of adminIds) {
        assert.ifError((await service.from('admin_users').delete().eq('id', adminId)).error);
      }
      for (const authId of authIds) {
        const deleted = await service.auth.admin.deleteUser(authId);
        if (deleted.error && !/not found/i.test(deleted.error.message)) {
          throw new Error('Verifier-owned Auth cleanup failed.');
        }
      }
      assert.equal(psql(`SELECT count(*) FROM public.projects WHERE public_id LIKE '${publicId}%';`), '0');
      assert.equal(psql(`SELECT count(*) FROM public.admin_users WHERE email LIKE '${prefix}%';`), '0');
      assert.equal(psql(`SELECT count(*) FROM auth.users WHERE email LIKE '${prefix}%';`), '0');
      assert.equal(
        psql(`SELECT count(*) FROM public.assistive_validation_runs WHERE input_hash IN ('${inputHash}', '${otherHash}', '${failedOnlyHash}');`),
        '0',
      );
      console.log('PASS: Scenario 39 - only verifier-owned fixtures were removed and none remain');
      passed += 1;
    } catch (error) {
      cleanupFailure = error;
    }
  }

  if (primaryFailure || cleanupFailure) {
    console.error('Assistive validation persistence runtime verification failed.');
    console.error(primaryFailure ?? cleanupFailure);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS: Assistive validation persistence Local runtime verification complete (${passed} scenarios).`);
}

void main();
