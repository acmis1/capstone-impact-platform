import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { generateSyntheticProjects, DEFAULT_SYNTHETIC_SEED } from '../fixtures/syntheticProjects';
import { isLoopbackUrl } from '../local-development/localEnvironmentFile';
import { SupabaseProjectRepositoryCore } from '../repositories/SupabaseProjectRepositoryCore';
import {
  BULK_REVIEW_MAX_SELECTION,
  BulkReviewAction,
  BulkReviewActor,
  BulkReviewExecutionItem,
} from '../projects/bulkProjectReview';
import { BulkReviewService } from '../projects/bulkProjectReviewService';
import { SupabaseBulkProjectReviewGateway } from '../projects/SupabaseBulkProjectReviewGateway';
import {
  acquireBulkReviewReferenceFixtures,
  cleanupBulkReviewReferenceFixtures,
  referenceFixtureCleanupIsClean,
  type BulkReviewReferenceOwnership,
} from './bulkProjectReviewReferenceFixtures';

/**
 * End-to-end functional evidence for the governed bulk review workflow at the assignment's
 * stated scale.
 *
 * This complements `bulkProjectReviewRuntime`, which pins an exact distribution over a fixed
 * 100-project cohort. Here the cohort is 120 projects and the selection is built the way staff
 * build one: by walking the real filtered, paginated project index and accumulating public ids
 * across pages, then submitting them through bounded preflight/execute cohorts.
 *
 * The invariant under test is reconciliation, not throughput: N unique requested projects must
 * produce exactly N deterministic result rows, with no dropped id, no duplicated row, and a
 * final database state that matches every reported outcome.
 */

export const FUNCTIONAL_WORKFLOW_PROJECT_COUNT = 120;

/** Page size used to walk the project index. Exercises multi-page selection at this cohort size. */
const INDEX_PAGE_SIZE = 25;

export interface FunctionalWorkflowOutcomeCounts {
  successful: number;
  blocked: number;
  alreadyComplete: number;
  invalidOrStale: number;
  failed: number;
}

export interface FunctionalWorkflowPhaseReport {
  phase: string;
  action: BulkReviewAction;
  cohorts: number;
  requestedUniqueProjects: number;
  resultRows: number;
  duplicateResultRows: number;
  missingResultRows: number;
  outcomes: FunctionalWorkflowOutcomeCounts;
  durationMs: number;
}

export interface FunctionalWorkflowReconciliation {
  reportedSuccessful: number;
  databaseTransitioned: number;
  auditRecords: number;
  duplicateAuditRecords: number;
  foreignActorAuditRecords: number;
  unmutatedBlockedProjects: number;
  unmutatedStaleProjects: number;
}

export interface FunctionalWorkflowReport {
  seed: number;
  syntheticProjects: number;
  importBatches: number;
  pagination: {
    pageSize: number;
    pagesWalked: number;
    unfilteredTotal: number;
    collectedAcrossPages: number;
    filteredStatus: string;
    filteredTotal: number;
    filteredPagesWalked: number;
    filteredCollected: number;
  };
  phases: FunctionalWorkflowPhaseReport[];
  requestedUniqueProjects: number;
  resultRows: number;
  outcomes: FunctionalWorkflowOutcomeCounts;
  duplicateResultRows: number;
  silentlyLostProjects: string[];
  reconciliation: FunctionalWorkflowReconciliation;
  sharedAdmin: {
    presentBefore: boolean;
    presentAfter: boolean;
    roleAfter: 'admin' | null;
  };
  workflowElapsedMs: number;
  referenceFixtures: { created: BulkReviewReferenceOwnership };
  cleanup: {
    clean: boolean;
    residualProjects: number;
    residualBatches: number;
    residualAudits: number;
    residualReferencePrograms: number;
    residualReferenceDisciplines: number;
    residualReferenceIndustryCategories: number;
  };
}

export interface FunctionalWorkflowOptions {
  apiUrl: string;
  serviceRoleKey: string;
  seed?: number;
}

