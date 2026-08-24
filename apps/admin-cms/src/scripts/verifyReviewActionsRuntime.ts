import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';
import { SupabaseProjectRepositoryCore } from '../repositories/SupabaseProjectRepositoryCore';
import { validateProjectForApproval } from '../validation/projectValidation';

const SYNTHETIC_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SYNTHETIC_PDF = Buffer.from('%PDF-1.4\n%%EOF', 'ascii');

export interface SupabaseCliInvocation {
  executable: string;
  argumentPrefix: string[];
  launcherCategory: 'node-package-bin' | 'native-package-bin';
  launcherPath: string;
}

interface SupabasePackageMetadata {
  name?: unknown;
  bin?: unknown;
}

class SupabaseCliExecutionError extends Error {
  constructor(operation: string, invocation: SupabaseCliInvocation, error: unknown) {
    const childError = error as { status?: unknown; code?: unknown };
    const exit = typeof childError?.status === 'number' ? String(childError.status) : 'unavailable';
    const code = typeof childError?.code === 'string' && /^[A-Z0-9_]+$/.test(childError.code)
      ? `, code=${childError.code}`
      : '';
    super(`Supabase CLI operation ${operation} failed (launcher=${invocation.launcherCategory}, exit=${exit}${code}).`);
    this.name = 'SupabaseCliExecutionError';
  }
}

export function resolveSupabaseCliInvocation(repoRoot: string): SupabaseCliInvocation {
  const packageRoot = path.resolve(repoRoot, 'node_modules', 'supabase');
  const packageJsonPath = path.join(packageRoot, 'package.json');
  let metadata: SupabasePackageMetadata;
  try {
    metadata = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as SupabasePackageMetadata;
  } catch {
    throw new Error('Supabase CLI package metadata is unavailable.');
  }
  const declaredBin = typeof metadata.bin === 'string'
    ? metadata.bin
    : metadata.bin && typeof metadata.bin === 'object'
      ? (metadata.bin as Record<string, unknown>).supabase
      : null;
  if (metadata.name !== 'supabase' || typeof declaredBin !== 'string' || declaredBin.trim() === '') {
    throw new Error('Supabase CLI package does not declare the expected bin entry.');
  }
  const launcherPath = path.resolve(packageRoot, declaredBin);
  const relativeLauncher = path.relative(packageRoot, launcherPath);
  if (relativeLauncher.startsWith('..') || path.isAbsolute(relativeLauncher) || !fs.statSync(launcherPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error('Supabase CLI declared bin target is unavailable.');
  }
  const extension = path.extname(launcherPath).toLowerCase();
  if (extension === '.js' || extension === '.cjs' || extension === '.mjs') {
    return { executable: process.execPath, argumentPrefix: [launcherPath], launcherCategory: 'node-package-bin', launcherPath };
  }
  return { executable: launcherPath, argumentPrefix: [], launcherCategory: 'native-package-bin', launcherPath };
}

function runSupabaseCli(repoRoot: string, operation: string, args: string[]): string {
  const invocation = resolveSupabaseCliInvocation(repoRoot);
  try {
    return execFileSync(invocation.executable, [...invocation.argumentPrefix, ...args], {
      encoding: 'utf8',
      cwd: repoRoot,
      env: { ...process.env, DO_NOT_TRACK: '1' },
    });
  } catch (error) {
    throw new SupabaseCliExecutionError(operation, invocation, error);
  }
}

export function parseLocalDbQueryRows(raw: string): Array<Record<string, unknown>> {
  const parsed = JSON.parse(raw.trim()) as unknown;
  if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown>>;
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { rows?: unknown }).rows)) {
    return (parsed as { rows: Array<Record<string, unknown>> }).rows;
  }
  throw new Error('Supabase CLI query output has an unsupported JSON shape.');
}

function boundedVerifierDiagnostic(error: unknown): string {
  if (error instanceof SupabaseCliExecutionError) return error.message;
  if (error instanceof SyntaxError) return 'Supabase CLI query output was not valid JSON.';
  if (error instanceof Error) return `Unexpected ${error.name}.`;
  return 'Unexpected non-Error failure.';
}

