import { createClient, SupabaseClient } from '@supabase/supabase-js';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';
import { computeProjectReviewReadiness } from '../import/importBatchReviewReadiness';

export interface RuntimeVerificationOptions {
  repoRoot?: string;
}

interface Lookups {
  programId: string;
  programName: string;
  disciplineId: string;
  disciplineName: string;
  industryId: string;
  industryName: string;
}

export async function runImportBatchReviewSubmitRuntimeVerification(options?: RuntimeVerificationOptions): Promise<boolean> {
  console.log('=== Local Supabase Import Batch Review Submission Runtime Verification ===\n');
  const repoRoot = options?.repoRoot || path.resolve(__dirname, '../../../..');

  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const testPrefix = `rbs-${runId}`;

  let success = true;
  let adminClient: SupabaseClient | null = null;

  try {
    const workdir = path.resolve(repoRoot, 'infra');
    const cliPath = path.resolve(repoRoot, 'node_modules/.bin/supabase');
    const cmd = `"${cliPath}" status --workdir "${workdir}" -o env`;
    const rawEnv = execSync(cmd, { encoding: 'utf8', cwd: repoRoot });
    const parsedEnv = parseSupabaseCliEnv(rawEnv);

    const apiUrl = parsedEnv.API_URL || 'http://127.0.0.1:54321';
    const serviceKey = parsedEnv.SERVICE_ROLE_KEY || '';

    adminClient = createClient(apiUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const client = adminClient;

    // Resolve staff UUIDs by role via PostgREST (not the CLI's raw `db query -o json`, whose
    // stdout-wrapping is not reliably parseable across platforms/CI runners).
    const { data: rolesData, error: rolesError } = await client.from('user_roles').select('user_id, role');
    if (rolesError || !rolesData) {
      console.error('FAIL: Failed to resolve local user_roles.');
      return false;
    }
    const adminUser = rolesData.find((u) => u.role === 'admin');
    const reviewerUser = rolesData.find((u) => u.role === 'reviewer');
    const editorUser = rolesData.find((u) => u.role === 'editor');

    if (!adminUser || !reviewerUser || !editorUser) {
      console.error('FAIL: Failed to resolve local staff users.');
      return false;
    }

    const adminId = String(adminUser.user_id);
    const reviewerId = String(reviewerUser.user_id);
    const editorId = String(editorUser.user_id);

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    const { data: programRow } = await client.from('programs').select('id, name').limit(1).single();
    const { data: disciplineRow } = await client.from('disciplines').select('id, name').limit(1).single();
    const { data: industryRow } = await client.from('industry_categories').select('id, name').limit(1).single();

    if (!programRow || !disciplineRow || !industryRow) {
      console.error('FAIL: Failed to resolve local taxonomy fixtures (programs/disciplines/industry_categories).');
      return false;
    }

    const lookups: Lookups = {
      programId: String(programRow.id),
      programName: String(programRow.name),
      disciplineId: String(disciplineRow.id),
      disciplineName: String(disciplineRow.name),
      industryId: String(industryRow.id),
      industryName: String(industryRow.name),
    };

    const createBatch = async (status: string, suffix: string) => {
      const { data, error } = await client
        .from('import_batches')
        .insert({
          batch_name: `${testPrefix}-batch-${suffix}`,
          mode: 'batch',
          source_folder: `/tmp/${testPrefix}`,
          imported_by: editorId,
          status,
          total_projects: 0,
        })
        .select()
        .single();
      if (error || !data) throw new Error(`Failed to create batch fixture: ${suffix}`);
      return data as Record<string, unknown>;
    };

    const createProject = async (params: {
      batchId: string;
      suffix: string;
      status: string;
      ready: boolean;
      missingDisciplineMapping?: boolean;
      missingMedia?: boolean;
      validationErrors?: string[];
    }) => {
      const publicId = `${testPrefix}-${params.suffix}`;
      const { data: proj, error: projErr } = await client
        .from('projects')
        .insert({
          public_id: publicId,
          title: `Runtime Review Submit Test ${params.suffix}`,
          summary: 'Synthetic summary for runtime verification.',
          year: 2026,
          program_id: lookups.programId,
          program_name: lookups.programName,
          study_program: lookups.programName,
          discipline: lookups.disciplineName,
          group_name: `Group ${params.suffix}`,
          team_members: ['Synthetic Member A', 'Synthetic Member B'],
          // Review submission and approval both require accessible poster content. This verifier
          // exercises batch submission atomicity/idempotency, so its fixture is compliant; the
          // dedicated accessibility runtime verifier owns the missing-content scenarios.
          poster_text_public: 'Synthetic runtime poster full text.',
          accessibility_text_public: 'Synthetic runtime accessibility text.',
          status: params.status,
          import_batch_id: params.batchId,
          validation_errors: params.validationErrors || [],
        })
        .select()
        .single();
      if (projErr || !proj) throw new Error(`Failed to create project fixture: ${publicId}`);

      if (!params.missingDisciplineMapping) {
        await client.from('project_disciplines').insert({ project_id: proj.id, discipline_id: lookups.disciplineId });
      }
      await client.from('project_industry_categories').insert({ project_id: proj.id, industry_category_id: lookups.industryId });

      if (!params.missingMedia) {
        await client.from('media_assets').insert([
          {
            project_id: proj.id,
            asset_type: 'poster_image',
            file_name: 'poster.png',
            storage_bucket: 'project-drafts-private',
            storage_path: `drafts/${publicId}/poster_image/poster.png`,
            mime_type: 'image/png',
            file_size_bytes: 128,
            public_url: null,
            is_public_approved: false,
          },
          {
            project_id: proj.id,
            asset_type: 'poster_pdf',
            file_name: 'poster.pdf',
            storage_bucket: 'project-drafts-private',
            storage_path: `drafts/${publicId}/poster_pdf/poster.pdf`,
            mime_type: 'application/pdf',
            file_size_bytes: 256,
            public_url: null,
            is_public_approved: false,
          },
        ]);
      }

      return proj as Record<string, unknown>;
    };

    const getAuditRecords = async (projectId: string) => {
      const { data } = await client.from('approval_records').select('*').eq('project_id', projectId);
      return data || [];
    };

    const getProjectStatus = async (projectId: string) => {
      const { data } = await client.from('projects').select('status').eq('id', projectId).single();
      return data?.status as string | undefined;
    };

    // ============================================================
    // Test 1: Readiness derivation across a multi-project completed batch
    // ============================================================
    console.log('--- Test 1: Readiness derivation (all projects returned, ready/unready correctly distinguished) ---');
    const t1Batch = await createBatch('completed', 't1');
    const t1Ready = await createProject({ batchId: String(t1Batch.id), suffix: 't1-ready', status: 'draft', ready: true });
    const t1BlockedByValidationError = await createProject({
      batchId: String(t1Batch.id), suffix: 't1-verr', status: 'draft', ready: false,
      validationErrors: ['Synthetic blocking ingestion error'],
    });
    const t1BlockedByMapping = await createProject({
      batchId: String(t1Batch.id), suffix: 't1-nomap', status: 'draft', ready: false, missingDisciplineMapping: true,
    });
    const t1BlockedByMedia = await createProject({
      batchId: String(t1Batch.id), suffix: 't1-nomedia', status: 'draft', ready: false, missingMedia: true,
    });

    const { data: t1Rows } = await client
      .from('projects')
      .select(
        `id, public_id, title, summary, status, program_id, program_name, study_program, discipline,
         group_name, team_members, poster_text_public, accessibility_text_public, snapshots, validation_errors,
         validation_warnings,
         project_disciplines(discipline_id), project_industry_categories(industry_category_id),
         media_assets(asset_type, is_public_approved, public_url),
         validation_flags(severity, resolved, message)`
      )
      .eq('import_batch_id', t1Batch.id);

    const rowsByPublicId = new Map((t1Rows || []).map((r: Record<string, unknown>) => [r.public_id as string, r]));

    const readinessFor = (row: Record<string, unknown> | undefined) => {
      if (!row) throw new Error('Missing expected row for readiness computation');
      return computeProjectReviewReadiness({
        publicId: row.public_id as string,
        title: row.title as string | null,
        summary: row.summary as string | null,
        programId: row.program_id as string | null,
        programName: row.program_name as string | null,
        studyProgram: row.study_program as string | null,
        discipline: row.discipline as string | null,
        groupName: row.group_name as string | null,
        teamMembers: row.team_members as string[] | null,
        posterText: row.poster_text_public as string | null,
        accessibilityText: row.accessibility_text_public as string | null,
        snapshots: row.snapshots as string[] | null,
        validationErrors: row.validation_errors as string[] | null,
        validationWarnings: row.validation_warnings as string[] | null,
        validationFlags: ((row.validation_flags as Array<Record<string, unknown>>) || []).map((f) => ({
          severity: f.severity as string,
          resolved: f.resolved as boolean | null,
          message: f.message as string,
        })),
        status: row.status as string,
        disciplineMappingCount: ((row.project_disciplines as unknown[]) || []).length,
        industryMappingCount: ((row.project_industry_categories as unknown[]) || []).length,
        mediaAssets: ((row.media_assets as Array<Record<string, unknown>>) || []).map((a) => ({
          assetType: a.asset_type as string,
          isPublicApproved: a.is_public_approved as boolean | null,
          publicUrl: a.public_url as string | null,
          altText: (a.alt_text_public as string | null) ?? null,
        })),
      });
    };

    const readyResult = readinessFor(rowsByPublicId.get(t1Ready.public_id as string));
    const verrResult = readinessFor(rowsByPublicId.get(t1BlockedByValidationError.public_id as string));
    const nomapResult = readinessFor(rowsByPublicId.get(t1BlockedByMapping.public_id as string));
    const nomediaResult = readinessFor(rowsByPublicId.get(t1BlockedByMedia.public_id as string));

    if (
      (t1Rows || []).length === 4 &&
      readyResult.ready === true && readyResult.blockingReasons.length === 0 &&
      verrResult.ready === false && verrResult.blockingReasons.some((r) => r.includes('Blocking ingestion validation error')) &&
      nomapResult.ready === false && nomapResult.blockingReasons.some((r) => r.includes('discipline mapping')) &&
      nomediaResult.ready === false && nomediaResult.blockingReasons.some((r) => r.toLowerCase().includes('poster'))
    ) {
      console.log('PASS: Test 1 - Readiness correctly derived for all four projects in the completed batch.');
    } else {
      console.error('FAIL: Test 1 - Readiness derivation assertion failed.');
      success = false;
    }

    // ============================================================
    // Test 2: Private media remains private (never public) — invariant check on fixtures
    // ============================================================
    console.log('--- Test 2: Staged media remains private (never public_url, never is_public_approved) ---');
    const { data: t2Media } = await client
      .from('media_assets')
      .select('is_public_approved, public_url')
      .eq('project_id', t1Ready.id);
    const allPrivate = (t2Media || []).every((m) => m.public_url === null && m.is_public_approved === false);
    if (allPrivate && (t2Media || []).length === 2) {
      console.log('PASS: Test 2 - Staged media rows remain private and unpromoted.');
    } else {
      console.error('FAIL: Test 2 - Staged media privacy invariant violated.');
      success = false;
    }

    // ============================================================
    // Test 3: Single submission draft -> submitted
    // ============================================================
    console.log('--- Test 3: Single submission draft -> submitted ---');
    const t3Res = await client.rpc('submit_import_projects_for_review', {
      p_batch_id: t1Batch.id,
      p_project_public_ids: [t1Ready.public_id],
      p_admin_id: editorId,
      p_comments: 'Runtime verification single submission',
    });

    const t3Audits = await getAuditRecords(String(t1Ready.id));
    const t3Status = await getProjectStatus(String(t1Ready.id));

    if (
      !t3Res.error &&
      t3Res.data?.resultCode === 'SUCCESS' &&
      t3Res.data?.submittedCount === 1 &&
      t3Status === 'submitted' &&
      t3Audits.length === 1 &&
      t3Audits[0].action_taken === 'submit_for_review' &&
      t3Audits[0].admin_id === editorId &&
      t3Audits[0].from_status === 'draft' &&
      t3Audits[0].to_status === 'submitted'
    ) {
      console.log('PASS: Test 3 - Single draft project submitted with exactly one correct audit record.');
    } else {
      console.error('FAIL: Test 3 - Single submission assertion failed.');
      success = false;
    }

    // ============================================================
    // Test 4: Resubmission changes_requested -> submitted
    // ============================================================
    console.log('--- Test 4: Resubmission changes_requested -> submitted ---');
    const t4Batch = await createBatch('completed', 't4');
    const t4Proj = await createProject({ batchId: String(t4Batch.id), suffix: 't4', status: 'changes_requested', ready: true });

    const t4Res = await client.rpc('submit_import_projects_for_review', {
      p_batch_id: t4Batch.id,
      p_project_public_ids: [t4Proj.public_id],
      p_admin_id: editorId,
      p_comments: 'Runtime verification resubmission',
    });

    const t4Audits = await getAuditRecords(String(t4Proj.id));
    const t4Status = await getProjectStatus(String(t4Proj.id));

    if (
      !t4Res.error &&
      t4Res.data?.resultCode === 'SUCCESS' &&
      t4Status === 'submitted' &&
      t4Audits.length === 1 &&
      t4Audits[0].from_status === 'changes_requested' &&
      t4Audits[0].to_status === 'submitted'
    ) {
      console.log('PASS: Test 4 - changes_requested project resubmitted with a new legitimate audit entry.');
    } else {
      console.error('FAIL: Test 4 - Resubmission assertion failed.');
      success = false;
    }

    // ============================================================
    // Test 5: Multi-project atomic submission
    // ============================================================
    console.log('--- Test 5: Multi-project atomic submission ---');
    const t5Batch = await createBatch('completed', 't5');
    const t5A = await createProject({ batchId: String(t5Batch.id), suffix: 't5a', status: 'draft', ready: true });
    const t5B = await createProject({ batchId: String(t5Batch.id), suffix: 't5b', status: 'draft', ready: true });

    const t5Res = await client.rpc('submit_import_projects_for_review', {
      p_batch_id: t5Batch.id,
      p_project_public_ids: [t5A.public_id, t5B.public_id],
      p_admin_id: adminId,
      p_comments: null,
    });

    const t5StatusA = await getProjectStatus(String(t5A.id));
    const t5StatusB = await getProjectStatus(String(t5B.id));
    const t5AuditsA = await getAuditRecords(String(t5A.id));
    const t5AuditsB = await getAuditRecords(String(t5B.id));

    if (
      !t5Res.error &&
      t5Res.data?.resultCode === 'SUCCESS' &&
      t5Res.data?.submittedCount === 2 &&
      t5StatusA === 'submitted' && t5StatusB === 'submitted' &&
      t5AuditsA.length === 1 && t5AuditsB.length === 1
    ) {
      console.log('PASS: Test 5 - Two ready projects transitioned together atomically.');
    } else {
      console.error('FAIL: Test 5 - Multi-project atomic submission assertion failed.');
      success = false;
    }

    // ============================================================
    // Test 6: Full rollback — one unready project blocks the whole selection
    // ============================================================
    console.log('--- Test 6: Full rollback when one selected project fails readiness ---');
    const t6Batch = await createBatch('completed', 't6');
    const t6Ready = await createProject({ batchId: String(t6Batch.id), suffix: 't6-ready', status: 'draft', ready: true });
    const t6Blocked = await createProject({
      batchId: String(t6Batch.id), suffix: 't6-blocked', status: 'draft', ready: false, missingMedia: true,
    });

    const t6Res = await client.rpc('submit_import_projects_for_review', {
      p_batch_id: t6Batch.id,
      p_project_public_ids: [t6Ready.public_id, t6Blocked.public_id],
      p_admin_id: editorId,
      p_comments: null,
    });

    const t6StatusReady = await getProjectStatus(String(t6Ready.id));
    const t6StatusBlocked = await getProjectStatus(String(t6Blocked.id));
    const t6AuditsReady = await getAuditRecords(String(t6Ready.id));
    const t6AuditsBlocked = await getAuditRecords(String(t6Blocked.id));

    if (
      !t6Res.error &&
      t6Res.data?.resultCode === 'READINESS_BLOCKED' &&
      t6StatusReady === 'draft' && t6StatusBlocked === 'draft' &&
      t6AuditsReady.length === 0 && t6AuditsBlocked.length === 0
    ) {
      console.log('PASS: Test 6 - Zero partial transitions and zero audit rows when one project fails readiness.');
    } else {
      console.error('FAIL: Test 6 - Full rollback assertion failed.');
      success = false;
    }

    // ============================================================
    // Test 7: Idempotent sequential retry — no duplicate audit records
    // ============================================================
    console.log('--- Test 7: Idempotent sequential retry ---');
    const t7Retry = await client.rpc('submit_import_projects_for_review', {
      p_batch_id: t1Batch.id,
      p_project_public_ids: [t1Ready.public_id],
      p_admin_id: editorId,
      p_comments: 'Retry attempt',
    });
    const t7Audits = await getAuditRecords(String(t1Ready.id));
    const t7Status = await getProjectStatus(String(t1Ready.id));

    if (
      !t7Retry.error &&
      t7Retry.data?.resultCode === 'SUCCESS' &&
      t7Retry.data?.submittedCount === 0 &&
      Array.isArray(t7Retry.data?.alreadySubmittedPublicIds) &&
      t7Retry.data.alreadySubmittedPublicIds.includes(t1Ready.public_id) &&
      t7Status === 'submitted' &&
      t7Audits.length === 1
    ) {
      console.log('PASS: Test 7 - Sequential retry converged idempotently with no duplicate audit record.');
    } else {
      console.error('FAIL: Test 7 - Idempotent sequential retry assertion failed.');
      success = false;
    }

    // ============================================================
    // Test 8: Real concurrency — two first-time submissions of the same fresh project
    // ============================================================
    console.log('--- Test 8: Real concurrency (two first-time concurrent submissions) ---');
    const t8Batch = await createBatch('completed', 't8');
    const t8Proj = await createProject({ batchId: String(t8Batch.id), suffix: 't8', status: 'draft', ready: true });

    const [t8ResA, t8ResB] = await Promise.all([
      client.rpc('submit_import_projects_for_review', {
        p_batch_id: t8Batch.id, p_project_public_ids: [t8Proj.public_id], p_admin_id: editorId, p_comments: 'Concurrent A',
      }),
      client.rpc('submit_import_projects_for_review', {
        p_batch_id: t8Batch.id, p_project_public_ids: [t8Proj.public_id], p_admin_id: adminId, p_comments: 'Concurrent B',
      }),
    ]);

    const t8Audits = await getAuditRecords(String(t8Proj.id));
    const t8Status = await getProjectStatus(String(t8Proj.id));

    const bothCoherent =
      !t8ResA.error && !t8ResB.error &&
      t8ResA.data?.resultCode === 'SUCCESS' && t8ResB.data?.resultCode === 'SUCCESS';
    const exactlyOneTransition = (t8ResA.data?.submittedCount ?? 0) + (t8ResB.data?.submittedCount ?? 0) === 1;

    if (bothCoherent && exactlyOneTransition && t8Status === 'submitted' && t8Audits.length === 1) {
      console.log('PASS: Test 8 - Concurrent first-time submissions converged to exactly one transition and one audit record.');
    } else {
      console.error('FAIL: Test 8 - Real concurrency assertion failed.');
      success = false;
    }

    // ============================================================
    // Test 9: Authorization — reviewer-only identity must not be able to submit
    // ============================================================
    console.log('--- Test 9: Authorization boundary (reviewer-only cannot submit; unknown admin id rejected) ---');
    const t9Batch = await createBatch('completed', 't9');
    const t9Proj = await createProject({ batchId: String(t9Batch.id), suffix: 't9', status: 'draft', ready: true });

    const t9ReviewerRes = await client.rpc('submit_import_projects_for_review', {
      p_batch_id: t9Batch.id, p_project_public_ids: [t9Proj.public_id], p_admin_id: reviewerId, p_comments: null,
    });
    const t9UnknownRes = await client.rpc('submit_import_projects_for_review', {
      p_batch_id: t9Batch.id, p_project_public_ids: [t9Proj.public_id], p_admin_id: '00000000-0000-0000-0000-000000000000', p_comments: null,
    });
    const t9Status = await getProjectStatus(String(t9Proj.id));
    const t9Audits = await getAuditRecords(String(t9Proj.id));

    const t9EditorRes = await client.rpc('submit_import_projects_for_review', {
      p_batch_id: t9Batch.id, p_project_public_ids: [t9Proj.public_id], p_admin_id: editorId, p_comments: null,
    });
    const t9StatusAfterEditor = await getProjectStatus(String(t9Proj.id));

    if (
      !t9ReviewerRes.error && t9ReviewerRes.data?.resultCode === 'SUBMIT_PERMISSION_DENIED' &&
      !t9UnknownRes.error && t9UnknownRes.data?.resultCode === 'SUBMIT_PERMISSION_DENIED' &&
      t9Status === 'draft' && t9Audits.length === 0 &&
      !t9EditorRes.error && t9EditorRes.data?.resultCode === 'SUCCESS' &&
      t9StatusAfterEditor === 'submitted'
    ) {
      console.log('PASS: Test 9 - Reviewer-only and unknown admin identities rejected; projects.edit-holding editor succeeded.');
    } else {
      console.error('FAIL: Test 9 - Authorization boundary assertion failed.');
      success = false;
    }

    // ============================================================
    // Test 10: Existing reviewer workflow becomes available after submission
    // ============================================================
    console.log('--- Test 10: Existing reviewer approve action becomes available after submission ---');
    const t10Res = await client.rpc('perform_project_review_action', {
      p_public_id: t1Ready.public_id,
      p_action: 'approve',
      p_comments: 'Approving after submission, runtime verification',
      p_admin_id: adminId,
    });
    const t10Status = await getProjectStatus(String(t1Ready.id));

    if (!t10Res.error && t10Res.data?.status === 'approved' && t10Status === 'approved') {
      console.log('PASS: Test 10 - Existing perform_project_review_action approve succeeded after review submission.');
    } else {
      console.error('FAIL: Test 10 - Existing reviewer workflow integration assertion failed.');
      success = false;
    }

    // ============================================================
    // Test 11: Unresolved error-severity validation_flags block submission at the SQL RPC layer
    // (server-authoritative, re-derived inside submit_import_projects_for_review); resolving the
    // flag allows the same otherwise-ready project to be submitted.
    // ============================================================
    console.log('--- Test 11: Unresolved error validation_flag blocks submission; resolving it unblocks ---');
    const t11Batch = await createBatch('completed', 't11');
    const t11Proj = await createProject({ batchId: String(t11Batch.id), suffix: 't11', status: 'draft', ready: true });

    const { data: t11Flag, error: t11FlagErr } = await client
      .from('validation_flags')
      .insert({
        project_id: t11Proj.id,
        severity: 'error',
        rule_code: 'SYNTHETIC_BLOCKING_FLAG',
        message: 'Synthetic unresolved error flag for runtime verification',
        resolved: false,
      })
      .select()
      .single();
    if (t11FlagErr || !t11Flag) throw new Error('Failed to create validation_flags fixture for Test 11');

    const t11BlockedRes = await client.rpc('submit_import_projects_for_review', {
      p_batch_id: t11Batch.id, p_project_public_ids: [t11Proj.public_id], p_admin_id: editorId, p_comments: null,
    });
    const t11StatusBlocked = await getProjectStatus(String(t11Proj.id));
    const t11AuditsBlocked = await getAuditRecords(String(t11Proj.id));

    await client.from('validation_flags').update({ resolved: true }).eq('id', t11Flag.id);

    const t11ResolvedRes = await client.rpc('submit_import_projects_for_review', {
      p_batch_id: t11Batch.id, p_project_public_ids: [t11Proj.public_id], p_admin_id: editorId, p_comments: null,
    });
    const t11StatusResolved = await getProjectStatus(String(t11Proj.id));
    const t11AuditsResolved = await getAuditRecords(String(t11Proj.id));

    if (
      !t11BlockedRes.error &&
      t11BlockedRes.data?.resultCode === 'READINESS_BLOCKED' &&
      Array.isArray(t11BlockedRes.data?.blockingReasons) &&
      t11BlockedRes.data.blockingReasons.includes('BLOCKING_VALIDATION_FLAGS') &&
      t11StatusBlocked === 'draft' && t11AuditsBlocked.length === 0 &&
      !t11ResolvedRes.error &&
      t11ResolvedRes.data?.resultCode === 'SUCCESS' &&
      t11StatusResolved === 'submitted' &&
      t11AuditsResolved.length === 1
    ) {
      console.log('PASS: Test 11 - Unresolved error validation_flag blocked submission at the SQL layer; resolving it allowed submission.');
    } else {
      console.error('FAIL: Test 11 - Validation-flag blocking assertion failed.');
      success = false;
    }

    if (!uuidRegex.test(String(t3Audits[0]?.id || ''))) {
      console.error('FAIL: Sanity check — audit record id was not a valid UUID.');
      success = false;
    }
  } catch (err: unknown) {
    console.error('FAIL: Unexpected runtime verification error.', err instanceof Error ? err.message : err);
    success = false;
  } finally {
    // Fail-Closed Global Cleanup Block
    let cleanupExecutionError = false;
    try {
      if (adminClient) {
        const client = adminClient;
        const { data: testProjects } = await client.from('projects').select('id').like('public_id', `${testPrefix}-%`);
        const projectIds = (testProjects || []).map((p) => p.id);
        if (projectIds.length > 0) {
          await client.from('approval_records').delete().in('project_id', projectIds);
          await client.from('validation_flags').delete().in('project_id', projectIds);
          await client.from('media_assets').delete().in('project_id', projectIds);
          await client.from('project_disciplines').delete().in('project_id', projectIds);
          await client.from('project_industry_categories').delete().in('project_id', projectIds);
        }
        await client.from('projects').delete().like('public_id', `${testPrefix}-%`);
        await client.from('import_batches').delete().like('batch_name', `${testPrefix}-%`);
      }
    } catch {
      cleanupExecutionError = true;
      console.error('FAIL: Global cleanup execution encountered an error.');
    }

    try {
      if (!adminClient) {
        throw new Error('adminClient unavailable for post-cleanup verification');
      }
      const client = adminClient;
      const { count: projCount } = await client
        .from('projects')
        .select('id', { count: 'exact', head: true })
        .like('public_id', `${testPrefix}-%`);
      const { count: batchCount } = await client
        .from('import_batches')
        .select('id', { count: 'exact', head: true })
        .like('batch_name', `${testPrefix}-%`);

      if (!cleanupExecutionError && projCount === 0 && batchCount === 0) {
        console.log('PASS: Independent post-cleanup verification confirmed zero leftover test projects and batches.');
      } else {
        console.error('FAIL: Post-cleanup count validation failed or cleanup error occurred.');
        success = false;
      }
    } catch {
      console.error('FAIL: Independent post-cleanup query execution failed.');
      success = false;
    }
  }

  console.log('\n====================================================');
  console.log(success ? 'OVERALL RUNTIME VERIFICATION RESULT: PASS' : 'OVERALL RUNTIME VERIFICATION RESULT: FAIL');
  console.log('====================================================\n');

  return success;
}

if (require.main === module) {
  runImportBatchReviewSubmitRuntimeVerification()
    .then((pass) => {
      if (!pass) process.exit(1);
    })
    .catch(() => {
      process.exit(1);
    });
}