interface ReferenceIds {
  programIds: string[];
  disciplineIds: string[];
  industryIds: string[];
  adminId: string;
}

function requireData<T>(data: T | null, error: unknown, message: string): T {
  if (error || data === null) throw new Error(message);
  return data;
}

function emptyOutcomes(): FunctionalWorkflowOutcomeCounts {
  return { successful: 0, blocked: 0, alreadyComplete: 0, invalidOrStale: 0, failed: 0 };
}

function addOutcomes(
  current: FunctionalWorkflowOutcomeCounts,
  next: FunctionalWorkflowOutcomeCounts,
): FunctionalWorkflowOutcomeCounts {
  return {
    successful: current.successful + next.successful,
    blocked: current.blocked + next.blocked,
    alreadyComplete: current.alreadyComplete + next.alreadyComplete,
    invalidOrStale: current.invalidOrStale + next.invalidOrStale,
    failed: current.failed + next.failed,
  };
}

function countOutcomes(items: BulkReviewExecutionItem[]): FunctionalWorkflowOutcomeCounts {
  return items.reduce((counts, item) => {
    if (item.outcome === 'successful') counts.successful += 1;
    if (item.outcome === 'blocked') counts.blocked += 1;
    if (item.outcome === 'already_complete') counts.alreadyComplete += 1;
    if (item.outcome === 'invalid_or_stale') counts.invalidOrStale += 1;
    if (item.outcome === 'failed') counts.failed += 1;
    return counts;
  }, emptyOutcomes());
}