export interface ProjectStateSnapshot {
  status: string | null;
  archived_at: string | null;
  archived_from_status: string | null;
  archive_reason: string | null;
  pending_removal_from_public: boolean | null;
}

export function captureProjectSnapshot(proj: Record<string, unknown>): ProjectStateSnapshot {
  return {
    status: (proj.status as string) ?? null,
    archived_at: (proj.archived_at as string) ?? null,
    archived_from_status: (proj.archived_from_status as string) ?? null,
    archive_reason: (proj.archive_reason as string) ?? null,
    pending_removal_from_public: (proj.pending_removal_from_public as boolean) ?? null,
  };
}

export function areProjectSnapshotsEqual(a: ProjectStateSnapshot, b: ProjectStateSnapshot): boolean {
  return (
    a.status === b.status &&
    a.archived_at === b.archived_at &&
    a.archived_from_status === b.archived_from_status &&
    a.archive_reason === b.archive_reason &&
    a.pending_removal_from_public === b.pending_removal_from_public
  );
}

export function runLocalDbQuery(sql: string, repoRoot: string): Array<Record<string, unknown>> {
  const workdir = path.resolve(repoRoot, 'infra');
  const raw = runSupabaseCli(repoRoot, 'db-query-json', ['db', 'query', '--local', '--workdir', workdir, '-o', 'json', sql]);
  return parseLocalDbQueryRows(raw);
}

export function runLocalDbExec(sql: string, repoRoot: string): void {
  const workdir = path.resolve(repoRoot, 'infra');
  runSupabaseCli(repoRoot, 'db-query-exec', ['db', 'query', '--local', '--workdir', workdir, sql]);
}

export interface RuntimeVerificationOptions {
  repoRoot?: string;
  queryRunner?: typeof runLocalDbQuery;
  execRunner?: typeof runLocalDbExec;
  skipFullDatabaseRun?: boolean;
  simulateCleanupFailure?: boolean;
}

