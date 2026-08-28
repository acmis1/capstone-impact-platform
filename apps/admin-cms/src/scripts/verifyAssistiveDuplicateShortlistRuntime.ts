import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync, execSync } from 'node:child_process';
import path from 'node:path';

import { createClient } from '@supabase/supabase-js';
import nativeFixture from '../../../assistive-worker/tests/fixtures/phase-2-consumer-native-pdf.json';

import { assistiveInspectionResponseSchema } from '../assistive-validation';
import { ASSISTIVE_PIPELINE_VERSION } from '../assistive-validation/domain/persistenceContract';
import { SupabaseAssistiveJobRepository } from '../assistive-validation/repositories/assistiveJobRepository';
import {
  SupabaseAssistiveInputRepository,
  type AssistiveInputGateway,
} from '../assistive-validation/repositories/assistiveInputRepository';
import { AssistiveValidationCoordinator } from '../assistive-validation/services/assistiveCoordinator';
import { enqueueAssistiveValidation } from '../assistive-validation/services/assistiveJobService';
import { loadAssistiveInput } from '../assistive-validation/services/assistiveInputService';
import type { AssistiveWorkerRunner } from '../assistive-validation/services/pythonWorkerProcess';
import { isLoopbackUrl, parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';

const DB_CONTAINER = 'supabase_db_capstone-impact-platform';
const PIPELINE = 'assistive-deterministic-checks/v2';
const PRIVATE_BUCKET = 'project-drafts-private';
const PDF = Buffer.from('%PDF-1.4\n% synthetic Phase 6B verifier\n', 'ascii');

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

interface VerifierCandidate {
  rank: number;
  publicId: string;
  title: string;
  summaryExcerpt: string;
  lexicalScore: number;
  exactContentMatch: boolean;
  normalizedTitleMatch: boolean;
}

/**
 * A lexical-only candidate: no exact content match, no normalized-title match, and a score strictly
 * below the exact-match value, in the descending order the deterministic ranker produces.
 */
function candidate(rank: number, overrides: Partial<VerifierCandidate> = {}): VerifierCandidate {
  return {
    rank,
    publicId: `2026-synthetic-similar-${rank}`,
    title: `Synthetic Similar Project ${rank}`,
    summaryExcerpt: `Bounded synthetic summary ${rank}.`,
    lexicalScore: Number((0.9 - rank * 0.1).toFixed(3)),
    exactContentMatch: false,
    normalizedTitleMatch: false,
    ...overrides,
  };
}

/** Canonical equality: implies the normalized title matched, and scores exactly 1. */
function exactCandidate(rank: number, overrides: Partial<VerifierCandidate> = {}): VerifierCandidate {
  return candidate(rank, {
    lexicalScore: 1, exactContentMatch: true, normalizedTitleMatch: true, ...overrides,
  });
}

const PROHIBITED_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const v1Finding = {
  checkType: 'TITLE_CONSISTENCY',
  outcome: 'AGREES',
  classification: 'NON_BLOCKING',
  reasonCode: 'NORMALIZED_EXACT_MATCH',
  affectedField: 'title',
  origin: 'DETERMINISTIC_HELPER',
  scoreKind: null,
  scoreValue: null,
  evidence: {
    version: 'assistive-finding-evidence/v1',
    evidenceExcerpt: null,
    pageNumber: null,
    boundingBox: null,
    metadataValue: 'Synthetic Phase 6B Project',
    normalizedMetadataValue: 'synthetic phase 6b project',
    candidateValue: 'Synthetic Phase 6B Project',
    normalizedCandidateValue: 'synthetic phase 6b project',
    explanation: 'The normalized project and document titles agree.',
  },
};

/**
 * The outcome and reason are not independent knobs: they follow from the candidate flags, exactly
 * as the production converter derives them. Passing candidates that disagree with the supplied
 * outcome/reason is how the incoherence scenarios below are built.
 */
function shortlistFinding(
  candidates: readonly VerifierCandidate[],
  overrides: { outcome?: string; reasonCode?: string } = {},
) {
  const hasExactOrNormalized = candidates.some(
    (item) => item.exactContentMatch || item.normalizedTitleMatch,
  );
  return {
    checkType: 'DUPLICATE_SHORTLIST',
    outcome: overrides.outcome ?? (hasExactOrNormalized ? 'REVIEW' : 'INFORMATION'),
    classification: 'NON_BLOCKING',
    reasonCode: overrides.reasonCode ?? (hasExactOrNormalized
      ? 'EXACT_OR_NORMALIZED_DUPLICATE_PRESENT'
      : 'LEXICAL_DUPLICATE_SHORTLIST'),
    affectedField: 'project_content',
    origin: 'DETERMINISTIC_HELPER',
    scoreKind: null,
    scoreValue: null,
    evidence: {
      version: 'assistive-finding-evidence/v2',
      evidenceExcerpt: null,
      pageNumber: null,
      boundingBox: null,
      metadataValue: null,
      normalizedMetadataValue: null,
      candidateValue: null,
      normalizedCandidateValue: null,
      explanation: 'Review these lexically similar project records. Staff decide whether any projects are duplicates.',
      duplicateCandidates: [...candidates],
    },
  };
}

function duplicateFinding(count: number) {
  return shortlistFinding(Array.from({ length: count }, (_, index) => candidate(index + 1)));
}

async function main(): Promise<void> {
  console.log('=== Assistive Duplicate Shortlist Migration 0033 Local Runtime Verification ===');
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
  const rpc = async (name: string, parameters: Record<string, unknown>) => {
    const result = await service.rpc(name, parameters);
    assert.ifError(result.error);
    return result.data as Record<string, unknown>;
  };
  const validator = (findings: unknown[]): boolean => psql(
    `SELECT public.is_valid_assistive_validation_findings($json$${JSON.stringify(findings)}$json$::jsonb);`,
  ) === 't';

  const prefix = `assistive-dup-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  let actorId = '';
  let projectId = '';
  const candidateProjectIds: string[] = [];
  let privatePosterPath = '';
  let passed = 0;
  let primaryFailure: unknown = null;
  let cleanupFailure: unknown = null;
  const scenario = async (number: number | string, name: string, body: () => Promise<void> | void) => {
    await body();
    passed += 1;
    console.log(`PASS: Scenario ${number} - ${name}`);
  };

  try {
    const actor = await service.from('admin_users').insert({
      email: `${prefix}@capstone.test`,
      full_name: 'Synthetic Duplicate Shortlist Reviewer',
    }).select('id').single();
    assert.ifError(actor.error);
    actorId = String(actor.data!.id);
    assert.ifError((await service.from('user_roles').insert({ user_id: actorId, role: 'reviewer' })).error);

    const project = await service.from('projects').insert({
      public_id: `2026-${prefix}`,
      title: 'Synthetic Phase 6B Project',
      summary: 'Disposable local duplicate shortlist fixture.',
      background: 'The fixture exists only for loopback verification.',
      solution: 'The verifier checks bounded lexical evidence.',
      status: 'submitted',
      year: 2026,
      program_name: 'Synthetic Software Engineering',
      discipline: 'Software Engineering',
      group_name: `Synthetic Group ${prefix}`,
      team_members: ['Synthetic Member'],
    }).select('id').single();
    assert.ifError(project.error);
    projectId = String(project.data!.id);

    const candidateProject = await service.from('projects').insert({
      public_id: `2026-${prefix}-candidate`,
      title: 'Synthetic Phase 6B Project',
      summary: 'Disposable local duplicate candidate fixture.',
      background: 'The candidate exists only for loopback verification.',
      solution: 'The verifier checks corpus identity and supersession.',
      status: 'published',
      year: 2025,
      program_name: 'Synthetic Software Engineering',
      discipline: 'Software Engineering',
      group_name: `Synthetic Candidate Group ${prefix}`,
      team_members: ['Synthetic Candidate'],
    }).select('id').single();
    assert.ifError(candidateProject.error);
    candidateProjectIds.push(String(candidateProject.data!.id));

    privatePosterPath = `drafts/2026-${prefix}/poster_pdf/poster.pdf`;
    const upload = await service.storage.from(PRIVATE_BUCKET).upload(privatePosterPath, PDF, {
      contentType: 'application/pdf',
      upsert: false,
    });
    assert.ifError(upload.error);
    const media = await service.from('media_assets').insert({
      project_id: projectId,
      asset_type: 'poster_pdf',
      file_name: 'poster.pdf',
      storage_bucket: PRIVATE_BUCKET,
      storage_path: privatePosterPath,
      mime_type: 'application/pdf',
      file_size_bytes: PDF.length,
      is_public_approved: false,
    });
    assert.ifError(media.error);

    let projectBefore = '';
    const approvalBefore = psql(`SELECT count(*) FROM public.approval_records WHERE project_id = '${projectId}'::uuid;`);
    const publicationBefore = psql('SELECT count(*) FROM public.published_snapshots;');

    await scenario(1, 'clean schema has exactly 47 applied migrations', () => {
      assert.equal(psql('SELECT count(*) FROM supabase_migrations.schema_migrations;'), '47');
    });
    await scenario(2, 'v1 and one-candidate v2 findings satisfy the shared validator', () => {
      assert.equal(validator([v1Finding, duplicateFinding(1)]), true);
    });
    await scenario(3, 'exactly five candidates satisfy the database boundary', () => {
      assert.equal(validator([duplicateFinding(5)]), true);
    });
    await scenario(3.1, 'an empty v2 candidate list is rejected because zero candidates produce no shortlist finding', () => {
      assert.equal(validator([duplicateFinding(0)]), false);
    });
    await scenario(4, 'more than five candidates are rejected', () => {
      assert.equal(validator([duplicateFinding(6)]), false);
    });
    await scenario(5, 'out-of-range and non-contiguous ranks are rejected', () => {
      const zero = duplicateFinding(1);
      zero.evidence.duplicateCandidates[0].rank = 0;
      const skipped = duplicateFinding(2);
      skipped.evidence.duplicateCandidates[1].rank = 3;
      assert.equal(validator([zero]), false);
      assert.equal(validator([skipped]), false);
    });
    await scenario(6, 'duplicate candidate public IDs are rejected', () => {
      const finding = duplicateFinding(2);
      finding.evidence.duplicateCandidates[1].publicId = finding.evidence.duplicateCandidates[0].publicId;
      assert.equal(validator([finding]), false);
    });
    await scenario(7, 'candidate scores below zero or above one are rejected', () => {
      const below = duplicateFinding(1);
      below.evidence.duplicateCandidates[0].lexicalScore = -0.01;
      const above = duplicateFinding(1);
      above.evidence.duplicateCandidates[0].lexicalScore = 1.01;
      assert.equal(validator([below]), false);
      assert.equal(validator([above]), false);
    });
    await scenario(8, 'oversized candidate title and summary excerpt are rejected', () => {
      const title = duplicateFinding(1);
      title.evidence.duplicateCandidates[0].title = 'x'.repeat(201);
      const summary = duplicateFinding(1);
      summary.evidence.duplicateCandidates[0].summaryExcerpt = 'x'.repeat(241);
      assert.equal(validator([title]), false);
      assert.equal(validator([summary]), false);
    });
    await scenario(9, 'prohibited controls and unknown/private candidate keys are rejected', () => {
      const control = duplicateFinding(1);
      control.evidence.duplicateCandidates[0].title = 'unsafe\u0001text';
      const privateKey = duplicateFinding(1) as ReturnType<typeof duplicateFinding> & {
        evidence: { duplicateCandidates: Array<Record<string, unknown>> };
      };
      privateKey.evidence.duplicateCandidates[0].databaseUuid = crypto.randomUUID();
      const unsafeRoute = duplicateFinding(1);
      unsafeRoute.evidence.duplicateCandidates[0].publicId = '../private-project';
      assert.equal(validator([control]), false);
      assert.equal(validator([privateKey]), false);
      assert.equal(validator([unsafeRoute]), false);
    });
    await scenario(10, 'unknown evidence keys and blocking classification are rejected', () => {
      const evidenceKey = duplicateFinding(1) as ReturnType<typeof duplicateFinding> & {
        evidence: Record<string, unknown>;
      };
      evidenceKey.evidence.privateData = 'forbidden';
      const blocking = { ...duplicateFinding(1), classification: 'BLOCKING' };
      assert.equal(validator([evidenceKey]), false);
      assert.equal(validator([blocking]), false);
    });
    await scenario(11, 'v2 evidence cannot be smuggled onto another check type', () => {
      assert.equal(validator([{ ...duplicateFinding(1), checkType: 'FORMATTING' }]), false);
    });

    const lexicalOnly = [candidate(1), candidate(2), candidate(3)];
    const withExact = [exactCandidate(1), candidate(2)];
    const withNormalizedTitleOnly = [candidate(1, { normalizedTitleMatch: true }), candidate(2)];

    await scenario('11.1', 'a lexical-only shortlist is accepted as INFORMATION with the lexical reason', () => {
      assert.equal(validator([shortlistFinding(lexicalOnly)]), true);
    });
    await scenario('11.2', 'exact and normalized-title shortlists are accepted as REVIEW with the exact reason', () => {
      assert.equal(validator([shortlistFinding(withExact)]), true);
      assert.equal(validator([shortlistFinding(withNormalizedTitleOnly)]), true);
    });
    await scenario('11.3', 'a lexical-only shortlist cannot claim REVIEW or the exact reason', () => {
      assert.equal(validator([shortlistFinding(lexicalOnly, { outcome: 'REVIEW' })]), false);
      assert.equal(validator([shortlistFinding(lexicalOnly, {
        reasonCode: 'EXACT_OR_NORMALIZED_DUPLICATE_PRESENT',
      })]), false);
      assert.equal(validator([shortlistFinding(lexicalOnly, {
        outcome: 'REVIEW', reasonCode: 'EXACT_OR_NORMALIZED_DUPLICATE_PRESENT',
      })]), false);
    });
    await scenario('11.4', 'an exact or normalized-title shortlist cannot claim INFORMATION or the lexical reason', () => {
      assert.equal(validator([shortlistFinding(withExact, { outcome: 'INFORMATION' })]), false);
      assert.equal(validator([shortlistFinding(withExact, {
        reasonCode: 'LEXICAL_DUPLICATE_SHORTLIST',
      })]), false);
      assert.equal(validator([shortlistFinding(withNormalizedTitleOnly, {
        outcome: 'INFORMATION', reasonCode: 'LEXICAL_DUPLICATE_SHORTLIST',
      })]), false);
    });
    await scenario('11.5', 'an exact content match that denies the normalized title is rejected', () => {
      assert.equal(validator([shortlistFinding([
        exactCandidate(1, { normalizedTitleMatch: false }),
      ])]), false);
    });
    await scenario('11.6', 'the exact-match score is pinned to 1 and no other candidate may claim it', () => {
      assert.equal(validator([shortlistFinding([exactCandidate(1, { lexicalScore: 0.7 })])]), false);
      assert.equal(validator([shortlistFinding([exactCandidate(1, { lexicalScore: 0.999 })])]), false);
      assert.equal(validator([shortlistFinding([candidate(1, { lexicalScore: 1 })])]), false);
      assert.equal(validator([shortlistFinding([
        candidate(1, { normalizedTitleMatch: true, lexicalScore: 1 }),
      ])]), false);
      assert.equal(validator([shortlistFinding([candidate(1, { lexicalScore: 0.999 })])]), true);
    });
    await scenario('11.7', 'a shortlist whose scores increase with rank is rejected', () => {
      assert.equal(validator([shortlistFinding([
        candidate(1, { lexicalScore: 0.20 }),
        candidate(2, { lexicalScore: 0.90 }),
      ])]), false);
    });
    await scenario('11.8', 'an equal-score tie ordered against the public-ID tie breaker is rejected', () => {
      assert.equal(validator([shortlistFinding([
        candidate(1, { publicId: '2026-synthetic-similar-a', lexicalScore: 0.5 }),
        candidate(2, { publicId: '2026-synthetic-similar-b', lexicalScore: 0.5 }),
      ])]), true);
      assert.equal(validator([shortlistFinding([
        candidate(1, { publicId: '2026-synthetic-similar-b', lexicalScore: 0.5 }),
        candidate(2, { publicId: '2026-synthetic-similar-a', lexicalScore: 0.5 }),
      ])]), false);
    });

    const inputRepository = new SupabaseAssistiveInputRepository(service);
    const baselineInput = await loadAssistiveInput(inputRepository, projectId, PRIVATE_BUCKET);
    assert(baselineInput, 'Production input repository could not load the synthetic private poster.');

    await scenario('11a', 'current prose changes the composite v2 identity while operational state does not', async () => {
      const changed = await service.from('projects').update({
        summary: 'Changed current-project summary for identity verification.',
      }).eq('id', projectId);
      assert.ifError(changed.error);
      const changedInput = await loadAssistiveInput(inputRepository, projectId, PRIVATE_BUCKET);
      assert(changedInput && changedInput.inputHash !== baselineInput.inputHash);
      const restored = await service.from('projects').update({
        summary: 'Disposable local duplicate shortlist fixture.',
      }).eq('id', projectId);
      assert.ifError(restored.error);
      const restoredInput = await loadAssistiveInput(inputRepository, projectId, PRIVATE_BUCKET);
      assert.equal(restoredInput?.inputHash, baselineInput.inputHash);
    });

    await scenario('11b', 'candidate prose/add/remove changes corpus identity while workflow status is excluded', async () => {
      const candidateId = candidateProjectIds[0];
      const proseChange = await service.from('projects').update({
        summary: 'Changed candidate summary for corpus verification.',
      }).eq('id', candidateId);
      assert.ifError(proseChange.error);
      const changedProseInput = await loadAssistiveInput(inputRepository, projectId, PRIVATE_BUCKET);
      assert(changedProseInput && changedProseInput.inputHash !== baselineInput.inputHash);

      const restored = await service.from('projects').update({
        summary: 'Disposable local duplicate candidate fixture.',
      }).eq('id', candidateId);
      assert.ifError(restored.error);
      const statusChange = await service.from('projects').update({ status: 'archived' }).eq('id', candidateId);
      assert.ifError(statusChange.error);
      assert.equal((await loadAssistiveInput(inputRepository, projectId, PRIVATE_BUCKET))?.inputHash, baselineInput.inputHash);

      const extra = await service.from('projects').insert({
        public_id: `2026-${prefix}-candidate-extra`, title: 'Extra corpus record',
        summary: 'Temporary candidate.', background: 'Temporary background.', solution: 'Temporary solution.',
        status: 'draft', year: 2024, program_name: 'Synthetic Software Engineering',
        discipline: 'Software Engineering', group_name: `Synthetic Extra Group ${prefix}`,
        team_members: ['Synthetic Extra Candidate'],
      }).select('id').single();
      assert.ifError(extra.error);
      const extraId = String(extra.data!.id);
      candidateProjectIds.push(extraId);
      assert.notEqual((await loadAssistiveInput(inputRepository, projectId, PRIVATE_BUCKET))?.inputHash, baselineInput.inputHash);
      assert.ifError((await service.from('projects').delete().eq('id', extraId)).error);
      candidateProjectIds.splice(candidateProjectIds.indexOf(extraId), 1);
      assert.equal((await loadAssistiveInput(inputRepository, projectId, PRIVATE_BUCKET))?.inputHash, baselineInput.inputHash);
    });

    await scenario('11c', 'a real queued run supersedes when the comparison corpus changes before finalization', async () => {
      const jobRepository = new SupabaseAssistiveJobRepository(service);
      const enqueued = await enqueueAssistiveValidation(jobRepository, inputRepository, {
        projectId,
        actorAdminUserId: actorId,
        privateBucket: PRIVATE_BUCKET,
        pipelineVersion: ASSISTIVE_PIPELINE_VERSION,
      });
      assert.equal(enqueued.resultCode, 'ENQUEUED');
      assert('runId' in enqueued);

      let projectLoads = 0;
      const changingInput: AssistiveInputGateway = {
        loadProject: async (id) => {
          projectLoads += 1;
          if (projectLoads === 2) {
            const mutation = await service.from('projects').update({
              solution: 'Corpus changed while the synthetic worker was running.',
            }).eq('id', candidateProjectIds[0]);
            assert.ifError(mutation.error);
          }
          return inputRepository.loadProject(id);
        },
        loadDuplicateCandidates: (id) => inputRepository.loadDuplicateCandidates(id),
        loadPosterAssets: (id, bucket) => inputRepository.loadPosterAssets(id, bucket),
        download: (bucket, objectPath) => inputRepository.download(bucket, objectPath),
      };
      const worker: AssistiveWorkerRunner = {
        run: async () => ({
          schema_version: 'assistive-worker-task-result/v1',
          task_id: crypto.randomUUID(),
          extraction: nativeFixture,
          error: null,
          duration_ms: 1,
        }),
      } as AssistiveWorkerRunner;
      const coordinator = new AssistiveValidationCoordinator(
        jobRepository,
        changingInput,
        PRIVATE_BUCKET,
        worker,
        crypto.randomUUID(),
      );
      const result = await coordinator.runOnce();
      assert.deepEqual(result, { outcome: 'SUPERSEDED', runId: enqueued.runId });
      assert.equal(psql(`SELECT status FROM public.assistive_validation_runs WHERE id = '${enqueued.runId}'::uuid;`), 'SUPERSEDED');
      assert.equal(psql(`SELECT count(*) FROM public.assistive_validation_findings WHERE run_id = '${enqueued.runId}'::uuid;`), '0');
    });

    projectBefore = psql(`SELECT to_jsonb(p)::text FROM public.projects p WHERE p.id = '${projectId}'::uuid;`);

    const persisted = await rpc('persist_assistive_validation_run', {
      p_project_id: projectId,
      p_actor_admin_id: actorId,
      p_input_hash: hash(`${prefix}-five`),
      p_pipeline_version: PIPELINE,
      p_status: 'COMPLETED',
      p_failure_code: null,
      p_findings: [v1Finding, duplicateFinding(5)],
    });
    assert.equal(persisted.resultCode, 'PERSISTED');
    const runId = String(persisted.runId);

    await scenario(12, 'v1 and v2 findings persist atomically in one pipeline-v2 run', () => {
      assert.equal(persisted.findingCount, 2);
      assert.equal(psql(`SELECT count(*) FROM public.assistive_validation_findings WHERE run_id = '${runId}'::uuid;`), '2');
    });
    await scenario(13, 'staff inspection round-trips strict browser-safe v2 evidence', async () => {
      const raw = await rpc('get_project_assistive_validation_inspection', {
        p_project_id: projectId,
        p_pipeline_version: PIPELINE,
        p_run_id: runId,
      });
      const parsed = assistiveInspectionResponseSchema.safeParse(raw);
      assert.equal(parsed.success, true, parsed.success ? '' : JSON.stringify(parsed.error.issues));
      assert.equal(parsed.success && parsed.data.resultCode, 'FOUND');
      if (parsed.success && parsed.data.resultCode === 'FOUND') {
        const shortlist = parsed.data.findings.find((finding) => finding.checkType === 'DUPLICATE_SHORTLIST');
        assert(shortlist && shortlist.evidence.version === 'assistive-finding-evidence/v2');
        assert.equal(shortlist.evidence.duplicateCandidates.length, 5);
      }
      const serialized = JSON.stringify(raw);
      for (const forbidden of ['claimToken', 'workerId', 'leaseUntil', 'storagePath', 'reviewedBy', 'reviewedAt', 'databaseUuid']) {
        assert.equal(serialized.includes(forbidden), false, `Inspection leaked ${forbidden}.`);
      }
    });

    const shortlistId = psql(`SELECT id::text FROM public.assistive_validation_findings WHERE run_id = '${runId}'::uuid AND check_type = 'DUPLICATE_SHORTLIST';`);
    await scenario(14, 'Mark reviewed persists on the shortlist as a whole', async () => {
      const result = await rpc('record_assistive_finding_disposition', {
        p_finding_id: shortlistId, p_actor_admin_id: actorId, p_disposition: 'REVIEWED',
      });
      assert.equal(result.resultCode, 'RECORDED');
      assert.equal(result.disposition, 'REVIEWED');
    });
    await scenario(15, 'Ignore persists on the same shortlist without project mutation', async () => {
      const result = await rpc('record_assistive_finding_disposition', {
        p_finding_id: shortlistId, p_actor_admin_id: actorId, p_disposition: 'IGNORED',
      });
      assert.equal(result.resultCode, 'RECORDED');
      assert.equal(result.disposition, 'IGNORED');
    });
    await scenario(16, 'service_role and browser roles retain no direct assistive table access', async () => {
      const serviceRead = await service.from('assistive_validation_findings').select('id').limit(1);
      const anonymousRead = await anonymous.from('assistive_validation_findings').select('id').limit(1);
      assert(serviceRead.error, 'service_role direct table read unexpectedly succeeded.');
      assert(anonymousRead.error, 'anon direct table read unexpectedly succeeded.');
      assert.equal(psql("SELECT has_table_privilege('authenticated', 'public.assistive_validation_findings', 'SELECT');"), 'f');
    });
    await scenario(17, 'anon and authenticated cannot execute the inspection RPC', async () => {
      const anonResult = await anonymous.rpc('get_project_assistive_validation_inspection', {
        p_project_id: projectId, p_pipeline_version: PIPELINE, p_run_id: runId,
      });
      assert(anonResult.error, 'Anon inspection RPC unexpectedly succeeded.');
      assert.equal(psql("SELECT has_function_privilege('authenticated', 'public.get_project_assistive_validation_inspection(uuid,text,uuid)', 'EXECUTE');"), 'f');
    });
    /**
     * The application caller is correct today, so the table itself is exercised directly as a
     * superuser: nothing but the CHECK constraint stands between these rows and the table.
     */
    let ordinal = 10;
    const directInsert = (finding: ReturnType<typeof shortlistFinding>): boolean => {
      ordinal += 1;
      try {
        psql(`INSERT INTO public.assistive_validation_findings (
            run_id, check_type, outcome, classification, reason_code, affected_field, origin,
            ordinal, score_kind, score_value, evidence
          ) VALUES (
            '${runId}'::uuid, 'DUPLICATE_SHORTLIST', '${finding.outcome}', 'NON_BLOCKING',
            '${finding.reasonCode}', 'project_content', 'DETERMINISTIC_HELPER',
            ${ordinal}, NULL, NULL, $json$${JSON.stringify(finding.evidence)}$json$::jsonb
          );`);
        return true;
      } catch {
        return false;
      }
    };

    await scenario('17.1', 'a direct superuser insert of coherent shortlist evidence is accepted', () => {
      assert.equal(directInsert(shortlistFinding([candidate(1), candidate(2)])), true);
      assert.equal(directInsert(shortlistFinding([exactCandidate(1), candidate(2)])), true);
      psql(`DELETE FROM public.assistive_validation_findings WHERE run_id = '${runId}'::uuid AND ordinal > 10;`);
    });
    await scenario('17.2', 'the table itself refuses incoherent duplicate evidence from a direct insert', () => {
      const rejected = [
        // Outcome and reason must follow from the candidate flags, in both directions.
        shortlistFinding([candidate(1)], { outcome: 'REVIEW' }),
        shortlistFinding([candidate(1)], { reasonCode: 'EXACT_OR_NORMALIZED_DUPLICATE_PRESENT' }),
        shortlistFinding([exactCandidate(1)], { outcome: 'INFORMATION' }),
        shortlistFinding([exactCandidate(1)], { reasonCode: 'LEXICAL_DUPLICATE_SHORTLIST' }),
        // Flag and score combinations the deterministic ranker cannot produce.
        shortlistFinding([exactCandidate(1, { normalizedTitleMatch: false })]),
        shortlistFinding([exactCandidate(1, { lexicalScore: 0.7 })]),
        shortlistFinding([candidate(1, { lexicalScore: 1 })]),
        // Rank order that is not the ranker's order.
        shortlistFinding([candidate(1, { lexicalScore: 0.2 }), candidate(2, { lexicalScore: 0.9 })]),
        shortlistFinding([
          candidate(1, { publicId: '2026-synthetic-similar-b', lexicalScore: 0.5 }),
          candidate(2, { publicId: '2026-synthetic-similar-a', lexicalScore: 0.5 }),
        ]),
      ];
      for (const finding of rejected) {
        assert.equal(directInsert(finding), false, `Table accepted incoherent evidence: ${JSON.stringify(finding.evidence.duplicateCandidates)}`);
      }
      assert.equal(psql(`SELECT count(*) FROM public.assistive_validation_findings WHERE run_id = '${runId}'::uuid;`), '2');
    });

    await scenario(18, 'project metadata, workflow, approval, and publication state remain unchanged', () => {
      assert.equal(psql(`SELECT to_jsonb(p)::text FROM public.projects p WHERE p.id = '${projectId}'::uuid;`), projectBefore);
      assert.equal(psql(`SELECT count(*) FROM public.approval_records WHERE project_id = '${projectId}'::uuid;`), approvalBefore);
      assert.equal(psql('SELECT count(*) FROM public.published_snapshots;'), publicationBefore);
    });

    /**
     * A historical project row is only required to be bounded, not free of interior control
     * characters. U+001F, U+0001 and U+007F are all storable PostgreSQL text (unlike NUL, which the
     * text type itself refuses), so this is reachable legacy data rather than a hypothetical.
     */
    const controlTitle = 'Synthetic Control\u001FCandidate';
    const controlSummary = 'Legacy prose with\u0001an unexpected control and\u007Fa delete marker.';
    let controlRunId = '';
    let candidateProseBefore = '';

    await scenario(19, 'a candidate control character cannot fail the whole assistive run', async () => {
      const hostile = await service.from('projects').update({
        title: controlTitle, summary: controlSummary,
      }).eq('id', candidateProjectIds[0]);
      assert.ifError(hostile.error);
      candidateProseBefore = psql(`SELECT to_jsonb(p)::text FROM public.projects p WHERE p.id = '${candidateProjectIds[0]}'::uuid;`);
      assert(PROHIBITED_CONTROLS.test(candidateProseBefore), 'The hostile candidate prose was not stored with its control characters.');

      const jobRepository = new SupabaseAssistiveJobRepository(service);
      const enqueued = await enqueueAssistiveValidation(jobRepository, inputRepository, {
        projectId,
        actorAdminUserId: actorId,
        privateBucket: PRIVATE_BUCKET,
        pipelineVersion: ASSISTIVE_PIPELINE_VERSION,
      });
      assert.equal(enqueued.resultCode, 'ENQUEUED');
      assert('runId' in enqueued);
      controlRunId = enqueued.runId;

      const worker: AssistiveWorkerRunner = {
        run: async () => ({
          schema_version: 'assistive-worker-task-result/v1',
          task_id: crypto.randomUUID(),
          extraction: nativeFixture,
          error: null,
          duration_ms: 1,
        }),
      } as AssistiveWorkerRunner;
      const coordinator = new AssistiveValidationCoordinator(
        jobRepository, inputRepository, PRIVATE_BUCKET, worker, crypto.randomUUID(),
      );
      const result = await coordinator.runOnce();
      assert.deepEqual(result, { outcome: 'FINALIZED', runId: controlRunId });
      assert.equal(psql(`SELECT failure_code IS NULL FROM public.assistive_validation_runs WHERE id = '${controlRunId}'::uuid;`), 't');
      assert.equal(psql(`SELECT count(*) FROM public.assistive_validation_findings WHERE run_id = '${controlRunId}'::uuid AND check_type = 'DUPLICATE_SHORTLIST';`), '1');
    });

    await scenario(20, 'the persisted shortlist evidence is sanitized and round-trips through staff inspection', async () => {
      const raw = await rpc('get_project_assistive_validation_inspection', {
        p_project_id: projectId,
        p_pipeline_version: ASSISTIVE_PIPELINE_VERSION,
        p_run_id: controlRunId,
      });
      const parsed = assistiveInspectionResponseSchema.safeParse(raw);
      assert.equal(parsed.success, true, parsed.success ? '' : JSON.stringify(parsed.error.issues));
      assert(parsed.success && parsed.data.resultCode === 'FOUND');
      const shortlist = parsed.data.findings.find((finding) => finding.checkType === 'DUPLICATE_SHORTLIST');
      assert(shortlist && shortlist.evidence.version === 'assistive-finding-evidence/v2');
      const hostileCandidate = shortlist.evidence.duplicateCandidates.find(
        (item) => item.publicId === `2026-${prefix}-candidate`,
      );
      assert(hostileCandidate, 'The hostile candidate is missing from the shortlist.');
      assert.equal(hostileCandidate.title, 'Synthetic Control�Candidate');
      assert.equal(
        hostileCandidate.summaryExcerpt,
        'Legacy prose with�an unexpected control and�a delete marker.',
      );
      assert.equal(PROHIBITED_CONTROLS.test(JSON.stringify(raw)), false, 'Inspection returned a raw prohibited control.');
      assert.equal(PROHIBITED_CONTROLS.test(psql(`SELECT evidence::text FROM public.assistive_validation_findings WHERE run_id = '${controlRunId}'::uuid AND check_type = 'DUPLICATE_SHORTLIST';`)), false);
    });

    await scenario(21, 'the authoritative candidate prose is never rewritten by evidence sanitization', () => {
      const candidateProseAfter = psql(`SELECT to_jsonb(p)::text FROM public.projects p WHERE p.id = '${candidateProjectIds[0]}'::uuid;`);
      assert.equal(candidateProseAfter, candidateProseBefore);
      assert.equal(psql(`SELECT title FROM public.projects WHERE id = '${candidateProjectIds[0]}'::uuid;`), controlTitle);
      assert(PROHIBITED_CONTROLS.test(candidateProseAfter), 'The source project prose was modified.');
      assert.equal(psql(`SELECT to_jsonb(p)::text FROM public.projects p WHERE p.id = '${projectId}'::uuid;`), projectBefore);
      assert.equal(psql('SELECT count(*) FROM public.published_snapshots;'), publicationBefore);
    });
  } catch (error) {
    primaryFailure = error;
  } finally {
    try {
      if (privatePosterPath) {
        const storageCleanup = await service.storage.from(PRIVATE_BUCKET).remove([privatePosterPath]);
        assert.ifError(storageCleanup.error);
      }
      if (projectId) {
        psql(`
          DELETE FROM public.assistive_validation_findings WHERE run_id IN (SELECT id FROM public.assistive_validation_runs WHERE project_id = '${projectId}'::uuid);
          DELETE FROM public.assistive_validation_jobs WHERE run_id IN (SELECT id FROM public.assistive_validation_runs WHERE project_id = '${projectId}'::uuid);
          DELETE FROM public.assistive_validation_runs WHERE project_id = '${projectId}'::uuid;
          DELETE FROM public.projects WHERE id = '${projectId}'::uuid;
        `);
      }
      if (candidateProjectIds.length > 0) {
        const candidateCleanup = await service.from('projects').delete().in('id', candidateProjectIds);
        assert.ifError(candidateCleanup.error);
      }
      if (actorId) {
        psql(`
          DELETE FROM public.user_roles WHERE user_id = '${actorId}'::uuid;
          DELETE FROM public.admin_users WHERE id = '${actorId}'::uuid;
        `);
      }
    } catch (error) {
      cleanupFailure = error;
    }
  }

  if (primaryFailure) {
    console.error('FAIL: Assistive duplicate shortlist runtime verification failed:', primaryFailure);
    process.exit(1);
  }
  if (cleanupFailure) {
    console.error('FAIL: Assistive duplicate shortlist cleanup failed:', cleanupFailure);
    process.exit(1);
  }
  console.log(`\nALL ${passed} SCENARIOS PASSED for Migration 0033 duplicate shortlist runtime verification.`);
}

main().catch((error) => {
  console.error('Unexpected fatal error:', error);
  process.exit(1);
});
