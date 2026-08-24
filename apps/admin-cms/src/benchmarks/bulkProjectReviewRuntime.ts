import assert from 'node:assert/strict';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { generateSyntheticProjects, DEFAULT_SYNTHETIC_SEED } from '../fixtures/syntheticProjects';
import { BulkReviewAction, BulkReviewActor, BulkReviewPreflightResponse, BulkReviewExecutionResponse } from '../projects/bulkProjectReview';
import { BulkReviewService } from '../projects/bulkProjectReviewService';
import { SupabaseBulkProjectReviewGateway } from '../projects/SupabaseBulkProjectReviewGateway';
import { isLoopbackUrl } from '../local-development/localEnvironmentFile';
import {
  acquireBulkReviewReferenceFixtures,
  cleanupBulkReviewReferenceFixtures,
  referenceFixtureCleanupIsClean,
  type BulkReviewReferenceOwnership,
} from './bulkProjectReviewReferenceFixtures';

export interface BulkRuntimePreflightSummary {
  total: number;
  eligible: number;
  blocked: number;
  alreadyComplete: number;
  invalidOrStale: number;
}

export interface BulkRuntimeExecutionSummary {
  total: number;
  successful: number;
  blocked: number;
  alreadyComplete: number;
  invalidOrStale: number;
  failed: number;
}

export interface BulkRuntimeStageReport {
  stage: string;
  selected: number;
  eligible: number;
  blocked: number;
  alreadyComplete: number;
  invalidOrStale: number;
  successful: number;
  failed: number;
  durationMs: number;
}

export interface BulkRuntimeCleanupResidue {
  projects: number;
  batches: number;
  projectDisciplines: number;
  projectIndustryCategories: number;
  mediaAssets: number;
  validationFlags: number;
  approvalRecords: number;
  participantPreviews: number;
  correctionRequests: number;
  confirmations: number;
  referencePrograms: number;
  referenceDisciplines: number;
  referenceIndustryCategories: number;
}

export interface BulkProjectReviewRuntimeReport {
  seed: number;
  total: number;
  selected: number;
  eligible: number;
  blocked: number;
  alreadyComplete: number;
  stale: number;
  successful: number;
  failed: number;
  submit: { preflight: BulkRuntimePreflightSummary; execution: BulkRuntimeExecutionSummary; transitionCount: number };
  approval: { preflight: BulkRuntimePreflightSummary; execution: BulkRuntimeExecutionSummary; transitionCount: number };
  requestChanges: { execution: BulkRuntimeExecutionSummary; comment: string };
  workflowTransitions: number;
  uniqueProjectsTransitioned: number;
  auditCount: number;
  duplicateAudits: number;
  staleProjectIds: string[];
  batchCount: number;
  concurrency: {
    duplicateExecution: boolean;
    sameActionOverlap: boolean;
    conflictingOverlap: boolean;
    stalePreflight: boolean;
    deadlocks: number;
  };
  stages: BulkRuntimeStageReport[];
  referenceFixtures: { created: BulkReviewReferenceOwnership };
  cleanup: { clean: boolean; residue: BulkRuntimeCleanupResidue };
}

export interface BulkProjectReviewRuntimeOptions {
  apiUrl: string;
  serviceRoleKey: string;
  seed?: number;
  evidenceMode?: boolean;
}

interface ReferenceIds {
  programIds: string[];
  disciplineIds: string[];
  industryIds: string[];
  adminId: string;
}

interface FixtureProject {
  id: string;
  publicId: string;
  batchId: string;
}

function assertLocal(apiUrl: string): void {
  if (!isLoopbackUrl(apiUrl)) {
    throw new Error('Bulk project review runtime requires a loopback-only Local Supabase endpoint.');
  }
}

function requireData<T>(data: T | null, error: unknown, message: string): T {
  if (error || data === null) throw new Error(message);
  return data;
}

function preflightSummary(preflight: BulkReviewPreflightResponse): BulkRuntimePreflightSummary {
  return { ...preflight.summary };
}

function executionSummary(result: BulkReviewExecutionResponse): BulkRuntimeExecutionSummary {
  return { ...result.summary };
}

function addPreflightSummary(current: BulkRuntimePreflightSummary, next: BulkRuntimePreflightSummary): BulkRuntimePreflightSummary {
  return {
    total: current.total + next.total,
    eligible: current.eligible + next.eligible,
    blocked: current.blocked + next.blocked,
    alreadyComplete: current.alreadyComplete + next.alreadyComplete,
    invalidOrStale: current.invalidOrStale + next.invalidOrStale,
  };
}