export async function runReviewActionsRuntimeVerification(options?: RuntimeVerificationOptions): Promise<boolean> {
  console.log('=== Local Supabase Transactional Review Actions Runtime Verification ===\n');
  const repoRoot = options?.repoRoot || path.resolve(__dirname, '../../../..');
  const queryDb = options?.queryRunner || runLocalDbQuery;
  const execDb = options?.execRunner || runLocalDbExec;

  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const testProjectPrefix = `test-proj-${runId}`;

  let success = true;

  try {
    if (!options?.skipFullDatabaseRun) {
      // 1. Query local Supabase CLI env
    const workdir = path.resolve(repoRoot, 'infra');
    const rawEnv = runSupabaseCli(repoRoot, 'status-env', ['status', '--workdir', workdir, '-o', 'env']);
    const parsedEnv = parseSupabaseCliEnv(rawEnv);

    const apiUrl = parsedEnv.API_URL || 'http://127.0.0.1:54321';
    const serviceKey = parsedEnv.SERVICE_ROLE_KEY || '';

    const adminClient = createClient(apiUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // 2. Fetch admin_users with user_roles to retrieve UUIDs silently
    const usersWithRoles = queryDb(
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
    const createFixture = async (
      suffix: string,
      status: string = 'in_review',
      media: { posterImage?: boolean; posterPdf?: boolean; snapshotAltText?: string | null } = {},
    ) => {
      const publicId = `${testProjectPrefix}-${suffix}`;
      const { data, error } = await adminClient
        .from('projects')
        .insert({
          public_id: publicId,
          title: `Disposable Runtime Test Project ${suffix}`,
          summary: 'Synthetic test project for runtime verification',
          status: status,
          year: 2026,
          program_name: 'Synthetic Software Engineering',
          study_program: 'Synthetic Software Engineering',
          discipline: 'Software Engineering',
          group_name: `Runtime Group ${suffix}`,
          team_members: ['Synthetic Member'],
          // Approval requires accessible poster content. This verifier exercises review-action
          // transitions and atomicity, so its standard fixture is compliant by construction.
          poster_text_public: 'Synthetic runtime poster full text.',
          accessibility_text_public: 'Synthetic runtime accessibility text.',
        })
        .select()
        .single();

      if (error || !data) {
        throw new Error(`Failed to create test project fixture: ${publicId}`);
      }

      const mediaRows: Array<Record<string, unknown>> = [];
      if (media.posterImage !== false) {
        mediaRows.push({
          project_id: data.id, asset_type: 'poster_image', file_name: 'poster.png',
          storage_bucket: 'project-drafts-private', storage_path: `drafts/${publicId}/poster_image/poster.png`,
          public_url: null, public_storage_bucket: null, public_storage_path: null,
          mime_type: 'image/png', file_size_bytes: SYNTHETIC_PNG.length, is_public_approved: false,
        });
      }
      if (media.posterPdf !== false) {
        mediaRows.push({
          project_id: data.id, asset_type: 'poster_pdf', file_name: 'poster.pdf',
          storage_bucket: 'project-drafts-private', storage_path: `drafts/${publicId}/poster_pdf/poster.pdf`,
          public_url: null, public_storage_bucket: null, public_storage_path: null,
          mime_type: 'application/pdf', file_size_bytes: SYNTHETIC_PDF.length, is_public_approved: false,
        });
      }
      if (media.snapshotAltText !== undefined) {
        mediaRows.push({
          project_id: data.id, asset_type: 'snapshot_image', file_name: 'snapshot-1.png',
          storage_bucket: 'project-drafts-private', storage_path: `drafts/${publicId}/snapshot_image/snapshot-1.png`,
          public_url: null, public_storage_bucket: null, public_storage_path: null,
          mime_type: 'image/png', file_size_bytes: SYNTHETIC_PNG.length, is_public_approved: false,
          alt_text_public: media.snapshotAltText,
        });
      }
      if (mediaRows.length > 0) {
        const mediaInsert = await adminClient.from('media_assets').insert(mediaRows);
        if (mediaInsert.error) throw new Error(`Failed to create media fixture: ${publicId}`);
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
    const snap3Before = captureProjectSnapshot(t3Proj);

    const { error: t3Err } = await adminClient.rpc('perform_project_review_action', {
      p_public_id: t3Proj.public_id,
      p_action: 'archive',
      p_comments: 'Reviewer archiving',
      p_admin_id: reviewerId,
    });

    const { data: t3ProjDb } = await adminClient.from('projects').select('*').eq('id', t3Proj.id).single();
    const { data: t3Audits } = await adminClient.from('approval_records').select('*').eq('project_id', t3Proj.id);

    const snap3After = captureProjectSnapshot(t3ProjDb || {});

    if (
      t3Err &&
      t3Err.message.includes('REVIEW_PERMISSION_DENIED') &&
      areProjectSnapshotsEqual(snap3Before, snap3After) &&
      t3Audits?.length === 0
    ) {
      console.log('PASS: Test 3 - Reviewer archive attempt rejected by RBAC; complete project state snapshot unchanged.');
    } else {
      console.error('FAIL: Test 3 - RBAC enforcement or snapshot state preservation failed.');
      success = false;
    }

    // ============================================================
    // Test 4: Editor Attempts Review Action (Unauthorized)
    // ============================================================
    console.log('--- Test 4: Editor attempts review action (Unauthorized) ---');
    const t4Proj = await createFixture('t4', 'in_review');
    const snap4Before = captureProjectSnapshot(t4Proj);

    const { error: t4Err } = await adminClient.rpc('perform_project_review_action', {
      p_public_id: t4Proj.public_id,
      p_action: 'approve',
      p_comments: 'Editor approving',
      p_admin_id: editorId,
    });

    const { data: t4ProjDb } = await adminClient.from('projects').select('*').eq('id', t4Proj.id).single();
    const { data: t4Audits } = await adminClient.from('approval_records').select('*').eq('project_id', t4Proj.id);

    const snap4After = captureProjectSnapshot(t4ProjDb || {});

    if (
      t4Err &&
      t4Err.message.includes('REVIEW_PERMISSION_DENIED') &&
      areProjectSnapshotsEqual(snap4Before, snap4After) &&
      t4Audits?.length === 0
    ) {
      console.log('PASS: Test 4 - Editor review action attempt rejected by RBAC; complete project state snapshot unchanged.');
    } else {
      console.error('FAIL: Test 4 - Editor RBAC enforcement or snapshot state preservation failed.');
      success = false;
    }

    // ============================================================
    // Test 5: Invalid Workflow State Transition Attempt
    // ============================================================
    console.log('--- Test 5: Invalid workflow state transition attempt ---');
    const t5Proj = await createFixture('t5', 'draft');
    const snap5Before = captureProjectSnapshot(t5Proj);

    const { error: t5Err } = await adminClient.rpc('perform_project_review_action', {
      p_public_id: t5Proj.public_id,
      p_action: 'approve',
      p_comments: 'Approving draft',
      p_admin_id: adminId,
    });

    const { data: t5ProjDb } = await adminClient.from('projects').select('*').eq('id', t5Proj.id).single();
    const { data: t5Audits } = await adminClient.from('approval_records').select('*').eq('project_id', t5Proj.id);

    const snap5After = captureProjectSnapshot(t5ProjDb || {});

    if (
      t5Err &&
      t5Err.message.includes('REVIEW_TRANSITION_INVALID') &&
      areProjectSnapshotsEqual(snap5Before, snap5After) &&
      t5Audits?.length === 0
    ) {
      console.log('PASS: Test 5 - Invalid transition rejected by workflow engine; complete project state snapshot unchanged.');
    } else {
      console.error('FAIL: Test 5 - Invalid transition validation or snapshot state preservation failed.');
      success = false;
    }

    // ============================================================
    // Test 6: Forced Audit Log Failure Rollback Test
    // ============================================================
    console.log('--- Test 6: Forced Audit Log Failure Rollback Test ---');
    const t6Proj = await createFixture('t6', 'in_review');
    const snap6Before = captureProjectSnapshot(t6Proj);

    let t6RpcErr: Error | null = null;
    try {
      // Install temporary trigger
      execDb(
        "CREATE OR REPLACE FUNCTION public.temp_fail_audit() RETURNS TRIGGER AS $$ BEGIN RAISE EXCEPTION 'FORCED_AUDIT_FAILURE'; END; $$ LANGUAGE plpgsql;",
        repoRoot
      );
      execDb("DROP TRIGGER IF EXISTS trigger_temp_fail_audit ON public.approval_records;", repoRoot);
      execDb(
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
        execDb("DROP TRIGGER IF EXISTS trigger_temp_fail_audit ON public.approval_records;", repoRoot);
        execDb("DROP FUNCTION IF EXISTS public.temp_fail_audit();", repoRoot);
      } catch {
        // Ignored
      }
    }

    const { data: t6ProjDb } = await adminClient.from('projects').select('*').eq('id', t6Proj.id).single();
    const { data: t6Audits } = await adminClient.from('approval_records').select('*').eq('project_id', t6Proj.id);

    const snap6After = captureProjectSnapshot(t6ProjDb || {});

    if (
      t6RpcErr &&
      t6RpcErr.message.includes('FORCED_AUDIT_FAILURE') &&
      areProjectSnapshotsEqual(snap6Before, snap6After) &&
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

    const winningOutcome = resA.data
      ? { res: resA.data, action: 'request_changes', adminId: reviewerId, comments: 'Concurrent request_changes', expectedStatus: 'changes_requested' }
      : resB.data
      ? { res: resB.data, action: 'archive', adminId: adminId, comments: 'Concurrent archive', expectedStatus: 'archived' }
      : null;

    const singleAudit = t7Audits && t7Audits.length === 1 ? t7Audits[0] : null;

    const winnerValid =
      winningOutcome !== null &&
      winningOutcome.res.publicId === t7Proj.public_id &&
      winningOutcome.res.status === winningOutcome.expectedStatus &&
      uuidRegex.test(winningOutcome.res.auditRecordId);

    const auditMatchesWinner =
      singleAudit !== null &&
      winningOutcome !== null &&
      singleAudit.id === winningOutcome.res.auditRecordId &&
      singleAudit.action_taken === winningOutcome.action &&
      singleAudit.from_status === 'in_review' &&
      singleAudit.to_status === winningOutcome.expectedStatus &&
      singleAudit.admin_id === winningOutcome.adminId &&
      singleAudit.comments === winningOutcome.comments;

    const projectStatusMatchesWinner =
      winningOutcome !== null &&
      t7ProjDb?.status === winningOutcome.res.status;

    if (
      successes.length === 1 &&
      failures.length === 1 &&
      hasExpectedFailureCode &&
      winnerValid &&
      t7Audits?.length === 1 &&
      auditMatchesWinner &&
      projectStatusMatchesWinner
    ) {
      console.log('PASS: Test 7 - Row locking (FOR UPDATE) successfully serialized concurrent requests (1 succeeded, 1 failed with REVIEW_TRANSITION_INVALID). All winner and audit properties verified.');
    } else {
      console.error('FAIL: Test 7 - Concurrent action serialization assertion failed.');
      success = false;
    }

    // ============================================================
    // Test 8: Submitted browser-import shape approves without public URLs or media mutation
    // ============================================================
    console.log('--- Test 8: Private staged poster media authorizes approval without public URLs ---');
    const t8Proj = await createFixture('t8', 'submitted', { snapshotAltText: 'Synthetic accessible snapshot.' });
    const { data: t8MediaBefore } = await adminClient
      .from('media_assets')
      .select('id,asset_type,gallery_position,file_name,storage_bucket,storage_path,public_url,public_storage_bucket,public_storage_path,mime_type,file_size_bytes,is_public_approved,alt_text_public')
      .eq('project_id', t8Proj.id)
      .order('asset_type');
    const t8Rows = t8MediaBefore ?? [];
    const t8PrivatePaths = t8Rows.map((row) => row.storage_path);
    const t8Content = (assetType: string) => assetType === 'poster_pdf' ? SYNTHETIC_PDF : SYNTHETIC_PNG;
    const t8PublicAssetsBefore = await adminClient.storage.from('project-public-assets').list('', { limit: 1000 });
    const t8PublicFeedsBefore = await adminClient.storage.from('public-feeds').list('', { limit: 1000 });
    const { count: t8PublishedSnapshotsBefore } = await adminClient.from('published_snapshots').select('id', { count: 'exact', head: true });
    let t8Passed = false;

    try {
      for (const row of t8Rows) {
        const upload = await adminClient.storage.from('project-drafts-private').upload(
          row.storage_path,
          t8Content(row.asset_type),
          { contentType: row.mime_type ?? undefined, upsert: false },
        );
        if (upload.error) throw new Error('Private approval acceptance upload failed.');
      }

      const t8PrivateHashesBefore = new Map<string, string>();
      for (const row of t8Rows) {
        const download = await adminClient.storage.from('project-drafts-private').download(row.storage_path);
        if (download.error || !download.data) throw new Error('Private approval acceptance download failed.');
        t8PrivateHashesBefore.set(row.storage_path, createHash('sha256').update(Buffer.from(await download.data.arrayBuffer())).digest('hex'));
      }

      const applicationProject = await new SupabaseProjectRepositoryCore(adminClient).getProjectByPublicId(String(t8Proj.public_id));
      const evidence = (assetType: string) => {
        const rows = t8Rows.filter((row) => row.asset_type === assetType);
        return {
          rowCount: rows.length,
          validPrivateCount: rows.filter((row) => (
            row.storage_bucket === 'project-drafts-private' &&
            row.storage_path.startsWith(`drafts/${String(t8Proj.public_id)}/${assetType}/`) &&
            row.is_public_approved === false && row.public_url === null &&
            row.public_storage_bucket === null && row.public_storage_path === null
          )).length,
        };
      };
      const snapshotRows = t8Rows.filter(
        (row) => row.asset_type === 'snapshot_image',
      );

      const applicationMedia = {
        posterImage: evidence('poster_image'),
        posterPdf: evidence('poster_pdf'),

        snapshotMedia: snapshotRows
          .map((row) => ({
            galleryPosition: row.gallery_position,
            validPrivate:
              row.storage_bucket === 'project-drafts-private' &&
              row.storage_path.startsWith(
                `drafts/${String(t8Proj.public_id)}/snapshot_image/`,
              ) &&
              row.is_public_approved === false &&
              row.public_url === null &&
              row.public_storage_bucket === null &&
              row.public_storage_path === null,
            altText: row.alt_text_public,
          }))
          .sort(
            (a, b) =>
              (a.galleryPosition ?? Number.MAX_SAFE_INTEGER) -
              (b.galleryPosition ?? Number.MAX_SAFE_INTEGER),
          ),
      };
      const applicationPreflightPassed = Boolean(
        applicationProject && validateProjectForApproval(applicationProject, applicationMedia).valid,
      );

      const { data: t8Result, error: t8Error } = await adminClient.rpc('perform_project_review_action', {
        p_public_id: t8Proj.public_id, p_action: 'approve', p_comments: 'Private media approval', p_admin_id: reviewerId,
      });

      const t8RawToken = randomBytes(32).toString('hex');
      const t8TokenHash = createHash('sha256').update(t8RawToken).digest('hex');
      const t8Preview = await adminClient.rpc('generate_participant_preview', {
        p_public_id: t8Proj.public_id,
        p_admin_id: reviewerId,
        p_token_hash: t8TokenHash,
        p_expires_in_seconds: 3600,
        p_private_bucket: 'project-drafts-private',
      });
      const t8Resolved = await adminClient.rpc('resolve_participant_preview', { p_token_hash: t8TokenHash });
      const t8PreviewId = t8Preview.data?.previewId;
      const { data: t8PreviewRow } = await adminClient
        .from('participant_previews')
        .select('token_hash,media_snapshot')
        .eq('id', t8PreviewId)
        .single();

      let signedPrivateMediaResolved = true;
      for (const row of t8Rows) {
        const signed = await adminClient.storage.from('project-drafts-private').createSignedUrl(row.storage_path, 60);
        if (signed.error || !signed.data?.signedUrl) {
          signedPrivateMediaResolved = false;
          break;
        }
        const response = await fetch(signed.data.signedUrl);
        const bytes = response.ok ? Buffer.from(await response.arrayBuffer()) : Buffer.alloc(0);
        if (!bytes.equals(t8Content(row.asset_type))) {
          signedPrivateMediaResolved = false;
          break;
        }
      }

      const t8Confirmation = await adminClient.rpc('confirm_participant_preview', { p_token_hash: t8TokenHash });
      const t8Readiness = await adminClient.rpc('get_project_publication_readiness', {
        p_public_id: t8Proj.public_id,
        p_admin_id: reviewerId,
        p_private_bucket: 'project-drafts-private',
      });
      const { data: t8After } = await adminClient.from('projects').select('status,poster_url,poster_pdf_url').eq('id', t8Proj.id).single();
      const { data: t8MediaAfter } = await adminClient
        .from('media_assets')
        .select('id,asset_type,gallery_position,file_name,storage_bucket,storage_path,public_url,public_storage_bucket,public_storage_path,mime_type,file_size_bytes,is_public_approved,alt_text_public')
        .eq('project_id', t8Proj.id)
        .order('asset_type');
      const { data: t8Audits } = await adminClient.from('approval_records').select('id,action_taken').eq('project_id', t8Proj.id);
      const { count: t8PublicationAttempts } = await adminClient.from('publication_attempts').select('id', { count: 'exact', head: true }).eq('project_id', t8Proj.id);
      const t8PublicAssetsAfter = await adminClient.storage.from('project-public-assets').list('', { limit: 1000 });
      const t8PublicFeedsAfter = await adminClient.storage.from('public-feeds').list('', { limit: 1000 });
      const { count: t8PublishedSnapshotsAfter } = await adminClient.from('published_snapshots').select('id', { count: 'exact', head: true });

      let privateBytesUnchanged = true;
      for (const row of t8Rows) {
        const download = await adminClient.storage.from('project-drafts-private').download(row.storage_path);
        const hash = download.error || !download.data
          ? ''
          : createHash('sha256').update(Buffer.from(await download.data.arrayBuffer())).digest('hex');
        if (hash !== t8PrivateHashesBefore.get(row.storage_path)) privateBytesUnchanged = false;
      }

      const previewMedia = Array.isArray(t8PreviewRow?.media_snapshot) ? t8PreviewRow.media_snapshot : [];
      t8Passed =
        applicationPreflightPassed &&
        !t8Error && t8Result?.status === 'approved' && t8After?.status === 'approved' &&
        t8After.poster_url === null && t8After.poster_pdf_url === null &&
        JSON.stringify(t8MediaAfter) === JSON.stringify(t8MediaBefore) && privateBytesUnchanged &&
        t8Audits?.length === 1 && t8Audits[0].action_taken === 'approve' &&
        !t8Preview.error && t8Preview.data?.resultCode === 'SUCCESS' &&
        t8PreviewRow?.token_hash === t8TokenHash && JSON.stringify(t8PreviewRow).includes(t8RawToken) === false &&
        !t8Resolved.error && t8Resolved.data?.resultCode === 'SUCCESS' && previewMedia.length === 3 &&
        previewMedia.every((item: Record<string, unknown>) => item.storageBucket === 'project-drafts-private') &&
        signedPrivateMediaResolved &&
        !t8Confirmation.error && t8Confirmation.data?.resultCode === 'SUCCESS' &&
        !t8Readiness.error && t8Readiness.data?.resultCode === 'READY' &&
        t8PublicationAttempts === 0 && t8PublishedSnapshotsAfter === t8PublishedSnapshotsBefore &&
        JSON.stringify(t8PublicAssetsAfter.data ?? []) === JSON.stringify(t8PublicAssetsBefore.data ?? []) &&
        JSON.stringify(t8PublicFeedsAfter.data ?? []) === JSON.stringify(t8PublicFeedsBefore.data ?? []);
    } finally {
      const cleanup = await adminClient.storage.from('project-drafts-private').remove(t8PrivatePaths);
      if (cleanup.error) t8Passed = false;
    }

    if (t8Passed) {
      console.log('PASS: Test 8 - Application preflight, approval, signed private preview, confirmation, and readiness succeeded with zero publication or media mutation.');
    } else {
      console.error('FAIL: Test 8 - Private staged media end-to-end acceptance invariant failed.');
      success = false;
    }

    // ============================================================
    // Tests 9-10: Each required private poster type fails closed independently
    // ============================================================
    for (const [number, suffix, media, expectedType] of [
      [9, 't9', { posterImage: false }, 'poster_image'],
      [10, 't10', { posterPdf: false }, 'poster_pdf'],
    ] as const) {
      console.log(`--- Test ${number}: Missing ${expectedType} blocks approval with zero mutation ---`);
      const project = await createFixture(suffix, 'submitted', media);
      const { data: result, error } = await adminClient.rpc('perform_project_review_action', {
        p_public_id: project.public_id, p_action: 'approve', p_comments: null, p_admin_id: reviewerId,
      });
      const { data: after } = await adminClient.from('projects').select('status,poster_url,poster_pdf_url').eq('id', project.id).single();
      const { data: audits } = await adminClient.from('approval_records').select('id').eq('project_id', project.id);
      if (!error && result?.resultCode === 'PROJECT_MEDIA_REQUIRED' && result?.assetType === expectedType && after?.status === 'submitted' && after.poster_url === null && after.poster_pdf_url === null && audits?.length === 0) {
        console.log(`PASS: Test ${number} - Missing ${expectedType} rejected without status, URL, or audit mutation.`);
      } else {
        console.error(`FAIL: Test ${number} - Missing ${expectedType} gate failed.`);
        success = false;
      }
    }

    // ============================================================
    // Test 11: Project-row public URLs cannot bypass absent authoritative media
    // ============================================================
    console.log('--- Test 11: Public URL values cannot bypass absent authoritative media ---');
    const t11Proj = await createFixture('t11', 'submitted', { posterImage: false, posterPdf: false });
    await adminClient.from('projects').update({
      poster_url: 'https://assets.synthetic.invalid/poster.png',
      poster_pdf_url: 'https://assets.synthetic.invalid/poster.pdf',
    }).eq('id', t11Proj.id);
    const { data: t11Result, error: t11Error } = await adminClient.rpc('perform_project_review_action', {
      p_public_id: t11Proj.public_id, p_action: 'approve', p_comments: null, p_admin_id: adminId,
    });
    const { data: t11After } = await adminClient.from('projects').select('status').eq('id', t11Proj.id).single();
    const { data: t11Audits } = await adminClient.from('approval_records').select('id').eq('project_id', t11Proj.id);
    if (!t11Error && t11Result?.resultCode === 'PROJECT_MEDIA_REQUIRED' && t11After?.status === 'submitted' && t11Audits?.length === 0) {
      console.log('PASS: Test 11 - Public URL projections supplied no approval authority.');
    } else {
      console.error('FAIL: Test 11 - Public URL projections bypassed the authoritative media gate.');
      success = false;
    }

    // ============================================================
    // Test 12: Wrong-bucket/malformed media fails closed
    // ============================================================
    console.log('--- Test 12: Contradictory private media metadata blocks approval ---');
    const t12Proj = await createFixture('t12', 'submitted');
    await adminClient.from('media_assets').update({ storage_bucket: 'foreign-private-bucket' }).eq('project_id', t12Proj.id).eq('asset_type', 'poster_image');
    const { data: t12Result, error: t12Error } = await adminClient.rpc('perform_project_review_action', {
      p_public_id: t12Proj.public_id, p_action: 'approve', p_comments: null, p_admin_id: adminId,
    });
    const { data: t12After } = await adminClient.from('projects').select('status').eq('id', t12Proj.id).single();
    const { data: t12Audits } = await adminClient.from('approval_records').select('id').eq('project_id', t12Proj.id);
    if (!t12Error && t12Result?.resultCode === 'PROJECT_MEDIA_INVALID' && t12Result?.assetType === 'poster_image' && t12After?.status === 'submitted' && t12Audits?.length === 0) {
      console.log('PASS: Test 12 - Wrong-bucket media rejected without mutation.');
    } else {
      console.error('FAIL: Test 12 - Contradictory media state was not rejected safely.');
      success = false;
    }
    }

  } catch (error) {
    console.error(`FAIL: Runtime verification error: ${boundedVerifierDiagnostic(error)}`);
    success = false;
  } finally {
    // Fail-Closed Global Cleanup Block
    let cleanupExecutionError = false;
    if (options?.simulateCleanupFailure) {
      cleanupExecutionError = true;
    } else {
      try {
        execDb("DROP TRIGGER IF EXISTS trigger_temp_fail_audit ON public.approval_records;", repoRoot);
        execDb("DROP FUNCTION IF EXISTS public.temp_fail_audit();", repoRoot);
        execDb(`DELETE FROM public.approval_records WHERE project_id IN (SELECT id FROM public.projects WHERE public_id LIKE '${testProjectPrefix}-%');`, repoRoot);
        execDb(`DELETE FROM public.projects WHERE public_id LIKE '${testProjectPrefix}-%';`, repoRoot);
      } catch (error) {
        cleanupExecutionError = true;
        console.error(`FAIL: Global cleanup execution error: ${boundedVerifierDiagnostic(error)}`);
      }
    }

    // Independent Post-Cleanup Query Validation
    try {
      const projCountRows = queryDb(`SELECT count(*)::int as count FROM public.projects WHERE public_id LIKE '${testProjectPrefix}-%';`, repoRoot);
      const auditCountRows = queryDb(`SELECT count(*)::int as count FROM public.approval_records WHERE project_id IN (SELECT id FROM public.projects WHERE public_id LIKE '${testProjectPrefix}-%');`, repoRoot);
      const triggerCountRows = queryDb("SELECT count(*)::int as count FROM pg_trigger WHERE tgname = 'trigger_temp_fail_audit';", repoRoot);
      const functionCountRows = queryDb("SELECT count(*)::int as count FROM pg_proc WHERE proname = 'temp_fail_audit';", repoRoot);

      const projCount = Number(projCountRows[0]?.count ?? -1);
      const auditCount = Number(auditCountRows[0]?.count ?? -1);
      const triggerCount = Number(triggerCountRows[0]?.count ?? -1);
      const functionCount = Number(functionCountRows[0]?.count ?? -1);

      if (!cleanupExecutionError && projCount === 0 && auditCount === 0 && triggerCount === 0 && functionCount === 0) {
        console.log('PASS: Independent post-cleanup verification confirmed zero leftover test projects, audit rows, triggers, and functions.');
      } else {
        console.error('FAIL: Post-cleanup count validation failed or cleanup error occurred.');
        success = false;
      }
    } catch (error) {
      console.error(`FAIL: Independent post-cleanup query error: ${boundedVerifierDiagnostic(error)}`);
      success = false;
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
