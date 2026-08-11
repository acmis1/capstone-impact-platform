import { createClient } from '@supabase/supabase-js';
import { SupabaseParticipantPreviewRepositoryCore } from '../repositories/SupabaseParticipantPreviewRepositoryCore';
import { compilePublicFeed } from '../feed/compilePublicFeed';
import { Project } from '../domain/project';
import crypto from 'node:crypto';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';

const PRIVATE_DRAFT_BUCKET = 'project-drafts-private';

function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

export async function runPublicationReadinessRuntimeVerification(): Promise<boolean> {
  console.log('=== Capstone Impact Platform: Publication Readiness Runtime Verification ===\n');

  const repoRoot = path.resolve(__dirname, '../../../..');
  const rawEnv = execSync(`"${path.resolve(repoRoot, 'node_modules/.bin/supabase')}" status --workdir "${path.resolve(repoRoot, 'infra')}" -o env`, { encoding: 'utf8', cwd: repoRoot });
  const localEnv = parseSupabaseCliEnv(rawEnv);
  const apiUrl = localEnv.API_URL || 'http://127.0.0.1:54321';
  const serviceKey = localEnv.SERVICE_ROLE_KEY;
  const anonKey = localEnv.ANON_KEY;
  if (!serviceKey || !anonKey) throw new Error('Local Supabase CLI did not return service and anon keys.');
  const client = createClient(apiUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const anonClient = createClient(apiUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const repo = new SupabaseParticipantPreviewRepositoryCore(client);

  const createdProjectIds: string[] = [];
  let authenticatedUserId: string | null = null;

  try {
    // Resolve admin user ID
    const { data: roleRows, error: adminErr } = await client.from('user_roles').select('user_id, role');
    const adminUser = roleRows?.find((row) => row.role === 'admin');
    const reviewerUser = roleRows?.find((row) => row.role === 'reviewer');
    const editorUser = roleRows?.find((row) => row.role === 'editor');

    if (adminErr || !adminUser) {
      console.error('❌ Failed to resolve admin user fixture:', adminErr);
      return false;
    }
    if (!reviewerUser || !editorUser) return false;
    const adminId = String(adminUser.user_id);
    const reviewerId = String(reviewerUser.user_id);
    const editorId = String(editorUser.user_id);

    // Helper to generate project fixture
    async function createProjectFixture(tag: string, status: string = 'approved') {
      const publicId = `pub-readiness-${tag}-${Date.now()}`;
      const { data: proj, error } = await client
        .from('projects')
        .insert({
          public_id: publicId,
          title: `Publication Readiness ${tag}`,
          summary: 'Testing publication readiness gate',
          background: 'Background info',
          solution: 'Solution info',
          year: '2026',
          program_name: 'Software Engineering',
          study_program: 'Bachelor of Software Engineering',
          discipline: 'Software Engineering',
          industry: 'Technology',
          industry_partner: 'Tech Partner',
          academic_supervisor: 'Dr. Supervisor',
          group_name: 'Team Alpha',
          team_members: ['Alice', 'Bob'],
          poster_text_public: 'Poster text',
          accessibility_text_public: 'Accessibility text',
          status,
        })
        .select('id, public_id')
        .single();

      if (error || !proj) {
        throw new Error(`Failed to create project fixture ${tag}: ${error?.message}`);
      }
      createdProjectIds.push(proj.id);
      return proj;
    }

    // Helper to generate preview
    async function generatePreview(publicId: string, isReissue = false) {
      const token = `raw-token-${crypto.randomUUID()}`;
      const tokenHash = hashToken(token);
      const res = await repo.generatePreview({
        publicId,
        adminId,
        tokenHash,
        privateBucket: PRIVATE_DRAFT_BUCKET,
        isCorrectionReissue: isReissue,
      });
      return { token, tokenHash, previewId: res.previewId };
    }

    // Capture initial public storage / published snapshots baseline
    const { count: initialSnapshotCount } = await client
      .from('published_snapshots')
      .select('id', { count: 'exact', head: true });
    const { data: initialFeedObjects, error: initialFeedError } = await client.storage.from('public-feeds').list();
    const { data: initialPublicAssetObjects, error: initialPublicAssetError } = await client.storage.from('project-public-assets').list();
    if (initialFeedError || initialPublicAssetError) throw new Error('Unable to capture public storage baseline.');

    // TEST 1: Approved project, no participant preview -> NOT READY (NO_ACTIVE_PREVIEW)
    console.log('--- TEST 1: Approved project with no preview ---');
    const p1 = await createProjectFixture('t1', 'approved');
    const r1 = await repo.getPublicationReadiness({ publicId: p1.public_id, adminId, privateBucket: PRIVATE_DRAFT_BUCKET });
    if (!r1.ready && r1.resultCode === 'NO_ACTIVE_PREVIEW') {
      console.log('PASS: Test 1 - Approved project without preview returned NO_ACTIVE_PREVIEW');
    } else {
      console.error('FAIL: Test 1 unexpected result', r1);
      return false;
    }

    // TEST 2: Approved project, active Preview A, no response -> NOT READY (PREVIEW_NOT_CONFIRMED)
    console.log('--- TEST 2: Active Preview A unresponded ---');
    const p2 = await createProjectFixture('t2', 'approved');
    await generatePreview(p2.public_id);
    const r2 = await repo.getPublicationReadiness({ publicId: p2.public_id, adminId, privateBucket: PRIVATE_DRAFT_BUCKET });
    if (!r2.ready && r2.resultCode === 'PREVIEW_NOT_CONFIRMED') {
      console.log('PASS: Test 2 - Active unresponded preview returned PREVIEW_NOT_CONFIRMED');
    } else {
      console.error('FAIL: Test 2 unexpected result', r2);
      return false;
    }

    // TEST 3: Approved project, active Preview A, confirmed, data unchanged -> READY
    console.log('--- TEST 3: Active confirmed Preview A unchanged ---');
    const p3 = await createProjectFixture('t3', 'approved');
    const prev3 = await generatePreview(p3.public_id);
    await repo.confirmPreview(prev3.tokenHash);
    const { data: p3BeforeReadiness } = await client.from('projects').select('status').eq('id', p3.id).single();
    const r3 = await repo.getPublicationReadiness({ publicId: p3.public_id, adminId, privateBucket: PRIVATE_DRAFT_BUCKET });
    if (r3.ready && r3.resultCode === 'READY' && r3.confirmedPreviewId === prev3.previewId && r3.confirmedAt) {
      console.log('PASS: Test 3 - Confirmed active preview with unchanged snapshot returned READY');
    } else {
      console.error('FAIL: Test 3 unexpected result', r3);
      return false;
    }

    // TEST 4: Confirmed Preview A becomes time-expired but remains structurally active -> READY
    console.log('--- TEST 4: Confirmed preview expired but active ---');
    const p4 = await createProjectFixture('t4', 'approved');
    const prev4 = await generatePreview(p4.public_id);
    await repo.confirmPreview(prev4.tokenHash);
    // Manually set expires_at in past
    await client.from('participant_previews').update({ expires_at: new Date(Date.now() - 3600000).toISOString() }).eq('id', prev4.previewId);
    const r4 = await repo.getPublicationReadiness({ publicId: p4.public_id, adminId, privateBucket: PRIVATE_DRAFT_BUCKET });
    if (r4.ready && r4.resultCode === 'READY') {
      console.log('PASS: Test 4 - Expired confirmed preview remains READY for publication');
    } else {
      console.error('FAIL: Test 4 unexpected result', r4);
      return false;
    }

    // TEST 5: Confirmed Preview A explicitly revoked -> NOT READY (NO_ACTIVE_PREVIEW)
    console.log('--- TEST 5: Confirmed preview explicitly revoked ---');
    const p5 = await createProjectFixture('t5', 'approved');
    const prev5 = await generatePreview(p5.public_id);
    await repo.confirmPreview(prev5.tokenHash);
    await repo.revokePreview({ publicId: p5.public_id, adminId });
    const r5 = await repo.getPublicationReadiness({ publicId: p5.public_id, adminId, privateBucket: PRIVATE_DRAFT_BUCKET });
    if (!r5.ready && r5.resultCode === 'NO_ACTIVE_PREVIEW') {
      console.log('PASS: Test 5 - Revoked confirmed preview returned NO_ACTIVE_PREVIEW');
    } else {
      console.error('FAIL: Test 5 unexpected result', r5);
      return false;
    }

    // TEST 6: Historical confirmed Preview A revoked, Preview B active unresponded -> NOT READY (PREVIEW_NOT_CONFIRMED)
    console.log('--- TEST 6: Historical confirmed A vs active unconfirmed B ---');
    const p6 = await createProjectFixture('t6', 'approved');
    const prev6a = await generatePreview(p6.public_id);
    await repo.confirmPreview(prev6a.tokenHash);
    await repo.revokePreview({ publicId: p6.public_id, adminId });
    await generatePreview(p6.public_id);
    const r6 = await repo.getPublicationReadiness({ publicId: p6.public_id, adminId, privateBucket: PRIVATE_DRAFT_BUCKET });
    if (!r6.ready && r6.resultCode === 'PREVIEW_NOT_CONFIRMED') {
      console.log('PASS: Test 6 - Active unconfirmed Preview B returned PREVIEW_NOT_CONFIRMED despite historical Preview A confirmation');
    } else {
      console.error('FAIL: Test 6 unexpected result', r6);
      return false;
    }

    // TEST 7: Active preview has open correction -> NOT READY (CORRECTION_UNRESOLVED)
    console.log('--- TEST 7: Active preview has open correction ---');
    const p7 = await createProjectFixture('t7', 'approved');
    const prev7 = await generatePreview(p7.public_id);
    await repo.requestCorrection(prev7.tokenHash, 'Fix title typo please');
    const r7 = await repo.getPublicationReadiness({ publicId: p7.public_id, adminId, privateBucket: PRIVATE_DRAFT_BUCKET });
    if (!r7.ready && r7.resultCode === 'CORRECTION_UNRESOLVED') {
      console.log('PASS: Test 7 - Open correction returned CORRECTION_UNRESOLVED');
    } else {
      console.error('FAIL: Test 7 unexpected result', r7);
      return false;
    }

    // TEST 8: Correction is in_progress -> NOT READY (CORRECTION_UNRESOLVED)
    console.log('--- TEST 8: Correction in_progress ---');
    const p8 = await createProjectFixture('t8', 'approved');
    const prev8 = await generatePreview(p8.public_id);
    await repo.requestCorrection(prev8.tokenHash, 'Fix background text');
    await repo.startCorrectionResolution({ publicId: p8.public_id, adminId });
    const r8 = await repo.getPublicationReadiness({ publicId: p8.public_id, adminId, privateBucket: PRIVATE_DRAFT_BUCKET });
    if (!r8.ready && r8.resultCode === 'CORRECTION_UNRESOLVED') {
      console.log('PASS: Test 8 - In_progress correction returned not ready');
    } else {
      console.error('FAIL: Test 8 unexpected result', r8);
      return false;
    }

    // TEST 9: Correction resolved, Preview B active unresponded -> NOT READY (CORRECTED_PREVIEW_AWAITING_CONFIRMATION)
    console.log('--- TEST 9: Resolved correction + Preview B unresponded ---');
    const p9 = await createProjectFixture('t9', 'approved');
    const prev9a = await generatePreview(p9.public_id);
    await repo.requestCorrection(prev9a.tokenHash, 'Fix summary');
    await repo.startCorrectionResolution({ publicId: p9.public_id, adminId });
    const reapprove9 = await client.rpc('perform_project_review_action', {
      p_public_id: p9.public_id, p_action: 'approve', p_comments: 'Reapproved after correction resolution.', p_admin_id: adminId,
    });
    if (reapprove9.error || !reapprove9.data?.auditRecordId) throw new Error('Test 9 reapproval failed.');
    await generatePreview(p9.public_id, true); // Reissue Preview B
    const r9 = await repo.getPublicationReadiness({ publicId: p9.public_id, adminId, privateBucket: PRIVATE_DRAFT_BUCKET });
    if (!r9.ready && r9.resultCode === 'CORRECTED_PREVIEW_AWAITING_CONFIRMATION') {
      console.log('PASS: Test 9 - Corrected Preview B awaiting confirmation returned CORRECTED_PREVIEW_AWAITING_CONFIRMATION');
    } else {
      console.error('FAIL: Test 9 unexpected result', r9);
      return false;
    }

    // TEST 10: Correction resolved, Preview B active confirmed -> READY
    console.log('--- TEST 10: Resolved correction + Preview B confirmed ---');
    const p10 = await createProjectFixture('t10', 'approved');
    const prev10a = await generatePreview(p10.public_id);
    await repo.requestCorrection(prev10a.tokenHash, 'Fix title');
    await repo.startCorrectionResolution({ publicId: p10.public_id, adminId });
    const reapprove10 = await client.rpc('perform_project_review_action', {
      p_public_id: p10.public_id, p_action: 'approve', p_comments: 'Reapproved after correction resolution.', p_admin_id: adminId,
    });
    if (reapprove10.error || !reapprove10.data?.auditRecordId) throw new Error('Test 10 reapproval failed.');
    const prev10b = await generatePreview(p10.public_id, true);
    await repo.confirmPreview(prev10b.tokenHash);
    const r10 = await repo.getPublicationReadiness({ publicId: p10.public_id, adminId, privateBucket: PRIVATE_DRAFT_BUCKET });
    if (r10.ready && r10.resultCode === 'READY' && r10.confirmedPreviewId === prev10b.previewId) {
      console.log('PASS: Test 10 - Resolved correction + Preview B confirmed returned READY');
    } else {
      console.error('FAIL: Test 10 unexpected result', r10);
      return false;
    }

    // TEST 11: Confirmed preview then scalar metadata changes -> NOT READY (PROJECT_SNAPSHOT_STALE)
    console.log('--- TEST 11: Scalar metadata drift ---');
    const p11 = await createProjectFixture('t11', 'approved');
    const prev11 = await generatePreview(p11.public_id);
    await repo.confirmPreview(prev11.tokenHash);
    // Mutate scalar field (title)
    await client.from('projects').update({ title: 'Updated Title Post Confirmation' }).eq('id', p11.id);
    const r11 = await repo.getPublicationReadiness({ publicId: p11.public_id, adminId, privateBucket: PRIVATE_DRAFT_BUCKET });
    if (!r11.ready && r11.resultCode === 'PROJECT_SNAPSHOT_STALE') {
      console.log('PASS: Test 11 - Title change after confirmation returned PROJECT_SNAPSHOT_STALE');
    } else {
      console.error('FAIL: Test 11 unexpected result', r11);
      return false;
    }

    // TEST 12: Confirmed preview then taxonomy relationship changes -> NOT READY (PROJECT_SNAPSHOT_STALE)
    console.log('--- TEST 12: Taxonomy relationship drift ---');
    const p12 = await createProjectFixture('t12', 'approved');
    const prev12 = await generatePreview(p12.public_id);
    await repo.confirmPreview(prev12.tokenHash);
    // Add discipline relationship
    const { data: disc } = await client.from('disciplines').select('id').limit(1).single();
    if (disc) {
      await client.from('project_disciplines').insert({ project_id: p12.id, discipline_id: disc.id });
    }
    const r12 = await repo.getPublicationReadiness({ publicId: p12.public_id, adminId, privateBucket: PRIVATE_DRAFT_BUCKET });
    if (!r12.ready && r12.resultCode === 'PROJECT_SNAPSHOT_STALE') {
      console.log('PASS: Test 12 - Discipline relationship change after confirmation returned PROJECT_SNAPSHOT_STALE');
    } else {
      console.error('FAIL: Test 12 unexpected result', r12);
      return false;
    }

    // TEST 13: Confirmed preview then authoritative private media changes -> NOT READY (MEDIA_SNAPSHOT_STALE)
    console.log('--- TEST 13: Private media drift ---');
    const p13 = await createProjectFixture('t13', 'approved');
    const prev13 = await generatePreview(p13.public_id);
    await repo.confirmPreview(prev13.tokenHash);
    // Add a media asset row
    await client.from('media_assets').insert({
      project_id: p13.id,
      asset_type: 'poster',
      file_name: 'new_poster.png',
      storage_bucket: PRIVATE_DRAFT_BUCKET,
      storage_path: `projects/${p13.id}/new_poster.png`,
      mime_type: 'image/png',
      is_public_approved: false,
    });
    const r13 = await repo.getPublicationReadiness({ publicId: p13.public_id, adminId, privateBucket: PRIVATE_DRAFT_BUCKET });
    if (!r13.ready && r13.resultCode === 'MEDIA_SNAPSHOT_STALE') {
      console.log('PASS: Test 13 - Private media change after confirmation returned MEDIA_SNAPSHOT_STALE');
    } else {
      console.error('FAIL: Test 13 unexpected result', r13);
      return false;
    }

    // TEST 14: Every non-approved workflow state -> NOT READY (INVALID_PROJECT_STATE)
    console.log('--- TEST 14: Non-approved project states ---');
    const nonApprovedStates = ['draft', 'submitted', 'in_review', 'changes_requested', 'published', 'archived'];
    for (const st of nonApprovedStates) {
      const p14 = await createProjectFixture(`t14-${st}`, st);
      const r14 = await repo.getPublicationReadiness({ publicId: p14.public_id, adminId, privateBucket: PRIVATE_DRAFT_BUCKET });
      if (!r14.ready && r14.resultCode === 'INVALID_PROJECT_STATE') {
        // PASS for this status
      } else {
        console.error(`FAIL: Test 14 failed for status [${st}]`, r14);
        return false;
      }
    }
    console.log('PASS: Test 14 - All non-approved workflow states returned INVALID_PROJECT_STATE');

    // TEST 15: Contradictory/ambiguous synthetic DB state -> fail closed
    console.log('--- TEST 15: Contradictory DB state ---');
    const p15 = await createProjectFixture('t15', 'approved');
    const prev15 = await generatePreview(p15.public_id);
    await repo.confirmPreview(prev15.tokenHash);
    // Force insert correction request on confirmed preview directly
    await client.from('participant_preview_correction_requests').insert({
      participant_preview_id: prev15.previewId,
      correction_comment: 'Contradictory comment',
      status: 'open',
    });
    const r15 = await repo.getPublicationReadiness({ publicId: p15.public_id, adminId, privateBucket: PRIVATE_DRAFT_BUCKET });
    const p15Resolved = await createProjectFixture('t15-resolved', 'approved');
    const prev15Resolved = await generatePreview(p15Resolved.public_id);
    await repo.confirmPreview(prev15Resolved.tokenHash);
    const resolvedAt = new Date().toISOString();
    const { error: resolvedCorrectionError } = await client.from('participant_preview_correction_requests').insert({
      participant_preview_id: prev15Resolved.previewId,
      correction_comment: 'Contradictory resolved correction',
      status: 'resolved',
      resolution_started_at: resolvedAt,
      resolution_started_by: adminId,
      resolved_at: resolvedAt,
      resolved_by: adminId,
      replacement_preview_id: prev15Resolved.previewId,
    });
    if (resolvedCorrectionError) throw new Error(`Test 15 resolved corruption setup failed: ${resolvedCorrectionError.message}`);
    const resolvedCorrection = await repo.getPublicationReadiness({ publicId: p15Resolved.public_id, adminId, privateBucket: PRIVATE_DRAFT_BUCKET });
    const p15Malformed = await createProjectFixture('t15-malformed', 'approved');
    const prev15Malformed = await generatePreview(p15Malformed.public_id);
    await repo.confirmPreview(prev15Malformed.tokenHash);
    await client.from('participant_previews').update({ snapshot: 'malformed snapshot' }).eq('id', prev15Malformed.previewId);
    const malformedSnapshot = await repo.getPublicationReadiness({ publicId: p15Malformed.public_id, adminId, privateBucket: PRIVATE_DRAFT_BUCKET });
    const p15MalformedMedia = await createProjectFixture('t15-malformed-media', 'approved');
    const prev15MalformedMedia = await generatePreview(p15MalformedMedia.public_id);
    await repo.confirmPreview(prev15MalformedMedia.tokenHash);
    await client.from('participant_previews').update({ media_snapshot: ['malformed media'] }).eq('id', prev15MalformedMedia.previewId);
    const malformedMedia = await repo.getPublicationReadiness({ publicId: p15MalformedMedia.public_id, adminId, privateBucket: PRIVATE_DRAFT_BUCKET });
    if (
      !r15.ready && r15.resultCode === 'READINESS_UNAVAILABLE' &&
      !resolvedCorrection.ready && resolvedCorrection.resultCode === 'READINESS_UNAVAILABLE' &&
      malformedSnapshot.resultCode === 'READINESS_UNAVAILABLE' && malformedMedia.resultCode === 'READINESS_UNAVAILABLE'
    ) {
      console.log('PASS: Test 15 - Active-preview correction and resolved-correction contradictions, plus malformed state, failed closed');
    } else {
      console.error('FAIL: Test 15 fail-closed assertion failed', { r15, resolvedCorrection, malformedSnapshot, malformedMedia });
      return false;
    }

    // TEST 16: Authorization / Data API boundary
    console.log('--- TEST 16: Data API boundary & authorization ---');
    const reviewerResult = await repo.getPublicationReadiness({ publicId: p3.public_id, adminId: reviewerId, privateBucket: PRIVATE_DRAFT_BUCKET });
    const editorResult = await repo.getPublicationReadiness({ publicId: p3.public_id, adminId: editorId, privateBucket: PRIVATE_DRAFT_BUCKET });
    const unknownResult = await repo.getPublicationReadiness({ publicId: p3.public_id, adminId: crypto.randomUUID(), privateBucket: PRIVATE_DRAFT_BUCKET });
    const { error: anonErr } = await anonClient.rpc('get_project_publication_readiness', {
      p_public_id: p3.public_id,
      p_admin_id: adminId,
      p_private_bucket: PRIVATE_DRAFT_BUCKET,
    });
    const password = `Readiness-${crypto.randomUUID()}`;
    const createdAuth = await client.auth.admin.createUser({ email: `readiness-${crypto.randomUUID()}@example.test`, password, email_confirm: true });
    authenticatedUserId = createdAuth.data.user?.id || null;
    if (createdAuth.error || !createdAuth.data.user) throw new Error(`Failed to create authenticated boundary fixture: ${createdAuth.error?.message}`);
    const authenticatedClient = createClient(apiUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const signIn = await authenticatedClient.auth.signInWithPassword({ email: createdAuth.data.user.email!, password });
    const { error: authenticatedErr } = await authenticatedClient.rpc('get_project_publication_readiness', {
      p_public_id: p3.public_id, p_admin_id: adminId, p_private_bucket: PRIVATE_DRAFT_BUCKET,
    });
    const { error: anonTableErr } = await anonClient.from('participant_preview_confirmations').select('id').limit(1);
    const { error: authenticatedTableErr } = await authenticatedClient.from('participant_preview_confirmations').select('id').limit(1);
    if (
      r3.ready && reviewerResult.ready &&
      editorResult.resultCode === 'READINESS_PERMISSION_DENIED' &&
      unknownResult.resultCode === 'READINESS_PERMISSION_DENIED' &&
      anonErr && signIn.data.session && authenticatedErr && anonTableErr && authenticatedTableErr
    ) {
      console.log('PASS: Test 16 - service admin/reviewer allowed; editor/unknown rejected; real anon/authenticated RPC and protected-table access denied');
    } else {
      console.error('FAIL: Test 16 authorization boundary assertion failed', { reviewerResult, editorResult, unknownResult, anonErr, authenticatedErr, anonTableErr, authenticatedTableErr });
      return false;
    }

    // TEST 17: PUBLIC FEED COMPILER
    console.log('--- TEST 17: Public feed compiler hardening ---');
    const dummyProjects: Project[] = [
      { id: 1, publicId: 'p-draft', title: 'D', status: 'draft' } as Project,
      { id: 2, publicId: 'p-submitted', title: 'S', status: 'submitted' } as Project,
      { id: 3, publicId: 'p-in-review', title: 'R', status: 'in_review' } as Project,
      { id: 4, publicId: 'p-changes', title: 'C', status: 'changes_requested' } as Project,
      { id: 5, publicId: 'p-approved', title: 'A', status: 'approved' } as Project,
      { id: 6, publicId: 'p-published', title: 'P', status: 'published' } as Project,
      { id: 7, publicId: 'p-archived', title: 'Ar', status: 'archived' } as Project,
    ];
    const feed = compilePublicFeed(dummyProjects);
    if (feed.length === 1 && feed[0].publicId === 'p-published') {
      console.log('PASS: Test 17 - Public feed compiler includes published projects ONLY (approved excluded)');
    } else {
      console.error('FAIL: Test 17 - Compiler failed published-only rule', feed);
      return false;
    }

    // TEST 18: ZERO PUBLICATION SIDE EFFECTS
    console.log('--- TEST 18: Zero publication side effects ---');
    const { count: finalSnapshotCount } = await client
      .from('published_snapshots')
      .select('id', { count: 'exact', head: true });
    const { data: finalFeedObjects, error: finalFeedError } = await client.storage.from('public-feeds').list();
    const { data: finalPublicAssetObjects, error: finalPublicAssetError } = await client.storage.from('project-public-assets').list();
    const { data: p3AfterReadiness } = await client.from('projects').select('status').eq('id', p3.id).single();
    if (
      initialSnapshotCount === finalSnapshotCount &&
      JSON.stringify(initialFeedObjects) === JSON.stringify(finalFeedObjects) &&
      JSON.stringify(initialPublicAssetObjects) === JSON.stringify(finalPublicAssetObjects) &&
      p3BeforeReadiness?.status === p3AfterReadiness?.status &&
      !finalFeedError && !finalPublicAssetError
    ) {
      console.log('PASS: Test 18 - published_snapshots and public-feeds/project-public-assets stayed unchanged; representative project status stayed approved');
    } else {
      console.error('FAIL: Test 18 - Side effects detected');
      return false;
    }

    console.log('\n✔ All publication readiness runtime test cases passed.');
    return true;

  } finally {
    // TEST 19: CLEANUP
    console.log('--- TEST 19: Fixture Cleanup ---');
    let cleanupSuccess = true;
    for (const projId of createdProjectIds) {
      // Delete project (cascade removes previews, confirmations, correction requests, disciplines)
      const { error: delErr } = await client.from('projects').delete().eq('id', projId);
      if (delErr) {
        console.error(`❌ Cleanup error deleting project [${projId}]:`, delErr.message);
        cleanupSuccess = false;
      }
    }
    if (authenticatedUserId) {
      const { error } = await client.auth.admin.deleteUser(authenticatedUserId);
      if (error) {
        console.error('Cleanup error deleting authenticated boundary fixture:', error.message);
        cleanupSuccess = false;
      }
    }
    const { count: projectResidue } = await client.from('projects').select('id', { count: 'exact', head: true }).like('public_id', 'pub-readiness-%');
    const { count: previewResidue } = await client.from('participant_previews').select('id', { count: 'exact', head: true }).in('project_id', createdProjectIds);
    if (!cleanupSuccess || projectResidue !== 0 || previewResidue !== 0) {
      throw new Error(`Fixture cleanup residue detected: projects=${projectResidue}, previews=${previewResidue}`);
    }
    console.log('PASS: Test 19 - All synthetic projects and cascading preview/confirmation/correction/media/taxonomy fixtures cleaned up with zero residue.');
  }
}

async function main() {
  try {
    const success = await runPublicationReadinessRuntimeVerification();
    if (success) {
      console.log('\nOVERALL PUBLICATION READINESS RUNTIME VERIFICATION RESULT: PASS\n');
      process.exit(0);
    } else {
      console.log('\nOVERALL PUBLICATION READINESS RUNTIME VERIFICATION RESULT: FAIL\n');
      process.exit(1);
    }
  } catch (err: unknown) {
    console.error('❌ Fatal error in publication readiness verifier:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