function addExecutionSummary(current: BulkRuntimeExecutionSummary, next: BulkRuntimeExecutionSummary): BulkRuntimeExecutionSummary {
  return {
    total: current.total + next.total,
    successful: current.successful + next.successful,
    blocked: current.blocked + next.blocked,
    alreadyComplete: current.alreadyComplete + next.alreadyComplete,
    invalidOrStale: current.invalidOrStale + next.invalidOrStale,
    failed: current.failed + next.failed,
  };
}

function stageSummary(stage: string, preflight: BulkReviewPreflightResponse, durationMs: number): BulkRuntimeStageReport {
  return {
    stage,
    selected: preflight.summary.total,
    eligible: preflight.summary.eligible,
    blocked: preflight.summary.blocked,
    alreadyComplete: preflight.summary.alreadyComplete,
    invalidOrStale: preflight.summary.invalidOrStale,
    successful: 0,
    failed: 0,
    durationMs: Number(durationMs.toFixed(2)),
  };
}

function executionStage(stage: string, result: BulkReviewExecutionResponse, durationMs: number): BulkRuntimeStageReport {
  return {
    stage,
    selected: result.summary.total,
    eligible: 0,
    blocked: result.summary.blocked,
    alreadyComplete: result.summary.alreadyComplete,
    invalidOrStale: result.summary.invalidOrStale,
    successful: result.summary.successful,
    failed: result.summary.failed,
    durationMs: Number(durationMs.toFixed(2)),
  };
}

function assertPreflight(preflight: BulkReviewPreflightResponse, expected: BulkRuntimePreflightSummary, label: string): void {
  assert.deepEqual(preflight.summary, expected, `${label} preflight distribution changed.`);
}

function assertExecution(result: BulkReviewExecutionResponse, expected: BulkRuntimeExecutionSummary, label: string): void {
  assert.deepEqual(result.summary, expected, `${label} execution distribution changed.`);
}

function cleanupIsClean(residue: BulkRuntimeCleanupResidue): boolean {
  return Object.values(residue).every((count) => count === 0);
}

async function references(supabase: SupabaseClient, fixtureIdentity: string): Promise<ReferenceIds & { ownership: BulkReviewReferenceOwnership }> {
  const admins = await supabase.from('user_roles').select('user_id').eq('role', 'admin').limit(1);
  const adminRows = requireData(admins.data, admins.error, 'A local admin identity is required for runtime verification.') as Array<{ user_id: string }>;
  if (!adminRows[0]?.user_id) {
    throw new Error('A local admin identity is required for runtime verification.');
  }
  const fixtures = await acquireBulkReviewReferenceFixtures(supabase, fixtureIdentity);
  return { ...fixtures, adminId: adminRows[0].user_id };
}

async function projectStatus(supabase: SupabaseClient, publicId: string): Promise<{ id: string; status: string; updated_at: string }> {
  const result = await supabase.from('projects').select('id,status,updated_at').eq('public_id', publicId).single();
  return requireData(result.data, result.error, `Project ${publicId} could not be read.`) as { id: string; status: string; updated_at: string };
}

async function workflowRpc(
  supabase: SupabaseClient,
  publicId: string,
  action: BulkReviewAction,
  expectedUpdatedAt: string,
  adminId: string,
  comments: string | null = null,
): Promise<Record<string, unknown>> {
  const result = await supabase.rpc('perform_project_workflow_action_if_current', {
    p_public_id: publicId,
    p_action: action,
    p_comments: comments,
    p_admin_id: adminId,
    p_expected_updated_at: expectedUpdatedAt,
  });
  if (result.error || !result.data || typeof result.data !== 'object') throw new Error(`Workflow RPC failed for ${publicId}.`);
  return result.data as Record<string, unknown>;
}

