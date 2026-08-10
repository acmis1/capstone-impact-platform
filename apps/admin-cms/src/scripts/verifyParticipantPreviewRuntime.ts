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
      const { data, error } = await client
        .from('media_assets')
        .insert({
          project_id: projectId,
          asset_type: assetType,
          file_name: `${assetType}-${suffix}.bin`,
          storage_bucket: bucket,
          storage_path: `drafts/${suffix}/${assetType}/${assetType}.bin`,
          mime_type: 'application/octet-stream',
          file_size_bytes: 10,
          public_url: overrides?.publicUrl ?? null,
          is_public_approved: overrides?.isPublicApproved ?? false,
        })
        .select()
        .single();
      if (error || !data) throw new Error(`Failed to create media asset fixture for ${suffix}`);
      return data as Record<string, unknown>;
    };

    const generate = async (publicId: string, adminUserId: string) => {
      const raw = newRawToken();
      const hash = hashToken(raw);
      const res = await client.rpc('generate_participant_preview', {
        p_public_id: publicId,
        p_admin_id: adminUserId,
        p_token_hash: hash,
        p_expires_in_seconds: null,
        p_private_bucket: PRIVATE_DRAFT_BUCKET,
      });
      return { raw, hash, res };
    };

    const resolve = async (hash: string) => client.rpc('resolve_participant_preview', { p_token_hash: hash });

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
      t8MediaPaths.every((p) => p.includes('/t8a/')) &&
      !t8MediaPaths.some((p) => p.includes('/t8b/')) &&
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
          await client.from('participant_previews').delete().in('project_id', projectIds);
          await client.from('media_assets').delete().in('project_id', projectIds);
        }
        await client.from('projects').delete().like('public_id', `${testPrefix}-%`);
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