function chunk(values: string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function references(supabase: SupabaseClient, fixtureIdentity: string): Promise<ReferenceIds & { ownership: BulkReviewReferenceOwnership }> {
  const admins = await supabase.from('user_roles').select('user_id').eq('role', 'admin').limit(1);
  const adminRows = requireData(admins.data, admins.error, 'A local admin identity is required for functional verification.') as Array<{ user_id: string }>;
  if (!adminRows[0]?.user_id) {
    throw new Error('A local admin identity is required for functional verification.');
  }
  const fixtures = await acquireBulkReviewReferenceFixtures(supabase, fixtureIdentity);
  return { ...fixtures, adminId: adminRows[0].user_id };
}

/**
 * Walks the real paginated, filtered project index and accumulates public ids across pages, which
 * is how a staff selection larger than one page is actually built.
 */
async function collectAcrossPages(
  repository: SupabaseProjectRepositoryCore,
  search: string,
  status?: 'draft' | 'submitted',
): Promise<{ publicIds: string[]; total: number; pagesWalked: number }> {
  const collected: string[] = [];
  const seen = new Set<string>();
  let page = 1;
  let total = 0;
  let pageCount = 1;
  let pagesWalked = 0;

  do {
    const result = await repository.listProjectsPage({
      search,
      status,
      sort: 'title',
      direction: 'asc',
      page,
      pageSize: INDEX_PAGE_SIZE,
    });
    total = result.total;
    pageCount = result.pageCount;
    pagesWalked += 1;
    for (const project of result.projects) {
      const publicId = project.publicId;
      // Selection state is accumulated across pages, so a project that shifts between pages
      // during the walk must never be added twice.
      if (!publicId || seen.has(publicId)) continue;
      seen.add(publicId);
      collected.push(publicId);
    }
    page += 1;
  } while (page <= pageCount);

  return { publicIds: collected, total, pagesWalked };
}

async function runPhase(
  service: BulkReviewService,
  action: BulkReviewAction,
  publicIds: string[],
  actor: BulkReviewActor,
  phase: string,
  options: { comments?: string; staleAfterPreflight?: (ids: string[]) => Promise<void> } = {},
): Promise<{ report: FunctionalWorkflowPhaseReport; items: BulkReviewExecutionItem[] }> {
  const cohorts = chunk(publicIds, BULK_REVIEW_MAX_SELECTION);
  const items: BulkReviewExecutionItem[] = [];
  const start = performance.now();

  for (const cohort of cohorts) {
    const preflight = await service.preflight({ action, publicIds: cohort, actor });
    assert.equal(
      preflight.items.length,
      cohort.length,
      `${phase}: preflight returned ${preflight.items.length} rows for ${cohort.length} requested projects.`,
    );

    // Confirmation is prepared from the server's own evidence, never from browser state.
    const expectedUpdatedAt = Object.fromEntries(
      preflight.items.map((item) => [item.publicId, item.updatedAt]),
    );

    if (options.staleAfterPreflight) {
      await options.staleAfterPreflight(cohort);
    }

    const execution = await service.execute({
      action,
      publicIds: cohort,
      expectedUpdatedAt,
      comments: options.comments,
      actor,
    });
    assert.equal(
      execution.items.length,
      cohort.length,
      `${phase}: execution returned ${execution.items.length} rows for ${cohort.length} requested projects.`,
    );
    items.push(...execution.items);
  }

  const durationMs = performance.now() - start;
  const requested = new Set(publicIds);
  const returned = items.map((item) => item.publicId);
  const returnedSet = new Set(returned);
  const duplicateResultRows = returned.length - returnedSet.size;
  const missingResultRows = [...requested].filter((id) => !returnedSet.has(id)).length;

  return {
    items,
    report: {
      phase,
      action,
      cohorts: cohorts.length,
      requestedUniqueProjects: requested.size,
      resultRows: items.length,
      duplicateResultRows,
      missingResultRows,
      outcomes: countOutcomes(items),
      durationMs: Number(durationMs.toFixed(2)),
    },
  };
}

export async function runBulkProjectReviewFunctionalWorkflow(
  options: FunctionalWorkflowOptions,
): Promise<FunctionalWorkflowReport> {
  if (!isLoopbackUrl(options.apiUrl)) {
    throw new Error('The functional bulk review workflow requires a loopback-only Local Supabase endpoint.');
  }

  const seed = options.seed ?? DEFAULT_SYNTHETIC_SEED;
  const supabase = createClient(options.apiUrl, options.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const prefix = `bulk-functional-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const batchNamePrefix = `${prefix}-batch`;
  // A verifier-owned marker that the real index search matches, so the walk selects exactly this
  // cohort and never another developer's data.
  const searchMarker = prefix;
  const createdProjectIds: string[] = [];
  const createdBatchIds: string[] = [];
  let referenceOwnership: BulkReviewReferenceOwnership = { programIds: [], disciplineIds: [], industryIds: [] };

  try {
    const refs = await references(supabase, prefix);
    referenceOwnership = refs.ownership;
    const synthetic = generateSyntheticProjects({ count: 500, seed }).slice(
      0,
      FUNCTIONAL_WORKFLOW_PROJECT_COUNT,
    );
    assert.equal(synthetic.length, FUNCTIONAL_WORKFLOW_PROJECT_COUNT);

    const batchRows = [0, 1, 2].map((index) => ({
      batch_name: `${batchNamePrefix}-${index + 1}`,
      source_folder: prefix,
      mode: 'batch',
      status: 'completed',
      total_projects: 40,
      warning_count: 0,
      error_count: 0,
    }));
    const batchInsert = await supabase.from('import_batches').insert(batchRows).select('id,batch_name');
    const batches = requireData(batchInsert.data, batchInsert.error, 'Could not create functional verifier import batches.') as Array<{ id: string; batch_name: string }>;
    assert.equal(batches.length, 3);
    createdBatchIds.push(...batches.map((batch) => batch.id));

    // Deterministic mixed cohort. Profiles 0-9 repeat over the 120 projects:
    //   profile 3 -> missing accessibility text  (blocked on submit and approve)
    //   profile 7 -> no media evidence           (blocked on submit and approve)
    //   profile 5 -> already approved            (already complete on approve)
    //   everything else                          -> eligible
    const projectRows = synthetic.map((project, index) => {
      const profile = index % 10;
      return {
        public_id: `${prefix}-${project.publicId}`,
        title: `${searchMarker} ${String(index).padStart(3, '0')} ${project.title}`,
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
        status: profile === 5 ? 'approved' : 'draft',
        import_batch_id: batches[Math.floor(index / 40)].id,
        source_folder: prefix,
        validation_errors: [],
        validation_warnings: [],
      };
    });

    const projectInsert = await supabase.from('projects').insert(projectRows).select('id,public_id');
    const inserted = requireData(projectInsert.data, projectInsert.error, 'Could not seed functional verifier projects.') as Array<{ id: string; public_id: string }>;
    assert.equal(inserted.length, FUNCTIONAL_WORKFLOW_PROJECT_COUNT);
    createdProjectIds.push(...inserted.map((row) => row.id));
    const idByPublicId = new Map(inserted.map((row) => [row.public_id, row.id]));

    const disciplineInsert = await supabase.from('project_disciplines').insert(
      projectRows.map((row, index) => ({
        project_id: idByPublicId.get(row.public_id) as string,
        discipline_id: refs.disciplineIds[index % refs.disciplineIds.length],
      })),
    );
    if (disciplineInsert.error) throw new Error('Could not seed functional discipline mappings.');

    const industryInsert = await supabase.from('project_industry_categories').insert(
      projectRows.map((row, index) => ({
        project_id: idByPublicId.get(row.public_id) as string,
        industry_category_id: refs.industryIds[index % refs.industryIds.length],
      })),
    );
    if (industryInsert.error) throw new Error('Could not seed functional industry mappings.');

    const mediaRows = projectRows.flatMap((row, index) => {
      if (index % 10 === 7) return [];
      const projectId = idByPublicId.get(row.public_id) as string;
      const base = {
        project_id: projectId,
        storage_bucket: 'project-drafts-private',
        is_public_approved: false,
        public_url: null,
        public_storage_bucket: null,
        public_storage_path: null,
      };
      return [
        { ...base, asset_type: 'poster_image', file_name: 'poster.png', storage_path: `drafts/${row.public_id}/poster_image/poster.png`, mime_type: 'image/png', file_size_bytes: 1024 },
        { ...base, asset_type: 'poster_pdf', file_name: 'poster.pdf', storage_path: `drafts/${row.public_id}/poster_pdf/poster.pdf`, mime_type: 'application/pdf', file_size_bytes: 2048 },
        { ...base, asset_type: 'snapshot_image', gallery_position: 1, file_name: 'snapshot-1.png', storage_path: `drafts/${row.public_id}/snapshot_image/snapshot-1.png`, mime_type: 'image/png', file_size_bytes: 1024, alt_text_public: 'Synthetic snapshot description.' },
      ];
    });
    const mediaInsert = await supabase.from('media_assets').insert(mediaRows);
    if (mediaInsert.error) throw new Error('Could not seed functional media evidence.');

    const repository = new SupabaseProjectRepositoryCore(supabase);
    const gateway = new SupabaseBulkProjectReviewGateway(supabase, 'project-drafts-private');
    const service = new BulkReviewService(gateway);
    const editor: BulkReviewActor = { adminId: refs.adminId, permissions: ['projects.edit'] };
    const reviewer: BulkReviewActor = { adminId: refs.adminId, permissions: ['projects.review'] };

    const workflowStart = performance.now();

    // --- Selection across filtered, paginated results ---------------------------------------
    const walked = await collectAcrossPages(repository, searchMarker);
    assert.equal(walked.total, FUNCTIONAL_WORKFLOW_PROJECT_COUNT, 'The filtered index total changed unexpectedly.');
    assert.equal(walked.publicIds.length, FUNCTIONAL_WORKFLOW_PROJECT_COUNT, 'Selection across pages lost or duplicated a project.');
    assert.equal(walked.pagesWalked, Math.ceil(FUNCTIONAL_WORKFLOW_PROJECT_COUNT / INDEX_PAGE_SIZE));

    const draftWalk = await collectAcrossPages(repository, searchMarker, 'draft');
    assert.equal(draftWalk.total, 108, 'The status-filtered index total changed unexpectedly.');
    assert.equal(draftWalk.publicIds.length, 108);

    const selection = walked.publicIds;
    assert.equal(new Set(selection).size, FUNCTIONAL_WORKFLOW_PROJECT_COUNT);

    // --- Phase 1: submit the whole selection --------------------------------------------------
    const submit = await runPhase(service, 'submit_for_review', selection, editor, 'submit_for_review');

    // --- Phase 2: approve the whole selection, with a deterministic stale cohort ---------------
    // Every fourth project in the first execute cohort is mutated between preflight and execute,
    // which must produce a bounded stale result rather than a mutation from stale evidence.
    const staleTargets: string[] = [];
    const approve = await runPhase(service, 'approve', selection, reviewer, 'approve', {
      staleAfterPreflight: async (cohortIds) => {
        if (staleTargets.length > 0) return;
        const targets = cohortIds.filter((_, index) => index % 4 === 0).slice(0, 6);
        const eligibleTargets: string[] = [];
        for (const publicId of targets) {
          const row = await supabase.from('projects').select('status').eq('public_id', publicId).single();
          if (row.data?.status === 'submitted') eligibleTargets.push(publicId);
        }
        if (eligibleTargets.length === 0) return;
        const update = await supabase
          .from('projects')
          .update({ summary: 'Synthetic deterministic concurrent change.' })
          .in('public_id', eligibleTargets);
        if (update.error) throw new Error('Could not create deterministic stale candidates.');
        staleTargets.push(...eligibleTargets);
      },
    });

    // A project that changed between preflight and execute must be reported stale and left
    // untouched. This is checked before the retry phase, which legitimately approves them from
    // fresh evidence.
    const staleReported = new Set(
      approve.items.filter((item) => item.outcome === 'invalid_or_stale').map((item) => item.publicId),
    );
    let unmutatedStaleProjects = 0;
    for (const publicId of staleTargets) {
      assert.equal(staleReported.has(publicId), true, `Concurrently changed project ${publicId} was not reported stale.`);
      const row = await supabase.from('projects').select('status').eq('public_id', publicId).single();
      assert.equal(row.data?.status, 'submitted', `Stale project ${publicId} was transitioned from stale evidence.`);
      unmutatedStaleProjects += 1;
    }

    // --- Phase 3: idempotent retry of the identical approve request ----------------------------
    const retry = await runPhase(service, 'approve', selection, reviewer, 'approve_retry');

    const workflowElapsedMs = performance.now() - workflowStart;

    const phases = [submit.report, approve.report, retry.report];
    const allItems = [...submit.items, ...approve.items, ...retry.items];

    // --- Reconciliation against the real database state ----------------------------------------
    const statusResult = await supabase
      .from('projects')
      .select('id,public_id,status,summary')
      .like('public_id', `${prefix}-%`);
    const statusRows = requireData(statusResult.data, statusResult.error, 'Could not read final project states.') as Array<{ id: string; public_id: string; status: string; summary: string }>;
    assert.equal(statusRows.length, FUNCTIONAL_WORKFLOW_PROJECT_COUNT);
    const statusByPublicId = new Map(statusRows.map((row) => [row.public_id, row.status]));

    const auditResult = await supabase
      .from('approval_records')
      .select('id,project_id,action_taken,from_status,to_status,admin_id')
      .in('project_id', createdProjectIds);
    const audits = requireData(auditResult.data, auditResult.error, 'Could not read audit records.') as Array<{ id: string; project_id: string; action_taken: string; from_status: string; to_status: string; admin_id: string }>;

    const reportedSuccessful = allItems.filter((item) => item.outcome === 'successful').length;
    const auditSignatures = audits.map((audit) => `${audit.project_id}|${audit.action_taken}|${audit.from_status}|${audit.to_status}`);
    const duplicateAuditRecords = auditSignatures.length - new Set(auditSignatures).size;
    const foreignActorAuditRecords = audits.filter((audit) => audit.admin_id !== refs.adminId).length;

    // Every project reported successful must actually hold a status reachable from that
    // transition. A submit success may have been approved by the later phase, so its reachable
    // set is wider than the approve phases'.
    const reachableAfterSuccess: Array<{ items: BulkReviewExecutionItem[]; allowed: string[] }> = [
      { items: submit.items, allowed: ['submitted', 'approved'] },
      { items: approve.items, allowed: ['approved'] },
      { items: retry.items, allowed: ['approved'] },
    ];
    for (const { items, allowed } of reachableAfterSuccess) {
      for (const item of items) {
        if (item.outcome !== 'successful') continue;
        const stored = statusByPublicId.get(item.publicId);
        assert.equal(
          allowed.includes(stored ?? ''),
          true,
          `Reported success for ${item.publicId} stored status ${stored}, expected one of ${allowed.join('/')}.`,
        );
      }
    }

    // A project blocked in every phase must still hold the status it was seeded with: the bulk
    // workflow must not have mutated it on any attempt.
    const seededStatusByPublicId = new Map(projectRows.map((row) => [row.public_id, row.status]));
    const everSucceeded = new Set(
      allItems.filter((item) => item.outcome === 'successful').map((item) => item.publicId),
    );
    const blockedPublicIds = new Set(
      submit.items
        .filter((item) => item.outcome === 'blocked' && !everSucceeded.has(item.publicId))
        .map((item) => item.publicId),
    );
    const unmutatedBlockedProjects = [...blockedPublicIds].filter(
      (publicId) => statusByPublicId.get(publicId) === seededStatusByPublicId.get(publicId),
    ).length;
    assert.equal(
      unmutatedBlockedProjects,
      blockedPublicIds.size,
      'A project reported as blocked was mutated by the bulk workflow.',
    );

    // The retry converges the previously stale projects and reports every other project as
    // already complete; no project is transitioned twice.
    assert.equal(retry.report.outcomes.successful, staleTargets.length, 'The idempotent retry produced an unexpected number of transitions.');
    assert.equal(
      retry.items.filter((item) => item.outcome === 'already_complete').length,
      approve.report.outcomes.successful + approve.report.outcomes.alreadyComplete,
      'The idempotent retry did not converge on already-complete semantics.',
    );

    const databaseTransitioned = statusRows.filter((row) => row.status !== 'draft').length;

    const requestedUniqueProjects = phases.reduce((total, phase) => total + phase.requestedUniqueProjects, 0);
    const resultRows = phases.reduce((total, phase) => total + phase.resultRows, 0);
    const duplicateResultRows = phases.reduce((total, phase) => total + phase.duplicateResultRows, 0);
    const silentlyLostProjects = phases.flatMap((phase) => (phase.missingResultRows > 0 ? [phase.phase] : []));

    const report: FunctionalWorkflowReport = {
      seed,
      syntheticProjects: FUNCTIONAL_WORKFLOW_PROJECT_COUNT,
      importBatches: batches.length,
      pagination: {
        pageSize: INDEX_PAGE_SIZE,
        pagesWalked: walked.pagesWalked,
        unfilteredTotal: walked.total,
        collectedAcrossPages: walked.publicIds.length,
        filteredStatus: 'draft',
        filteredTotal: draftWalk.total,
        filteredPagesWalked: draftWalk.pagesWalked,
        filteredCollected: draftWalk.publicIds.length,
      },
      phases,
      requestedUniqueProjects,
      resultRows,
      outcomes: phases.map((phase) => phase.outcomes).reduce(addOutcomes, emptyOutcomes()),
      duplicateResultRows,
      silentlyLostProjects,
      reconciliation: {
        reportedSuccessful,
        databaseTransitioned,
        auditRecords: audits.length,
        duplicateAuditRecords,
        foreignActorAuditRecords,
        unmutatedBlockedProjects,
        unmutatedStaleProjects,
      },
      sharedAdmin: { presentBefore: true, presentAfter: false, roleAfter: null },
      workflowElapsedMs: Number(workflowElapsedMs.toFixed(2)),
      referenceFixtures: { created: referenceOwnership },
      cleanup: {
        clean: false,
        residualProjects: -1,
        residualBatches: -1,
        residualAudits: -1,
        residualReferencePrograms: -1,
        residualReferenceDisciplines: -1,
        residualReferenceIndustryCategories: -1,
      },
    };

    report.cleanup = await cleanupFixture(supabase, prefix, batchNamePrefix, createdProjectIds, createdBatchIds, referenceOwnership);
    assert.equal(report.cleanup.clean, true, `Functional workflow cleanup left verifier-owned residue: ${JSON.stringify(report.cleanup)}`);
    const retainedAdmin = await supabase.from('user_roles').select('role').eq('user_id', refs.adminId).eq('role', 'admin').maybeSingle();
    if (retainedAdmin.error) throw new Error('Could not verify preservation of the pre-existing Local Admin role.');
    report.sharedAdmin = {
      presentBefore: true,
      presentAfter: retainedAdmin.data !== null,
      roleAfter: retainedAdmin.data?.role === 'admin' ? 'admin' : null,
    };
    assert.equal(report.sharedAdmin.presentAfter, true, 'Functional workflow cleanup removed the pre-existing Local Admin.');
    return report;
  } catch (error) {
    await cleanupFixture(supabase, prefix, batchNamePrefix, createdProjectIds, createdBatchIds, referenceOwnership);
    throw error;
  }
}

/**
 * Removes exactly the rows this verifier created. Nothing outside the verifier-owned prefix is
 * touched, so the run is safe against a Local stack that holds other development data.
 */
async function cleanupFixture(
  supabase: SupabaseClient,
  prefix: string,
  batchNamePrefix: string,
  projectIds: string[],
  batchIds: string[],
  referenceOwnership: BulkReviewReferenceOwnership,
): Promise<FunctionalWorkflowReport['cleanup']> {
  if (projectIds.length > 0) {
    for (const table of [
      'approval_records',
      'validation_flags',
      'media_assets',
      'project_industry_categories',
      'project_disciplines',
    ]) {
      const result = await supabase.from(table).delete().in('project_id', projectIds);
      if (result.error) throw new Error(`Could not delete functional verifier ${table} rows.`);
    }
    const projectDeletion = await supabase.from('projects').delete().in('id', projectIds);
    if (projectDeletion.error) throw new Error('Could not delete functional verifier projects.');
  }
  if (batchIds.length > 0) {
    const batchDeletion = await supabase.from('import_batches').delete().in('id', batchIds);
    if (batchDeletion.error) throw new Error('Could not delete functional verifier import batches.');
  }

  const referenceResidue = await cleanupBulkReviewReferenceFixtures(supabase, referenceOwnership);

  const projectResidue = await supabase.from('projects').select('id', { count: 'exact', head: true }).like('public_id', `${prefix}-%`);
  const batchResidue = await supabase.from('import_batches').select('id', { count: 'exact', head: true }).like('batch_name', `${batchNamePrefix}-%`);
  const auditResidue = projectIds.length === 0
    ? { count: 0, error: null }
    : await supabase.from('approval_records').select('id', { count: 'exact', head: true }).in('project_id', projectIds);

  const residualProjects = projectResidue.error ? -1 : projectResidue.count ?? 0;
  const residualBatches = batchResidue.error ? -1 : batchResidue.count ?? 0;
  const residualAudits = auditResidue.error ? -1 : auditResidue.count ?? 0;

  return {
    clean: residualProjects === 0 && residualBatches === 0 && residualAudits === 0 && referenceFixtureCleanupIsClean(referenceResidue),
    residualProjects,
    residualBatches,
    residualAudits,
    residualReferencePrograms: referenceResidue.programs,
    residualReferenceDisciplines: referenceResidue.disciplines,
    residualReferenceIndustryCategories: referenceResidue.industryCategories,
  };
}