async function insertWorkflowFixture(
  supabase: SupabaseClient,
  refs: ReferenceIds,
  batchId: string,
  publicId: string,
  status: string,
): Promise<FixtureProject> {
  const projectInsert = await supabase.from('projects').insert({
    public_id: publicId,
    title: 'Synthetic concurrency project',
    summary: 'Synthetic runtime summary.',
    year: 2026,
    program_id: refs.programIds[0],
    program_name: 'Synthetic program',
    study_program: 'Synthetic study program',
    discipline: 'Synthetic discipline',
    group_name: 'Synthetic runtime group',
    team_members: ['Synthetic Member A'],
    participant_contact_email: null,
    poster_text_public: 'Synthetic poster full text.',
    accessibility_text_public: 'Synthetic accessibility text.',
    snapshots: ['snapshot-1.png'],
    layout_config: {},
    status,
    import_batch_id: batchId,
    source_folder: publicId,
    validation_errors: [],
    validation_warnings: [],
  }).select('id,public_id').single();
  const project = requireData(projectInsert.data, projectInsert.error, `Could not create fixture ${publicId}.`) as { id: string; public_id: string };
  const disciplineInsert = await supabase.from('project_disciplines').insert({ project_id: project.id, discipline_id: refs.disciplineIds[0] });
  if (disciplineInsert.error) throw new Error(`Could not create discipline mapping for ${publicId}.`);
  const industryInsert = await supabase.from('project_industry_categories').insert({ project_id: project.id, industry_category_id: refs.industryIds[0] });
  if (industryInsert.error) throw new Error(`Could not create industry mapping for ${publicId}.`);
  const mediaInsert = await supabase.from('media_assets').insert([
    { project_id: project.id, asset_type: 'poster_image', file_name: 'poster.png', storage_bucket: 'project-drafts-private', storage_path: `drafts/${publicId}/poster_image/poster.png`, mime_type: 'image/png', file_size_bytes: 1024, public_url: null, is_public_approved: false },
    { project_id: project.id, asset_type: 'poster_pdf', file_name: 'poster.pdf', storage_bucket: 'project-drafts-private', storage_path: `drafts/${publicId}/poster_pdf/poster.pdf`, mime_type: 'application/pdf', file_size_bytes: 2048, public_url: null, is_public_approved: false },
  ]);
  if (mediaInsert.error) throw new Error(`Could not create media evidence for ${publicId}.`);
  return { id: project.id, publicId: project.public_id, batchId };
}

async function countByProject(supabase: SupabaseClient, table: string, projectIds: string[]): Promise<number> {
  if (projectIds.length === 0) return 0;
  const result = await supabase.from(table).select('project_id', { count: 'exact', head: true }).in('project_id', projectIds);
  return result.error ? -1 : result.count ?? 0;
}

async function cleanupResidue(
  supabase: SupabaseClient,
  prefix: string,
  batchNamePrefix: string,
  projectIds: string[],
  referenceResidue: { programs: number; disciplines: number; industryCategories: number },
): Promise<BulkRuntimeCleanupResidue> {
  const projectResult = await supabase.from('projects').select('id', { count: 'exact', head: true }).like('public_id', `${prefix}-%`);
  const batchResult = await supabase.from('import_batches').select('id', { count: 'exact', head: true }).like('batch_name', `${batchNamePrefix}-%`);
  const projectResidue = projectResult.error ? -1 : projectResult.count ?? 0;
  const batchResidue = batchResult.error ? -1 : batchResult.count ?? 0;
  const previewResult = projectIds.length === 0 ? { data: [], error: null } : await supabase.from('participant_previews').select('id').in('project_id', projectIds);
  const previewIds = (previewResult.data || []).map((row: { id: string }) => row.id);
  const correctionResult = previewIds.length === 0 ? { count: 0, error: null } : await supabase.from('participant_preview_correction_requests').select('id', { count: 'exact', head: true }).in('participant_preview_id', previewIds);
  const confirmationResult = previewIds.length === 0 ? { count: 0, error: null } : await supabase.from('participant_preview_confirmations').select('id', { count: 'exact', head: true }).in('participant_preview_id', previewIds);
  return {
    projects: projectResidue,
    batches: batchResidue,
    projectDisciplines: await countByProject(supabase, 'project_disciplines', projectIds),
    projectIndustryCategories: await countByProject(supabase, 'project_industry_categories', projectIds),
    mediaAssets: await countByProject(supabase, 'media_assets', projectIds),
    validationFlags: await countByProject(supabase, 'validation_flags', projectIds),
    approvalRecords: await countByProject(supabase, 'approval_records', projectIds),
    participantPreviews: previewResult.error ? -1 : previewIds.length,
    correctionRequests: correctionResult.error ? -1 : correctionResult.count ?? 0,
    confirmations: confirmationResult.error ? -1 : confirmationResult.count ?? 0,
    referencePrograms: referenceResidue.programs,
    referenceDisciplines: referenceResidue.disciplines,
    referenceIndustryCategories: referenceResidue.industryCategories,
  };
}

