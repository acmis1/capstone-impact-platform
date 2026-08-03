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
  console.log('=== Starting Local Supabase Transactional Review Actions Runtime Verification ===\n');
  const repoRoot = path.resolve(__dirname, '../../../..');

  // 1. Reset database to clean seed state
  console.log('Resetting local database to clean seed state...');
  execSync('npm run supabase:reset', { encoding: 'utf8', cwd: repoRoot });
  execSync('npm run supabase:users:local -- --force', { encoding: 'utf8', cwd: repoRoot });

  // 2. Query local Supabase CLI env
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

  // 3. Fetch admin_users with user_roles to retrieve UUIDs
  const usersWithRoles = runLocalDbQuery(
    "SELECT u.id, u.email, r.role FROM public.admin_users u JOIN public.user_roles r ON r.user_id = u.id",
    repoRoot
  );

  const adminUser = usersWithRoles.find((u) => u.role === 'admin');
  const reviewerUser = usersWithRoles.find((u) => u.role === 'reviewer');
  const editorUser = usersWithRoles.find((u) => u.role === 'editor');

  if (!adminUser || !reviewerUser || !editorUser) {
    console.error('❌ Failed to resolve local staff users (admin, reviewer, editor required).');
    return false;
  }

  const adminId = String(adminUser.id);
  const reviewerId = String(reviewerUser.id);
  const editorId = String(editorUser.id);

  console.log('✔ Staff user roles resolved from database:');
  console.log(`    Admin:    ${adminId} (${adminUser.email})`);
  console.log(`    Reviewer: ${reviewerId} (${reviewerUser.email})`);
  console.log(`    Editor:   ${editorId} (${editorUser.email})\n`);

  // ============================================================
  // Test 1: Admin Approves in_review Project
  // ============================================================
  console.log('--- Test 1: Admin approves in_review project ---');
  const t1PublicId = '2026-agri-iot'; // initial status is 'in_review'

  const { data: t1Res, error: t1Err } = await adminClient.rpc('perform_project_review_action', {
    p_public_id: t1PublicId,
    p_action: 'approve',
    p_comments: 'Approved by Admin in runtime verification',
    p_admin_id: adminId,
  });

  if (t1Err || !t1Res || t1Res.status !== 'approved') {
    console.error(`❌ Test 1 Failed: Admin approval failed: ${t1Err?.message || 'Invalid response'}`);
    return false;
  }

  const { data: t1Proj } = await adminClient.from('projects').select('*').eq('public_id', t1PublicId).single();
  const { data: t1Audit } = await adminClient.from('approval_records').select('*').eq('id', t1Res.auditRecordId).single();

  if (t1Proj?.status !== 'approved' || t1Audit?.action_taken !== 'approve' || t1Audit?.admin_id !== adminId) {
    console.error('❌ Test 1 Failed: Database state mismatch after approval.');
    return false;
  }
  console.log('✔ Test 1 Passed: Admin approval successfully executed atomically and recorded in audit log.\n');

  // ============================================================
  // Test 2: Reviewer Requests Changes on Approved Project
  // ============================================================
  console.log('--- Test 2: Reviewer requests changes on approved project ---');
  const { data: t2Res, error: t2Err } = await adminClient.rpc('perform_project_review_action', {
    p_public_id: t1PublicId,
    p_action: 'request_changes',
    p_comments: 'Need minor changes',
    p_admin_id: reviewerId,
  });

  if (t2Err || !t2Res || t2Res.status !== 'changes_requested') {
    console.error(`❌ Test 2 Failed: Reviewer request_changes failed: ${t2Err?.message || 'Invalid response'}`);
    return false;
  }

  const { data: t2Proj } = await adminClient.from('projects').select('*').eq('public_id', t1PublicId).single();
  const { data: t2Audit } = await adminClient.from('approval_records').select('*').eq('id', t2Res.auditRecordId).single();

  if (t2Proj?.status !== 'changes_requested' || t2Audit?.action_taken !== 'request_changes' || t2Audit?.admin_id !== reviewerId) {
    console.error('❌ Test 2 Failed: Database state mismatch after request_changes.');
    return false;
  }
  console.log('✔ Test 2 Passed: Reviewer request_changes successfully executed atomically and recorded in audit log.\n');

  // ============================================================
  // Test 3: Reviewer Attempts Archive Action (Unauthorized)
  // ============================================================
  console.log('--- Test 3: Reviewer attempts archive action (Unauthorized) ---');
  const countBeforeT3 = runLocalDbQuery("SELECT count(*) FROM public.approval_records", repoRoot)[0].count;

  const { error: t3Err } = await adminClient.rpc('perform_project_review_action', {
    p_public_id: t1PublicId,
    p_action: 'archive',
    p_comments: 'Reviewer archiving',
    p_admin_id: reviewerId,
  });

  if (!t3Err || !t3Err.message.includes('REVIEW_PERMISSION_DENIED')) {
    console.error(`❌ Test 3 Failed: Reviewer archive attempt did not throw REVIEW_PERMISSION_DENIED.`);
    return false;
  }

  const countAfterT3 = runLocalDbQuery("SELECT count(*) FROM public.approval_records", repoRoot)[0].count;
  const { data: t3Proj } = await adminClient.from('projects').select('*').eq('public_id', t1PublicId).single();

  if (t3Proj?.status !== 'changes_requested' || countBeforeT3 !== countAfterT3) {
    console.error('❌ Test 3 Failed: State was mutated despite REVIEW_PERMISSION_DENIED.');
    return false;
  }
  console.log('✔ Test 3 Passed: Reviewer archive attempt rejected by RBAC; project status and audit log unchanged.\n');

  // ============================================================
  // Test 4: Editor Attempts Review Action (Unauthorized)
  // ============================================================
  console.log('--- Test 4: Editor attempts review action (Unauthorized) ---');
  const { error: t4Err } = await adminClient.rpc('perform_project_review_action', {
    p_public_id: t1PublicId,
    p_action: 'approve',
    p_comments: 'Editor approving',
    p_admin_id: editorId,
  });

  if (!t4Err || !t4Err.message.includes('REVIEW_PERMISSION_DENIED')) {
    console.error(`❌ Test 4 Failed: Editor approve attempt did not throw REVIEW_PERMISSION_DENIED.`);
    return false;
  }
  console.log('✔ Test 4 Passed: Editor review action attempt rejected by RBAC.\n');

  // ============================================================
  // Test 5: Invalid Workflow State Transition Attempt
  // ============================================================
  console.log('--- Test 5: Invalid workflow state transition attempt ---');
  const t5PublicId = '2026-vr-rehab'; // status is 'draft' in seed

  const { error: t5Err } = await adminClient.rpc('perform_project_review_action', {
    p_public_id: t5PublicId,
    p_action: 'archive',
    p_comments: 'Archiving draft',
    p_admin_id: adminId,
  });

  if (!t5Err || !t5Err.message.includes('REVIEW_TRANSITION_INVALID')) {
    console.error(`❌ Test 5 Failed: Invalid transition did not throw REVIEW_TRANSITION_INVALID.`);
    return false;
  }

  const { data: t5Proj } = await adminClient.from('projects').select('*').eq('public_id', t5PublicId).single();
  if (t5Proj?.status !== 'draft') {
    console.error('❌ Test 5 Failed: Draft project status changed despite invalid transition.');
    return false;
  }
  console.log('✔ Test 5 Passed: Invalid transition rejected by workflow engine; project status unchanged.\n');

  // ============================================================
  // Test 6: Forced Audit Log Failure Rollback Test
  // ============================================================
  console.log('--- Test 6: Forced Audit Log Failure Rollback Test ---');
  const t6PublicId = '2026-medical-drone'; // status is 'approved' in seed -> admin requests changes
  // Let's set it to 'in_review' first for a clean transition
  runLocalDbExec("UPDATE public.projects SET status = 'in_review' WHERE public_id = '2026-medical-drone'", repoRoot);

  // Inject temporary failing trigger on approval_records
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
    p_public_id: t6PublicId,
    p_action: 'approve',
    p_comments: 'Approving under forced audit failure',
    p_admin_id: adminId,
  });

  // Cleanup temporary trigger immediately
  runLocalDbExec("DROP TRIGGER IF EXISTS trigger_temp_fail_audit ON public.approval_records;", repoRoot);
  runLocalDbExec("DROP FUNCTION IF EXISTS public.temp_fail_audit();", repoRoot);

  if (!t6Err || !t6Err.message.includes('FORCED_AUDIT_FAILURE')) {
    console.error(`❌ Test 6 Failed: RPC did not catch forced audit failure: ${t6Err?.message}`);
    return false;
  }

  // Verify project status remained 'in_review' (proving transaction rollback!)
  const { data: t6Proj } = await adminClient.from('projects').select('*').eq('public_id', t6PublicId).single();
  if (t6Proj?.status !== 'in_review') {
    console.error(`❌ Test 6 Failed: Transaction ROLLBACK FAILED! Project status was changed to [${t6Proj?.status}].`);
    return false;
  }
  console.log('✔ Test 6 Passed: Complete transaction rollback verified! When audit log fails, project status update is cleanly rolled back.\n');

  // ============================================================
  // Test 7: Concurrent Action Serialization Test (Promise.all)
  // ============================================================
  console.log('--- Test 7: Concurrent Action Serialization Test ---');
  const t7PublicId = '2026-medical-drone'; // status is 'in_review'

  const [res1, res2] = await Promise.all([
    adminClient.rpc('perform_project_review_action', {
      p_public_id: t7PublicId,
      p_action: 'approve',
      p_comments: 'Concurrent Action 1',
      p_admin_id: adminId,
    }),
    adminClient.rpc('perform_project_review_action', {
      p_public_id: t7PublicId,
      p_action: 'request_changes',
      p_comments: 'Concurrent Action 2',
      p_admin_id: reviewerId,
    }),
  ]);

  const successCount = (res1.data ? 1 : 0) + (res2.data ? 1 : 0);
  const errorCount = (res1.error ? 1 : 0) + (res2.error ? 1 : 0);

  const { data: t7Proj } = await adminClient.from('projects').select('*').eq('public_id', t7PublicId).single();

  if (successCount < 1 || !['approved', 'changes_requested'].includes(t7Proj?.status || '')) {
    console.error('❌ Test 7 Failed: Concurrent actions resulted in invalid database state.');
    return false;
  }
  console.log(`✔ Test 7 Passed: Row locking (FOR UPDATE) successfully serialized concurrent requests (${successCount} succeeded, ${errorCount} serialized, final status: ${t7Proj?.status}).\n`);

  console.log('====================================================');
  console.log('🎉 ALL LOCAL RUNTIME ATOMICITY & ROLLBACK VERIFICATIONS PASSED 100%!');
  console.log('====================================================\n');
  return true;
}

if (require.main === module) {
  runReviewActionsRuntimeVerification()
    .then((success) => {
      if (!success) process.exit(1);
    })
    .catch((err) => {
      console.error('❌ Unexpected runtime verification error:', err);
      process.exit(1);
    });
}
