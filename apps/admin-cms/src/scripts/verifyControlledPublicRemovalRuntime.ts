import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { getPermissionsForRoles } from '../auth/permissions';
import { compilePublicFeed, compilePublicRemovalCandidateFeed } from '../feed/compilePublicFeed';
import { serializePublicFeedArtifact } from '../feed/serializePublicFeedArtifact';
import { isLoopbackUrl, parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';
import { executeControlledPublicRemoval, PublicRemovalFailurePoint } from '../projects/controlledPublicRemovalService';
import { createControlledPublicRemovalDependencies } from '../projects/createControlledPublicRemovalDependencies';
import { executeControlledPublication } from '../projects/controlledPublicationService';
import { createControlledPublicationDependencies } from '../projects/createControlledPublicationDependencies';
import { SupabaseParticipantPreviewRepositoryCore } from '../repositories/SupabaseParticipantPreviewRepositoryCore';
import { SupabaseProjectRepositoryCore } from '../repositories/SupabaseProjectRepositoryCore';
import { SupabasePublicationExecutionRepositoryCore } from '../repositories/SupabasePublicationExecutionRepositoryCore';
import { SupabasePublicRemovalRepositoryCore } from '../repositories/SupabasePublicRemovalRepositoryCore';

const FEED_BUCKET = 'public-feeds';
const FEED_PATH = 'capstones-latest.json';
const PRIVATE_BUCKET = 'project-drafts-private';
const PUBLIC_BUCKET = 'project-public-assets';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PDF = Buffer.from('%PDF-1.4\ncontrolled-removal\n%%EOF', 'ascii');

type Fixture = { id: string; publicId: string };

async function main(): Promise<void> {
  console.log('=== Controlled Public Removal Local Supabase Runtime Verification ===');
  const root = path.resolve(__dirname, '../../../..');
  const cli = path.join(root, 'node_modules/.bin/supabase');
  const raw = execSync(`"${cli}" status --workdir "${path.join(root, 'infra')}" -o env`, { cwd: root, encoding: 'utf8' });
  const env = parseSupabaseCliEnv(raw);
  assert(env.API_URL && env.SERVICE_ROLE_KEY && env.ANON_KEY && isLoopbackUrl(env.API_URL), 'Verifier requires loopback Local Supabase.');

  const db = createClient(env.API_URL, env.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const projects = new SupabaseProjectRepositoryCore(db);
  const previews = new SupabaseParticipantPreviewRepositoryCore(db);
  const publication = new SupabasePublicationExecutionRepositoryCore(db, env.API_URL);
  const removal = new SupabasePublicRemovalRepositoryCore(db, env.API_URL);
  const prefix = `removal-runtime-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const fixtures: Fixture[] = [];
  const privatePaths = new Set<string>();
  const publicPaths = new Set<string>();
  let temporaryAdminRole = false;

  const roleRows = (await db.from('user_roles').select('user_id,role')).data ?? [];
  const adminId = String(roleRows.find((row) => row.role === 'admin')?.user_id ?? '');
  const reviewerId = String(roleRows.find((row) => row.role === 'reviewer')?.user_id ?? '');
  assert(adminId && reviewerId, 'Synthetic admin and reviewer fixtures are required.');

  const download = async (bucket = FEED_BUCKET, objectPath = FEED_PATH): Promise<Buffer | null> => {
    const result = await db.storage.from(bucket).download(objectPath);
    if (result.error) {
      if (/not found|does not exist|404/i.test(result.error.message)) return null;
      throw result.error;
    }
    return result.data ? Buffer.from(await result.data.arrayBuffer()) : null;
  };
  const upload = async (bucket: string, objectPath: string, content: Buffer, contentType: string): Promise<void> => {
    const result = await db.storage.from(bucket).upload(objectPath, content, { contentType, upsert: true });
    if (result.error) throw result.error;
  };
  const originalFeed = await download();
  const baselinePublishedRows = (await db.from('projects').select('id').eq('status', 'published')).data ?? [];
  const baselineSnapshotResult = await db.from('published_snapshots').select('id').order('id');
  if (baselineSnapshotResult.error) throw baselineSnapshotResult.error;
  const baselineSnapshotIds = (baselineSnapshotResult.data ?? []).map((row) => String(row.id));
  const verifierSnapshotIds = new Set<string>();
  console.log(`Published snapshots baseline before verifier: ${baselineSnapshotIds.length}`);
  let baselineHidden = false;

  const scenario = async (number: number, name: string, run: () => Promise<void>): Promise<void> => {
    await run();
    console.log(`PASS: Scenario ${number} - ${name}`);
  };
  const createProject = async (tag: string, status: 'draft' | 'submitted' | 'in_review' | 'approved' | 'published' = 'published'): Promise<Fixture> => {
    const publicId = `${prefix}-${tag}`;
    const result = await db.from('projects').insert({
      public_id: publicId,
      slug: publicId,
      title: `Removal runtime ${tag}`,
      summary: 'Synthetic public summary.',
      background: 'Synthetic public background.',
      solution: 'Synthetic public solution.',
      year: 2026,
      program_name: 'Bachelor of Software Engineering',
      study_program: 'Bachelor of Software Engineering',
      discipline: 'Software Engineering',
      industry: 'Technology',
      group_name: 'Synthetic Group',
      team_members: ['Synthetic Member'],
      poster_url: `${env.API_URL}/storage/v1/object/public/${PUBLIC_BUCKET}/${publicId}/poster.png`,
      poster_pdf_url: `${env.API_URL}/storage/v1/object/public/${PUBLIC_BUCKET}/${publicId}/poster.pdf`,
      poster_text_public: 'Synthetic poster text.',
      accessibility_text_public: 'Synthetic accessibility text.',
      snapshots: [],
      external_links: [],
      citations: [],
      layout_config: {},
      status,
    }).select('id,public_id').single();
    if (result.error || !result.data) throw result.error ?? new Error('Project fixture creation failed.');
    const fixture = { id: String(result.data.id), publicId: String(result.data.public_id) };
    fixtures.push(fixture);
    return fixture;
  };
  const syncFeed = async (): Promise<Buffer> => {
    const artifact = serializePublicFeedArtifact(compilePublicFeed(await projects.listProjects()));
    const bytes = Buffer.from(artifact.content, 'utf8');
    await upload(FEED_BUCKET, FEED_PATH, bytes, 'application/json');
    return bytes;
  };
  const execute = (fixture: Fixture, actorId = adminId, role: 'admin' | 'reviewer' | 'editor' = 'admin', failurePoint?: PublicRemovalFailurePoint, barriers?: { afterReservation?(): Promise<void> }) => executeControlledPublicRemoval({
    permissions: getPermissionsForRoles([role]),
    publicId: fixture.publicId,
    archiveReason: `Archive ${fixture.publicId}`,
    dependencies: createControlledPublicRemovalDependencies({ supabase: db, supabaseUrl: env.API_URL!, publicId: fixture.publicId, adminId: actorId, feedBucket: FEED_BUCKET, feedPath: FEED_PATH }),
    failurePoint,
    barriers,
  });
  const publish = (fixture: Fixture, barriers?: { afterReservation?(): Promise<void> }) => executeControlledPublication({
    permissions: getPermissionsForRoles(['admin']),
    publicId: fixture.publicId,
    privateBucket: PRIVATE_BUCKET,
    publicAssetsBucket: PUBLIC_BUCKET,
    publicFeedBucket: FEED_BUCKET,
    publicFeedPath: FEED_PATH,
    dependencies: createControlledPublicationDependencies({ supabase: db, supabaseUrl: env.API_URL!, publicId: fixture.publicId, adminId, privateBucket: PRIVATE_BUCKET, publicFeedBucket: FEED_BUCKET, publicFeedPath: FEED_PATH }),
    barriers,
  });
  const attemptFor = async (fixture: Fixture) => {
    const result = await db.from('public_removal_attempts').select('*').eq('project_id', fixture.id).order('created_at', { ascending: false }).limit(1).single();
    if (result.error) throw result.error;
    return result.data;
  };
  const psql = (sql: string): string => execSync(`docker exec supabase_db_capstone-impact-platform psql -U postgres -d postgres -At -v ON_ERROR_STOP=1 -c "${sql}"`, { cwd: root, encoding: 'utf8' });
  const expire = (table: 'publication_attempts' | 'public_removal_attempts', id: string): void => {
    psql(`UPDATE public.${table} SET lease_expires_at = pg_catalog.now() - interval '1 hour' WHERE id = '${id}'::uuid;`);
  };
  const setBaselinePublishedVisibility = (visible: boolean): void => {
    if (!baselinePublishedRows.length) return;
    const ids = baselinePublishedRows.map((row) => `'${String(row.id)}'::uuid`).join(',');
    psql(`SET session_replication_role = replica; UPDATE public.projects SET status = '${visible ? 'published' : 'archived'}' WHERE id IN (${ids}); SET session_replication_role = origin;`);
    baselineHidden = !visible;
  };
  const failRemoval = async (result: Record<string, unknown>, code = 'RUNTIME_CLEANUP'): Promise<void> => {
    const failed = await removal.failAttempt(String(result.attemptId), String(result.executionToken), code);
    assert.equal(failed.resultCode, 'FAILED');
  };
  const makeReady = async (tag: string): Promise<{ fixture: Fixture; previewId: string; confirmedAt: string }> => {
    const fixture = await createProject(tag, 'approved');
    for (const asset of [
      { type: 'poster_image', file: 'poster.png', mime: 'image/png', bytes: PNG },
      { type: 'poster_pdf', file: 'poster.pdf', mime: 'application/pdf', bytes: PDF },
    ]) {
      const objectPath = `drafts/${fixture.publicId}/${asset.type}/${asset.file}`;
      privatePaths.add(objectPath);
      await upload(PRIVATE_BUCKET, objectPath, asset.bytes, asset.mime);
      const inserted = await db.from('media_assets').insert({ project_id: fixture.id, asset_type: asset.type, file_name: asset.file, storage_bucket: PRIVATE_BUCKET, storage_path: objectPath, public_url: null, mime_type: asset.mime, file_size_bytes: asset.bytes.length, is_public_approved: false });
      if (inserted.error) throw inserted.error;
    }
    const generated = await previews.generatePreview({ publicId: fixture.publicId, adminId, tokenHash: crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex'), privateBucket: PRIVATE_BUCKET });
    const token = await db.from('participant_previews').select('token_hash').eq('id', generated.previewId).single();
    if (token.error) throw token.error;
    const confirmed = await previews.confirmPreview(String(token.data.token_hash));
    assert(confirmed, 'Ready fixture confirmation failed.');
    return { fixture, previewId: generated.previewId, confirmedAt: confirmed.confirmedAt };
  };

  let primaryFailure: unknown = null;
  let cleanupFailure: unknown = null;
  let happyTarget: Fixture | null = null;
  try {
    const target = await createProject('happy-target');
    const other = await createProject('happy-other');
    happyTarget = target;
    const publicObject = `published/${target.publicId}/poster_image/poster.png`;
    const privateObject = `drafts/${target.publicId}/poster_pdf/source.pdf`;
    publicPaths.add(publicObject);
    privatePaths.add(privateObject);
    await upload(PUBLIC_BUCKET, publicObject, PNG, 'image/png');
    await upload(PRIVATE_BUCKET, privateObject, PDF, 'application/pdf');
    const mediaInsert = await db.from('media_assets').insert([
      { project_id: target.id, asset_type: 'poster_image', file_name: 'poster.png', storage_bucket: PUBLIC_BUCKET, storage_path: publicObject, public_storage_bucket: PUBLIC_BUCKET, public_storage_path: publicObject, public_url: `${env.API_URL}/storage/v1/object/public/${PUBLIC_BUCKET}/${publicObject}`, mime_type: 'image/png', file_size_bytes: PNG.length, is_public_approved: true },
      { project_id: target.id, asset_type: 'poster_pdf', file_name: 'source.pdf', storage_bucket: PRIVATE_BUCKET, storage_path: privateObject, public_url: null, mime_type: 'application/pdf', file_size_bytes: PDF.length, is_public_approved: false },
    ]);
    if (mediaInsert.error) throw mediaInsert.error;
    const mediaBefore = (await db.from('media_assets').select('*').eq('project_id', target.id).order('asset_type')).data;
    await syncFeed();

    const genericBefore = await db.from('projects').select('*').eq('id', target.id).single();
    const genericAuditCount = (await db.from('approval_records').select('id', { count: 'exact', head: true }).eq('project_id', target.id)).count ?? 0;
    const generic = await db.rpc('perform_project_review_action', { p_public_id: target.publicId, p_action: 'archive', p_comments: 'generic bypass', p_admin_id: adminId });
    const genericAfter = await db.from('projects').select('*').eq('id', target.id).single();
    const genericAuditAfter = (await db.from('approval_records').select('id', { count: 'exact', head: true }).eq('project_id', target.id)).count ?? 0;

    const completed = await execute(target);
    const archived = await db.from('projects').select('*').eq('id', target.id).single();
    const stored = await download();
    const authoritative = serializePublicFeedArtifact(compilePublicFeed(await projects.listProjects()));
    const audits = await db.from('approval_records').select('*').eq('project_id', target.id).eq('action_taken', 'archive');
    const mediaAfter = (await db.from('media_assets').select('*').eq('project_id', target.id).order('asset_type')).data;

    await scenario(1, 'published target archives successfully', async () => assert.equal(completed.resultCode, 'COMPLETED'));
    await scenario(2, 'target disappears from canonical feed', async () => assert(!stored?.toString('utf8').includes(`"publicId": "${target.publicId}"`)));
    await scenario(3, 'all other published records remain byte-correct', async () => assert(stored?.toString('utf8').includes(`"publicId": "${other.publicId}"`) && stored.toString('utf8') === authoritative.content));
    await scenario(4, 'project status is archived', async () => assert.equal(archived.data?.status, 'archived'));
    await scenario(5, 'archived_from_status records published', async () => assert.equal(archived.data?.archived_from_status, 'published'));
    await scenario(6, 'authoritative archived_at is set', async () => assert(Number.isFinite(Date.parse(String(archived.data?.archived_at)))));
    await scenario(7, 'exact bound archive reason persists', async () => assert.equal(archived.data?.archive_reason, `Archive ${target.publicId}`));
    await scenario(8, 'pending public removal remains true', async () => assert.equal(archived.data?.pending_removal_from_public, true));
    await scenario(9, 'public removal completion remains null', async () => assert.equal(archived.data?.public_removal_completed_at, null));
    await scenario(10, 'exactly one archive audit exists', async () => assert.equal(audits.data?.length, 1));
    await scenario(11, 'archive audit actor is exact admin', async () => assert.equal(audits.data?.[0].admin_id, adminId));
    await scenario(12, 'public media mappings remain unchanged', async () => assert.deepEqual(mediaAfter, mediaBefore));
    await scenario(13, 'public media object bytes remain unchanged', async () => assert((await download(PUBLIC_BUCKET, publicObject))?.equals(PNG)));
    await scenario(14, 'private media object bytes remain unchanged', async () => assert((await download(PRIVATE_BUCKET, privateObject))?.equals(PDF)));

    setBaselinePublishedVisibility(false);
    await syncFeed();
    const zero = await execute(other);
    await scenario(15, 'sole published target produces valid zero-record [] feed', async () => {
      assert.equal(zero.resultCode, 'COMPLETED');
      assert.equal((await download())?.toString('utf8'), '[]');
    });
    setBaselinePublishedVisibility(true);
    await syncFeed();

    const nonPublished = await createProject('not-published', 'approved');
    await scenario(16, 'non-published target is rejected with zero mutation', async () => {
      const before = await db.from('projects').select('*').eq('id', nonPublished.id).single();
      assert.equal((await execute(nonPublished)).resultCode, 'NOT_PUBLISHED');
      const after = await db.from('projects').select('*').eq('id', nonPublished.id).single();
      assert.deepEqual(after.data, before.data);
    });
    const reviewerDenied = await createProject('reviewer-denied');
    const editorDenied = await createProject('editor-denied');
    await syncFeed();
    await scenario(17, 'reviewer is denied before reservation', async () => assert.equal((await execute(reviewerDenied, reviewerId, 'reviewer')).resultCode, 'PERMISSION_DENIED'));
    await scenario(18, 'editor is denied before reservation', async () => assert.equal((await execute(editorDenied, reviewerId, 'editor')).resultCode, 'PERMISSION_DENIED'));

    const anon = createClient(env.API_URL!, env.ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
    await scenario(19, 'anon cannot execute removal RPC directly', async () => {
      const result = await anon.rpc('reserve_public_removal_attempt', { p_public_id: reviewerDenied.publicId, p_admin_id: adminId, p_archive_reason: 'Denied' });
      assert(result.error);
    });
    await scenario(20, 'authenticated non-service client cannot execute removal RPC directly', async () => {
      const credentials = JSON.parse(fs.readFileSync(path.join(root, 'apps/admin-cms/.local-users.json'), 'utf8')) as { users: Record<string, string> };
      const password = credentials.users['local.editor@capstone.test'];
      assert(password);
      const authenticated = createClient(env.API_URL!, env.ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
      const signIn = await authenticated.auth.signInWithPassword({ email: 'local.editor@capstone.test', password });
      assert(!signIn.error);
      const result = await authenticated.rpc('reserve_public_removal_attempt', { p_public_id: editorDenied.publicId, p_admin_id: adminId, p_archive_reason: 'Denied' });
      assert(result.error);
    });
    await scenario(21, 'completed retry is idempotent', async () => assert.equal((await execute(target)).resultCode, 'ALREADY_COMPLETED'));
    const laterB = await makeReady('later-controlled-b');
    publicPaths.add(`published/${laterB.fixture.publicId}/poster_image/poster.png`);
    publicPaths.add(`published/${laterB.fixture.publicId}/poster_pdf/poster.pdf`);
    const publishedB = await publish(laterB.fixture);
    if (publishedB.resultCode === 'COMPLETED') verifierSnapshotIds.add(publishedB.snapshotId);
    await scenario(22, 'archive A then controlled publish B then retry A uses current feed', async () => {
      assert.equal(publishedB.resultCode, 'COMPLETED');
      const retry = await execute(target);
      assert.equal(retry.resultCode, 'ALREADY_COMPLETED');
      assert((await download())?.toString('utf8').includes(laterB.fixture.publicId));
    });
    await scenario(23, 'generic published archive is blocked with zero mutation', async () => {
      assert.equal(generic.data?.resultCode, 'CONTROLLED_PUBLIC_REMOVAL_REQUIRED');
      assert.deepEqual(genericAfter.data, genericBefore.data);
      assert.equal(genericAuditAfter, genericAuditCount);
    });
    await scenario(24, 'normal non-public archive remains valid', async () => {
      const fixture = await createProject('normal-approved', 'approved');
      const result = await db.rpc('perform_project_review_action', { p_public_id: fixture.publicId, p_action: 'archive', p_comments: 'Normal archive', p_admin_id: adminId });
      assert.equal(result.error, null);
      const row = await db.from('projects').select('status').eq('id', fixture.id).single();
      assert.equal(row.data?.status, 'archived');
    });

    const diverged = await createProject('diverged');
    await syncFeed();
    const divergentBytes = Buffer.from('[]');
    await upload(FEED_BUCKET, FEED_PATH, divergentBytes, 'application/json');
    await scenario(25, 'current DB/feed divergence fails closed without overwrite', async () => {
      const result = await execute(diverged);
      assert.deepEqual(result, { resultCode: 'EXECUTION_FAILED', failureCode: 'CURRENT_FEED_DIVERGED' });
      assert((await download())?.equals(divergentBytes));
    });
    await syncFeed();

    const missing = await createProject('missing-target');
    await syncFeed();
    const missingArtifact = serializePublicFeedArtifact(compilePublicRemovalCandidateFeed(await projects.listProjects(), missing.publicId));
    await upload(FEED_BUCKET, FEED_PATH, Buffer.from(missingArtifact.content), 'application/json');
    await scenario(26, 'published target missing from stored feed fails closed', async () => {
      const result = await execute(missing);
      assert.deepEqual(result, { resultCode: 'EXECUTION_FAILED', failureCode: 'CURRENT_FEED_DIVERGED' });
      assert.equal((await download())?.toString('utf8'), missingArtifact.content);
    });
    await syncFeed();

    const recovery = await createProject('recovery');
    await syncFeed();
    let crashed = false;
    try { await execute(recovery, adminId, 'admin', 'after_feed_write'); } catch { crashed = true; }
    assert(crashed);
    const crashedAttempt = await attemptFor(recovery);
    expire('public_removal_attempts', String(crashedAttempt.id));
    const recovered = await execute(recovery);
    await scenario(27, 'expired same-owner attempt recovery completes', async () => assert.equal(recovered.resultCode, 'COMPLETED'));
    await scenario(30, 'crash after feed write recovers from durable artifact evidence', async () => {
      assert.equal(crashedAttempt.state, 'prepared');
      assert.equal((await attemptFor(recovery)).state, 'completed');
    });

    const owner = await createProject('owner-mismatch');
    await syncFeed();
    const ownerReserved = await removal.reserveAttempt(owner.publicId, adminId, `Archive ${owner.publicId}`);
    assert.equal(ownerReserved.resultCode, 'ATTEMPT_RESERVED');
    expire('public_removal_attempts', String(ownerReserved.attemptId));
    const addedRole = await db.from('user_roles').insert({ user_id: reviewerId, role: 'admin' });
    if (addedRole.error) throw addedRole.error;
    temporaryAdminRole = true;
    await scenario(28, 'different admin recovery is denied with zero mutation', async () => {
      const before = await db.from('projects').select('*').eq('id', owner.id).single();
      const result = await execute(owner, reviewerId, 'admin');
      assert.equal(result.resultCode, 'ATTEMPT_OWNER_MISMATCH');
      assert.deepEqual((await db.from('projects').select('*').eq('id', owner.id).single()).data, before.data);
    });
    await failRemoval(ownerReserved);
    await db.from('user_roles').delete().eq('user_id', reviewerId).eq('role', 'admin');
    temporaryAdminRole = false;

    const stale = await createProject('stale-token');
    await syncFeed();
    const staleReserved = await removal.reserveAttempt(stale.publicId, adminId, `Archive ${stale.publicId}`);
    assert.equal(staleReserved.resultCode, 'ATTEMPT_RESERVED');
    expire('public_removal_attempts', String(staleReserved.attemptId));
    const claimed = await removal.claimAttempt(stale.publicId, adminId);
    assert.equal(claimed.resultCode, 'ATTEMPT_CLAIMED');
    const currentProjects = await projects.listProjects();
    const currentArtifact = serializePublicFeedArtifact(compilePublicFeed(currentProjects));
    const staleCandidate = serializePublicFeedArtifact(compilePublicRemovalCandidateFeed(currentProjects, stale.publicId));
    await scenario(29, 'reclaim rotates token and stale token cannot invoke any mutation path', async () => {
      assert.notEqual(claimed.executionToken, staleReserved.executionToken);
      const assertRejectedWithoutMutation = async (invoke: () => Promise<Record<string, unknown>>) => {
        const attemptBefore = await attemptFor(stale);
        const projectBefore = await db.from('projects').select('*').eq('id', stale.id).single();
        const feedBefore = await download();
        const result = await invoke();
        assert.equal(result.resultCode, 'ATTEMPT_TOKEN_MISMATCH');
        assert.deepEqual(await attemptFor(stale), attemptBefore);
        assert.deepEqual((await db.from('projects').select('*').eq('id', stale.id).single()).data, projectBefore.data);
        assert.equal((await download())?.toString('base64') ?? null, feedBefore?.toString('base64') ?? null);
        return result.resultCode;
      };
      const oldAttemptId = String(staleReserved.attemptId);
      const oldToken = String(staleReserved.executionToken);
      const prepareCode = await assertRejectedWithoutMutation(() => removal.prepareAttempt({ attemptId: oldAttemptId, token: oldToken, count: staleCandidate.recordCount, hash: staleCandidate.feedHash, content: staleCandidate.content, bucket: FEED_BUCKET, path: FEED_PATH, publicUrl: removal.getPublicUrl(FEED_BUCKET, FEED_PATH), previous: currentArtifact.content }));
      const markCode = await assertRejectedWithoutMutation(() => removal.markStorageWritten(oldAttemptId, oldToken, staleCandidate.feedHash, staleCandidate.recordCount));
      const finalizeCode = await assertRejectedWithoutMutation(() => removal.finalizeAttempt(oldAttemptId, oldToken));
      const failCode = await assertRejectedWithoutMutation(() => removal.failAttempt(oldAttemptId, oldToken, 'STALE_TOKEN_MUST_NOT_MUTATE'));
      console.log(`Stale old-token results: prepare=${prepareCode}, mark-storage-written=${markCode}, finalize=${finalizeCode}, fail=${failCode}`);
    });
    await failRemoval({ ...staleReserved, executionToken: claimed.executionToken });

    const finalizeFailure = await createProject('finalize-failure');
    const beforeFailureFeed = await syncFeed();
    const failed = await execute(finalizeFailure, adminId, 'admin', 'before_finalize');
    await scenario(31, 'finalization failure restores exact previous feed bytes', async () => {
      assert.equal(failed.resultCode, 'EXECUTION_FAILED');
      assert((await download())?.equals(beforeFailureFeed));
      assert.equal((await attemptFor(finalizeFailure)).state, 'failed');
    });

    const ready = await makeReady('ready-publication');
    const compFailure = await createProject('compensation-failure');
    await syncFeed();
    const compResult = await execute(compFailure, adminId, 'admin', 'during_compensation');
    await scenario(32, 'compensation failure enters compensation_failed', async () => {
      assert('compensationFailureCode' in compResult);
      assert.equal(compResult.compensationFailureCode, 'COMPENSATION_FAILED');
      assert.equal((await attemptFor(compFailure)).state, 'compensation_failed');
    });
    const readiness = await previews.getPublicationReadiness({ publicId: ready.fixture.publicId, adminId, privateBucket: PRIVATE_BUCKET });
    assert(readiness.ready && readiness.confirmedPreviewId && readiness.confirmedAt);
    await scenario(33, 'compensation_failed removal blocks publication', async () => {
      const result = await publication.reserveAttempt({ publicId: ready.fixture.publicId, adminId, privateBucket: PRIVATE_BUCKET, confirmedPreviewId: readiness.confirmedPreviewId!, confirmedAt: readiness.confirmedAt! });
      assert.equal(result.resultCode, 'COMPENSATION_INCOMPLETE');
    });
    psql(`DELETE FROM public.public_removal_attempts WHERE project_id = '${compFailure.id}'::uuid;`);
    await syncFeed();

    const publicationBlocked = await publication.reserveAttempt({ publicId: ready.fixture.publicId, adminId, privateBucket: PRIVATE_BUCKET, confirmedPreviewId: readiness.confirmedPreviewId!, confirmedAt: readiness.confirmedAt! });
    assert.equal(publicationBlocked.resultCode, 'ATTEMPT_RESERVED');
    const publicationFailed = await publication.failAttempt(String(publicationBlocked.attemptId), String(publicationBlocked.executionToken), 'RUNTIME_FAILURE', 'COMPENSATION_FAILED');
    assert.equal(publicationFailed.resultCode, 'COMPENSATION_INCOMPLETE');
    const blockedRemoval = await createProject('blocked-by-publication');
    await syncFeed();
    await scenario(34, 'compensation_failed publication blocks removal', async () => {
      assert.equal((await removal.reserveAttempt(blockedRemoval.publicId, adminId, `Archive ${blockedRemoval.publicId}`)).resultCode, 'COMPENSATION_INCOMPLETE');
    });
    psql(`DELETE FROM public.publication_attempts WHERE project_id = '${ready.fixture.id}'::uuid;`);

    const raceRemoval = await createProject('publication-removal-race');
    publicPaths.add(`published/${ready.fixture.publicId}/poster_image/poster.png`);
    publicPaths.add(`published/${ready.fixture.publicId}/poster_pdf/poster.pdf`);
    await syncFeed();
    await scenario(35, 'full publication-vs-removal execution race has one durable winner', async () => {
      let releaseWinner!: () => void;
      let signalWinnerReserved!: () => void;
      const winnerReserved = new Promise<void>((resolve) => { signalWinnerReserved = resolve; });
      const winnerRelease = new Promise<void>((resolve) => { releaseWinner = resolve; });
      const sharedBarrier = { afterReservation: async () => { signalWinnerReserved(); await winnerRelease; } };
      const publicationExecution = publish(ready.fixture, sharedBarrier).then((result) => ({ operation: 'publication' as const, result }));
      const removalExecution = execute(raceRemoval, adminId, 'admin', undefined, sharedBarrier).then((result) => ({ operation: 'removal' as const, result }));

      await winnerReserved;
      const loser = await Promise.race([publicationExecution, removalExecution]);
      assert.equal(loser.result.resultCode, 'PUBLICATION_IN_PROGRESS');
      releaseWinner();
      const [publicationOutcome, removalOutcome] = await Promise.all([publicationExecution, removalExecution]);
      const publicationWon = publicationOutcome.result.resultCode === 'COMPLETED';
      const removalWon = removalOutcome.result.resultCode === 'COMPLETED';
      assert.notEqual(publicationWon, removalWon);
      assert.equal(publicationWon ? removalOutcome.result.resultCode : publicationOutcome.result.resultCode, 'PUBLICATION_IN_PROGRESS');
      if (publicationOutcome.result.resultCode === 'COMPLETED') verifierSnapshotIds.add(publicationOutcome.result.snapshotId);

      const raceRemovalRow = await db.from('projects').select('status').eq('id', raceRemoval.id).single();
      const readyRow = await db.from('projects').select('status').eq('id', ready.fixture.id).single();
      const stored = (await download())?.toString('utf8') ?? '';
      const authoritative = serializePublicFeedArtifact(compilePublicFeed(await projects.listProjects()));
      assert.equal(stored, authoritative.content);
      if (removalWon) {
        assert.equal(raceRemovalRow.data?.status, 'archived');
        assert.equal(readyRow.data?.status, 'approved');
        assert(!stored.includes(`"publicId": "${raceRemoval.publicId}"`));
        assert(!stored.includes(`"publicId": "${ready.fixture.publicId}"`));
        assert.equal(Number(psql(`SELECT count(*) FROM public.publication_attempts WHERE project_id = '${ready.fixture.id}'::uuid;`).trim()), 0);
      } else {
        assert.equal(raceRemovalRow.data?.status, 'published');
        assert.equal(readyRow.data?.status, 'published');
        assert(stored.includes(`"publicId": "${raceRemoval.publicId}"`));
        assert(stored.includes(`"publicId": "${ready.fixture.publicId}"`));
        assert.equal(Number(psql(`SELECT count(*) FROM public.public_removal_attempts WHERE project_id = '${raceRemoval.id}'::uuid;`).trim()), 0);
      }
      console.log(`Scenario 35 winner: ${removalWon ? 'removal' : 'publication'}; stored feed exactly matched authoritative serialization.`);
    });

    const raceA = await createProject('removal-race-a');
    const raceB = await createProject('removal-race-b');
    await syncFeed();
    await scenario(36, 'full removal-vs-removal race completes one winner then rebases loser retry', async () => {
      let releaseWinner!: () => void;
      let signalWinnerReserved!: () => void;
      const winnerReserved = new Promise<void>((resolve) => { signalWinnerReserved = resolve; });
      const winnerRelease = new Promise<void>((resolve) => { releaseWinner = resolve; });
      const sharedBarrier = { afterReservation: async () => { signalWinnerReserved(); await winnerRelease; } };
      const aExecution = execute(raceA, adminId, 'admin', undefined, sharedBarrier).then((result) => ({ fixture: raceA, result }));
      const bExecution = execute(raceB, adminId, 'admin', undefined, sharedBarrier).then((result) => ({ fixture: raceB, result }));

      await winnerReserved;
      const first = await Promise.race([aExecution, bExecution]);
      assert.equal(first.result.resultCode, 'PUBLICATION_IN_PROGRESS');
      releaseWinner();
      const [aOutcome, bOutcome] = await Promise.all([aExecution, bExecution]);
      const winner = aOutcome.result.resultCode === 'COMPLETED' ? aOutcome : bOutcome;
      const loser = winner.fixture.id === raceA.id ? bOutcome : aOutcome;
      assert.equal(winner.result.resultCode, 'COMPLETED');
      assert.equal(loser.result.resultCode, 'PUBLICATION_IN_PROGRESS');

      const winnerRow = await db.from('projects').select('status').eq('id', winner.fixture.id).single();
      const loserRow = await db.from('projects').select('status').eq('id', loser.fixture.id).single();
      const postWinnerStored = (await download())?.toString('utf8') ?? '';
      const postWinnerAuthoritative = serializePublicFeedArtifact(compilePublicFeed(await projects.listProjects()));
      assert.equal(winnerRow.data?.status, 'archived');
      assert.equal(loserRow.data?.status, 'published');
      assert.equal(postWinnerStored, postWinnerAuthoritative.content);
      assert(!postWinnerStored.includes(`"publicId": "${winner.fixture.publicId}"`));
      assert(postWinnerStored.includes(`"publicId": "${loser.fixture.publicId}"`));

      const loserRetry = await execute(loser.fixture);
      assert.equal(loserRetry.resultCode, 'COMPLETED');
      const finalRows = await db.from('projects').select('id,status').in('id', [raceA.id, raceB.id]);
      assert.equal(finalRows.data?.filter((row) => row.status === 'archived').length, 2);
      const finalStored = (await download())?.toString('utf8') ?? '';
      const finalAuthoritative = serializePublicFeedArtifact(compilePublicFeed(await projects.listProjects()));
      assert.equal(finalStored, finalAuthoritative.content);
      assert(!finalStored.includes(`"publicId": "${raceA.publicId}"`));
      assert(!finalStored.includes(`"publicId": "${raceB.publicId}"`));
      console.log(`Scenario 36 winner: ${winner.fixture.publicId}; loser retry result: ${loserRetry.resultCode}; both feeds matched authoritative serialization.`);
    });

    const barrierTarget = await createProject('reservation-barrier');
    const barrierBaseline = await syncFeed();
    let releaseBarrier!: () => void;
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    const release = new Promise<void>((resolve) => { releaseBarrier = resolve; });
    const barrierExecution = execute(barrierTarget, adminId, 'admin', undefined, { afterReservation: async () => { signalEntered(); await release; } });
    await entered;
    await scenario(37, 'deterministic barrier proves reservation precedes baseline observation', async () => {
      const attempt = await attemptFor(barrierTarget);
      assert.equal(attempt.state, 'reserved');
      assert((await download())?.equals(barrierBaseline));
      const blocked = await publication.reserveAttempt({ publicId: ready.fixture.publicId, adminId, privateBucket: PRIVATE_BUCKET, confirmedPreviewId: readiness.confirmedPreviewId!, confirmedAt: readiness.confirmedAt! });
      assert.equal(blocked.resultCode, 'PUBLICATION_IN_PROGRESS');
      releaseBarrier();
      assert.equal((await barrierExecution).resultCode, 'COMPLETED');
    });

    await scenario(38, 'final stored feed equals authoritative compilePublicFeed bytes', async () => {
      const expected = serializePublicFeedArtifact(compilePublicFeed(await projects.listProjects()));
      assert.equal((await download())?.toString('utf8'), expected.content);
    });
    await scenario(39, 'completed target remains absent from final canonical feed', async () => assert(!(await download())?.toString('utf8').includes(target.publicId)));
  } catch (error) {
    primaryFailure = error;
  } finally {
    try {
      if (baselineHidden) setBaselinePublishedVisibility(true);
      if (temporaryAdminRole) await db.from('user_roles').delete().eq('user_id', reviewerId).eq('role', 'admin');
      const ownedSnapshotResult = await db.from('publication_attempts').select('published_snapshot_id').like('public_id', `${prefix}%`).not('published_snapshot_id', 'is', null);
      if (ownedSnapshotResult.error) throw ownedSnapshotResult.error;
      for (const row of ownedSnapshotResult.data ?? []) verifierSnapshotIds.add(String(row.published_snapshot_id));
      console.log(`Verifier-created published snapshot IDs: ${[...verifierSnapshotIds].sort().join(', ') || 'none'}`);

      psql(`DELETE FROM public.public_removal_attempts WHERE public_id LIKE '${prefix}%';`);
      psql(`DELETE FROM public.publication_attempts WHERE public_id LIKE '${prefix}%';`);
      if (verifierSnapshotIds.size) {
        const deletedSnapshots = await db.from('published_snapshots').delete().in('id', [...verifierSnapshotIds]);
        if (deletedSnapshots.error) throw deletedSnapshots.error;
      }
      const ids = fixtures.map((fixture) => fixture.id);
      if (ids.length) {
        await db.from('approval_records').delete().in('project_id', ids);
        await db.from('media_assets').delete().in('project_id', ids);
        await db.from('projects').delete().in('id', ids);
      }
      if (privatePaths.size) await db.storage.from(PRIVATE_BUCKET).remove([...privatePaths]);
      if (publicPaths.size) await db.storage.from(PUBLIC_BUCKET).remove([...publicPaths]);
      if (originalFeed) await upload(FEED_BUCKET, FEED_PATH, originalFeed, 'application/json');
      else await db.storage.from(FEED_BUCKET).remove([FEED_PATH]);
      const projectCount = (await db.from('projects').select('id', { count: 'exact', head: true }).like('public_id', `${prefix}%`)).count ?? -1;
      const attemptCount = Number(psql(`SELECT count(*) FROM public.public_removal_attempts WHERE public_id LIKE '${prefix}%';`).trim());
      const publicationCount = Number(psql(`SELECT count(*) FROM public.publication_attempts WHERE public_id LIKE '${prefix}%';`).trim());
      const cleanupSnapshotResult = await db.from('published_snapshots').select('id').order('id');
      if (cleanupSnapshotResult.error) throw cleanupSnapshotResult.error;
      const cleanupSnapshotIds = (cleanupSnapshotResult.data ?? []).map((row) => String(row.id));
      assert.equal(projectCount, 0);
      assert.equal(attemptCount, 0);
      assert.equal(publicationCount, 0);
      assert.deepEqual(cleanupSnapshotIds, baselineSnapshotIds);
      assert([...verifierSnapshotIds].every((id) => !cleanupSnapshotIds.includes(id)));
      assert.equal((await download())?.toString('base64') ?? null, originalFeed?.toString('base64') ?? null);
      if (happyTarget) assert(!fixtures.some((fixture) => fixture.publicId === happyTarget?.publicId) || projectCount === 0);
      console.log(`Published snapshots cleanup result: exact baseline restored (${cleanupSnapshotIds.length}); no verifier snapshot residue remains.`);
      console.log('PASS: Scenario 40 - cleanup restored exact original DB/storage/feed baseline with zero verifier residue');
    } catch (error) {
      cleanupFailure = error;
    }
  }

  if (primaryFailure) throw primaryFailure;
  if (cleanupFailure) throw cleanupFailure;
  console.log('OVERALL CONTROLLED PUBLIC REMOVAL RUNTIME VERIFICATION RESULT: PASS');
}

main().catch((error) => {
  console.error('CONTROLLED PUBLIC REMOVAL VERIFIER FAILURE:', error instanceof Error ? error.message : String(error));
  console.error('OVERALL CONTROLLED PUBLIC REMOVAL RUNTIME VERIFICATION RESULT: FAIL');
  process.exit(1);
});
