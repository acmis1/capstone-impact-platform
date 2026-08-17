import { createClient, SupabaseClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';

export interface RuntimeVerificationOptions {
  repoRoot?: string;
}

const PRIVATE_DRAFT_BUCKET = 'project-drafts-private';

function newRawToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

export async function runParticipantPreviewRuntimeVerification(options?: RuntimeVerificationOptions): Promise<boolean> {
  console.log('=== Local Supabase Participant Preview Links Runtime Verification ===\n');
  const repoRoot = options?.repoRoot || path.resolve(__dirname, '../../../..');

  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const testPrefix = `pp-${runId}`;

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
    const anonKey = parsedEnv.ANON_KEY || '';

    adminClient = createClient(apiUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const anonClient = createClient(apiUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const client = adminClient;

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

    const createProject = async (suffix: string, status: string) => {
      const publicId = `${testPrefix}-${suffix}`;
      const { data, error } = await client
        .from('projects')
        .insert({
          public_id: publicId,
          title: `Runtime Preview Test ${suffix}`,
          summary: 'Synthetic summary for runtime verification.',
          year: 2026,
          status,
          // Approval requires accessible poster content. This verifier exercises preview issuance,
          // snapshot stability and participant responses, so its fixture is compliant.
          poster_text_public: 'Synthetic runtime poster full text.',
          accessibility_text_public: 'Synthetic runtime accessibility text.',
        })
        .select()
        .single();
      if (error || !data) throw new Error(`Failed to create project fixture: ${publicId}: ${error?.message}`);
      return data as Record<string, unknown>;
    };

    const createMediaAsset = async (
      projectId: string,
      assetType: string,
      suffix: string,
      overrides?: { bucket?: string; isPublicApproved?: boolean; publicUrl?: string | null }
    ) => {
      const bucket = overrides?.bucket ?? PRIVATE_DRAFT_BUCKET;
      const isPosterImage = assetType === 'poster_image';
      const isPosterPdf = assetType === 'poster_pdf';
      const fileName = isPosterImage ? 'poster.png' : isPosterPdf ? 'poster.pdf' : `${assetType}-${suffix}.bin`;
      const mimeType = isPosterImage ? 'image/png' : isPosterPdf ? 'application/pdf' : 'application/octet-stream';
      const projectPublicId = `${testPrefix}-${suffix}`;
      const storagePath = isPosterImage || isPosterPdf
        ? `drafts/${projectPublicId}/${assetType}/${fileName}`
        : `drafts/${suffix}/${assetType}/${assetType}.bin`;
      const { data, error } = await client
        .from('media_assets')
        .insert({
          project_id: projectId,
          asset_type: assetType,
          file_name: fileName,
          storage_bucket: bucket,
          storage_path: storagePath,
          mime_type: mimeType,
          file_size_bytes: 10,
          public_url: overrides?.publicUrl ?? null,
          is_public_approved: overrides?.isPublicApproved ?? false,
        })
        .select()
        .single();
      if (error || !data) throw new Error(`Failed to create media asset fixture for ${suffix}`);
      return data as Record<string, unknown>;
    };

    const createRequiredApprovalMedia = async (projectId: string, suffix: string) => {
      await createMediaAsset(projectId, 'poster_image', suffix);
      await createMediaAsset(projectId, 'poster_pdf', suffix);
    };

    const generate = async (publicId: string, adminUserId: string, isCorrectionReissue?: boolean) => {
      const raw = newRawToken();
      const hash = hashToken(raw);
      const res = isCorrectionReissue !== undefined
        ? await client.rpc('generate_participant_preview', {
            p_public_id: publicId,
            p_admin_id: adminUserId,
            p_token_hash: hash,
            p_expires_in_seconds: null,
            p_private_bucket: PRIVATE_DRAFT_BUCKET,
            p_is_correction_reissue: isCorrectionReissue,
          })
        : await client.rpc('generate_participant_preview', {
            p_public_id: publicId,
            p_admin_id: adminUserId,
            p_token_hash: hash,
            p_expires_in_seconds: null,
            p_private_bucket: PRIVATE_DRAFT_BUCKET,
          });
      return { raw, hash, res };
    };

    const resolve = async (hash: string) => client.rpc('resolve_participant_preview', { p_token_hash: hash });

    const confirm = async (hash: string) => client.rpc('confirm_participant_preview', { p_token_hash: hash });

    const requestCorrection = async (hash: string, comment: string) =>
      client.rpc('request_participant_preview_correction', { p_token_hash: hash, p_comment: comment });

    // ============================================================
    // Test 1: Generation on an approved project; DB stores a hash, never the raw token;
    // snapshot is authoritative and server-derived.
    // ============================================================
    console.log('--- Test 1: Approved project receives a preview; DB stores a hash, never the raw token ---');
    const t1Proj = await createProject('t1', 'approved');
    await createMediaAsset(String(t1Proj.id), 'poster_image', 't1');
    const t1 = await generate(String(t1Proj.public_id), adminId);

    const { data: t1Row } = await client.from('participant_previews').select('*').eq('project_id', t1Proj.id).single();
    const t1RowJson = JSON.stringify(t1Row);

    if (
      !t1.res.error &&
      t1.res.data?.resultCode === 'SUCCESS' &&
      t1Row &&
      t1Row.token_hash === t1.hash &&
      t1Row.token_hash !== t1.raw &&
      !t1RowJson.includes(t1.raw) &&
      t1Row.snapshot?.title === t1Proj.title &&
      t1Row.snapshot?.summary === t1Proj.summary &&
      Array.isArray(t1Row.media_snapshot) &&
      t1Row.media_snapshot.length === 1 &&
      t1Row.status === 'active'
    ) {
      console.log('PASS: Test 1 - Preview generated; row stores the hash (never the raw token) and an authoritative snapshot.');
    } else {
      console.error('FAIL: Test 1 - Generation/hash-storage assertion failed.');
      success = false;
    }

    // ============================================================
    // Test 2: Eligibility — generation is rejected for every non-approved state.
    // ============================================================
    console.log('--- Test 2: Generation rejected for draft/submitted/changes_requested/archived/published ---');
    const ineligibleStatuses = ['draft', 'submitted', 'changes_requested', 'archived', 'published'];
    let allIneligibleRejected = true;
    for (const status of ineligibleStatuses) {
      const proj = await createProject(`t2-${status}`, status);
      const attempt = await generate(String(proj.public_id), adminId);
      if (attempt.res.error || attempt.res.data?.resultCode !== 'INVALID_PROJECT_STATE') {
        allIneligibleRejected = false;
        console.error(`FAIL: Test 2 - Expected INVALID_PROJECT_STATE for status "${status}", got`, attempt.res.data);
      }
    }
    if (allIneligibleRejected) {
      console.log('PASS: Test 2 - All non-approved states correctly rejected.');
    } else {
      success = false;
    }

    // ============================================================
    // Test 3: Snapshot immutability — editing the project after issuance must not change what
    // the already-issued preview resolves to.
    // ============================================================
    console.log('--- Test 3: Snapshot immutability across a subsequent project metadata edit ---');
    const t3Proj = await createProject('t3', 'approved');
    const t3 = await generate(String(t3Proj.public_id), adminId);
    const t3Before = await resolve(t3.hash);

    await client.from('projects').update({ title: 'MUTATED TITLE — should not appear in the issued preview' }).eq('id', t3Proj.id);

    const t3After = await resolve(t3.hash);

    if (
      t3Before.data?.resultCode === 'SUCCESS' &&
      t3After.data?.resultCode === 'SUCCESS' &&
      t3Before.data.snapshot.title === t3Proj.title &&
      t3After.data.snapshot.title === t3Proj.title &&
      t3After.data.snapshot.title !== 'MUTATED TITLE — should not appear in the issued preview'
    ) {
      console.log('PASS: Test 3 - Preview snapshot remained stable after the authoritative project row was edited.');
    } else {
      console.error('FAIL: Test 3 - Snapshot immutability assertion failed.');
      success = false;
    }

    // ============================================================
    // Test 4: Expiry — an expired (but unrevoked) preview cannot be resolved.
    // Directly inserted with a past expires_at to test the boundary without waiting real time.
    // ============================================================
    console.log('--- Test 4: Expired preview cannot be resolved ---');
    const t4Proj = await createProject('t4', 'approved');
    const t4Raw = newRawToken();
    const t4Hash = hashToken(t4Raw);
    const pastExpiry = new Date(Date.now() - 60_000).toISOString();
    const { error: t4InsertError } = await client.from('participant_previews').insert({
      project_id: t4Proj.id,
      token_hash: t4Hash,
      snapshot: { title: t4Proj.title, summary: null, background: null, solution: null, year: 2026, program: null, studyProgram: null, discipline: null, disciplines: [], industry: null, industryPartner: null, academicSupervisor: null, groupName: null, teamMembers: [], posterText: null, accessibilityText: null, citations: [], externalLinks: [], industryCategories: [] },
      media_snapshot: [],
      status: 'active',
      created_by: adminId,
      expires_at: pastExpiry,
    });
    const t4Resolve = await resolve(t4Hash);

    if (!t4InsertError && t4Resolve.data?.resultCode === 'NOT_FOUND') {
      console.log('PASS: Test 4 - Expired preview correctly fails to resolve.');
    } else {
      console.error('FAIL: Test 4 - Expiry assertion failed.', t4InsertError, t4Resolve.data);
      success = false;
    }

    // ============================================================
    // Test 5: Revocation — token stops resolving, the row remains for audit/history, and a new
    // preview may subsequently be issued.
    // ============================================================
    console.log('--- Test 5: Revocation stops resolution, preserves the row, and allows reissuance ---');
    const t5Proj = await createProject('t5', 'approved');
    const t5 = await generate(String(t5Proj.public_id), adminId);
    const t5Revoke = await client.rpc('revoke_participant_preview', { p_public_id: t5Proj.public_id, p_admin_id: adminId });
    const t5ResolveAfterRevoke = await resolve(t5.hash);
    const { data: t5RowAfterRevoke } = await client.from('participant_previews').select('id, status, revoked_at, revoked_by').eq('id', t5Revoke.data?.previewId).single();
    const t5Reissue = await generate(String(t5Proj.public_id), adminId);

    if (
      !t5Revoke.error &&
      t5Revoke.data?.resultCode === 'SUCCESS' &&
      t5ResolveAfterRevoke.data?.resultCode === 'NOT_FOUND' &&
      t5RowAfterRevoke?.status === 'revoked' &&
      t5RowAfterRevoke?.revoked_at &&
      t5RowAfterRevoke?.revoked_by === adminId &&
      !t5Reissue.res.error &&
      t5Reissue.res.data?.resultCode === 'SUCCESS'
    ) {
      console.log('PASS: Test 5 - Revocation, audit preservation, and reissuance all behaved correctly.');
    } else {
      console.error('FAIL: Test 5 - Revocation lifecycle assertion failed.');
      success = false;
    }

    // ============================================================
    // Test 6: Invalid token — unknown and malformed tokens resolve to the same generic
    // NOT_FOUND resultCode as an expired/revoked one (no distinguishable reason).
    // ============================================================
    console.log('--- Test 6: Unknown and malformed tokens both resolve to NOT_FOUND ---');
    const unknownHash = hashToken(newRawToken());
    const unknownResolve = await resolve(unknownHash);
    const malformedResolve = await resolve('not-a-valid-hash');

    if (unknownResolve.data?.resultCode === 'NOT_FOUND' && malformedResolve.data?.resultCode === 'NOT_FOUND') {
      console.log('PASS: Test 6 - Unknown and malformed tokens both collapse to NOT_FOUND.');
    } else {
      console.error('FAIL: Test 6 - Invalid token assertion failed.');
      success = false;
    }

    // ============================================================
    // Test 7: Concurrency — two first-time generation attempts for the same eligible project.
    // ============================================================
    console.log('--- Test 7: Concurrent first-time generation converges to exactly one active preview ---');
    const t7Proj = await createProject('t7', 'approved');
    const [t7A, t7B] = await Promise.all([
      generate(String(t7Proj.public_id), adminId),
      generate(String(t7Proj.public_id), reviewerId),
    ]);
    const { data: t7ActiveRows } = await client.from('participant_previews').select('id').eq('project_id', t7Proj.id).eq('status', 'active');

    const t7Codes = [t7A.res.data?.resultCode, t7B.res.data?.resultCode].sort();
    const t7ExactlyOneSuccess = t7Codes[0] === 'ACTIVE_PREVIEW_EXISTS' && t7Codes[1] === 'SUCCESS';

    if (!t7A.res.error && !t7B.res.error && t7ExactlyOneSuccess && (t7ActiveRows || []).length === 1) {
      console.log('PASS: Test 7 - Exactly one active preview and one successful generation under concurrency.');
    } else {
      console.error('FAIL: Test 7 - Concurrency assertion failed.', t7A.res.data, t7B.res.data, t7ActiveRows);
      success = false;
    }

    // ============================================================
    // Test 8: Media — snapshotted media references belong strictly to the target project, are
    // authoritatively still private draft media, and never include anomalous rows (already
    // public-approved, carrying a public_url, or sitting in the public bucket) even when such a
    // row exists for the same target project; underlying media_assets rows remain
    // untouched/private for the legitimate rows.
    // ============================================================
    console.log('--- Test 8: Snapshotted media is authoritative private draft media only ---');
    const t8ProjA = await createProject('t8a', 'approved');
    const t8ProjB = await createProject('t8b', 'approved');
    await createMediaAsset(String(t8ProjA.id), 'poster_image', 't8a');
    await createMediaAsset(String(t8ProjA.id), 'poster_pdf', 't8a');
    await createMediaAsset(String(t8ProjB.id), 'poster_image', 't8b');
    // Anomalous rows for the SAME target project (t8a) that must NOT enter the snapshot.
    // media_assets has a UNIQUE(project_id, asset_type) constraint, so each fixture (including
    // the two legitimate ones above) needs its own distinct asset_type.
    const t8PublicApproved = await createMediaAsset(String(t8ProjA.id), 'snapshot_image', 't8a-public-approved', {
      isPublicApproved: true,
      publicUrl: 'https://example.test/public/t8a-already-approved.png',
    });
    const t8PublicBucket = await createMediaAsset(String(t8ProjA.id), 'anomaly_public_bucket', 't8a-public-bucket', {
      bucket: 'project-public-assets',
    });

    const t8 = await generate(String(t8ProjA.public_id), adminId);
    const { data: t8Row } = await client.from('participant_previews').select('media_snapshot').eq('project_id', t8ProjA.id).single();
    const t8MediaSnapshot: Array<Record<string, unknown>> = t8Row?.media_snapshot || [];
    const t8MediaPaths: string[] = t8MediaSnapshot.map((m) => String(m.storagePath));
    const t8SnapshotAssetIds: string[] = t8MediaSnapshot.map((m) => String(m.mediaAssetId));

    const { data: t8MediaAfter } = await client.from('media_assets').select('id, public_url, is_public_approved, storage_bucket').in('project_id', [t8ProjA.id, t8ProjB.id]);
    const t8LegitimateRows = (t8MediaAfter || []).filter((m) => m.id !== t8PublicApproved.id && m.id !== t8PublicBucket.id);
    const t8AllLegitimateStillPrivate = t8LegitimateRows.every((m) => m.public_url === null && m.is_public_approved === false && m.storage_bucket === PRIVATE_DRAFT_BUCKET);

    if (
      t8.res.data?.resultCode === 'SUCCESS' &&
      t8MediaPaths.length === 2 &&
      t8MediaPaths.every((p) => p.startsWith(`drafts/${String(t8ProjA.public_id)}/`)) &&
      !t8MediaPaths.some((p) => p.startsWith(`drafts/${String(t8ProjB.public_id)}/`)) &&
      !t8SnapshotAssetIds.includes(String(t8PublicApproved.id)) &&
      !t8SnapshotAssetIds.includes(String(t8PublicBucket.id)) &&
      t8AllLegitimateStillPrivate
    ) {
      console.log('PASS: Test 8 - Snapshotted media is project-scoped, excludes anomalous public/approved rows, and remains private.');
    } else {
      console.error('FAIL: Test 8 - Media scoping/privacy assertion failed.', t8MediaPaths);
      success = false;
    }

    // ============================================================
    // Test 9: Authorization — insufficient role (editor) and unknown admin id cannot
    // generate/revoke; admin/reviewer can.
    // ============================================================
    console.log('--- Test 9: Authorization boundary (editor cannot manage previews; admin/reviewer can) ---');
    const t9Proj = await createProject('t9', 'approved');
    const t9EditorAttempt = await generate(String(t9Proj.public_id), editorId);
    const t9UnknownAttempt = await generate(String(t9Proj.public_id), '00000000-0000-0000-0000-000000000000');
    const t9ReviewerAttempt = await generate(String(t9Proj.public_id), reviewerId);
    const t9RevokeByEditor = await client.rpc('revoke_participant_preview', { p_public_id: t9Proj.public_id, p_admin_id: editorId });
    const t9RevokeByReviewer = await client.rpc('revoke_participant_preview', { p_public_id: t9Proj.public_id, p_admin_id: reviewerId });

    if (
      t9EditorAttempt.res.data?.resultCode === 'PREVIEW_PERMISSION_DENIED' &&
      t9UnknownAttempt.res.data?.resultCode === 'PREVIEW_PERMISSION_DENIED' &&
      t9ReviewerAttempt.res.data?.resultCode === 'SUCCESS' &&
      t9RevokeByEditor.data?.resultCode === 'PREVIEW_PERMISSION_DENIED' &&
      t9RevokeByReviewer.data?.resultCode === 'SUCCESS'
    ) {
      console.log('PASS: Test 9 - Editor and unknown identities rejected; admin/reviewer succeed for both generate and revoke.');
    } else {
      console.error('FAIL: Test 9 - Authorization boundary assertion failed.');
      success = false;
    }

    // ============================================================
    // Test 10: Direct browser access — anon key cannot read participant_previews or execute
    // any of the three RPCs (Data API / Postgres grants close this off entirely).
    // ============================================================
    console.log('--- Test 10: Direct anon-key access to participant_previews and its RPCs is refused ---');
    const t10Select = await anonClient.from('participant_previews').select('id').limit(1);
    const t10Generate = await anonClient.rpc('generate_participant_preview', {
      p_public_id: String(t1Proj.public_id),
      p_admin_id: adminId,
      p_token_hash: hashToken(newRawToken()),
      p_expires_in_seconds: null,
      p_private_bucket: PRIVATE_DRAFT_BUCKET,
    });
    const t10Resolve = await anonClient.rpc('resolve_participant_preview', { p_token_hash: t1.hash });

    if (t10Select.error && t10Generate.error && t10Resolve.error) {
      console.log('PASS: Test 10 - Anon-key table access and RPC execution are both refused.');
    } else {
      console.error('FAIL: Test 10 - Direct browser access boundary assertion failed.');
      success = false;
    }

    // ============================================================
    // Test 11: Valid confirmation — a valid token confirms its exact preview; exactly one
    // confirmation row is persisted, referencing the exact participant_previews.id; confirmed_at
    // is server-generated; the raw token appears nowhere in confirmation persistence.
    // ============================================================
    console.log('--- Test 11: Valid confirmation persists exactly one server-attributed record ---');
    const t11Proj = await createProject('t11', 'approved');
    const t11 = await generate(String(t11Proj.public_id), adminId);
    const t11PreviewId = t11.res.data?.previewId;
    const t11Confirm = await confirm(t11.hash);

    const { data: t11ConfirmRows } = await client.from('participant_preview_confirmations').select('*').eq('participant_preview_id', t11PreviewId);
    const t11ConfirmRowsJson = JSON.stringify(t11ConfirmRows || []);

    if (
      !t11Confirm.error &&
      t11Confirm.data?.resultCode === 'SUCCESS' &&
      t11Confirm.data?.alreadyConfirmed === false &&
      typeof t11Confirm.data?.confirmedAt === 'string' && t11Confirm.data.confirmedAt.length > 0 &&
      (t11ConfirmRows || []).length === 1 &&
      t11ConfirmRows?.[0]?.participant_preview_id === t11PreviewId &&
      !t11ConfirmRowsJson.includes(t11.raw)
    ) {
      console.log('PASS: Test 11 - Exactly one confirmation record persisted, exact-preview-attributed, raw token never present.');
    } else {
      console.error('FAIL: Test 11 - Valid confirmation assertion failed.', t11Confirm.data, t11ConfirmRows);
      success = false;
    }

    // ============================================================
    // Test 12: Idempotency — submitting confirmation twice for the same valid preview leaves
    // exactly one row and the original confirmed_at remains authoritative.
    // ============================================================
    console.log('--- Test 12: Idempotent repeat confirmation submission ---');
    const t12Second = await confirm(t11.hash);
    const { data: t12Rows } = await client.from('participant_preview_confirmations').select('confirmed_at').eq('participant_preview_id', t11PreviewId);

    if (
      !t12Second.error &&
      t12Second.data?.resultCode === 'SUCCESS' &&
      t12Second.data?.alreadyConfirmed === true &&
      t12Second.data?.confirmedAt === t11Confirm.data?.confirmedAt &&
      (t12Rows || []).length === 1
    ) {
      console.log('PASS: Test 12 - Repeat submission is idempotent; original confirmed_at remains authoritative.');
    } else {
      console.error('FAIL: Test 12 - Idempotency assertion failed.', t11Confirm.data, t12Second.data, t12Rows);
      success = false;
    }

    // ============================================================
    // Test 13: Concurrency — two first-time confirmation attempts for the same preview converge
    // to exactly one row, one authoritative timestamp, and no unhandled database error.
    // ============================================================
    console.log('--- Test 13: Concurrent first-time confirmation converges to exactly one record ---');
    const t13Proj = await createProject('t13', 'approved');
    const t13 = await generate(String(t13Proj.public_id), adminId);
    const [t13A, t13B] = await Promise.all([confirm(t13.hash), confirm(t13.hash)]);
    const { data: t13Rows } = await client.from('participant_preview_confirmations').select('confirmed_at').eq('participant_preview_id', t13.res.data?.previewId);
    const t13Timestamps = new Set((t13Rows || []).map((r) => String(r.confirmed_at)));

    if (
      !t13A.error && !t13B.error &&
      t13A.data?.resultCode === 'SUCCESS' && t13B.data?.resultCode === 'SUCCESS' &&
      (t13Rows || []).length === 1 &&
      t13Timestamps.size === 1 &&
      t13A.data?.confirmedAt === t13B.data?.confirmedAt
    ) {
      console.log('PASS: Test 13 - Concurrent first-time confirmation converged to exactly one record with no unhandled error.');
    } else {
      console.error('FAIL: Test 13 - Concurrency assertion failed.', t13A.data, t13B.data, t13Rows);
      success = false;
    }

    // ============================================================
    // Test 14: Invalid tokens — malformed and unknown tokens create no confirmation record.
    // ============================================================
    console.log('--- Test 14: Malformed and unknown tokens create no confirmation record ---');
    const { count: t14ConfirmCountBefore } = await client.from('participant_preview_confirmations').select('id', { count: 'exact', head: true });
    const t14Malformed = await confirm('not-a-valid-hash');
    const t14Unknown = await confirm(hashToken(newRawToken()));
    const { count: t14ConfirmCountAfter } = await client.from('participant_preview_confirmations').select('id', { count: 'exact', head: true });

    if (
      t14Malformed.data?.resultCode === 'NOT_FOUND' &&
      t14Unknown.data?.resultCode === 'NOT_FOUND' &&
      t14ConfirmCountAfter === t14ConfirmCountBefore
    ) {
      console.log('PASS: Test 14 - Malformed and unknown tokens both collapse to NOT_FOUND and create no confirmation.');
    } else {
      console.error('FAIL: Test 14 - Invalid-token assertion failed.', t14Malformed.data, t14Unknown.data);
      success = false;
    }

    // ============================================================
    // Test 15: Expired preview cannot be newly confirmed.
    // ============================================================
    console.log('--- Test 15: Expired preview cannot be newly confirmed ---');
    const t15Proj = await createProject('t15', 'approved');
    const t15Raw = newRawToken();
    const t15Hash = hashToken(t15Raw);
    const t15PastExpiry = new Date(Date.now() - 60_000).toISOString();
    await client.from('participant_previews').insert({
      project_id: t15Proj.id,
      token_hash: t15Hash,
      snapshot: { title: t15Proj.title, summary: null, background: null, solution: null, year: 2026, program: null, studyProgram: null, discipline: null, disciplines: [], industry: null, industryPartner: null, academicSupervisor: null, groupName: null, teamMembers: [], posterText: null, accessibilityText: null, citations: [], externalLinks: [], industryCategories: [] },
      media_snapshot: [],
      status: 'active',
      created_by: adminId,
      expires_at: t15PastExpiry,
    });
    const t15Confirm = await confirm(t15Hash);
    const { data: t15PreviewRow } = await client.from('participant_previews').select('id').eq('token_hash', t15Hash).single();
    const { count: t15ConfirmCount } = await client.from('participant_preview_confirmations').select('id', { count: 'exact', head: true }).eq('participant_preview_id', t15PreviewRow?.id);

    if (t15Confirm.data?.resultCode === 'NOT_FOUND' && t15ConfirmCount === 0) {
      console.log('PASS: Test 15 - Expired preview correctly refuses a new confirmation.');
    } else {
      console.error('FAIL: Test 15 - Expired-preview assertion failed.', t15Confirm.data, t15ConfirmCount);
      success = false;
    }

    // ============================================================
    // Test 16: Revoked preview cannot be newly confirmed.
    // ============================================================
    console.log('--- Test 16: Revoked preview cannot be newly confirmed ---');
    const t16Proj = await createProject('t16', 'approved');
    const t16 = await generate(String(t16Proj.public_id), adminId);
    await client.rpc('revoke_participant_preview', { p_public_id: t16Proj.public_id, p_admin_id: adminId });
    const t16Confirm = await confirm(t16.hash);
    const { count: t16ConfirmCount } = await client.from('participant_preview_confirmations').select('id', { count: 'exact', head: true }).eq('participant_preview_id', t16.res.data?.previewId);

    if (t16Confirm.data?.resultCode === 'NOT_FOUND' && t16ConfirmCount === 0) {
      console.log('PASS: Test 16 - Revoked preview correctly refuses a new confirmation.');
    } else {
      console.error('FAIL: Test 16 - Revoked-preview assertion failed.', t16Confirm.data, t16ConfirmCount);
      success = false;
    }

    // ============================================================
    // Test 17: Exact-version attribution — confirming Preview A, revoking it, and issuing
    // Preview B leaves Preview A's confirmation untouched as independent historical evidence;
    // Preview B starts unconfirmed and may receive its own separate confirmation.
    // ============================================================
    console.log('--- Test 17: Exact-version attribution survives revoke + reissue ---');
    const t17Proj = await createProject('t17', 'approved');
    const t17A = await generate(String(t17Proj.public_id), adminId);
    const t17AConfirm = await confirm(t17A.hash);
    await client.rpc('revoke_participant_preview', { p_public_id: t17Proj.public_id, p_admin_id: adminId });
    const t17B = await generate(String(t17Proj.public_id), adminId);
    const { count: t17BConfirmCountBefore } = await client.from('participant_preview_confirmations').select('id', { count: 'exact', head: true }).eq('participant_preview_id', t17B.res.data?.previewId);
    const t17BConfirm = await confirm(t17B.hash);
    const { data: t17AConfirmRow } = await client.from('participant_preview_confirmations').select('confirmed_at').eq('participant_preview_id', t17A.res.data?.previewId).single();

    if (
      t17AConfirm.data?.resultCode === 'SUCCESS' &&
      t17BConfirmCountBefore === 0 &&
      t17BConfirm.data?.resultCode === 'SUCCESS' &&
      t17AConfirmRow?.confirmed_at === t17AConfirm.data?.confirmedAt &&
      t17A.res.data?.previewId !== t17B.res.data?.previewId
    ) {
      console.log('PASS: Test 17 - Preview A confirmation preserved untouched; Preview B started unconfirmed and received its own confirmation.');
    } else {
      console.error('FAIL: Test 17 - Exact-version attribution assertion failed.', t17AConfirm.data, t17BConfirm.data, t17AConfirmRow);
      success = false;
    }

    // ============================================================
    // Test 18: Mutable-project independence — editing the project after Preview A's
    // confirmation must not alter the confirmation's reference to Preview A.
    // ============================================================
    console.log('--- Test 18: Confirmation reference is independent of later mutable-project edits ---');
    const t18Proj = await createProject('t18', 'approved');
    const t18 = await generate(String(t18Proj.public_id), adminId);
    const t18Confirm = await confirm(t18.hash);
    await client.from('projects').update({ title: 'MUTATED TITLE — must not affect the confirmation reference' }).eq('id', t18Proj.id);
    const { data: t18ConfirmRowAfter } = await client.from('participant_preview_confirmations').select('participant_preview_id, confirmed_at').eq('participant_preview_id', t18.res.data?.previewId).single();

    if (
      t18Confirm.data?.resultCode === 'SUCCESS' &&
      t18ConfirmRowAfter?.participant_preview_id === t18.res.data?.previewId &&
      t18ConfirmRowAfter?.confirmed_at === t18Confirm.data?.confirmedAt
    ) {
      console.log('PASS: Test 18 - Confirmation still references the exact preview id, unaffected by the later project edit.');
    } else {
      console.error('FAIL: Test 18 - Mutable-project independence assertion failed.', t18Confirm.data, t18ConfirmRowAfter);
      success = false;
    }

    // ============================================================
    // Test 19: Direct browser access — anon key cannot read/write participant_preview_
    // confirmations or execute confirm_participant_preview. (Authenticated-role denial is
    // proven statically by Migration 0014's REVOKE ... FROM authenticated contract in
    // participantPreviewConfirmationMigration.test.ts, mirroring how Migration 0013's
    // authenticated boundary is verified for participant_previews.)
    // ============================================================
    console.log('--- Test 19: Direct anon-key access to participant_preview_confirmations and its RPC is refused ---');
    const t19Select = await anonClient.from('participant_preview_confirmations').select('id').limit(1);
    const t19Insert = await anonClient.from('participant_preview_confirmations').insert({ participant_preview_id: t11PreviewId });
    const t19Confirm = await anonClient.rpc('confirm_participant_preview', { p_token_hash: t13.hash });

    if (t19Select.error && t19Insert.error && t19Confirm.error) {
      console.log('PASS: Test 19 - Anon-key table read/write and RPC execution are all refused.');
    } else {
      console.error('FAIL: Test 19 - Direct browser access boundary assertion failed.', t19Select.error, t19Insert.error, t19Confirm.error);
      success = false;
    }

    // ============================================================
    // Test 20: No publication side effects — confirmation performs zero public bucket writes,
    // zero public_url/is_public_approved changes, and zero project workflow-status transitions.
    // ============================================================
    console.log('--- Test 20: Confirmation performs zero publication side effects ---');
    const t20Proj = await createProject('t20', 'approved');
    await createMediaAsset(String(t20Proj.id), 'poster_image', 't20');
    const t20 = await generate(String(t20Proj.public_id), adminId);
    await confirm(t20.hash);
    const { data: t20ProjAfter } = await client.from('projects').select('status').eq('id', t20Proj.id).single();
    const { data: t20MediaAfter } = await client.from('media_assets').select('public_url, is_public_approved, storage_bucket').eq('project_id', t20Proj.id);
    const t20MediaUntouched = (t20MediaAfter || []).every((m) => m.public_url === null && m.is_public_approved === false && m.storage_bucket === PRIVATE_DRAFT_BUCKET);

    if (t20ProjAfter?.status === 'approved' && t20MediaUntouched) {
      console.log('PASS: Test 20 - Confirmation left project status and media publication state completely untouched.');
    } else {
      console.error('FAIL: Test 20 - Publication side-effect assertion failed.', t20ProjAfter, t20MediaAfter);
      success = false;
    }

    // ============================================================
    // Test 21: Valid correction request — a valid token records a correction against its exact
    // preview; exactly one row is persisted, referencing the exact participant_previews.id;
    // requested_at is server-generated; comment is stored as submitted; status starts 'open'.
    // ============================================================
    console.log('--- Test 21: Valid correction request persists exactly one server-attributed record ---');
    const t21Proj = await createProject('t21', 'approved');
    const t21 = await generate(String(t21Proj.public_id), adminId);
    const t21PreviewId = t21.res.data?.previewId;
    const t21Comment = 'Please update the group name spelling.';
    const t21Correction = await requestCorrection(t21.hash, t21Comment);

    const { data: t21Rows } = await client.from('participant_preview_correction_requests').select('*').eq('participant_preview_id', t21PreviewId);
    const t21RowsJson = JSON.stringify(t21Rows || []);

    if (
      !t21Correction.error &&
      t21Correction.data?.resultCode === 'SUCCESS' &&
      t21Correction.data?.alreadyRequested === false &&
      typeof t21Correction.data?.requestedAt === 'string' && t21Correction.data.requestedAt.length > 0 &&
      t21Correction.data?.comment === t21Comment &&
      (t21Rows || []).length === 1 &&
      t21Rows?.[0]?.participant_preview_id === t21PreviewId &&
      t21Rows?.[0]?.status === 'open' &&
      !t21RowsJson.includes(t21.raw)
    ) {
      console.log('PASS: Test 21 - Exactly one correction request persisted, exact-preview-attributed, raw token never present, initial status open.');
    } else {
      console.error('FAIL: Test 21 - Valid correction request assertion failed.', t21Correction.data, t21Rows);
      success = false;
    }

    // ============================================================
    // Test 22: Comment validation — empty, whitespace-only, and over-limit comments are all
    // rejected and create no row.
    // ============================================================
    console.log('--- Test 22: Comment validation rejects empty/whitespace-only/over-limit input and creates no row ---');
    const t22Proj = await createProject('t22', 'approved');
    const t22 = await generate(String(t22Proj.public_id), adminId);
    const t22Empty = await requestCorrection(t22.hash, '');
    const t22Whitespace = await requestCorrection(t22.hash, '   \n\t  ');
    const t22OverLimit = await requestCorrection(t22.hash, 'a'.repeat(2001));
    const { count: t22Count } = await client.from('participant_preview_correction_requests').select('id', { count: 'exact', head: true }).eq('participant_preview_id', t22.res.data?.previewId);

    if (
      t22Empty.data?.resultCode === 'INVALID_COMMENT' &&
      t22Whitespace.data?.resultCode === 'INVALID_COMMENT' &&
      t22OverLimit.data?.resultCode === 'INVALID_COMMENT' &&
      t22Count === 0
    ) {
      console.log('PASS: Test 22 - Empty, whitespace-only, and over-limit comments are all rejected with no row created.');
    } else {
      console.error('FAIL: Test 22 - Comment validation assertion failed.', t22Empty.data, t22Whitespace.data, t22OverLimit.data, t22Count);
      success = false;
    }

    // ============================================================
    // Test 23: Sequential idempotency — submitting a correction request twice for the same
    // preview leaves exactly one row; the original requested_at and comment remain authoritative
    // and are never overwritten by a later duplicate submission.
    // ============================================================
    console.log('--- Test 23: Idempotent repeat correction-request submission ---');
    const t23Second = await requestCorrection(t21.hash, 'A different, later comment that must not overwrite the original.');
    const { data: t23Rows } = await client.from('participant_preview_correction_requests').select('requested_at, correction_comment').eq('participant_preview_id', t21PreviewId);

    if (
      !t23Second.error &&
      t23Second.data?.resultCode === 'SUCCESS' &&
      t23Second.data?.alreadyRequested === true &&
      t23Second.data?.requestedAt === t21Correction.data?.requestedAt &&
      t23Second.data?.comment === t21Comment &&
      (t23Rows || []).length === 1 &&
      t23Rows?.[0]?.correction_comment === t21Comment
    ) {
      console.log('PASS: Test 23 - Repeat submission is idempotent; original requested_at and comment remain authoritative.');
    } else {
      console.error('FAIL: Test 23 - Idempotency assertion failed.', t21Correction.data, t23Second.data, t23Rows);
      success = false;
    }

    // ============================================================
    // Test 24: Concurrency — two first-time correction-request attempts for the same preview
    // converge to exactly one row, one authoritative timestamp/comment, and no unhandled error.
    // ============================================================
    console.log('--- Test 24: Concurrent first-time correction request converges to exactly one record ---');
    const t24Proj = await createProject('t24', 'approved');
    const t24 = await generate(String(t24Proj.public_id), adminId);
    const [t24A, t24B] = await Promise.all([
      requestCorrection(t24.hash, 'First concurrent comment.'),
      requestCorrection(t24.hash, 'Second concurrent comment.'),
    ]);
    const { data: t24Rows } = await client.from('participant_preview_correction_requests').select('requested_at, correction_comment').eq('participant_preview_id', t24.res.data?.previewId);

    if (
      !t24A.error && !t24B.error &&
      t24A.data?.resultCode === 'SUCCESS' && t24B.data?.resultCode === 'SUCCESS' &&
      (t24Rows || []).length === 1 &&
      t24A.data?.requestedAt === t24B.data?.requestedAt &&
      t24A.data?.comment === t24B.data?.comment
    ) {
      console.log('PASS: Test 24 - Concurrent first-time correction request converged to exactly one record with no unhandled error.');
    } else {
      console.error('FAIL: Test 24 - Concurrency assertion failed.', t24A.data, t24B.data, t24Rows);
      success = false;
    }

    // ============================================================
    // Test 25: Mutual exclusion — an existing correction request blocks a subsequent
    // confirmation attempt for the same exact preview; no confirmation row is created.
    // ============================================================
    console.log('--- Test 25: An existing correction request blocks a subsequent confirmation ---');
    const t25Proj = await createProject('t25', 'approved');
    const t25 = await generate(String(t25Proj.public_id), adminId);
    const t25Correction = await requestCorrection(t25.hash, 'Please fix the team member list.');
    const t25Confirm = await confirm(t25.hash);
    const { count: t25ConfirmCount } = await client.from('participant_preview_confirmations').select('id', { count: 'exact', head: true }).eq('participant_preview_id', t25.res.data?.previewId);

    if (
      t25Correction.data?.resultCode === 'SUCCESS' &&
      t25Confirm.data?.resultCode === 'CORRECTION_REQUESTED' &&
      t25ConfirmCount === 0
    ) {
      console.log('PASS: Test 25 - Existing correction request blocked confirmation; no confirmation row created.');
    } else {
      console.error('FAIL: Test 25 - Correction-blocks-confirmation assertion failed.', t25Correction.data, t25Confirm.data, t25ConfirmCount);
      success = false;
    }

    // ============================================================
    // Test 26: Mutual exclusion — an existing confirmation blocks a subsequent correction-request
    // attempt for the same exact preview; no correction row is created.
    // ============================================================
    console.log('--- Test 26: An existing confirmation blocks a subsequent correction request ---');
    const t26Proj = await createProject('t26', 'approved');
    const t26 = await generate(String(t26Proj.public_id), adminId);
    const t26Confirm = await confirm(t26.hash);
    const t26Correction = await requestCorrection(t26.hash, 'Please fix the accessibility text.');
    const { count: t26CorrectionCount } = await client.from('participant_preview_correction_requests').select('id', { count: 'exact', head: true }).eq('participant_preview_id', t26.res.data?.previewId);

    if (
      t26Confirm.data?.resultCode === 'SUCCESS' &&
      t26Correction.data?.resultCode === 'ALREADY_CONFIRMED' &&
      t26CorrectionCount === 0
    ) {
      console.log('PASS: Test 26 - Existing confirmation blocked correction request; no correction row created.');
    } else {
      console.error('FAIL: Test 26 - Confirmation-blocks-correction assertion failed.', t26Confirm.data, t26Correction.data, t26CorrectionCount);
      success = false;
    }

    // ============================================================
    // Test 27: Real confirmation-vs-correction race — both operations fired concurrently for the
    // same unresponded preview. Exactly one response type must exist afterward, never both, and
    // the losing request must receive a controlled bounded resultCode rather than an unhandled
    // integrity error.
    // ============================================================
    console.log('--- Test 27: Real confirmation-vs-correction race converges to exactly one response type ---');
    const t27Proj = await createProject('t27', 'approved');
    const t27 = await generate(String(t27Proj.public_id), adminId);
    const [t27Confirm, t27Correction] = await Promise.all([
      confirm(t27.hash),
      requestCorrection(t27.hash, 'Racing correction comment.'),
    ]);
    const { count: t27ConfirmCount } = await client.from('participant_preview_confirmations').select('id', { count: 'exact', head: true }).eq('participant_preview_id', t27.res.data?.previewId);
    const { count: t27CorrectionCount } = await client.from('participant_preview_correction_requests').select('id', { count: 'exact', head: true }).eq('participant_preview_id', t27.res.data?.previewId);

    const t27ConfirmWon = t27Confirm.data?.resultCode === 'SUCCESS' && t27Correction.data?.resultCode === 'ALREADY_CONFIRMED';
    const t27CorrectionWon = t27Correction.data?.resultCode === 'SUCCESS' && t27Confirm.data?.resultCode === 'CORRECTION_REQUESTED';
    const t27ExactlyOneWinner = (t27ConfirmWon && !t27CorrectionWon) || (!t27ConfirmWon && t27CorrectionWon);

    if (
      !t27Confirm.error && !t27Correction.error &&
      t27ExactlyOneWinner &&
      (t27ConfirmCount || 0) + (t27CorrectionCount || 0) === 1
    ) {
      console.log(`PASS: Test 27 - Confirmation/correction race converged to exactly one response type (${t27ConfirmWon ? 'confirmation won' : 'correction won'}) with no unhandled error.`);
    } else {
      console.error('FAIL: Test 27 - Confirmation-vs-correction race assertion failed.', t27Confirm.data, t27Correction.data, t27ConfirmCount, t27CorrectionCount);
      success = false;
    }

    // ============================================================
    // Test 28: Invalid token — malformed and unknown tokens create no correction record.
    // ============================================================
    console.log('--- Test 28: Malformed and unknown tokens cannot request a correction ---');
    const { count: t28CountBefore } = await client.from('participant_preview_correction_requests').select('id', { count: 'exact', head: true });
    const t28Malformed = await requestCorrection('not-a-valid-hash', 'Some comment.');
    const t28Unknown = await requestCorrection(hashToken(newRawToken()), 'Some comment.');
    const { count: t28CountAfter } = await client.from('participant_preview_correction_requests').select('id', { count: 'exact', head: true });

    if (
      t28Malformed.data?.resultCode === 'NOT_FOUND' &&
      t28Unknown.data?.resultCode === 'NOT_FOUND' &&
      t28CountAfter === t28CountBefore
    ) {
      console.log('PASS: Test 28 - Malformed and unknown tokens both collapse to NOT_FOUND and create no correction request.');
    } else {
      console.error('FAIL: Test 28 - Invalid-token assertion failed.', t28Malformed.data, t28Unknown.data);
      success = false;
    }

    // ============================================================
    // Test 29: Expired preview cannot receive a new correction request.
    // ============================================================
    console.log('--- Test 29: Expired preview cannot receive a new correction request ---');
    const t29Proj = await createProject('t29', 'approved');
    const t29Raw = newRawToken();
    const t29Hash = hashToken(t29Raw);
    const t29PastExpiry = new Date(Date.now() - 60_000).toISOString();
    await client.from('participant_previews').insert({
      project_id: t29Proj.id,
      token_hash: t29Hash,
      snapshot: { title: t29Proj.title, summary: null, background: null, solution: null, year: 2026, program: null, studyProgram: null, discipline: null, disciplines: [], industry: null, industryPartner: null, academicSupervisor: null, groupName: null, teamMembers: [], posterText: null, accessibilityText: null, citations: [], externalLinks: [], industryCategories: [] },
      media_snapshot: [],
      status: 'active',
      created_by: adminId,
      expires_at: t29PastExpiry,
    });
    const t29Correction = await requestCorrection(t29Hash, 'Comment on an expired preview.');
    const { data: t29PreviewRow } = await client.from('participant_previews').select('id').eq('token_hash', t29Hash).single();
    const { count: t29CorrectionCount } = await client.from('participant_preview_correction_requests').select('id', { count: 'exact', head: true }).eq('participant_preview_id', t29PreviewRow?.id);

    if (t29Correction.data?.resultCode === 'NOT_FOUND' && t29CorrectionCount === 0) {
      console.log('PASS: Test 29 - Expired preview correctly refuses a new correction request.');
    } else {
      console.error('FAIL: Test 29 - Expired-preview assertion failed.', t29Correction.data, t29CorrectionCount);
      success = false;
    }

    // ============================================================
    // Test 30: Revoked preview cannot receive a new correction request.
    // ============================================================
    console.log('--- Test 30: Revoked preview cannot receive a new correction request ---');
    const t30Proj = await createProject('t30', 'approved');
    const t30 = await generate(String(t30Proj.public_id), adminId);
    await client.rpc('revoke_participant_preview', { p_public_id: t30Proj.public_id, p_admin_id: adminId });
    const t30Correction = await requestCorrection(t30.hash, 'Comment on a revoked preview.');
    const { count: t30CorrectionCount } = await client.from('participant_preview_correction_requests').select('id', { count: 'exact', head: true }).eq('participant_preview_id', t30.res.data?.previewId);

    if (t30Correction.data?.resultCode === 'NOT_FOUND' && t30CorrectionCount === 0) {
      console.log('PASS: Test 30 - Revoked preview correctly refuses a new correction request.');
    } else {
      console.error('FAIL: Test 30 - Revoked-preview assertion failed.', t30Correction.data, t30CorrectionCount);
      success = false;
    }

    // ============================================================
    // Test 31: Resolution Gating — manually revoking a preview with an open correction request
    // MUST NOT allow bypassing correction resolution via ordinary 5-arg wrapper or 6-arg (false).
    // ============================================================
    console.log('--- Test 31: Revoked preview with open correction blocks ordinary 5-arg and 6-arg (false) generation ---');
    const t31Proj = await createProject('t31', 'approved');
    const t31A = await generate(String(t31Proj.public_id), adminId);
    const t31AComment = 'Correction against Preview A before manual revoke.';
    const t31ACorrection = await requestCorrection(t31A.hash, t31AComment);
    await client.rpc('revoke_participant_preview', { p_public_id: t31Proj.public_id, p_admin_id: adminId });

    // Ordinary 5-arg generation attempt (omits p_is_correction_reissue)
    const t31Ordinary5Arg = await generate(String(t31Proj.public_id), adminId);
    // Ordinary 6-arg generation attempt (explicitly passes false)
    const t31Ordinary6Arg = await generate(String(t31Proj.public_id), adminId, false);

    const { count: t31BCount } = await client.from('participant_previews').select('id', { count: 'exact', head: true }).eq('project_id', t31Proj.id).eq('status', 'active');
    const { data: t31ProjRow } = await client.from('projects').select('status').eq('id', t31Proj.id).single();
    const { data: t31ACorrectionRow } = await client.from('participant_preview_correction_requests').select('status, correction_comment, requested_at').eq('participant_preview_id', t31A.res.data?.previewId).single();

    if (
      t31ACorrection.data?.resultCode === 'SUCCESS' &&
      t31Ordinary5Arg.res.data?.resultCode === 'CORRECTION_RESOLUTION_REQUIRED' &&
      t31Ordinary6Arg.res.data?.resultCode === 'CORRECTION_RESOLUTION_REQUIRED' &&
      t31BCount === 0 &&
      t31ProjRow?.status === 'approved' &&
      t31ACorrectionRow?.status === 'open' &&
      t31ACorrectionRow?.correction_comment === t31AComment &&
      t31ACorrectionRow?.requested_at === t31ACorrection.data?.requestedAt
    ) {
      console.log('PASS: Test 31 - Both 5-arg wrapper and 6-arg (false) were blocked by open correction on revoked Preview A.');
    } else {
      console.error('FAIL: Test 31 - Resolution gating assertion failed.', t31Ordinary5Arg.res.data, t31Ordinary6Arg.res.data, t31ACorrectionRow);
      success = false;
    }

    // ============================================================
    // Test 32: Mutable-project independence — editing the project after Preview A's correction
    // request must not alter the correction request's reference, timestamp, or stored comment.
    // ============================================================
    console.log('--- Test 32: Correction request reference is independent of later mutable-project edits ---');
    const t32Proj = await createProject('t32', 'approved');
    const t32 = await generate(String(t32Proj.public_id), adminId);
    const t32Comment = 'Correction comment that must survive a later project edit.';
    const t32Correction = await requestCorrection(t32.hash, t32Comment);
    await client.from('projects').update({ title: 'MUTATED TITLE — must not affect the correction request reference' }).eq('id', t32Proj.id);
    const { data: t32CorrectionRowAfter } = await client.from('participant_preview_correction_requests').select('participant_preview_id, requested_at, correction_comment').eq('participant_preview_id', t32.res.data?.previewId).single();

    if (
      t32Correction.data?.resultCode === 'SUCCESS' &&
      t32CorrectionRowAfter?.participant_preview_id === t32.res.data?.previewId &&
      t32CorrectionRowAfter?.requested_at === t32Correction.data?.requestedAt &&
      t32CorrectionRowAfter?.correction_comment === t32Comment
    ) {
      console.log('PASS: Test 32 - Correction request still references the exact preview id and original comment, unaffected by the later project edit.');
    } else {
      console.error('FAIL: Test 32 - Mutable-project independence assertion failed.', t32Correction.data, t32CorrectionRowAfter);
      success = false;
    }

    // ============================================================
    // Test 33: Direct browser access — anon key cannot read/write
    // participant_preview_correction_requests or execute request_participant_preview_correction.
    // (Authenticated-role denial is proven statically by Migration 0015's REVOKE ... FROM
    // authenticated contract in participantPreviewCorrectionRequestMigration.test.ts, mirroring
    // how Migration 0014's authenticated boundary is verified for participant_preview_
    // confirmations.)
    // ============================================================
    console.log('--- Test 33: Direct anon-key access to participant_preview_correction_requests and its RPC is refused ---');
    const t33Select = await anonClient.from('participant_preview_correction_requests').select('id').limit(1);
    const t33Insert = await anonClient.from('participant_preview_correction_requests').insert({ participant_preview_id: t21PreviewId, correction_comment: 'anon attempt' });
    const t33Request = await anonClient.rpc('request_participant_preview_correction', { p_token_hash: t24.hash, p_comment: 'anon attempt' });

    if (t33Select.error && t33Insert.error && t33Request.error) {
      console.log('PASS: Test 33 - Anon-key table read/write and RPC execution are all refused.');
    } else {
      console.error('FAIL: Test 33 - Direct browser access boundary assertion failed.', t33Select.error, t33Insert.error, t33Request.error);
      success = false;
    }

    // ============================================================
    // Test 34: No publication side effects — a correction request performs zero public bucket
    // writes, zero public_url/is_public_approved changes, and zero project workflow-status
    // transitions.
    // ============================================================
    console.log('--- Test 34: Correction request performs zero publication side effects ---');
    const t34Proj = await createProject('t34', 'approved');
    await createMediaAsset(String(t34Proj.id), 'poster_image', 't34');
    const t34 = await generate(String(t34Proj.public_id), adminId);
    await requestCorrection(t34.hash, 'Comment that must not trigger any publication side effect.');
    const { data: t34ProjAfter } = await client.from('projects').select('status').eq('id', t34Proj.id).single();
    const { data: t34MediaAfter } = await client.from('media_assets').select('public_url, is_public_approved, storage_bucket').eq('project_id', t34Proj.id);
    const t34MediaUntouched = (t34MediaAfter || []).every((m) => m.public_url === null && m.is_public_approved === false && m.storage_bucket === PRIVATE_DRAFT_BUCKET);

    if (t34ProjAfter?.status === 'approved' && t34MediaUntouched) {
      console.log('PASS: Test 34 - Correction request left project status and media publication state completely untouched.');
    } else {
      console.error('FAIL: Test 34 - Publication side-effect assertion failed.', t34ProjAfter, t34MediaAfter);
      success = false;
    }

    // ============================================================
    // Test 35 (Scenario A): Start Resolution Happy Path
    // ============================================================
    console.log('--- Test 35 (Scenario A): Start Resolution Happy Path ---');
    const t35Proj = await createProject('t35', 'approved');
    await createRequiredApprovalMedia(String(t35Proj.id), 't35');
    const t35A = await generate(String(t35Proj.public_id), adminId);
    const t35Comment = 'Please update team members list.';
    const t35Correction = await requestCorrection(t35A.hash, t35Comment);
    const t35Start = await client.rpc('start_participant_preview_correction_resolution', {
      p_public_id: String(t35Proj.public_id),
      p_admin_id: adminId,
    });

    const { data: t35PreviewRow } = await client.from('participant_previews').select('status').eq('id', t35A.res.data?.previewId).single();
    const { data: t35ProjRow } = await client.from('projects').select('status').eq('id', t35Proj.id).single();
    const { data: t35CorrRow } = await client.from('participant_preview_correction_requests').select('status, resolution_started_at, resolution_started_by, correction_comment, requested_at').eq('id', t35Correction.data?.correctionRequestId).single();
    const { data: t35AuditRows } = await client.from('approval_records').select('*').eq('project_id', t35Proj.id).eq('from_status', 'approved').eq('to_status', 'changes_requested');

    if (
      !t35Start.error &&
      t35Start.data?.resultCode === 'SUCCESS' &&
      t35PreviewRow?.status === 'revoked' &&
      t35ProjRow?.status === 'changes_requested' &&
      t35CorrRow?.status === 'in_progress' &&
      t35CorrRow?.resolution_started_at &&
      t35CorrRow?.resolution_started_by === adminId &&
      t35CorrRow?.correction_comment === t35Comment &&
      t35CorrRow?.requested_at === t35Correction.data?.requestedAt &&
      (t35AuditRows || []).length === 1
    ) {
      console.log('PASS: Test 35 - Start resolution happy path succeeded as expected.');
    } else {
      console.error('FAIL: Test 35 - Start resolution happy path failed.', t35Start.data, t35PreviewRow, t35ProjRow, t35CorrRow, t35AuditRows);
      success = false;
    }

    // ============================================================
    // Test 36 (Scenario B): Start Resolution Idempotency
    // ============================================================
    console.log('--- Test 36 (Scenario B): Start Resolution Idempotency ---');
    const t36StartAgain = await client.rpc('start_participant_preview_correction_resolution', {
      p_public_id: String(t35Proj.public_id),
      p_admin_id: adminId,
    });
    const { data: t36AuditRows } = await client.from('approval_records').select('*').eq('project_id', t35Proj.id).eq('from_status', 'approved').eq('to_status', 'changes_requested');
    const { data: t36CorrRow } = await client.from('participant_preview_correction_requests').select('resolution_started_at, resolution_started_by').eq('id', t35Correction.data?.correctionRequestId).single();

    if (
      !t36StartAgain.error &&
      t36StartAgain.data?.resultCode === 'ALREADY_IN_PROGRESS' &&
      (t36AuditRows || []).length === 1 &&
      t36CorrRow?.resolution_started_at === t35CorrRow?.resolution_started_at &&
      t36CorrRow?.resolution_started_by === adminId
    ) {
      console.log('PASS: Test 36 - Start resolution repeat call was cleanly idempotent.');
    } else {
      console.error('FAIL: Test 36 - Start resolution idempotency failed.', t36StartAgain.data, t36AuditRows, t36CorrRow);
      success = false;
    }

    // ============================================================
    // Test 37 (Scenario C): Wrong Active Preview Protection
    // ============================================================
    console.log('--- Test 37 (Scenario C): Wrong Active Preview Protection ---');
    const t37Proj = await createProject('t37', 'approved');
    const t37A = await generate(String(t37Proj.public_id), adminId);
    if (!t37A.res.data?.previewId || t37A.res.data.resultCode !== 'SUCCESS') {
      console.error('FAIL: Test 37 setup - Preview A generation failed.', t37A.res.data);
      success = false;
    }
    const t37Correction = await requestCorrection(t37A.hash, 'Correction on Preview A.');
    if (t37Correction.data?.resultCode !== 'SUCCESS') {
      console.error('FAIL: Test 37 setup - Correction request failed.', t37Correction.data);
      success = false;
    }
    // Revoke Preview A manually
    const t37Revoke = await client.rpc('revoke_participant_preview', { p_public_id: t37Proj.public_id, p_admin_id: adminId });
    if (t37Revoke.data?.resultCode !== 'SUCCESS') {
      console.error('FAIL: Test 37 setup - Revoke Preview A failed.', t37Revoke.data);
      success = false;
    }
    // Manually insert Preview B (active) directly with explicit valid future expires_at
    const t37BHash = hashToken(newRawToken());
    const t37FutureExpiry = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
    const t37InsertRes = await client.from('participant_previews').insert({
      project_id: t37Proj.id,
      token_hash: t37BHash,
      snapshot: { title: t37Proj.title, summary: null, background: null, solution: null, year: 2026, program: null, studyProgram: null, discipline: null, disciplines: [], industry: null, industryPartner: null, academicSupervisor: null, groupName: null, teamMembers: [], posterText: null, accessibilityText: null, citations: [], externalLinks: [], industryCategories: [] },
      media_snapshot: [],
      status: 'active',
      created_by: adminId,
      expires_at: t37FutureExpiry,
    }).select().single();

    if (t37InsertRes.error) {
      console.error('FAIL: Test 37 setup - Manual Preview B insertion error.', t37InsertRes.error);
      success = false;
    } else {
      const t37BRow = t37InsertRes.data;
      // Now attempt to start resolution of Preview A's open correction request
      const t37StartAttempt = await client.rpc('start_participant_preview_correction_resolution', {
        p_public_id: String(t37Proj.public_id),
        p_admin_id: adminId,
      });
      const { data: t37ActiveRows } = await client.from('participant_previews').select('id, status').eq('id', t37BRow.id);
      const { data: t37ProjRow } = await client.from('projects').select('status').eq('id', t37Proj.id).single();
      const { data: t37CorrRow } = await client.from('participant_preview_correction_requests').select('status, resolution_started_at').eq('id', t37Correction.data?.correctionRequestId).single();
      const { count: t37AuditCount } = await client.from('approval_records').select('id', { count: 'exact', head: true }).eq('project_id', t37Proj.id);

      if (
        t37StartAttempt.data?.resultCode === 'CONFLICTING_ACTIVE_PREVIEW' &&
        t37ActiveRows?.[0]?.status === 'active' &&
        t37ProjRow?.status === 'approved' &&
        t37CorrRow?.status === 'open' &&
        t37CorrRow?.resolution_started_at === null &&
        t37AuditCount === 0
      ) {
        console.log('PASS: Test 37 - Conflicting active preview correctly blocked start_resolution and preserved all state.');
      } else {
        console.error('FAIL: Test 37 - Wrong active preview protection failed.', t37StartAttempt.data, t37ActiveRows, t37ProjRow, t37CorrRow, t37AuditCount);
        success = false;
      }
    }

    // ============================================================
    // Test 38 (Scenario D): Reapproval Gate & Review RPC Call
    // ============================================================
    console.log('--- Test 38 (Scenario D): Reapproval Gate & perform_project_review_action ---');
    // Using t35Proj (currently changes_requested)
    const t38AttemptReissue = await generate(String(t35Proj.public_id), adminId, true);
    const { data: t38CorrBefore } = await client.from('participant_preview_correction_requests').select('status, resolved_at').eq('id', t35Correction.data?.correctionRequestId).single();

    // Reapprove project using existing authoritative review RPC (p_public_id, p_action, p_comments, p_admin_id)
    const t38ReapproveRpc = await client.rpc('perform_project_review_action', {
      p_public_id: String(t35Proj.public_id),
      p_action: 'approve',
      p_comments: 'Reapproved following correction resolution edits.',
      p_admin_id: adminId,
    });
    const { data: t38ProjAfterReapprove } = await client.from('projects').select('status').eq('id', t35Proj.id).single();

    if (
      t38AttemptReissue.res.data?.resultCode === 'INVALID_PROJECT_STATE' &&
      t38CorrBefore?.status === 'in_progress' &&
      t38CorrBefore?.resolved_at === null &&
      !t38ReapproveRpc.error &&
      t38ReapproveRpc.data?.status === 'approved' &&
      t38ReapproveRpc.data?.publicId === String(t35Proj.public_id) &&
      t38ReapproveRpc.data?.auditRecordId &&
      t38ProjAfterReapprove?.status === 'approved'
    ) {
      console.log('PASS: Test 38 - Reissue blocked in changes_requested state; project reapproved cleanly via perform_project_review_action.');
    } else {
      console.error('FAIL: Test 38 - Reapproval gate assertion failed.', t38AttemptReissue.res.data, t38CorrBefore, t38ReapproveRpc.data, t38ProjAfterReapprove);
      success = false;
    }

    // ============================================================
    // Test 39 (Scenario E): Corrected Preview B Generation
    // ============================================================
    console.log('--- Test 39 (Scenario E): Corrected Preview B Generation ---');
    const t39Reissue = await generate(String(t35Proj.public_id), adminId, true);
    const t39PreviewBId = t39Reissue.res.data?.previewId;
    const { data: t39ActivePreviews } = await client.from('participant_previews').select('id').eq('project_id', t35Proj.id).eq('status', 'active');
    const { data: t39CorrAfter } = await client.from('participant_preview_correction_requests').select('status, resolved_at, resolved_by, replacement_preview_id, correction_comment, requested_at').eq('id', t35Correction.data?.correctionRequestId).single();
    const { count: t39BConfirmCount } = await client.from('participant_preview_confirmations').select('id', { count: 'exact', head: true }).eq('participant_preview_id', t39PreviewBId);
    const { count: t39BCorrCount } = await client.from('participant_preview_correction_requests').select('id', { count: 'exact', head: true }).eq('participant_preview_id', t39PreviewBId);

    if (
      !t39Reissue.res.error &&
      t39Reissue.res.data?.resultCode === 'SUCCESS' &&
      t39PreviewBId !== t35A.res.data?.previewId &&
      (t39ActivePreviews || []).length === 1 &&
      t39ActivePreviews?.[0]?.id === t39PreviewBId &&
      t39CorrAfter?.status === 'resolved' &&
      t39CorrAfter?.resolved_at &&
      t39CorrAfter?.resolved_by === adminId &&
      t39CorrAfter?.replacement_preview_id === t39PreviewBId &&
      t39CorrAfter?.correction_comment === t35Comment &&
      t39CorrAfter?.requested_at === t35Correction.data?.requestedAt &&
      t39BConfirmCount === 0 &&
      t39BCorrCount === 0
    ) {
      console.log('PASS: Test 39 - Corrected Preview B generated; correction request resolved; Preview B starts unresponded.');
    } else {
      console.error('FAIL: Test 39 - Corrected Preview B generation failed.', t39Reissue.res.data, t39CorrAfter, t39ActivePreviews);
      success = false;
    }

    // ============================================================
    // Test 40 (Scenario F): Immutable Version History
    // ============================================================
    console.log('--- Test 40 (Scenario F): Immutable Version History ---');
    const t40Proj = await createProject('t40', 'approved');
    await createRequiredApprovalMedia(String(t40Proj.id), 't40');
    const t40A = await generate(String(t40Proj.public_id), adminId);
    await requestCorrection(t40A.hash, 'Fix title typo.');
    await client.rpc('start_participant_preview_correction_resolution', { p_public_id: t40Proj.public_id, p_admin_id: adminId });
    // Update project title while in changes_requested
    await client.from('projects').update({ title: 'Corrected Project Title F' }).eq('id', t40Proj.id);
    // Reapprove using authoritative review RPC
    await client.rpc('perform_project_review_action', {
      p_public_id: String(t40Proj.public_id),
      p_action: 'approve',
      p_comments: 'Reapproved for Scenario F',
      p_admin_id: adminId,
    });
    // Reissue Preview B
    const t40B = await generate(String(t40Proj.public_id), adminId, true);

    const t40AResolve = await resolve(t40A.hash);
    const t40BResolve = await resolve(t40B.hash);

    if (
      t40AResolve.data?.resultCode === 'NOT_FOUND' && // Preview A was revoked during start_resolution
      t40BResolve.data?.resultCode === 'SUCCESS' &&
      t40BResolve.data?.snapshot?.title === 'Corrected Project Title F'
    ) {
      // Check stored snapshot in DB for Preview A directly
      const { data: t40ARow } = await client.from('participant_previews').select('snapshot').eq('id', t40A.res.data?.previewId).single();
      if (t40ARow?.snapshot?.title === t40Proj.title && t40ARow?.snapshot?.title !== 'Corrected Project Title F') {
        console.log('PASS: Test 40 - Preview A stored snapshot remained untouched; Preview B captured corrected title.');
      } else {
        console.error('FAIL: Test 40 - Preview A stored snapshot mutated unexpectedly.', t40ARow);
        success = false;
      }
    } else {
      console.error('FAIL: Test 40 - Immutable version history failed.', t40AResolve.data, t40BResolve.data);
      success = false;
    }

    // ============================================================
    // Test 41 (Scenario G): Concurrent Start Resolution
    // ============================================================
    console.log('--- Test 41 (Scenario G): Concurrent Start Resolution ---');
    const t41Proj = await createProject('t41', 'approved');
    await createRequiredApprovalMedia(String(t41Proj.id), 't41');
    const t41A = await generate(String(t41Proj.public_id), adminId);
    await requestCorrection(t41A.hash, 'Concurrent resolution comment.');
    const [t41Start1, t41Start2] = await Promise.all([
      client.rpc('start_participant_preview_correction_resolution', { p_public_id: t41Proj.public_id, p_admin_id: adminId }),
      client.rpc('start_participant_preview_correction_resolution', { p_public_id: t41Proj.public_id, p_admin_id: adminId }),
    ]);

    const t41Codes = [t41Start1.data?.resultCode, t41Start2.data?.resultCode].sort();
    const { count: t41AuditCount } = await client.from('approval_records').select('id', { count: 'exact', head: true }).eq('project_id', t41Proj.id).eq('action_taken', 'request_changes');

    if (
      !t41Start1.error && !t41Start2.error &&
      t41Codes[0] === 'ALREADY_IN_PROGRESS' &&
      t41Codes[1] === 'SUCCESS' &&
      t41AuditCount === 1
    ) {
      console.log('PASS: Test 41 - Concurrent start resolution converged to exactly one SUCCESS and one ALREADY_IN_PROGRESS.');
    } else {
      console.error('FAIL: Test 41 - Concurrent start resolution failed.', t41Start1.data, t41Start2.data, t41AuditCount);
      success = false;
    }

    // ============================================================
    // Test 42 (Scenario H): Concurrent Corrected Reissue
    // ============================================================
    console.log('--- Test 42 (Scenario H): Concurrent Corrected Reissue ---');
    // Reapprove t41Proj using authoritative review RPC
    await client.rpc('perform_project_review_action', {
      p_public_id: String(t41Proj.public_id),
      p_action: 'approve',
      p_comments: 'Reapproved for Scenario H',
      p_admin_id: adminId,
    });
    const [t42Reissue1, t42Reissue2] = await Promise.all([
      generate(String(t41Proj.public_id), adminId, true),
      generate(String(t41Proj.public_id), adminId, true),
    ]);

    const t42Codes = [t42Reissue1.res.data?.resultCode, t42Reissue2.res.data?.resultCode].sort();
    const { data: t42ActivePreviews } = await client.from('participant_previews').select('id').eq('project_id', t41Proj.id).eq('status', 'active');
    const { data: t42CorrRow } = await client.from('participant_preview_correction_requests').select('status, replacement_preview_id').eq('participant_preview_id', t41A.res.data?.previewId).single();

    if (
      !t42Reissue1.res.error && !t42Reissue2.res.error &&
      t42Codes[0] === 'ACTIVE_PREVIEW_EXISTS' &&
      t42Codes[1] === 'SUCCESS' &&
      (t42ActivePreviews || []).length === 1 &&
      t42CorrRow?.status === 'resolved' &&
      t42CorrRow?.replacement_preview_id === t42ActivePreviews?.[0]?.id
    ) {
      console.log('PASS: Test 42 - Concurrent corrected reissue converged to exactly one active Preview B and one ACTIVE_PREVIEW_EXISTS.');
    } else {
      console.error('FAIL: Test 42 - Concurrent corrected reissue failed.', t42Reissue1.res.data, t42Reissue2.res.data, t42ActivePreviews, t42CorrRow);
      success = false;
    }

    // ============================================================
    // Test 43 (Scenario I): Authorization Boundaries
    // ============================================================
    console.log('--- Test 43 (Scenario I): Authorization Boundaries ---');
    const t43Proj = await createProject('t43', 'approved');
    await createRequiredApprovalMedia(String(t43Proj.id), 't43');
    const t43A = await generate(String(t43Proj.public_id), adminId);
    await requestCorrection(t43A.hash, 'Auth test comment.');

    // Start resolution role attempts:
    const t43StartReviewer = await client.rpc('start_participant_preview_correction_resolution', { p_public_id: t43Proj.public_id, p_admin_id: reviewerId });
    const t43StartEditor = await client.rpc('start_participant_preview_correction_resolution', { p_public_id: t43Proj.public_id, p_admin_id: editorId });
    const t43StartAdmin = await client.rpc('start_participant_preview_correction_resolution', { p_public_id: t43Proj.public_id, p_admin_id: adminId });

    // Reapprove t43Proj using authoritative review RPC
    await client.rpc('perform_project_review_action', {
      p_public_id: String(t43Proj.public_id),
      p_action: 'approve',
      p_comments: 'Reapproved for Scenario I',
      p_admin_id: adminId,
    });

    // Reissue role attempts:
    const t43ReissueReviewer = await generate(String(t43Proj.public_id), reviewerId, true);
    const t43ReissueEditor = await generate(String(t43Proj.public_id), editorId, true);
    const t43ReissueAdmin = await generate(String(t43Proj.public_id), adminId, true);

    if (
      t43StartReviewer.data?.resultCode === 'PERMISSION_DENIED' &&
      t43StartEditor.data?.resultCode === 'PERMISSION_DENIED' &&
      t43StartAdmin.data?.resultCode === 'SUCCESS' &&
      t43ReissueReviewer.res.data?.resultCode === 'PREVIEW_PERMISSION_DENIED' &&
      t43ReissueEditor.res.data?.resultCode === 'PREVIEW_PERMISSION_DENIED' &&
      t43ReissueAdmin.res.data?.resultCode === 'SUCCESS'
    ) {
      console.log('PASS: Test 43 - Start resolution and corrected reissue both strictly require combined authority (admin).');
    } else {
      console.error('FAIL: Test 43 - Authorization boundary assertion failed.', t43StartReviewer.data, t43StartEditor.data, t43StartAdmin.data, t43ReissueReviewer.res.data, t43ReissueEditor.res.data, t43ReissueAdmin.res.data);
      success = false;
    }

    // ============================================================
    // Test 44 (Scenario J): Ambiguous State (Multiple in_progress + Mixed open + in_progress)
    // ============================================================
    console.log('--- Test 44 (Scenario J): Ambiguous State ---');
    const t44Proj1 = await createProject('t44a', 'approved');
    const t44A1 = await generate(String(t44Proj1.public_id), adminId);
    await client.rpc('revoke_participant_preview', { p_public_id: t44Proj1.public_id, p_admin_id: adminId });
    const t44A2 = await generate(String(t44Proj1.public_id), adminId);
    await client.rpc('revoke_participant_preview', { p_public_id: t44Proj1.public_id, p_admin_id: adminId });

    // Manually insert TWO in_progress correction requests for t44Proj1
    const now = new Date().toISOString();
    await client.from('participant_preview_correction_requests').insert([
      { participant_preview_id: t44A1.res.data?.previewId, correction_comment: 'Ambiguous in_progress 1', status: 'in_progress', resolution_started_at: now, resolution_started_by: adminId },
      { participant_preview_id: t44A2.res.data?.previewId, correction_comment: 'Ambiguous in_progress 2', status: 'in_progress', resolution_started_at: now, resolution_started_by: adminId },
    ]);

    const t44aReissueAttempt = await generate(String(t44Proj1.public_id), adminId, true);
    const t44aStartAttempt = await client.rpc('start_participant_preview_correction_resolution', { p_public_id: t44Proj1.public_id, p_admin_id: adminId });

    // Mixed unresolved test (one open + one in_progress for t44Proj2)
    const t44Proj2 = await createProject('t44b', 'approved');
    const t44B1 = await generate(String(t44Proj2.public_id), adminId);
    await client.rpc('revoke_participant_preview', { p_public_id: t44Proj2.public_id, p_admin_id: adminId });
    const t44B2 = await generate(String(t44Proj2.public_id), adminId);
    await client.rpc('revoke_participant_preview', { p_public_id: t44Proj2.public_id, p_admin_id: adminId });

    await client.from('participant_preview_correction_requests').insert([
      { participant_preview_id: t44B1.res.data?.previewId, correction_comment: 'Mixed open 1', status: 'open' },
      { participant_preview_id: t44B2.res.data?.previewId, correction_comment: 'Mixed in_progress 2', status: 'in_progress', resolution_started_at: now, resolution_started_by: adminId },
    ]);

    const t44bReissueAttempt = await generate(String(t44Proj2.public_id), adminId, true);
    const t44bStartAttempt = await client.rpc('start_participant_preview_correction_resolution', { p_public_id: t44Proj2.public_id, p_admin_id: adminId });

    if (
      t44aReissueAttempt.res.data?.resultCode === 'AMBIGUOUS_CORRECTION_REQUEST' &&
      t44aStartAttempt.data?.resultCode === 'AMBIGUOUS_CORRECTION_REQUEST' &&
      t44bReissueAttempt.res.data?.resultCode === 'AMBIGUOUS_CORRECTION_REQUEST' &&
      t44bStartAttempt.data?.resultCode === 'AMBIGUOUS_CORRECTION_REQUEST'
    ) {
      console.log('PASS: Test 44 - Multiple in_progress and mixed open+in_progress correction requests both correctly failed closed as AMBIGUOUS_CORRECTION_REQUEST.');
    } else {
      console.error('FAIL: Test 44 - Ambiguous state assertion failed.', t44aReissueAttempt.res.data, t44aStartAttempt.data, t44bReissueAttempt.res.data, t44bStartAttempt.data);
      success = false;
    }

    // ============================================================
    // Test 45 (Scenario K): Zero Publication Side Effects
    // ============================================================
    console.log('--- Test 45 (Scenario K): Zero Publication Side Effects Across Entire Flow ---');
    const { data: t45ProjRow } = await client.from('projects').select('status').eq('id', t35Proj.id).single();
    const { data: t45MediaRows } = await client.from('media_assets').select('public_url, is_public_approved, storage_bucket').eq('project_id', t35Proj.id);
    const t45MediaClean = (t45MediaRows || []).every((m) => m.public_url === null && m.is_public_approved === false && m.storage_bucket === PRIVATE_DRAFT_BUCKET);

    if (t45ProjRow?.status !== 'published' && t45MediaClean) {
      console.log('PASS: Test 45 - Zero publication side effects across complete correction-resolution lifecycle.');
    } else {
      console.error('FAIL: Test 45 - Zero publication side effects assertion failed.', t45ProjRow, t45MediaRows);
      success = false;
    }

    // ============================================================
    // Test 46: Fully-Resolved Lifecycle Deletion Semantics (Independent Block & Atomic Project Cascade)
    // ============================================================
    console.log('--- Test 46: Fully-Resolved Lifecycle Deletion Semantics ---');
    const t46Proj = await createProject('t46', 'approved');
    await createRequiredApprovalMedia(String(t46Proj.id), 't46');
    const t46A = await generate(String(t46Proj.public_id), adminId);
    if (!t46A.res.data?.previewId || t46A.res.data.resultCode !== 'SUCCESS') {
      console.error('FAIL: Test 46 setup - Preview A generation failed.', t46A.res.data);
      success = false;
    }
    const t46Correction = await requestCorrection(t46A.hash, 'Fully resolved lifecycle comment.');
    if (t46Correction.data?.resultCode !== 'SUCCESS' || !t46Correction.data.correctionRequestId) {
      console.error('FAIL: Test 46 setup - Correction request failed.', t46Correction.data);
      success = false;
    }
    const t46Start = await client.rpc('start_participant_preview_correction_resolution', { p_public_id: String(t46Proj.public_id), p_admin_id: adminId });
    if (t46Start.data?.resultCode !== 'SUCCESS') {
      console.error('FAIL: Test 46 setup - Start resolution failed.', t46Start.data);
      success = false;
    }
    const t46Reapprove = await client.rpc('perform_project_review_action', {
      p_public_id: String(t46Proj.public_id),
      p_action: 'approve',
      p_comments: 'Reapproved for Scenario 46',
      p_admin_id: adminId,
    });
    if (t46Reapprove.error || t46Reapprove.data?.status !== 'approved') {
      console.error('FAIL: Test 46 setup - Reapproval failed.', t46Reapprove.error, t46Reapprove.data);
      success = false;
    }
    const t46B = await generate(String(t46Proj.public_id), adminId, true);
    if (!t46B.res.data?.previewId || t46B.res.data.resultCode !== 'SUCCESS' || t46B.res.data.previewId === t46A.res.data?.previewId) {
      console.error('FAIL: Test 46 setup - Corrected Preview B generation failed.', t46B.res.data);
      success = false;
    }

    const { data: t46CorrRowBefore } = await client
      .from('participant_preview_correction_requests')
      .select('status, resolved_at, resolved_by, replacement_preview_id, participant_preview_id')
      .eq('id', t46Correction.data?.correctionRequestId)
      .single();

    if (
      t46CorrRowBefore?.status !== 'resolved' ||
      !t46CorrRowBefore.resolved_at ||
      t46CorrRowBefore.resolved_by !== adminId ||
      t46CorrRowBefore.replacement_preview_id !== t46B.res.data?.previewId ||
      t46CorrRowBefore.participant_preview_id !== t46A.res.data?.previewId
    ) {
      console.error('FAIL: Test 46 setup - Correction request pre-deletion assertions failed.', t46CorrRowBefore);
      success = false;
    }

    // A. Attempt independent deletion of Preview B ONLY (must be BLOCKED by 23503 FK error)
    const t46BDeleteAttempt = await client.from('participant_previews').delete().eq('id', t46B.res.data?.previewId);
    const { data: t46BStillExists } = await client.from('participant_previews').select('id').eq('id', t46B.res.data?.previewId).single();
    const { data: t46CorrStillExists } = await client.from('participant_preview_correction_requests').select('status, replacement_preview_id').eq('id', t46Correction.data?.correctionRequestId).single();

    if (
      t46BDeleteAttempt.error?.code === '23503' &&
      t46BStillExists?.id === t46B.res.data?.previewId &&
      t46CorrStillExists?.status === 'resolved' &&
      t46CorrStillExists.replacement_preview_id === t46B.res.data?.previewId
    ) {
      console.log('PASS: Test 46 Part A - Independent deletion of Preview B was correctly BLOCKED with FK error 23503, preserving correction history.');
    } else {
      console.error('FAIL: Test 46 Part A - Independent Preview B deletion blocking failed.', t46BDeleteAttempt.error, t46BStillExists, t46CorrStillExists);
      success = false;
    }

    // B. Direct atomic PROJECT deletion (must SUCCEED via project -> previews -> correction cascade under deferred FK)
    const t46ProjDelete = await client.from('projects').delete().eq('id', t46Proj.id);
    const { count: t46ProjCountAfter } = await client.from('projects').select('id', { count: 'exact', head: true }).eq('id', t46Proj.id);
    const { count: t46PreviewsCountAfter } = await client.from('participant_previews').select('id', { count: 'exact', head: true }).eq('project_id', t46Proj.id);
    const { count: t46CorrCountAfter } = await client.from('participant_preview_correction_requests').select('id', { count: 'exact', head: true }).eq('participant_preview_id', t46A.res.data?.previewId);

    if (
      !t46ProjDelete.error &&
      t46ProjCountAfter === 0 &&
      t46PreviewsCountAfter === 0 &&
      t46CorrCountAfter === 0
    ) {
      console.log('PASS: Test 46 Part B - Direct atomic project deletion succeeded cleanly under DEFERRABLE INITIALLY DEFERRED FK.');
    } else {
      console.error('FAIL: Test 46 Part B - Direct atomic project deletion failed.', t46ProjDelete.error, t46ProjCountAfter, t46PreviewsCountAfter, t46CorrCountAfter);
      success = false;
    }

    // ============================================================
    // Test 47: Multi-Project Deletion Order-Independence Regression Test
    // ============================================================
    console.log('--- Test 47: Multi-Project Deletion Order-Independence Regression Test ---');
    const t47ProjX = await createProject('t47x', 'approved');
    await createRequiredApprovalMedia(String(t47ProjX.id), 't47x');
    const t47XA = await generate(String(t47ProjX.public_id), adminId);
    await requestCorrection(t47XA.hash, 'Multi-project regression X');
    await client.rpc('start_participant_preview_correction_resolution', { p_public_id: String(t47ProjX.public_id), p_admin_id: adminId });
    await client.rpc('perform_project_review_action', { p_public_id: String(t47ProjX.public_id), p_action: 'approve', p_comments: 'Reapproved X', p_admin_id: adminId });
    const t47XB = await generate(String(t47ProjX.public_id), adminId, true);

    const t47ProjY = await createProject('t47y', 'approved');
    await createRequiredApprovalMedia(String(t47ProjY.id), 't47y');
    const t47YA = await generate(String(t47ProjY.public_id), adminId);
    await requestCorrection(t47YA.hash, 'Multi-project regression Y');
    await client.rpc('start_participant_preview_correction_resolution', { p_public_id: String(t47ProjY.public_id), p_admin_id: adminId });
    await client.rpc('perform_project_review_action', { p_public_id: String(t47ProjY.public_id), p_action: 'approve', p_comments: 'Reapproved Y', p_admin_id: adminId });
    const t47YB = await generate(String(t47ProjY.public_id), adminId, true);

    // Delete both projects atomically in one request
    const t47MultiDelete = await client.from('projects').delete().in('id', [t47ProjX.id, t47ProjY.id]);
    const { count: t47RemainingProjs } = await client.from('projects').select('id', { count: 'exact', head: true }).in('id', [t47ProjX.id, t47ProjY.id]);
    const { count: t47RemainingPreviews } = await client.from('participant_previews').select('id', { count: 'exact', head: true }).in('project_id', [t47ProjX.id, t47ProjY.id]);
    const { count: t47RemainingCorrs } = await client.from('participant_preview_correction_requests').select('id', { count: 'exact', head: true }).in('participant_preview_id', [t47XA.res.data?.previewId, t47YA.res.data?.previewId]);

    if (
      !t47MultiDelete.error &&
      t47RemainingProjs === 0 &&
      t47RemainingPreviews === 0 &&
      t47RemainingCorrs === 0 &&
      t47XB.res.data?.previewId &&
      t47YB.res.data?.previewId
    ) {
      console.log('PASS: Test 47 - Multi-project atomic deletion succeeded cleanly regardless of row ordering.');
    } else {
      console.error('FAIL: Test 47 - Multi-project atomic deletion failed.', t47MultiDelete.error, t47RemainingProjs, t47RemainingPreviews, t47RemainingCorrs);
      success = false;
    }
  } catch (err: unknown) {
    console.error('FAIL: Unexpected runtime verification error.', err instanceof Error ? err.message : err);
    success = false;
  } finally {
    let cleanupExecutionError = false;
    try {
      if (adminClient) {
        const client = adminClient;
        const { data: testProjects } = await client.from('projects').select('id').like('public_id', `${testPrefix}-%`);
        const projectIds = (testProjects || []).map((p) => p.id);
        if (projectIds.length > 0) {
          const previewDel = await client.from('participant_previews').delete().in('project_id', projectIds);
          if (previewDel.error) {
            cleanupExecutionError = true;
            console.error('FAIL: Global cleanup participant_previews deletion error:', previewDel.error.code, previewDel.error.message);
          }
          const mediaDel = await client.from('media_assets').delete().in('project_id', projectIds);
          if (mediaDel.error) {
            cleanupExecutionError = true;
            console.error('FAIL: Global cleanup media_assets deletion error:', mediaDel.error.code, mediaDel.error.message);
          }
        }
        const projDel = await client.from('projects').delete().like('public_id', `${testPrefix}-%`);
        if (projDel.error) {
          cleanupExecutionError = true;
          console.error('FAIL: Global cleanup projects deletion error:', projDel.error.code, projDel.error.message);
        }
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

      if (!cleanupExecutionError && projCount === 0) {
        console.log('PASS: Independent post-cleanup verification confirmed zero leftover test projects (cascading previews/media).');
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
  runParticipantPreviewRuntimeVerification()
    .then((pass) => {
      if (!pass) process.exit(1);
    })
    .catch(() => {
      process.exit(1);
    });
}
