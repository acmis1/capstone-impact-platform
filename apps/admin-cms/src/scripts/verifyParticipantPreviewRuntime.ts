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
      overrides?: {
        bucket?: string;
        isPublicApproved?: boolean;
        publicUrl?: string | null;
        galleryPosition?: number;
        altText?: string | null;
      }
    ) => {
      const bucket = overrides?.bucket ?? PRIVATE_DRAFT_BUCKET;
      const isPosterImage = assetType === 'poster_image';
      const isPosterPdf = assetType === 'poster_pdf';
      const isImage = isPosterImage || assetType === 'snapshot_image';
      const fileName = isPosterImage ? 'poster.png' : isPosterPdf ? 'poster.pdf' : `${assetType}-${suffix}.png`;
      const mimeType = isImage ? 'image/png' : isPosterPdf ? 'application/pdf' : 'application/octet-stream';
      const projectPublicId = `${testPrefix}-${suffix}`;
      const storagePath = `drafts/${projectPublicId}/${assetType}/${fileName}`;
      const { data, error } = await client
        .from('media_assets')
        .insert({
          project_id: projectId,
          asset_type: assetType,
          // snapshot_image carries authoritative gallery identity; every other asset
          // type must persist a NULL position.
          gallery_position: assetType === 'snapshot_image' ? overrides?.galleryPosition ?? 1 : null,
          file_name: fileName,
          storage_bucket: bucket,
          storage_path: storagePath,
          mime_type: mimeType,
          file_size_bytes: 10,
          public_url: overrides?.publicUrl ?? null,
          is_public_approved: overrides?.isPublicApproved ?? false,
          alt_text_public: overrides?.altText ?? null,
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
    // Test 8: Valid unrelated media is excluded by project scoping. In contrast, invalid
    // same-project media fails the whole preview request closed and creates no preview.
    // ============================================================
    console.log('--- Test 8: Project-scoped valid media succeeds; invalid same-project media fails closed ---');
    const t8ProjA = await createProject('t8a', 'approved');
    const t8ProjB = await createProject('t8b', 'approved');
    const t8APosterImage = await createMediaAsset(String(t8ProjA.id), 'poster_image', 't8a');
    const t8APosterPdf = await createMediaAsset(String(t8ProjA.id), 'poster_pdf', 't8a');
    const t8ASnapshot = await createMediaAsset(String(t8ProjA.id), 'snapshot_image', 't8a', {
      galleryPosition: 1,
      altText: 'Synthetic valid project A snapshot.',
    });
    await createRequiredApprovalMedia(String(t8ProjB.id), 't8b');

    const t8 = await generate(String(t8ProjA.public_id), adminId);
    const { data: t8Row } = await client.from('participant_previews').select('media_snapshot').eq('project_id', t8ProjA.id).single();
    const t8MediaSnapshot: Array<Record<string, unknown>> = t8Row?.media_snapshot || [];
    const t8MediaPaths = t8MediaSnapshot.map((m) => String(m.storagePath));
    const t8SnapshotAssetIds = t8MediaSnapshot.map((m) => String(m.mediaAssetId));
    const t8ExpectedAssetIds = [t8APosterImage.id, t8APosterPdf.id, t8ASnapshot.id].map(String);
    const { data: t8MediaAfter } = await client
      .from('media_assets')
      .select('id, public_url, is_public_approved, public_storage_bucket, public_storage_path, storage_bucket')
      .in('project_id', [t8ProjA.id, t8ProjB.id]);
    const { data: t8ProjectsAfter } = await client.from('projects').select('id, status').in('id', [t8ProjA.id, t8ProjB.id]);
    const t8AllMediaStillPrivate = (t8MediaAfter || []).every((media) =>
      media.public_url === null &&
      media.is_public_approved === false &&
      media.public_storage_bucket === null &&
      media.public_storage_path === null &&
      media.storage_bucket === PRIVATE_DRAFT_BUCKET
    );

    if (
      !t8.res.error &&
      t8.res.data?.resultCode === 'SUCCESS' &&
      t8MediaPaths.length === t8ExpectedAssetIds.length &&
      t8MediaPaths.every((mediaPath) => mediaPath.startsWith(`drafts/${String(t8ProjA.public_id)}/`)) &&
      !t8MediaPaths.some((mediaPath) => mediaPath.startsWith(`drafts/${String(t8ProjB.public_id)}/`)) &&
      t8SnapshotAssetIds.every((id) => t8ExpectedAssetIds.includes(id)) &&
      t8ExpectedAssetIds.every((id) => t8SnapshotAssetIds.includes(id)) &&
      t8AllMediaStillPrivate &&
      (t8ProjectsAfter || []).every((project) => project.status === 'approved')
    ) {
      console.log('PASS: Test 8 - Valid project media is project-scoped, private, and captured as immutable evidence.');
    } else {
      console.error('FAIL: Test 8 - Valid project-scoping assertion failed.', t8.res.data, t8MediaSnapshot, t8MediaAfter, t8ProjectsAfter);
      success = false;
    }

    const t8PublicProject = await createProject('t8public', 'approved');
    await createRequiredApprovalMedia(String(t8PublicProject.id), 't8public');
    await createMediaAsset(String(t8PublicProject.id), 'snapshot_image', 't8public', {
      isPublicApproved: true,
      publicUrl: 'https://example.test/public/t8public-already-approved.png',
      galleryPosition: 1,
      altText: 'Synthetic publicly contradictory snapshot.',
    });
    const { data: t8PublicProjectBefore } = await client.from('projects').select('*').eq('id', t8PublicProject.id).single();
    const { data: t8PublicMediaBefore } = await client.from('media_assets').select('*').eq('project_id', t8PublicProject.id).order('id');
    const t8Public = await generate(String(t8PublicProject.public_id), adminId);
    const { count: t8PublicPreviewCount } = await client.from('participant_previews').select('id', { count: 'exact', head: true }).eq('project_id', t8PublicProject.id);
    const { data: t8PublicProjectAfter } = await client.from('projects').select('*').eq('id', t8PublicProject.id).single();
    const { data: t8PublicMediaAfter } = await client.from('media_assets').select('*').eq('project_id', t8PublicProject.id).order('id');

    if (
      !t8Public.res.error &&
      t8Public.res.data?.resultCode === 'PROJECT_MEDIA_INVALID' &&
      t8PublicPreviewCount === 0 &&
      JSON.stringify(t8PublicProjectAfter) === JSON.stringify(t8PublicProjectBefore) &&
      JSON.stringify(t8PublicMediaAfter) === JSON.stringify(t8PublicMediaBefore)
    ) {
      console.log('PASS: Test 8 - Public-approved/public-URL same-project media fails closed with no preview or state mutation.');
    } else {
      console.error('FAIL: Test 8 - Public-approved/public-URL anomaly assertion failed.', t8Public.res.data, t8PublicPreviewCount, t8PublicProjectBefore, t8PublicProjectAfter, t8PublicMediaBefore, t8PublicMediaAfter);
      success = false;
    }

    const t8WrongBucketProject = await createProject('t8bucket', 'approved');
    await createRequiredApprovalMedia(String(t8WrongBucketProject.id), 't8bucket');
    await createMediaAsset(String(t8WrongBucketProject.id), 'snapshot_image', 't8bucket', {
      bucket: 'project-public-assets',
      galleryPosition: 1,
      altText: 'Synthetic wrong-bucket snapshot.',
    });
    const { data: t8WrongBucketProjectBefore } = await client.from('projects').select('*').eq('id', t8WrongBucketProject.id).single();
    const { data: t8WrongBucketMediaBefore } = await client.from('media_assets').select('*').eq('project_id', t8WrongBucketProject.id).order('id');
    const t8WrongBucket = await generate(String(t8WrongBucketProject.public_id), adminId);
    const { count: t8WrongBucketPreviewCount } = await client.from('participant_previews').select('id', { count: 'exact', head: true }).eq('project_id', t8WrongBucketProject.id);
    const { data: t8WrongBucketProjectAfter } = await client.from('projects').select('*').eq('id', t8WrongBucketProject.id).single();
    const { data: t8WrongBucketMediaAfter } = await client.from('media_assets').select('*').eq('project_id', t8WrongBucketProject.id).order('id');

    if (
      !t8WrongBucket.res.error &&
      t8WrongBucket.res.data?.resultCode === 'PROJECT_MEDIA_INVALID' &&
      t8WrongBucketPreviewCount === 0 &&
      JSON.stringify(t8WrongBucketProjectAfter) === JSON.stringify(t8WrongBucketProjectBefore) &&
      JSON.stringify(t8WrongBucketMediaAfter) === JSON.stringify(t8WrongBucketMediaBefore)
    ) {
      console.log('PASS: Test 8 - Wrong-bucket same-project media fails closed with no preview or state mutation.');
    } else {
      console.error('FAIL: Test 8 - Wrong-bucket anomaly assertion failed.', t8WrongBucket.res.data, t8WrongBucketPreviewCount, t8WrongBucketProjectBefore, t8WrongBucketProjectAfter, t8WrongBucketMediaBefore, t8WrongBucketMediaAfter);
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
    // Tests 35-43: the retired staff correction-resolution shortcut.
    //
    // Migration 0051 (20260903130000_participant_owned_corrections.sql) deliberately retires
    // start_participant_preview_correction_resolution. It is now a constant-returning SQL
    // function that always answers PARTICIPANT_CANDIDATE_REQUIRED: staff may no longer push an
    // approved project into an editable changes_requested state merely because a participant
    // asked for a correction. An exact, participant-authored correction package must exist
    // first, and the authoritative Begin/freeze/Accept/Return workflow now lives in
    // review_participant_correction.
    //
    // The scenarios below therefore prove the retired shortcut fails closed and mutates nothing,
    // rather than asserting the transition it used to perform. Coverage that genuinely belongs
    // to the new workflow -- package staging and idempotency, exact package selection,
    // Begin/freeze, combined edit+review authority on the review decision, Accept/Return,
    // stale-selection fencing, immutable correction evidence, the corrected-preview reissue
    // lifecycle and its concurrency -- is owned by
    // src/scripts/verifyParticipantOwnedCorrectionsRuntime.ts and is deliberately not
    // duplicated here.
    // ============================================================
    const legacyStart = (publicId: string, actorId: string) =>
      client.rpc('start_participant_preview_correction_resolution', { p_public_id: publicId, p_admin_id: actorId });

    const correctionRow = async (correctionRequestId: string) => {
      const { data } = await client
        .from('participant_preview_correction_requests')
        .select('status, resolution_started_at, resolution_started_by, resolved_at, resolved_by, replacement_preview_id, correction_comment, requested_at')
        .eq('id', correctionRequestId)
        .single();
      return data as Record<string, unknown> | null;
    };

    const previewStateRow = async (previewId: string) => {
      const { data } = await client
        .from('participant_previews')
        .select('status, revoked_at, revoked_by')
        .eq('id', previewId)
        .single();
      return data as Record<string, unknown> | null;
    };

    const projectStatus = async (projectId: string) => {
      const { data } = await client.from('projects').select('status').eq('id', projectId).single();
      return data?.status as string | undefined;
    };

    const approvalRecordCount = async (projectId: string) => {
      const { count } = await client.from('approval_records').select('id', { count: 'exact', head: true }).eq('project_id', projectId);
      return count ?? -1;
    };

    // Migration 0051 keeps participant_correction_submissions service_role SELECT-only, so a
    // count is the strongest read this verifier can make -- and the only one it needs: the
    // retired shortcut must never bring a correction package into existence.
    const submissionCount = async (projectId: string) => {
      const { count } = await client.from('participant_correction_submissions').select('id', { count: 'exact', head: true }).eq('project_id', projectId);
      return count ?? -1;
    };

    const previewCount = async (projectId: string) => {
      const { count } = await client.from('participant_previews').select('id', { count: 'exact', head: true }).eq('project_id', projectId);
      return count ?? -1;
    };

    const mediaStaysPrivate = async (projectId: string) => {
      const { data } = await client
        .from('media_assets')
        .select('public_url, is_public_approved, storage_bucket, public_storage_bucket, public_storage_path')
        .eq('project_id', projectId);
      return (data || []).every(
        (m) =>
          m.public_url === null &&
          m.is_public_approved === false &&
          m.storage_bucket === PRIVATE_DRAFT_BUCKET &&
          m.public_storage_bucket === null &&
          m.public_storage_path === null
      );
    };

    // ============================================================
    // Test 35: For a genuine approved project + active participant preview + open correction
    // request and no participant correction package, the retired shortcut fails closed and
    // performs zero mutation. (Replaces the old "start resolution happy path".)
    // ============================================================
    console.log('--- Test 35: Retired correction-resolution shortcut fails closed with zero mutation ---');
    const t35Proj = await createProject('t35', 'approved');
    await createRequiredApprovalMedia(String(t35Proj.id), 't35');
    const t35A = await generate(String(t35Proj.public_id), adminId);
    const t35Comment = 'Please update team members list.';
    const t35Correction = await requestCorrection(t35A.hash, t35Comment);
    const t35CorrectionId = String(t35Correction.data?.correctionRequestId);
    const t35Start = await legacyStart(String(t35Proj.public_id), adminId);

    const t35PreviewRow = await previewStateRow(String(t35A.res.data?.previewId));
    const t35ProjStatus = await projectStatus(String(t35Proj.id));
    const t35CorrRow = await correctionRow(t35CorrectionId);
    const { data: t35LegacyAuditRows } = await client
      .from('approval_records')
      .select('id')
      .eq('project_id', t35Proj.id)
      .eq('from_status', 'approved')
      .eq('to_status', 'changes_requested');
    const t35Resolve = await resolve(t35A.hash);

    if (
      !t35Start.error &&
      t35Start.data?.resultCode === 'PARTICIPANT_CANDIDATE_REQUIRED' &&
      t35ProjStatus === 'approved' &&
      t35PreviewRow?.status === 'active' &&
      t35PreviewRow?.revoked_at === null &&
      t35PreviewRow?.revoked_by === null &&
      t35CorrRow?.status === 'open' &&
      t35CorrRow?.resolution_started_at === null &&
      t35CorrRow?.resolution_started_by === null &&
      t35CorrRow?.resolved_at === null &&
      t35CorrRow?.resolved_by === null &&
      t35CorrRow?.replacement_preview_id === null &&
      t35CorrRow?.correction_comment === t35Comment &&
      t35CorrRow?.requested_at === t35Correction.data?.requestedAt &&
      (t35LegacyAuditRows || []).length === 0 &&
      (await approvalRecordCount(String(t35Proj.id))) === 0 &&
      (await submissionCount(String(t35Proj.id))) === 0 &&
      (await mediaStaysPrivate(String(t35Proj.id))) &&
      t35Resolve.data?.resultCode === 'SUCCESS'
    ) {
      console.log('PASS: Test 35 - Retired shortcut returned PARTICIPANT_CANDIDATE_REQUIRED and left project, preview, correction, audit, package and media state untouched.');
    } else {
      console.error('FAIL: Test 35 - Retired shortcut fail-closed assertion failed.', t35Start.data, t35PreviewRow, t35ProjStatus, t35CorrRow, t35LegacyAuditRows, t35Resolve.data);
      success = false;
    }

    // ============================================================
    // Test 36: A repeated call stays fail-closed and mutation-free -- no retry, replay or
    // second attempt can resurrect the retired transition.
    // ============================================================
    console.log('--- Test 36: Repeated retired-shortcut calls stay fail-closed and mutation-free ---');
    const t36Before = JSON.stringify([t35ProjStatus, t35PreviewRow, t35CorrRow]);
    const t36Second = await legacyStart(String(t35Proj.public_id), adminId);
    const t36Third = await legacyStart(String(t35Proj.public_id), adminId);
    const t36After = JSON.stringify([
      await projectStatus(String(t35Proj.id)),
      await previewStateRow(String(t35A.res.data?.previewId)),
      await correctionRow(t35CorrectionId),
    ]);

    if (
      !t36Second.error &&
      !t36Third.error &&
      t36Second.data?.resultCode === 'PARTICIPANT_CANDIDATE_REQUIRED' &&
      t36Third.data?.resultCode === 'PARTICIPANT_CANDIDATE_REQUIRED' &&
      t36After === t36Before &&
      (await approvalRecordCount(String(t35Proj.id))) === 0 &&
      (await submissionCount(String(t35Proj.id))) === 0
    ) {
      console.log('PASS: Test 36 - Repeat calls remained PARTICIPANT_CANDIDATE_REQUIRED with a byte-identical workflow state.');
    } else {
      console.error('FAIL: Test 36 - Repeat retired-shortcut assertion failed.', t36Second.data, t36Third.data, t36Before, t36After);
      success = false;
    }

    // ============================================================
    // Test 37: No caller can use the retired shortcut. Migration 0051 replaced the function body
    // outright, so it no longer evaluates roles or workflow state at all -- every staff identity
    // receives the same fail-closed answer, and the service_role-only EXECUTE grant established
    // by the earlier migration survives CREATE OR REPLACE, so a browser anon key is still
    // refused outright. (Replaces the start-resolution half of the old Test 43; the combined
    // edit+review authority that actually governs a correction decision is proven against
    // review_participant_correction in verifyParticipantOwnedCorrectionsRuntime.ts.)
    // ============================================================
    console.log('--- Test 37: Retired shortcut is refused for every staff role and for the anon key ---');
    const t37Reviewer = await legacyStart(String(t35Proj.public_id), reviewerId);
    const t37Editor = await legacyStart(String(t35Proj.public_id), editorId);
    const t37Unknown = await legacyStart(String(t35Proj.public_id), crypto.randomUUID());
    const t37Anon = await anonClient.rpc('start_participant_preview_correction_resolution', {
      p_public_id: String(t35Proj.public_id),
      p_admin_id: adminId,
    });
    const t37After = JSON.stringify([
      await projectStatus(String(t35Proj.id)),
      await previewStateRow(String(t35A.res.data?.previewId)),
      await correctionRow(t35CorrectionId),
    ]);

    if (
      t37Reviewer.data?.resultCode === 'PARTICIPANT_CANDIDATE_REQUIRED' &&
      t37Editor.data?.resultCode === 'PARTICIPANT_CANDIDATE_REQUIRED' &&
      t37Unknown.data?.resultCode === 'PARTICIPANT_CANDIDATE_REQUIRED' &&
      Boolean(t37Anon.error) &&
      t37After === t36Before &&
      (await approvalRecordCount(String(t35Proj.id))) === 0 &&
      (await submissionCount(String(t35Proj.id))) === 0
    ) {
      console.log('PASS: Test 37 - Reviewer, editor and unknown identities all fail closed; the anon key cannot execute the retired RPC at all.');
    } else {
      console.error('FAIL: Test 37 - Retired-shortcut caller boundary assertion failed.', t37Reviewer.data, t37Editor.data, t37Unknown.data, t37Anon.error, t37After);
      success = false;
    }

    // ============================================================
    // Test 38: The corrected-reissue path is not an alternative bypass. With an open (never
    // begun) correction request, generation with p_is_correction_reissue = true fails closed as
    // NO_CORRECTION_IN_PROGRESS for a fully-authorized admin, and still fails on authority alone
    // for review-only and edit-only staff. Only accepting a participant-authored package can
    // move a correction request to in_progress. (Replaces the old Tests 38/39 reapproval and
    // corrected-reissue sequence, which depended entirely on the retired shortcut.)
    // ============================================================
    console.log('--- Test 38: Corrected reissue cannot bypass the participant package requirement ---');
    const t38Proj = await createProject('t38', 'approved');
    await createRequiredApprovalMedia(String(t38Proj.id), 't38');
    const t38A = await generate(String(t38Proj.public_id), adminId);
    const t38Correction = await requestCorrection(t38A.hash, 'Correction awaiting a participant-authored package.');
    await client.rpc('revoke_participant_preview', { p_public_id: t38Proj.public_id, p_admin_id: adminId });
    const t38Admin = await generate(String(t38Proj.public_id), adminId, true);
    const t38Reviewer = await generate(String(t38Proj.public_id), reviewerId, true);
    const t38Editor = await generate(String(t38Proj.public_id), editorId, true);
    const t38CorrRow = await correctionRow(String(t38Correction.data?.correctionRequestId));

    if (
      t38Admin.res.data?.resultCode === 'NO_CORRECTION_IN_PROGRESS' &&
      t38Reviewer.res.data?.resultCode === 'PREVIEW_PERMISSION_DENIED' &&
      t38Editor.res.data?.resultCode === 'PREVIEW_PERMISSION_DENIED' &&
      (await projectStatus(String(t38Proj.id))) === 'approved' &&
      t38CorrRow?.status === 'open' &&
      t38CorrRow?.resolution_started_at === null &&
      t38CorrRow?.replacement_preview_id === null &&
      (await previewCount(String(t38Proj.id))) === 1 &&
      (await approvalRecordCount(String(t38Proj.id))) === 0 &&
      (await submissionCount(String(t38Proj.id))) === 0
    ) {
      console.log('PASS: Test 38 - Corrected reissue stayed blocked for admin, reviewer and editor; no preview, audit or package was created.');
    } else {
      console.error('FAIL: Test 38 - Corrected-reissue bypass assertion failed.', t38Admin.res.data, t38Reviewer.res.data, t38Editor.res.data, t38CorrRow);
      success = false;
    }

    // ============================================================
    // Test 39: Concurrency cannot resurrect the retired transition. Three simultaneous calls all
    // fail closed and, between them, create zero approval audits, zero packages and zero
    // duplicate workflow state. (Replaces the old Test 41, which expected exactly one SUCCESS.)
    // ============================================================
    console.log('--- Test 39: Concurrent retired-shortcut calls create no state at all ---');
    const t39Proj = await createProject('t39', 'approved');
    await createRequiredApprovalMedia(String(t39Proj.id), 't39');
    const t39A = await generate(String(t39Proj.public_id), adminId);
    const t39Correction = await requestCorrection(t39A.hash, 'Concurrent retired-shortcut comment.');
    const t39Results = await Promise.all([
      legacyStart(String(t39Proj.public_id), adminId),
      legacyStart(String(t39Proj.public_id), adminId),
      legacyStart(String(t39Proj.public_id), adminId),
    ]);
    const t39CorrRow = await correctionRow(String(t39Correction.data?.correctionRequestId));
    const t39PreviewRow = await previewStateRow(String(t39A.res.data?.previewId));

    if (
      t39Results.every((r) => !r.error && r.data?.resultCode === 'PARTICIPANT_CANDIDATE_REQUIRED') &&
      (await projectStatus(String(t39Proj.id))) === 'approved' &&
      t39PreviewRow?.status === 'active' &&
      t39PreviewRow?.revoked_at === null &&
      t39CorrRow?.status === 'open' &&
      t39CorrRow?.resolution_started_at === null &&
      t39CorrRow?.resolution_started_by === null &&
      (await approvalRecordCount(String(t39Proj.id))) === 0 &&
      (await submissionCount(String(t39Proj.id))) === 0 &&
      (await previewCount(String(t39Proj.id))) === 1
    ) {
      console.log('PASS: Test 39 - All concurrent calls failed closed; no audit, package or duplicate preview was produced.');
    } else {
      console.error('FAIL: Test 39 - Concurrent retired-shortcut assertion failed.', t39Results.map((r) => r.data), t39CorrRow, t39PreviewRow);
      success = false;
    }

    // ============================================================
    // Test 40: Contradictory unresolved-correction state still fails closed.
    //
    // Under Migration 0051 an in_progress correction request implies a frozen, participant-
    // authored package, so the old scenario's two manually fabricated in_progress rows now
    // describe a state the supported workflow can never reach, and manufacturing one here would
    // misrepresent the new contract. The generation ambiguity guard is still live code, so this
    // scenario keeps that defense-in-depth coverage using the ambiguity that remains expressible
    // without inventing correction evidence: two unresolved open requests, one per revoked
    // preview. Ordinary generation, corrected reissue and the retired shortcut must all refuse.
    // ============================================================
    console.log('--- Test 40: Contradictory multi-open-correction state fails closed ---');
    const t40Proj = await createProject('t40', 'approved');
    await createRequiredApprovalMedia(String(t40Proj.id), 't40');
    const t40A1 = await generate(String(t40Proj.public_id), adminId);
    await client.rpc('revoke_participant_preview', { p_public_id: t40Proj.public_id, p_admin_id: adminId });
    const t40A2 = await generate(String(t40Proj.public_id), adminId);
    await client.rpc('revoke_participant_preview', { p_public_id: t40Proj.public_id, p_admin_id: adminId });
    const { error: t40InsertError } = await client.from('participant_preview_correction_requests').insert([
      { participant_preview_id: t40A1.res.data?.previewId, correction_comment: 'Contradictory unresolved 1', status: 'open' },
      { participant_preview_id: t40A2.res.data?.previewId, correction_comment: 'Contradictory unresolved 2', status: 'open' },
    ]);
    const t40Ordinary = await generate(String(t40Proj.public_id), adminId);
    const t40Reissue = await generate(String(t40Proj.public_id), adminId, true);
    const t40Start = await legacyStart(String(t40Proj.public_id), adminId);
    const { data: t40CorrRows } = await client
      .from('participant_preview_correction_requests')
      .select('status')
      .in('participant_preview_id', [t40A1.res.data?.previewId, t40A2.res.data?.previewId]);

    if (
      !t40InsertError &&
      t40Ordinary.res.data?.resultCode === 'CORRECTION_RESOLUTION_REQUIRED' &&
      t40Reissue.res.data?.resultCode === 'AMBIGUOUS_CORRECTION_REQUEST' &&
      t40Start.data?.resultCode === 'PARTICIPANT_CANDIDATE_REQUIRED' &&
      (t40CorrRows || []).length === 2 &&
      (t40CorrRows || []).every((r) => r.status === 'open') &&
      (await projectStatus(String(t40Proj.id))) === 'approved' &&
      (await previewCount(String(t40Proj.id))) === 2 &&
      (await approvalRecordCount(String(t40Proj.id))) === 0 &&
      (await submissionCount(String(t40Proj.id))) === 0
    ) {
      console.log('PASS: Test 40 - Ordinary generation, corrected reissue and the retired shortcut all failed closed on contradictory unresolved corrections.');
    } else {
      console.error('FAIL: Test 40 - Contradictory-state assertion failed.', t40InsertError, t40Ordinary.res.data, t40Reissue.res.data, t40Start.data, t40CorrRows);
      success = false;
    }

    // ============================================================
    // Test 41: Zero publication side effects across every retired-shortcut scenario. Nothing in
    // this block may publish a project, approve media for the public, or write a public URL,
    // bucket or path.
    // ============================================================
    console.log('--- Test 41: Zero publication side effects across the retired-shortcut scenarios ---');
    const t41ProjectIds = [String(t35Proj.id), String(t38Proj.id), String(t39Proj.id), String(t40Proj.id)];
    const { data: t41ProjRows } = await client.from('projects').select('id, status').in('id', t41ProjectIds);
    const t41StatusesClean = (t41ProjRows || []).every((p) => p.status === 'approved');
    const t41MediaClean = (await Promise.all(t41ProjectIds.map((id) => mediaStaysPrivate(id)))).every(Boolean);

    if ((t41ProjRows || []).length === t41ProjectIds.length && t41StatusesClean && t41MediaClean) {
      console.log('PASS: Test 41 - Every scenario project stayed approved with entirely private, unpublished media.');
    } else {
      console.error('FAIL: Test 41 - Publication side-effect assertion failed.', t41ProjRows, t41MediaClean);
      success = false;
    }

    // ============================================================
    // Test 42: Deletion semantics for preview and correction rows that carry no participant
    // correction evidence.
    //
    // Scope note: Migration 0051 gives participant_correction_submissions a plain projects(id)
    // reference with no cascade, and its evidence tables reject DELETE outright, so a project
    // that carries an immutable participant correction package is deliberately NOT freely
    // deletable. This verifier creates no correction packages and therefore makes no claim
    // about that case; it covers only the preview/correction cleanup contract that predates and
    // survives Migration 0051.
    //
    // Part A pins the replacement_preview_id contract (ON DELETE NO ACTION DEFERRABLE INITIALLY
    // DEFERRED): a preview referenced as a correction's replacement cannot be deleted on its
    // own. The resolved end state is written directly here because the only supported route to
    // it now runs through accepting a participant-authored package, which
    // verifyParticipantOwnedCorrectionsRuntime.ts owns; the assertions below are purely about
    // foreign-key wiring, and no correction submission or evidence row is created.
    // ============================================================
    console.log('--- Test 42: Deletion semantics without participant correction evidence ---');
    const stageReplacementLifecycle = async (suffix: string) => {
      const proj = await createProject(suffix, 'approved');
      await createRequiredApprovalMedia(String(proj.id), suffix);
      const previewA = await generate(String(proj.public_id), adminId);
      const correction = await requestCorrection(previewA.hash, `Replacement lifecycle ${suffix}`);
      await client.rpc('revoke_participant_preview', { p_public_id: proj.public_id, p_admin_id: adminId });
      const insertedB = await client
        .from('participant_previews')
        .insert({
          project_id: proj.id,
          token_hash: hashToken(newRawToken()),
          snapshot: { title: proj.title, summary: null, background: null, solution: null, year: 2026, program: null, studyProgram: null, discipline: null, disciplines: [], industry: null, industryPartner: null, academicSupervisor: null, groupName: null, teamMembers: [], posterText: null, accessibilityText: null, citations: [], externalLinks: [], industryCategories: [] },
          media_snapshot: [],
          status: 'active',
          created_by: adminId,
          expires_at: new Date(Date.now() + 7 * 86400 * 1000).toISOString(),
        })
        .select()
        .single();
      if (insertedB.error || !insertedB.data) throw new Error(`Failed to stage replacement preview for ${suffix}: ${insertedB.error?.message}`);
      const resolvedAt = new Date().toISOString();
      const resolvedUpdate = await client
        .from('participant_preview_correction_requests')
        .update({
          status: 'resolved',
          resolution_started_at: resolvedAt,
          resolution_started_by: adminId,
          resolved_at: resolvedAt,
          resolved_by: adminId,
          replacement_preview_id: insertedB.data.id,
        })
        .eq('id', correction.data?.correctionRequestId);
      if (resolvedUpdate.error) throw new Error(`Failed to stage resolved correction for ${suffix}: ${resolvedUpdate.error.message}`);
      return {
        projectId: String(proj.id),
        previewAId: String(previewA.res.data?.previewId),
        previewBId: String(insertedB.data.id),
        correctionId: String(correction.data?.correctionRequestId),
      };
    };

    const t42 = await stageReplacementLifecycle('t42');
    const t42DeleteB = await client.from('participant_previews').delete().eq('id', t42.previewBId);
    const { data: t42BStillExists } = await client.from('participant_previews').select('id').eq('id', t42.previewBId).single();
    const t42CorrStillExists = await correctionRow(t42.correctionId);

    if (
      t42DeleteB.error?.code === '23503' &&
      t42BStillExists?.id === t42.previewBId &&
      t42CorrStillExists?.status === 'resolved' &&
      t42CorrStillExists?.replacement_preview_id === t42.previewBId
    ) {
      console.log('PASS: Test 42 Part A - Independent deletion of the replacement preview was correctly BLOCKED with FK error 23503, preserving correction history.');
    } else {
      console.error('FAIL: Test 42 Part A - Replacement-preview deletion blocking failed.', t42DeleteB.error, t42BStillExists, t42CorrStillExists);
      success = false;
    }

    // Part B: atomic project deletion still cascades project -> previews -> correction requests
    // cleanly under the deferred replacement foreign key.
    const t42ProjDelete = await client.from('projects').delete().eq('id', t42.projectId);
    const { count: t42ProjCountAfter } = await client.from('projects').select('id', { count: 'exact', head: true }).eq('id', t42.projectId);
    const { count: t42PreviewsCountAfter } = await client.from('participant_previews').select('id', { count: 'exact', head: true }).eq('project_id', t42.projectId);
    const { count: t42CorrCountAfter } = await client.from('participant_preview_correction_requests').select('id', { count: 'exact', head: true }).eq('id', t42.correctionId);

    if (!t42ProjDelete.error && t42ProjCountAfter === 0 && t42PreviewsCountAfter === 0 && t42CorrCountAfter === 0) {
      console.log('PASS: Test 42 Part B - Direct atomic project deletion succeeded cleanly under DEFERRABLE INITIALLY DEFERRED FK.');
    } else {
      console.error('FAIL: Test 42 Part B - Direct atomic project deletion failed.', t42ProjDelete.error, t42ProjCountAfter, t42PreviewsCountAfter, t42CorrCountAfter);
      success = false;
    }

    // ============================================================
    // Test 43: Multi-project deletion order-independence regression test. Two projects whose
    // previews and correction requests interlock through the deferred replacement foreign key
    // must delete cleanly in a single statement regardless of row ordering.
    // ============================================================
    console.log('--- Test 43: Multi-project deletion order-independence regression test ---');
    const t43X = await stageReplacementLifecycle('t43x');
    const t43Y = await stageReplacementLifecycle('t43y');
    const t43MultiDelete = await client.from('projects').delete().in('id', [t43X.projectId, t43Y.projectId]);
    const { count: t43RemainingProjs } = await client.from('projects').select('id', { count: 'exact', head: true }).in('id', [t43X.projectId, t43Y.projectId]);
    const { count: t43RemainingPreviews } = await client.from('participant_previews').select('id', { count: 'exact', head: true }).in('project_id', [t43X.projectId, t43Y.projectId]);
    const { count: t43RemainingCorrs } = await client.from('participant_preview_correction_requests').select('id', { count: 'exact', head: true }).in('id', [t43X.correctionId, t43Y.correctionId]);

    if (!t43MultiDelete.error && t43RemainingProjs === 0 && t43RemainingPreviews === 0 && t43RemainingCorrs === 0) {
      console.log('PASS: Test 43 - Multi-project atomic deletion succeeded cleanly regardless of row ordering.');
    } else {
      console.error('FAIL: Test 43 - Multi-project atomic deletion failed.', t43MultiDelete.error, t43RemainingProjs, t43RemainingPreviews, t43RemainingCorrs);
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