async function waitForEvidenceMode(): Promise<void> {
  if (!process.stdin.isTTY) return;
  process.stdout.write('Evidence mode is active. Press Enter to clean the isolated fixture and finish.\n');
  await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()));
}

export async function runBulkProjectReviewRuntime(options: BulkProjectReviewRuntimeOptions): Promise<BulkProjectReviewRuntimeReport> {
  assertLocal(options.apiUrl);
  const seed = options.seed ?? DEFAULT_SYNTHETIC_SEED;
  const supabase = createClient(options.apiUrl, options.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const clientA = createClient(options.apiUrl, options.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const clientB = createClient(options.apiUrl, options.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const prefix = `bulk-review-runtime-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const batchNamePrefix = `${prefix}-batch`;
  const reports: BulkRuntimeStageReport[] = [];
  const createdProjectIds: string[] = [];
  const createdBatchIds: string[] = [];
  let referenceOwnership: BulkReviewReferenceOwnership = { programIds: [], disciplineIds: [], industryIds: [] };
  let cleanup = { clean: false, residue: {
    projects: -1, batches: -1, projectDisciplines: -1, projectIndustryCategories: -1,
    mediaAssets: -1, validationFlags: -1, approvalRecords: -1, participantPreviews: -1,
    correctionRequests: -1, confirmations: -1, referencePrograms: -1, referenceDisciplines: -1, referenceIndustryCategories: -1,
  } };
  let submitPreflightSummary: BulkRuntimePreflightSummary = { total: 0, eligible: 0, blocked: 0, alreadyComplete: 0, invalidOrStale: 0 };
  let submitExecutionSummary: BulkRuntimeExecutionSummary = { total: 0, successful: 0, blocked: 0, alreadyComplete: 0, invalidOrStale: 0, failed: 0 };
  let approvalPreflightSummary: BulkRuntimePreflightSummary = { total: 0, eligible: 0, blocked: 0, alreadyComplete: 0, invalidOrStale: 0 };
  let approvalExecutionSummary: BulkRuntimeExecutionSummary = { total: 0, successful: 0, blocked: 0, alreadyComplete: 0, invalidOrStale: 0, failed: 0 };
  let requestChangesExecutionSummary: BulkRuntimeExecutionSummary = { total: 0, successful: 0, blocked: 0, alreadyComplete: 0, invalidOrStale: 0, failed: 0 };
  let staleProjectIds: string[] = [];
  let auditCount = 0;
  let duplicateAudits = 0;
  let report: BulkProjectReviewRuntimeReport | null = null;

  try {
    const refs = await references(supabase, prefix);
    referenceOwnership = refs.ownership;
    const synthetic = generateSyntheticProjects({ count: 100, seed });
    assert.equal(synthetic.length, 100);
    const batchRows = [0, 1].map((index) => ({ batch_name: `${batchNamePrefix}-${index + 1}`, source_folder: prefix, mode: 'batch', status: 'completed', total_projects: 50, warning_count: 0, error_count: 0 }));
    const batchInsert = await supabase.from('import_batches').insert(batchRows).select('id,batch_name');
    const batches = requireData(batchInsert.data, batchInsert.error, 'Could not create verifier import batches.') as Array<{ id: string; batch_name: string }>;
    assert.equal(batches.length, 2);
    createdBatchIds.push(...batches.map((batch) => batch.id));

    const projectRows = synthetic.map((project, index) => {
      const profile = index % 10;
      const status = profile === 4 ? 'submitted' : profile === 5 ? 'approved' : 'draft';
      return {
        public_id: `${prefix}-${project.publicId}`,
        title: profile === 3 ? '' : project.title,
        summary: project.summary,
        year: Number(project.year),
        program_id: refs.programIds[index % refs.programIds.length],
        program_name: project.program,
        study_program: project.studyProgram,
        discipline: project.discipline,
        group_name: project.groupName,
        team_members: project.teamMembers,
        participant_contact_email: null,
        poster_text_public: project.posterText,
        accessibility_text_public: profile === 3 ? '' : project.accessibilityText,
        snapshots: project.snapshots,
        layout_config: project.layoutConfig,
        status,
        import_batch_id: batches[index < 50 ? 0 : 1].id,
        source_folder: prefix,
        validation_errors: [],
        validation_warnings: [],
      };
    });
    const projectInsert = await supabase.from('projects').insert(projectRows).select('id,public_id');
    const inserted = requireData(projectInsert.data, projectInsert.error, 'Could not seed verifier projects.') as Array<{ id: string; public_id: string }>;
    assert.equal(inserted.length, 100);
    createdProjectIds.push(...inserted.map((row) => row.id));
    const idByPublicId = new Map(inserted.map((row) => [row.public_id, row.id]));
    const disciplineInsert = await supabase.from('project_disciplines').insert(projectRows.map((row, index) => ({ project_id: idByPublicId.get(row.public_id) as string, discipline_id: refs.disciplineIds[index % refs.disciplineIds.length] })));
    if (disciplineInsert.error) throw new Error('Could not seed verifier discipline mappings.');
    const industryInsert = await supabase.from('project_industry_categories').insert(projectRows.flatMap((row, index) => index % 10 === 2 ? [] : [{ project_id: idByPublicId.get(row.public_id) as string, industry_category_id: refs.industryIds[index % refs.industryIds.length] }]));
    if (industryInsert.error) throw new Error('Could not seed verifier industry mappings.');
    const mediaRows = projectRows.flatMap((row, index) => {
      const projectId = idByPublicId.get(row.public_id) as string;
      if (index % 10 === 7) return [];
      const base = { project_id: projectId, storage_bucket: 'project-drafts-private', is_public_approved: false, public_url: null, public_storage_bucket: null, public_storage_path: null };
      const image = { ...base, asset_type: 'poster_image', file_name: 'poster.png', storage_path: `drafts/${row.public_id}/poster_image/poster.png`, mime_type: 'image/png', file_size_bytes: 1024 };
      const pdf = { ...base, asset_type: 'poster_pdf', file_name: 'poster.pdf', storage_path: `drafts/${row.public_id}/poster_pdf/poster.pdf`, mime_type: 'application/pdf', file_size_bytes: 2048 };
      const snapshot = { ...base, asset_type: 'snapshot_image', file_name: 'snapshot-1.png', storage_path: `drafts/${row.public_id}/snapshot_image/snapshot-1.png`, mime_type: 'image/png', file_size_bytes: 1024, alt_text_public: 'Synthetic snapshot description.' };
      return index % 10 === 8 ? [image] : [image, pdf, snapshot];
    });
    const mediaInsert = await supabase.from('media_assets').insert(mediaRows);
    if (mediaInsert.error) throw new Error('Could not seed verifier media evidence.');
    const flagInsert = await supabase.from('validation_flags').insert(projectRows.flatMap((row, index) => index % 10 === 1 ? [{ project_id: idByPublicId.get(row.public_id) as string, severity: 'warning', rule_code: 'SYNTHETIC_WARNING', message: 'Synthetic warning only.', resolved: false }] : []));
    if (flagInsert.error) throw new Error('Could not seed verifier validation flags.');

    const gateway = new SupabaseBulkProjectReviewGateway(supabase, 'project-drafts-private');
    const service = new BulkReviewService(gateway);
    const actor: BulkReviewActor = { adminId: refs.adminId, permissions: ['projects.edit', 'projects.review'] };
    const publicIds = projectRows.map((row) => row.public_id);
    const chunks = [publicIds.slice(0, 50), publicIds.slice(50, 100)];
    const expectedSubmitPreflight: BulkRuntimePreflightSummary = { total: 50, eligible: 20, blocked: 25, alreadyComplete: 5, invalidOrStale: 0 };
    const expectedSubmitExecution: BulkRuntimeExecutionSummary = { total: 50, successful: 20, blocked: 25, alreadyComplete: 5, invalidOrStale: 0, failed: 0 };
    const expectedApprovalPreflight: BulkRuntimePreflightSummary = { total: 50, eligible: 25, blocked: 20, alreadyComplete: 5, invalidOrStale: 0 };

    for (let index = 0; index < chunks.length; index += 1) {
      const ids = chunks[index];
      const preflightStart = performance.now();
      const preflight = await service.preflight({ action: 'submit_for_review', publicIds: ids, actor });
      assertPreflight(preflight, expectedSubmitPreflight, `submit cohort ${index + 1}`);
      submitPreflightSummary = addPreflightSummary(submitPreflightSummary, preflightSummary(preflight));
      reports.push(stageSummary(`submit_preflight_${index + 1}`, preflight, performance.now() - preflightStart));
      const expectedUpdatedAt = Object.fromEntries(preflight.items.map((item) => [item.publicId, item.updatedAt]));
      const executionStart = performance.now();
      const result = await service.execute({ action: 'submit_for_review', publicIds: ids, expectedUpdatedAt, actor });
      assertExecution(result, expectedSubmitExecution, `submit cohort ${index + 1}`);
      submitExecutionSummary = addExecutionSummary(submitExecutionSummary, executionSummary(result));
      reports.push(executionStage(`submit_execution_${index + 1}`, result, performance.now() - executionStart));
    }

    const statusAfterSubmit = await supabase.from('projects').select('public_id,status').like('public_id', `${prefix}-%`);
    const submitStatuses = requireData(statusAfterSubmit.data, statusAfterSubmit.error, 'Could not verify submit statuses.') as Array<{ public_id: string; status: string }>;
    for (const [index, row] of projectRows.entries()) {
      const profile = index % 10;
      const expected = [0, 1, 4, 6, 9].includes(profile) ? 'submitted' : profile === 5 ? 'approved' : 'draft';
      assert.equal(submitStatuses.find((item) => item.public_id === row.public_id)?.status, expected, `Unexpected submit status for ${row.public_id}.`);
    }

    const approvalPreflights: Array<{ ids: string[]; preflight: BulkReviewPreflightResponse }> = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const ids = chunks[index];
      const preflightStart = performance.now();
      const preflight = await service.preflight({ action: 'approve', publicIds: ids, actor: { adminId: refs.adminId, permissions: ['projects.review'] } });
      assertPreflight(preflight, expectedApprovalPreflight, `approval cohort ${index + 1}`);
      approvalPreflightSummary = addPreflightSummary(approvalPreflightSummary, preflightSummary(preflight));
      reports.push(stageSummary(`approval_preflight_${index + 1}`, preflight, performance.now() - preflightStart));
      approvalPreflights.push({ ids, preflight });
    }

    staleProjectIds = [0, 1, 6, 9].map((index) => publicIds[index]);
    assert.equal(staleProjectIds.every((id) => approvalPreflights[0].preflight.items.some((item) => item.publicId === id && item.disposition === 'eligible')), true);
    const staleBefore = new Map<string, { status: string; auditCount: number }>();
    for (const publicId of staleProjectIds) {
      const current = await projectStatus(supabase, publicId);
      const audits = await supabase.from('approval_records').select('id', { count: 'exact', head: true }).eq('project_id', current.id);
      staleBefore.set(publicId, { status: current.status, auditCount: audits.count ?? 0 });
    }
    const staleUpdate = await supabase.from('projects').update({ summary: 'Synthetic deterministic stale-state update.' }).in('public_id', staleProjectIds);
    if (staleUpdate.error) throw new Error('Could not create deterministic stale candidates.');

    for (let index = 0; index < approvalPreflights.length; index += 1) {
      const { ids, preflight } = approvalPreflights[index];
      const expectedUpdatedAt = Object.fromEntries(preflight.items.map((item) => [item.publicId, item.updatedAt]));
      const executionStart = performance.now();
      const result = await service.execute({ action: 'approve', publicIds: ids, expectedUpdatedAt, actor: { adminId: refs.adminId, permissions: ['projects.review'] } });
      const expected: BulkRuntimeExecutionSummary = index === 0
        ? { total: 50, successful: 21, blocked: 20, alreadyComplete: 5, invalidOrStale: 4, failed: 0 }
        : { total: 50, successful: 25, blocked: 20, alreadyComplete: 5, invalidOrStale: 0, failed: 0 };
      assertExecution(result, expected, `approval cohort ${index + 1}`);
      approvalExecutionSummary = addExecutionSummary(approvalExecutionSummary, executionSummary(result));
      reports.push(executionStage(`approval_execution_${index + 1}`, result, performance.now() - executionStart));
    }
    for (const publicId of staleProjectIds) {
      const current = await projectStatus(supabase, publicId);
      const audits = await supabase.from('approval_records').select('id', { count: 'exact', head: true }).eq('project_id', current.id);
      assert.equal(current.status, staleBefore.get(publicId)?.status);
      assert.equal(audits.count, staleBefore.get(publicId)?.auditCount);
    }

    const requestChangesComment = 'Synthetic shared bulk request-changes comment.';
    const requestTarget = staleProjectIds[0];
    const requestTargetState = await projectStatus(supabase, requestTarget);
    const requestPreflight = await service.preflight({ action: 'request_changes', publicIds: [requestTarget], actor: { adminId: refs.adminId, permissions: ['projects.review'] } });
    assert.deepEqual(requestPreflight.summary, { total: 1, eligible: 1, blocked: 0, alreadyComplete: 0, invalidOrStale: 0 });
    const requestResult = await service.execute({ action: 'request_changes', publicIds: [requestTarget], expectedUpdatedAt: { [requestTarget]: requestTargetState.updated_at }, comments: requestChangesComment, actor: { adminId: refs.adminId, permissions: ['projects.review'] } });
    requestChangesExecutionSummary = executionSummary(requestResult);
    assert.deepEqual(requestChangesExecutionSummary, { total: 1, successful: 1, blocked: 0, alreadyComplete: 0, invalidOrStale: 0, failed: 0 });
    assert.equal((await projectStatus(supabase, requestTarget)).status, 'changes_requested');

    const duplicate = await insertWorkflowFixture(supabase, refs, batches[0].id, `${prefix}-duplicate`, 'submitted');
    const duplicateVersion = await projectStatus(supabase, duplicate.publicId);
    createdProjectIds.push(duplicate.id);
    const [duplicateA, duplicateB] = await Promise.all([
      workflowRpc(clientA, duplicate.publicId, 'approve', duplicateVersion.updated_at, refs.adminId),
      workflowRpc(clientB, duplicate.publicId, 'approve', duplicateVersion.updated_at, refs.adminId),
    ]);
    assert.deepEqual([duplicateA.resultCode, duplicateB.resultCode].sort(), ['ALREADY_COMPLETE', 'SUCCESS']);
    assert.equal((await projectStatus(supabase, duplicate.publicId)).status, 'approved');

    const conflict = await insertWorkflowFixture(supabase, refs, batches[1].id, `${prefix}-conflict`, 'submitted');
    const conflictVersion = await projectStatus(supabase, conflict.publicId);
    createdProjectIds.push(conflict.id);
    const [approveRace, requestRace] = await Promise.all([
      workflowRpc(clientA, conflict.publicId, 'approve', conflictVersion.updated_at, refs.adminId),
      workflowRpc(clientB, conflict.publicId, 'request_changes', conflictVersion.updated_at, refs.adminId, 'Synthetic conflicting reviewer comment.'),
    ]);
    assert.deepEqual([approveRace.resultCode, requestRace.resultCode].sort(), ['STALE_VERSION', 'SUCCESS']);
    assert.ok(['approved', 'changes_requested'].includes((await projectStatus(supabase, conflict.publicId)).status));

    const staleFixture = await insertWorkflowFixture(supabase, refs, batches[1].id, `${prefix}-stale-preflight`, 'submitted');
    const staleFixtureVersion = await projectStatus(supabase, staleFixture.publicId);
    createdProjectIds.push(staleFixture.id);
    const staleFixtureUpdate = await supabase.from('projects').update({ summary: 'Synthetic stale preflight mutation.' }).eq('id', staleFixture.id);
    if (staleFixtureUpdate.error) throw new Error('Could not mutate stale-preflight fixture.');
    const staleResponse = await workflowRpc(clientA, staleFixture.publicId, 'approve', staleFixtureVersion.updated_at, refs.adminId);
    assert.equal(staleResponse.resultCode, 'STALE_VERSION');
    assert.equal((await projectStatus(supabase, staleFixture.publicId)).status, 'submitted');

    const verifierProjectResult = await supabase.from('projects').select('id,public_id').like('public_id', `${prefix}-%`);
    const verifierProjects = requireData(verifierProjectResult.data, verifierProjectResult.error, 'Could not verify verifier project IDs.') as Array<{ id: string; public_id: string }>;
    const verifierIds = verifierProjects.map((row) => row.id);
    const auditResult = await supabase.from('approval_records').select('id,project_id,admin_id,action_taken,from_status,to_status,comments').in('project_id', verifierIds);
    const audits = requireData(auditResult.data, auditResult.error, 'Could not verify verifier audit rows.') as Array<{ id: string; project_id: string; admin_id: string; action_taken: string; from_status: string; to_status: string; comments: string | null }>;
    auditCount = audits.length;
    const submitAuditCount = audits.filter((audit) => audit.action_taken === 'submit_for_review' && audit.from_status === 'draft' && audit.to_status === 'submitted').length;
    const approveAuditCount = audits.filter((audit) => audit.action_taken === 'approve' && audit.from_status === 'submitted' && audit.to_status === 'approved').length;
    const requestChangesAuditCount = audits.filter((audit) => audit.action_taken === 'request_changes' && audit.from_status === 'submitted' && audit.to_status === 'changes_requested').length;
    assert.equal(auditCount, 89, `Expected 89 audits, found ${auditCount} (submit=${submitAuditCount}, approve=${approveAuditCount}, request_changes=${requestChangesAuditCount}).`);
    assert.equal(submitAuditCount, 40);
    const conflictAction = approveRace.resultCode === 'SUCCESS' ? 'approve' : 'request_changes';
    assert.equal(audits.filter((audit) => audit.action_taken === 'approve' && audit.from_status === 'submitted' && audit.to_status === 'approved').length, 47 + (conflictAction === 'approve' ? 1 : 0));
    assert.equal(audits.filter((audit) => audit.action_taken === 'request_changes' && audit.from_status === 'submitted' && audit.to_status === 'changes_requested').length, 1 + (conflictAction === 'request_changes' ? 1 : 0));
    assert.equal(audits.filter((audit) => audit.comments === requestChangesComment).length, 1);
    assert.equal(audits.filter((audit) => audit.admin_id !== refs.adminId).length, 0);
    duplicateAudits = audits.length - new Set(audits.map((audit) => audit.id)).size;
    assert.equal(duplicateAudits, 0);
    if (options.evidenceMode) await waitForEvidenceMode();

    const workflowTransitions = submitExecutionSummary.successful + approvalExecutionSummary.successful + requestChangesExecutionSummary.successful + 2;
    const uniqueProjectsTransitioned = new Set([
      ...projectRows.filter((_, index) => [0, 1, 4, 6, 9].includes(index % 10)).map((row) => row.public_id),
      ...verifierProjects.filter((row) => row.public_id.endsWith('-duplicate') || row.public_id.endsWith('-conflict')).map((row) => row.public_id),
    ]).size;
    assert.equal(workflowTransitions, auditCount);
    assert.equal(uniqueProjectsTransitioned, 52);

    report = {
      seed, total: 100, selected: submitPreflightSummary.total, eligible: submitPreflightSummary.eligible,
      blocked: submitPreflightSummary.blocked, alreadyComplete: submitPreflightSummary.alreadyComplete,
      stale: approvalExecutionSummary.invalidOrStale, successful: submitExecutionSummary.successful + approvalExecutionSummary.successful,
      failed: submitExecutionSummary.failed + approvalExecutionSummary.failed,
      submit: { preflight: submitPreflightSummary, execution: submitExecutionSummary, transitionCount: submitExecutionSummary.successful },
      approval: { preflight: approvalPreflightSummary, execution: approvalExecutionSummary, transitionCount: approvalExecutionSummary.successful },
      requestChanges: { execution: requestChangesExecutionSummary, comment: requestChangesComment },
      workflowTransitions, uniqueProjectsTransitioned, auditCount, duplicateAudits, staleProjectIds, batchCount: 2,
      concurrency: { duplicateExecution: true, sameActionOverlap: true, conflictingOverlap: true, stalePreflight: true, deadlocks: 0 },
      stages: reports, cleanup,
      referenceFixtures: { created: referenceOwnership },
    };
  } finally {
    const projectDelete = createdProjectIds.length === 0
      ? { error: null }
      : await supabase.from('projects').delete().in('id', createdProjectIds).select('id');
    const batchDelete = createdBatchIds.length === 0
      ? { error: null }
      : await supabase.from('import_batches').delete().in('id', createdBatchIds).select('id');
    if (projectDelete.error || batchDelete.error) {
      cleanup = { clean: false, residue: { ...cleanup.residue, projects: -1, batches: -1 } };
    } else {
      const referenceResidue = await cleanupBulkReviewReferenceFixtures(supabase, referenceOwnership);
      const residue = await cleanupResidue(supabase, prefix, batchNamePrefix, createdProjectIds, referenceResidue);
      if (!referenceFixtureCleanupIsClean(referenceResidue)) {
        throw new Error(`Bulk runtime reference cleanup left verifier-owned residue: ${JSON.stringify(referenceResidue)}`);
      }
      cleanup = { clean: cleanupIsClean(residue), residue };
    }
  }

  if (!report) throw new Error('Bulk project review runtime did not produce a report.');
  report.cleanup = cleanup;
  assert.equal(cleanup.clean, true, `Bulk runtime cleanup left verifier-owned residue: ${JSON.stringify(cleanup.residue)}`);
  return report;
}

export { cleanupIsClean };
