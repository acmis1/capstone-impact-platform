import { createClient } from '@supabase/supabase-js';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';

function runLocalDbQuery(sql: string, repoRoot: string): Array<Record<string, unknown>> {
  const workdir = path.resolve(repoRoot, 'infra');
  const cliPath = path.resolve(repoRoot, 'node_modules/.bin/supabase');
  const cmd = `"${cliPath}" db query --local --workdir "${workdir}" -o json "${sql.replace(/"/g, '\\"')}"`;
  const raw = execSync(cmd, { encoding: 'utf8', cwd: repoRoot });
  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1) {
    const parsed = JSON.parse(raw.slice(firstBrace, lastBrace + 1)) as { rows?: Array<Record<string, unknown>> };
    return parsed.rows || [];
  }
  return [];
}

function runLocalDbExec(sql: string, repoRoot: string): void {
  const workdir = path.resolve(repoRoot, 'infra');
  const cliPath = path.resolve(repoRoot, 'node_modules/.bin/supabase');
  const cmd = `"${cliPath}" db query --local --workdir "${workdir}" "${sql.replace(/"/g, '\\"')}"`;
  execSync(cmd, { encoding: 'utf8', cwd: repoRoot });
}

export async function runReviewActionsRuntimeVerification(): Promise<boolean> {
  console.log('=== Local Supabase Transactional Review Actions Runtime Verification ===\n');
  const repoRoot = path.resolve(__dirname, '../../../..');
  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const testProjectPrefix = `test-proj-${runId}`;

  let success = true;

  try {
    // 1. Query local Supabase CLI env
    const workdir = path.resolve(repoRoot, 'infra');
    const cliPath = path.resolve(repoRoot, 'node_modules/.bin/supabase');
    const cmd = `"${cliPath}" status --workdir "${workdir}" -o env`;
    const rawEnv = execSync(cmd, { encoding: 'utf8', cwd: repoRoot });
    const parsedEnv = parseSupabaseCliEnv(rawEnv);

    const apiUrl = parsedEnv.API_URL || 'http://127.0.0.1:54321';
    const serviceKey = parsedEnv.SERVICE_ROLE_KEY || '';

    const adminClient = createClient(apiUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // 2. Fetch admin_users with user_roles to retrieve UUIDs silently
    const usersWithRoles = runLocalDbQuery(
      "SELECT u.id, r.role FROM public.admin_users u JOIN public.user_roles r ON r.user_id = u.id",
      repoRoot
    );

    const adminUser = usersWithRoles.find((u) => u.role === 'admin');
    const reviewerUser = usersWithRoles.find((u) => u.role === 'reviewer');
    const editorUser = usersWithRoles.find((u) => u.role === 'editor');

    if (!adminUser || !reviewerUser || !editorUser) {
      console.error('FAIL: Failed to resolve local staff users.');
      return false;
    }

    const adminId = String(adminUser.id);
    const reviewerId = String(reviewerUser.id);
    const editorId = String(editorUser.id);

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    // Helper to create disposable test projects
    const createFixture = async (suffix: string, status: string = 'in_review') => {
      const publicId = `${testProjectPrefix}-${suffix}`;
      const { data, error } = await adminClient
        .from('projects')
        .insert({
          public_id: publicId,
          title: `Disposable Runtime Test Project ${suffix}`,
          summary: 'Synthetic test project for runtime verification',
          status: status,
          year: 2026,
        })
        .select()
        .single();

      if (error || !data) {
        throw new Error(`Failed to create test project fixture: ${publicId}`);
      }
      return data;
    };

    // ============================================================
    // Test 1: Admin Approves in_review Project
    // ============================================================
    console.log('--- Test 1: Admin approves in_review project ---');
    const t1Proj = await createFixture('t1', 'in_review');

    const { data: t1Res, error: t1Err } = await adminClient.rpc('perform_project_review_action', {
      p_public_id: t1Proj.public_id,
      p_action: 'approve',
      p_comments: 'Approved by Admin in runtime verification',
      p_admin_id: adminId,
    });

    if (t1Err || !t1Res) {
      console.error('FAIL: Test 1 RPC invocation failed.');
      success = false;
    } else {
      const { data: t1ProjDb } = await adminClient.from('projects').select('*').eq('id', t1Proj.id).single();
      const { data: t1Audits } = await adminClient.from('approval_records').select('*').eq('project_id', t1Proj.id);

      const auditRow = t1Audits && t1Audits.length === 1 ? t1Audits[0] : null;

      if (
        t1Res.publicId === t1Proj.public_id &&
        t1Res.status === 'approved' &&
        uuidRegex.test(t1Res.auditRecordId) &&
        t1ProjDb?.status === 'approved' &&
        t1Audits?.length === 1 &&
        auditRow &&
        auditRow.id === t1Res.auditRecordId &&
        auditRow.action_taken === 'approve' &&
        auditRow.admin_id === adminId &&
        auditRow.from_status === 'in_review' &&
        auditRow.to_status === 'approved' &&
        auditRow.comments === 'Approved by Admin in runtime verification'
      ) {
        console.log('PASS: Test 1 - Admin approval executed atomically and verified.');
      } else {
        console.error('FAIL: Test 1 - Database or response validation failed.');
        success = false;
      }
    }

    // ============================================================
    // Test 2: Reviewer Requests Changes on Approved Project
    // ============================================================
    console.log('--- Test 2: Reviewer requests changes on approved project ---');
    const t2Proj = await createFixture('t2', 'approved');

    const { data: t2Res, error: t2Err } = await adminClient.rpc('perform_project_review_action', {
      p_public_id: t2Proj.public_id,
      p_action: 'request_changes',
      p_comments: 'Needs revision',
      p_admin_id: reviewerId,
    });

    if (t2Err || !t2Res) {
      console.error('FAIL: Test 2 RPC invocation failed.');
      success = false;
    } else {
      const { data: t2ProjDb } = await adminClient.from('projects').select('*').eq('id', t2Proj.id).single();
      const { data: t2Audits } = await adminClient.from('approval_records').select('*').eq('project_id', t2Proj.id);

      const auditRow = t2Audits && t2Audits.length === 1 ? t2Audits[0] : null;

      if (
        t2Res.publicId === t2Proj.public_id &&
        t2Res.status === 'changes_requested' &&
        uuidRegex.test(t2Res.auditRecordId) &&
        t2ProjDb?.status === 'changes_requested' &&
        t2Audits?.length === 1 &&
        auditRow &&
        auditRow.id === t2Res.auditRecordId &&
        auditRow.action_taken === 'request_changes' &&
        auditRow.admin_id === reviewerId &&
        auditRow.from_status === 'approved' &&
        auditRow.to_status === 'changes_requested' &&
        auditRow.comments === 'Needs revision'
      ) {
        console.log('PASS: Test 2 - Reviewer request_changes executed atomically and verified.');
      } else {
        console.error('FAIL: Test 2 - Database or response validation failed.');
        success = false;
      }
    }

    // ============================================================
    // Test 3: Reviewer Attempts Archive Action (Unauthorized)
    // ============================================================
    console.log('--- Test 3: Reviewer attempts archive action (Unauthorized) ---');
    const t3Proj = await createFixture('t3', 'in_review');

    const { error: t3Err } = await adminClient.rpc('perform_project_review_action', {
      p_public_id: t3Proj.public_id,
      p_action: 'archive',
      p_comments: 'Reviewer archiving',
      p_admin_id: reviewerId,
    });

    const { data: t3ProjDb } = await adminClient.from('projects').select('*').eq('id', t3Proj.id).single();
    const { data: t3Audits } = await adminClient.from('approval_records').select('*').eq('project_id', t3Proj.id);

    if (
      t3Err &&
      t3Err.message.includes('REVIEW_PERMISSION_DENIED') &&
      t3ProjDb?.status === 'in_review' &&
      t3ProjDb?.archived_at === null &&
      t3ProjDb?.archive_reason === null &&
      t3Audits?.length === 0
    ) {
      console.log('PASS: Test 3 - Reviewer archive attempt rejected by RBAC; project state unchanged.');
    } else {
      console.error('FAIL: Test 3 - RBAC enforcement or state preservation failed.');
      success = false;
    }

    // ============================================================
    // Test 4: Editor Attempts Review Action (Unauthorized)
    // ============================================================
    console.log('--- Test 4: Editor attempts review action (Unauthorized) ---');
    const t4Proj = await createFixture('t4', 'in_review');

    const { error: t4Err } = await adminClient.rpc('perform_project_review_action', {
      p_public_id: t4Proj.public_id,
      p_action: 'approve',
      p_comments: 'Editor approving',
      p_admin_id: editorId,
    });

    const { data: t4ProjDb } = await adminClient.from('projects').select('*').eq('id', t4Proj.id).single();
    const { data: t4Audits } = await adminClient.from('approval_records').select('*').eq('project_id', t4Proj.id);

    if (
      t4Err &&
      t4Err.message.includes('REVIEW_PERMISSION_DENIED') &&
      t4ProjDb?.status === 'in_review' &&
      t4Audits?.length === 0
    ) {
      console.log('PASS: Test 4 - Editor review action attempt rejected by RBAC; project state unchanged.');
    } else {
      console.error('FAIL: Test 4 - Editor RBAC enforcement failed.');
      success = false;
    }

    // ============================================================
    // Test 5: Invalid Workflow State Transition Attempt
    // ============================================================
    console.log('--- Test 5: Invalid workflow state transition attempt ---');
    const t5Proj = await createFixture('t5', 'draft');

    const { error: t5Err } = await adminClient.rpc('perform_project_review_action', {
      p_public_id: t5Proj.public_id,
      p_action: 'approve',
      p_comments: 'Approving draft',
      p_admin_id: adminId,
    });

    const { data: t5ProjDb } = await adminClient.from('projects').select('*').eq('id', t5Proj.id).single();
    const { data: t5Audits } = await adminClient.from('approval_records').select('*').eq('project_id', t5Proj.id);

    if (
      t5Err &&
      t5Err.message.includes('REVIEW_TRANSITION_INVALID') &&
      t5ProjDb?.status === 'draft' &&
      t5Audits?.length === 0
    ) {
      console.log('PASS: Test 5 - Invalid transition rejected by workflow engine; project state unchanged.');
    } else {
      console.error('FAIL: Test 5 - Invalid transition validation failed.');
      success = false;
    }

    // ============================================================
    // Test 6: Forced Audit Log Failure Rollback Test
    // ============================================================
    console.log('--- Test 6: Forced Audit Log Failure Rollback Test ---');
    const t6Proj = await createFixture('t6', 'in_review');

    const initialCaptured = {
      status: t6Proj.status,
      archived_at: t6Proj.archived_at,
      archived_from_status: t6Proj.archived_from_status,
      archive_reason: t6Proj.archive_reason,
      pending_removal_from_public: t6Proj.pending_removal_from_public,
    };

    let t6RpcErr: Error | null = null;
    try {
      // Install temporary trigger
      runLocalDbExec(
        "CREATE OR REPLACE FUNCTION public.temp_fail_audit() RETURNS TRIGGER AS $$ BEGIN RAISE EXCEPTION 'FORCED_AUDIT_FAILURE'; END; $$ LANGUAGE plpgsql;",
        repoRoot
      );
      runLocalDbExec("DROP TRIGGER IF EXISTS trigger_temp_fail_audit ON public.approval_records;", repoRoot);
      runLocalDbExec(
        "CREATE TRIGGER trigger_temp_fail_audit BEFORE INSERT ON public.approval_records FOR EACH ROW EXECUTE FUNCTION public.temp_fail_audit();",
        repoRoot
      );

      const { error: t6Err } = await adminClient.rpc('perform_project_review_action', {
        p_public_id: t6Proj.public_id,
        p_action: 'approve',
        p_comments: 'Approving under forced audit failure',
        p_admin_id: adminId,
      });

      if (t6Err) {
        t6RpcErr = t6Err;
      }
    } finally {
      // Remove temporary trigger immediately in nested finally
      try {
        runLocalDbExec("DROP TRIGGER IF EXISTS trigger_temp_fail_audit ON public.approval_records;", repoRoot);
        runLocalDbExec("DROP FUNCTION IF EXISTS public.temp_fail_audit();", repoRoot);
      } catch {
        // Ignored
      }
    }

    const { data: t6ProjDb } = await adminClient.from('projects').select('*').eq('id', t6Proj.id).single();
    const { data: t6Audits } = await adminClient.from('approval_records').select('*').eq('project_id', t6Proj.id);

    const fieldsUnchanged =
      t6ProjDb?.status === initialCaptured.status &&
      t6ProjDb?.archived_at === initialCaptured.archived_at &&
      t6ProjDb?.archived_from_status === initialCaptured.archived_from_status &&
      t6ProjDb?.archive_reason === initialCaptured.archive_reason &&
      t6ProjDb?.pending_removal_from_public === initialCaptured.pending_removal_from_public;

    if (
      t6RpcErr &&
      t6RpcErr.message.includes('FORCED_AUDIT_FAILURE') &&
      fieldsUnchanged &&
      t6Audits?.length === 0
    ) {
      console.log('PASS: Test 6 - Complete transaction rollback verified on forced audit failure.');
    } else {
      console.error('FAIL: Test 6 - Transaction rollback on audit failure failed.');
      success = false;
    }

    // ============================================================
    // Test 7: Concurrent Action Serialization Test (Race Condition)
    // ============================================================
    console.log('--- Test 7: Concurrent Action Serialization Test ---');
    const t7Proj = await createFixture('t7', 'in_review');

    const [resA, resB] = await Promise.all([
      adminClient.rpc('perform_project_review_action', {
        p_public_id: t7Proj.public_id,
        p_action: 'request_changes',
        p_comments: 'Concurrent request_changes',
        p_admin_id: reviewerId,
      }),
      adminClient.rpc('perform_project_review_action', {
        p_public_id: t7Proj.public_id,
        p_action: 'archive',
        p_comments: 'Concurrent archive',
        p_admin_id: adminId,
      }),
    ]);

    const successes = [resA, resB].filter((r) => !r.error && r.data);
    const failures = [resA, resB].filter((r) => r.error);

    const hasExpectedFailureCode = failures.some((f) => f.error?.message.includes('REVIEW_TRANSITION_INVALID'));

    const { data: t7ProjDb } = await adminClient.from('projects').select('*').eq('id', t7Proj.id).single();
    const { data: t7Audits } = await adminClient.from('approval_records').select('*').eq('project_id', t7Proj.id);

    const winningAction = resA.data ? 'request_changes' : resB.data ? 'archive' : null;
    const expectedStatus = winningAction === 'request_changes' ? 'changes_requested' : winningAction === 'archive' ? 'archived' : null;

    const singleAudit = t7Audits && t7Audits.length === 1 ? t7Audits[0] : null;

    const auditMatchesWinner =
      singleAudit &&
      singleAudit.action_taken === winningAction &&
      singleAudit.from_status === 'in_review' &&
      singleAudit.to_status === expectedStatus;

    if (
      successes.length === 1 &&
      failures.length === 1 &&
      hasExpectedFailureCode &&
      t7ProjDb?.status === expectedStatus &&
      t7Audits?.length === 1 &&
      auditMatchesWinner
    ) {
      console.log('PASS: Test 7 - Row locking (FOR UPDATE) successfully serialized concurrent requests (1 succeeded, 1 failed with REVIEW_TRANSITION_INVALID).');
    } else {
      console.error('FAIL: Test 7 - Concurrent action serialization failed.');
      success = false;
    }

  } catch {
    console.error('FAIL: Unexpected runtime verification error.');
    success = false;
  } finally {
    // Global Cleanup Block
    try {
      runLocalDbExec("DROP TRIGGER IF EXISTS trigger_temp_fail_audit ON public.approval_records;", repoRoot);
      runLocalDbExec("DROP FUNCTION IF EXISTS public.temp_fail_audit();", repoRoot);
      runLocalDbExec(`DELETE FROM public.approval_records WHERE project_id IN (SELECT id FROM public.projects WHERE public_id LIKE '${testProjectPrefix}-%');`, repoRoot);
      runLocalDbExec(`DELETE FROM public.projects WHERE public_id LIKE '${testProjectPrefix}-%';`, repoRoot);
    } catch {
      // Ignored
    }
  }

  console.log('\n====================================================');
  console.log(success ? 'OVERALL RUNTIME VERIFICATION RESULT: PASS' : 'OVERALL RUNTIME VERIFICATION RESULT: FAIL');
  console.log('====================================================\n');

  return success;
}

if (require.main === module) {
  runReviewActionsRuntimeVerification()
    .then((pass) => {
      if (!pass) process.exit(1);
    })
    .catch(() => {
      process.exit(1);
    });
}
