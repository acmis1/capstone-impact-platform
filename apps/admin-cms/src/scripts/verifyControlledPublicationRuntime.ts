import crypto from 'node:crypto';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { getPermissionsForRoles } from '../auth/permissions';
import { compilePublicFeed } from '../feed/compilePublicFeed';
import { serializePublicFeedArtifact } from '../feed/serializePublicFeedArtifact';
import { isLoopbackUrl, parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';
import { executeControlledPublication, ControlledPublicationBarriers, ControlledPublicationFailurePoint } from '../projects/controlledPublicationService';
import { createControlledPublicationDependencies } from '../projects/createControlledPublicationDependencies';
import { planPublicationArtifact } from '../projects/publicationArtifact';
import { ReviewActionExecutionError } from '../repositories/ProjectRepository';
import { ParticipantPreviewExecutionError } from '../repositories/ParticipantPreviewRepository';
import { SupabaseParticipantPreviewRepositoryCore } from '../repositories/SupabaseParticipantPreviewRepositoryCore';
import { SupabaseProjectRepositoryCore } from '../repositories/SupabaseProjectRepositoryCore';
import { SupabasePublicationExecutionRepositoryCore } from '../repositories/SupabasePublicationExecutionRepositoryCore';

const PRIVATE_BUCKET = 'project-drafts-private';
const PUBLIC_ASSETS_BUCKET = 'project-public-assets';
const PUBLIC_FEED_BUCKET = 'public-feeds';
const PUBLIC_FEED_PATH = 'capstones-latest.json';
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF', 'ascii');

type Fixture = { id: string; publicId: string; previewId?: string; confirmedAt?: string };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function runControlledPublicationRuntimeVerification(): Promise<boolean> {
  console.log('=== Controlled Publication Local Supabase Runtime Verification ===');
  const root = path.resolve(__dirname, '../../../..');
  const cli = path.resolve(root, 'node_modules/.bin/supabase');
  const env = parseSupabaseCliEnv(execSync(`"${cli}" status --workdir "${path.resolve(root, 'infra')}" -o env`, { cwd: root, encoding: 'utf8' }));
  assert(env.API_URL && env.SERVICE_ROLE_KEY && env.ANON_KEY, 'Local Supabase credentials unavailable.');
  assert(isLoopbackUrl(env.API_URL), 'Controlled publication verifier refused a non-loopback Supabase endpoint.');

  const db = createClient(env.API_URL, env.SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const projects = new SupabaseProjectRepositoryCore(db);
  const previews = new SupabaseParticipantPreviewRepositoryCore(db);
  const publication = new SupabasePublicationExecutionRepositoryCore(db, env.API_URL);
  publication.assertDisposableLocalEnvironment();

  const prefix = `controlled-publication-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const fixtures: Fixture[] = [];
  const privatePaths = new Set<string>();
  const publicPaths = new Set<string>();
  const snapshotIds = new Set<string>();
  let secondAdminId = '';
  const roles = (await db.from('user_roles').select('user_id,role')).data ?? [];
  const adminId = String(roles.find((row) => row.role === 'admin')?.user_id ?? '');
  const reviewerId = String(roles.find((row) => row.role === 'reviewer')?.user_id ?? '');
  assert(adminId && reviewerId, 'Synthetic admin/reviewer fixtures unavailable.');

  const download = async (bucket: string, objectPath: string): Promise<Buffer | null> => {
    const result = await db.storage.from(bucket).download(objectPath);
    if (result.error) {
      if (/not found|does not exist|404/i.test(result.error.message)) return null;
      throw result.error;
    }
    return result.data ? Buffer.from(await result.data.arrayBuffer()) : null;
  };
  const listTree = async (bucket: string, folder = ''): Promise<string[]> => {
    const result = await db.storage.from(bucket).list(folder, { limit: 1000, sortBy: { column: 'name', order: 'asc' } });
    if (result.error) throw result.error;
    const found: string[] = [];
    for (const item of result.data ?? []) {
      const itemPath = `${folder}${folder ? '/' : ''}${item.name}`;
      if (item.id) found.push(itemPath);
      else found.push(...await listTree(bucket, itemPath));
    }
    return found.sort();
  };
  const publicAssetBaseline = JSON.stringify(await listTree(PUBLIC_ASSETS_BUCKET));
  const feedBaseline = await download(PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH);
  const databaseBaseline = {
    attempts: (await db.from('publication_attempts').select('id', { count: 'exact', head: true })).count ?? 0,
    snapshots: (await db.from('published_snapshots').select('id', { count: 'exact', head: true })).count ?? 0,
  };

  const scenario = async (number: number, name: string, run: () => Promise<void>) => {
    console.log(`Scenario ${number}: ${name}`);
    await run();
    console.log(`PASS: Scenario ${number}`);
  };
  const createProject = async (tag: string, status: 'approved' | 'published' | 'draft' = 'approved'): Promise<Fixture> => {
    const publicId = `${prefix}-${tag}`;
    const result = await db.from('projects').insert({
      public_id: publicId,
      title: `Controlled publication ${tag}`,
      slug: publicId,
      summary: 'Synthetic public summary.',
      background: 'Synthetic public background.',
      solution: 'Synthetic public solution.',
      year: 2026,
      program_name: 'Bachelor of Software Engineering',
      study_program: 'Bachelor of Software Engineering',
      discipline: 'Software Engineering',
      industry: 'Technology',
      industry_partner: 'Synthetic Partner',
      academic_supervisor: 'Synthetic Supervisor',
      group_name: 'Synthetic Group',
      team_members: ['Synthetic Member'],
      poster_url: status === 'published' ? `${env.API_URL}/storage/v1/object/public/${PUBLIC_ASSETS_BUCKET}/${publicId}/legacy.png` : '',
      poster_pdf_url: status === 'published' ? `${env.API_URL}/storage/v1/object/public/${PUBLIC_ASSETS_BUCKET}/${publicId}/legacy.pdf` : '',
      poster_text_public: 'Synthetic poster text.',
      accessibility_text_public: 'Synthetic accessible text.',
      snapshots: [],
      external_links: [],
      citations: [],
      layout_config: {},
      status,
    }).select('id,public_id').single();
    if (result.error || !result.data) throw new Error(`Project fixture failed: ${result.error?.message ?? 'missing row'}`);
    const fixture = { id: String(result.data.id), publicId: String(result.data.public_id) };
    fixtures.push(fixture);
    return fixture;
  };
  const makeReady = async (tag: string): Promise<Fixture> => {
    const fixture = await createProject(tag);
    const media = [
      { assetType: 'poster_image', fileName: 'poster.png', mimeType: 'image/png', bytes: PNG_BYTES },
      { assetType: 'poster_pdf', fileName: 'poster.pdf', mimeType: 'application/pdf', bytes: PDF_BYTES },
    ];
    for (const asset of media) {
      const sourcePath = `drafts/${fixture.publicId}/${asset.assetType}/${asset.fileName}`;
      const upload = await db.storage.from(PRIVATE_BUCKET).upload(sourcePath, asset.bytes, { contentType: asset.mimeType, upsert: false });
      if (upload.error) throw upload.error;
      privatePaths.add(sourcePath);
      const inserted = await db.from('media_assets').insert({
        project_id: fixture.id,
        asset_type: asset.assetType,
        file_name: asset.fileName,
        storage_bucket: PRIVATE_BUCKET,
        storage_path: sourcePath,
        public_url: null,
        mime_type: asset.mimeType,
        file_size_bytes: asset.bytes.length,
        is_public_approved: false,
      });
      if (inserted.error) throw inserted.error;
      publicPaths.add(`published/${fixture.publicId}/${asset.assetType}/${asset.fileName}`);
    }
    const generated = await previews.generatePreview({
      publicId: fixture.publicId,
      adminId,
      tokenHash: crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex'),
      privateBucket: PRIVATE_BUCKET,
    });
    const tokenRow = await db.from('participant_previews').select('token_hash').eq('id', generated.previewId).single();
    if (tokenRow.error) throw tokenRow.error;
    const confirmed = await previews.confirmPreview(String(tokenRow.data.token_hash));
    assert(confirmed, 'Participant preview confirmation failed.');
    fixture.previewId = generated.previewId;
    fixture.confirmedAt = confirmed.confirmedAt;
    return fixture;
  };
  const execute = (fixture: Fixture, role: 'admin' | 'reviewer' | 'editor' = 'admin', failurePoint?: ControlledPublicationFailurePoint, barriers?: ControlledPublicationBarriers) => {
    const baseDependencies = createControlledPublicationDependencies({ supabase: db, supabaseUrl: env.API_URL!, publicId: fixture.publicId, adminId, privateBucket: PRIVATE_BUCKET, publicFeedBucket: PUBLIC_FEED_BUCKET, publicFeedPath: PUBLIC_FEED_PATH });
    const dependencies = new Proxy(baseDependencies, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== 'function' || property === 'assertDisposableLocalEnvironment' || property === 'getPublicUrl') return value;
        return async (...args: unknown[]) => {
          try { return await value(...args); }
          catch (error) {
            console.error(`DEPENDENCY FAILURE (${String(property)}):`, error instanceof Error ? error.message : String(error));
            throw error;
          }
        };
      },
    });
    return executeControlledPublication({
      permissions: getPermissionsForRoles([role]),
      publicId: fixture.publicId,
      privateBucket: PRIVATE_BUCKET,
      publicAssetsBucket: PUBLIC_ASSETS_BUCKET,
      publicFeedBucket: PUBLIC_FEED_BUCKET,
      publicFeedPath: PUBLIC_FEED_PATH,
      dependencies,
      failurePoint,
      barriers,
    });
  };
  const attemptFor = async (fixture: Fixture) => {
    const result = await db.from('publication_attempts').select('*').eq('project_id', fixture.id).order('created_at', { ascending: false }).limit(1).single();
    if (result.error) throw result.error;
    if (result.data.published_snapshot_id) snapshotIds.add(String(result.data.published_snapshot_id));
    return result.data;
  };
  const psql = (sql: string) => execSync(
    `docker exec supabase_db_capstone-impact-platform psql -U postgres -d postgres -At -v ON_ERROR_STOP=1 -c "${sql}"`,
    { cwd: root, encoding: 'utf8' },
  );
  // Local-only fixture manipulation: an expired lease is otherwise unreachable in a bounded run.
  const expireLease = (attemptId: string) => psql(
    `UPDATE public.publication_attempts SET lease_expires_at = pg_catalog.now() - interval '1 hour' WHERE id = '${attemptId}'::uuid;`,
  );
  const attemptById = async (attemptId: string) => {
    const result = await db.from('publication_attempts').select('*').eq('id', attemptId).single();
    if (result.error) throw result.error;
    if (result.data.published_snapshot_id) snapshotIds.add(String(result.data.published_snapshot_id));
    return result.data;
  };
  const reserveFor = async (fixture: Fixture, actorId = adminId) => {
    const readiness = await previews.getPublicationReadiness({ publicId: fixture.publicId, adminId, privateBucket: PRIVATE_BUCKET });
    assert(readiness.ready && readiness.confirmedPreviewId && readiness.confirmedAt, `Fixture ${fixture.publicId} was not ready.`);
    return publication.reserveAttempt({
      publicId: fixture.publicId,
      adminId: actorId,
      privateBucket: PRIVATE_BUCKET,
      confirmedPreviewId: readiness.confirmedPreviewId,
      confirmedAt: readiness.confirmedAt,
    });
  };
  const count = async (table: string, column: string, value: string) => {
    const result = await db.from(table).select('id', { count: 'exact', head: true }).eq(column, value);
    if (result.error) throw result.error;
    return result.count ?? 0;
  };
  const restoreFeed = async () => {
    if (feedBaseline === null) await db.storage.from(PUBLIC_FEED_BUCKET).remove([PUBLIC_FEED_PATH]);
    else {
      const restored = await db.storage.from(PUBLIC_FEED_BUCKET).upload(PUBLIC_FEED_PATH, feedBaseline, { contentType: 'application/json', upsert: true });
      if (restored.error) throw restored.error;
    }
  };

  let primaryFailure: unknown = null;
  let cleanupFailure: unknown = null;
  try {
    const publishedBefore = ((await db.from('projects').select('public_id').eq('status', 'published')).data ?? []).map((row) => String(row.public_id));
    const baseline = await createProject('published-baseline', 'published');
    const unrelated = await createProject('unrelated-draft', 'draft');
    const target = await makeReady('success');
    const preProjects = await projects.listProjects();
    const targetMedia = await publication.listProjectMedia(target.publicId);
    const planned = planPublicationArtifact({ projects: preProjects, targetPublicId: target.publicId, mediaAssets: targetMedia, privateBucket: PRIVATE_BUCKET, publicBucket: PUBLIC_ASSETS_BUCKET, getPublicUrl: (bucket, objectPath) => publication.getPublicUrl(bucket, objectPath) });
    const successful = await execute(target);

    await scenario(1, 'READY admin target begins a durable attempt', async () => {
      assert(successful.resultCode === 'COMPLETED', `Execution did not complete: ${JSON.stringify(successful)}`);
      const row = await attemptFor(target);
      assert(row.state === 'completed', 'Attempt was not durably completed.');
    });
    await scenario(2, 'exact participant confirmation evidence is bound', async () => {
      const row = await attemptFor(target);
      assert(row.confirmed_preview_id === target.previewId && Date.parse(row.confirmed_at) === Date.parse(target.confirmedAt!), 'Attempt evidence differs from the authoritative confirmation.');
    });
    await scenario(3, 'published baseline and approved target membership are exact', async () => {
      const expected = [...new Set([...publishedBefore, baseline.publicId, target.publicId])].sort();
      assert(JSON.stringify(planned.feed.map((record) => record.publicId).sort()) === JSON.stringify(expected), 'Candidate membership is not exact.');
    });
    await scenario(4, 'unrelated non-public project is excluded', async () => {
      assert(!planned.feed.some((record) => record.publicId === unrelated.publicId), 'Unrelated draft leaked into the feed.');
    });
    await scenario(5, 'candidate record count and SHA-256 are exact', async () => {
      assert(successful.resultCode === 'COMPLETED' && successful.recordCount === planned.recordCount && successful.feedHash === planned.feedHash, 'Execution evidence differs from canonical artifact evidence.');
    });
    await scenario(6, 'private media is promoted to deterministic public paths', async () => {
      for (const promotion of planned.mediaPromotions) assert((await download(promotion.publicBucket, promotion.publicPath)) !== null, `Missing promoted media ${promotion.publicPath}`);
    });
    await scenario(7, 'private source media remains byte-for-byte preserved', async () => {
      for (const promotion of planned.mediaPromotions) {
        const source = await download(promotion.sourceBucket, promotion.sourcePath);
        const expected = promotion.assetType === 'poster_pdf' ? PDF_BYTES : PNG_BYTES;
        assert(source?.equals(expected), `Private source changed: ${promotion.sourcePath}`);
      }
    });
    await scenario(8, 'public feed contains no private bucket or draft path', async () => {
      const stored = await download(PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH);
      assert(stored && !stored.toString('utf8').includes(PRIVATE_BUCKET) && !stored.toString('utf8').includes('/drafts/'), 'Private media reference leaked.');
    });
    await scenario(9, 'uploaded public feed retrieves with exact bytes and hash', async () => {
      const stored = await download(PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH);
      assert(stored?.toString('utf8') === planned.content && serializePublicFeedArtifact(JSON.parse(stored.toString('utf8'))).feedHash === planned.feedHash, 'Stored feed verification failed.');
    });
    await scenario(10, 'finalization changes only the target to published', async () => {
      const rows = await db.from('projects').select('public_id,status').in('id', [target.id, baseline.id, unrelated.id]);
      assert(!rows.error && rows.data?.find((row) => row.public_id === target.publicId)?.status === 'published' && rows.data?.find((row) => row.public_id === baseline.publicId)?.status === 'published' && rows.data?.find((row) => row.public_id === unrelated.publicId)?.status === 'draft', 'Project state convergence failed.');
    });
    await scenario(11, 'one publish audit row has exact actor and transition', async () => {
      const result = await db.from('approval_records').select('*').eq('project_id', target.id).eq('action_taken', 'publish');
      assert(!result.error && result.data?.length === 1 && result.data[0].admin_id === adminId && result.data[0].from_status === 'approved' && result.data[0].to_status === 'published', 'Publish audit semantics are incorrect.');
    });
    await scenario(12, 'one snapshot has exact storage and artifact evidence', async () => {
      const row = await attemptFor(target);
      const result = await db.from('published_snapshots').select('*').eq('id', row.published_snapshot_id).single();
      assert(!result.error && Number(result.data.record_count) === planned.recordCount && result.data.feed_hash === planned.feedHash && result.data.storage_bucket === PUBLIC_FEED_BUCKET && result.data.storage_path === `${PUBLIC_FEED_BUCKET}/${PUBLIC_FEED_PATH}` && result.data.created_by === adminId, `Published snapshot evidence is incorrect: ${JSON.stringify(result.data)}`);
    });
    await scenario(13, 'completed attempt is bound to its snapshot and audit record', async () => {
      const row = await attemptFor(target);
      assert(row.state === 'completed' && row.published_snapshot_id && row.publish_audit_record_id, 'Completed attempt lacks finalization bindings.');
    });
    await scenario(14, 'ordinary published feed compilation reproduces stored bytes', async () => {
      const ordinary = serializePublicFeedArtifact(compilePublicFeed(await projects.listProjects()));
      assert(ordinary.content === (await download(PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH))?.toString('utf8') && ordinary.feedHash === planned.feedHash, 'Database and storage do not converge.');
    });

    const reviewerTarget = await makeReady('reviewer-denied');
    const editorTarget = await makeReady('editor-denied');
    await scenario(15, 'reviewer is denied with zero publication side effects', async () => {
      assert((await execute(reviewerTarget, 'reviewer')).resultCode === 'PERMISSION_DENIED' && await count('publication_attempts', 'project_id', reviewerTarget.id) === 0, 'Reviewer created publication state.');
    });
    await scenario(16, 'editor is denied with zero publication side effects', async () => {
      assert((await execute(editorTarget, 'editor')).resultCode === 'PERMISSION_DENIED' && await count('publication_attempts', 'project_id', editorTarget.id) === 0, 'Editor created publication state.');
    });
    const notReady = await createProject('not-ready');
    await scenario(17, 'NOT_READY target creates no publication side effects', async () => {
      const before = await download(PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH);
      const result = await execute(notReady);
      assert(result.resultCode === 'NOT_READY' && await count('publication_attempts', 'project_id', notReady.id) === 0 && (await download(PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH))?.equals(before!), 'NOT_READY execution changed state.');
    });

    const stale = await makeReady('stale-evidence');
    await scenario(18, 'stale confirmation evidence is rejected by the DB reservation boundary', async () => {
      const readiness = await previews.getPublicationReadiness({ publicId: stale.publicId, adminId, privateBucket: PRIVATE_BUCKET });
      assert(readiness.ready && readiness.confirmedPreviewId && readiness.confirmedAt, 'Stale fixture was not ready.');
      const result = await publication.reserveAttempt({ publicId: stale.publicId, adminId, privateBucket: PRIVATE_BUCKET, confirmedPreviewId: readiness.confirmedPreviewId, confirmedAt: '2000-01-01T00:00:00.000Z' });
      assert(result.resultCode === 'STALE_EVIDENCE' && await count('publication_attempts', 'project_id', stale.id) === 0, 'Stale evidence created an attempt.');
    });

    // A bare reservation already freezes the target: no artifact has been bound yet.
    const frozen = await makeReady('frozen');
    const frozenBegin = await reserveFor(frozen);
    assert(frozenBegin.resultCode === 'ATTEMPT_RESERVED', `Could not establish active frozen reservation: ${JSON.stringify(frozenBegin)}`);
    await scenario(19, 'Request changes cannot invalidate an active target', async () => {
      let code = '';
      try { await projects.performReviewAction({ publicId: frozen.publicId, action: 'request_changes', adminId: reviewerId }); } catch (error) { code = error instanceof ReviewActionExecutionError ? error.code : ''; }
      assert(code === 'PUBLICATION_IN_PROGRESS' && (await db.from('projects').select('status').eq('id', frozen.id).single()).data?.status === 'approved', 'Request changes bypassed publication freeze.');
    });
    await scenario(20, 'preview revocation cannot invalidate an active target', async () => {
      let code = '';
      try { await previews.revokePreview({ publicId: frozen.publicId, adminId }); } catch (error) { code = error instanceof ParticipantPreviewExecutionError ? error.code : ''; }
      assert(code === 'PUBLICATION_IN_PROGRESS' && (await db.from('participant_previews').select('status').eq('id', frozen.previewId!).single()).data?.status === 'active', 'Preview revocation bypassed publication freeze.');
    });
    await publication.failAttempt(String(frozenBegin.attemptId), String(frozenBegin.executionToken), 'VERIFIER_RELEASE');

    const same = await makeReady('concurrent-same');
    await scenario(21, 'concurrent same-target requests converge to one publication', async () => {
      const results = await Promise.all([execute(same), execute(same)]);
      assert(results.filter((result) => result.resultCode === 'COMPLETED').length === 1 && results.some((result) => result.resultCode === 'PUBLICATION_IN_PROGRESS') && await count('publication_attempts', 'project_id', same.id) === 1 && await count('approval_records', 'project_id', same.id) === 1, `Same-target convergence failed: ${JSON.stringify(results)}`);
      await attemptFor(same);
    });
    const differentA = await makeReady('concurrent-a');
    const differentB = await makeReady('concurrent-b');
    await scenario(22, 'different-target requests are globally serialized', async () => {
      const results = await Promise.all([execute(differentA), execute(differentB)]);
      assert(results.filter((result) => result.resultCode === 'COMPLETED').length === 1 && results.some((result) => result.resultCode === 'PUBLICATION_IN_PROGRESS') && await count('publication_attempts', 'project_id', differentA.id) + await count('publication_attempts', 'project_id', differentB.id) === 1, `Global serialization failed: ${JSON.stringify(results)}`);
      if (results[0].resultCode === 'COMPLETED') await attemptFor(differentA); else await attemptFor(differentB);
    });

    const failures = await makeReady('failures');
    await scenario(23, 'media and pre-feed failures leave DB and public feed unchanged', async () => {
      const before = await download(PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH);
      const first = await execute(failures, 'admin', 'during_media_upload');
      const second = await execute(failures, 'admin', 'before_feed_upload');
      const project = await db.from('projects').select('status').eq('id', failures.id).single();
      assert(first.resultCode === 'EXECUTION_FAILED' && second.resultCode === 'EXECUTION_FAILED' && project.data?.status === 'approved' && (await download(PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH))?.equals(before!), 'Pre-feed failure was not clean.');
    });
    await scenario(24, 'post-upload failure restores prior feed and removes new media', async () => {
      const before = await download(PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH);
      const result = await execute(failures, 'admin', 'after_feed_verification');
      const mediaAfter = await Promise.all([...publicPaths].filter((item) => item.includes(failures.publicId)).map((item) => download(PUBLIC_ASSETS_BUCKET, item)));
      assert(result.resultCode === 'EXECUTION_FAILED' && (await download(PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH))?.equals(before!) && mediaAfter.every((item) => item === null), 'Post-upload compensation failed.');
    });
    await scenario(25, 'retry after compensated failure succeeds', async () => {
      const result = await execute(failures);
      assert(result.resultCode === 'COMPLETED', `Retry did not complete: ${result.resultCode}`);
      await attemptFor(failures);
    });
    await scenario(26, 'exact retry creates no duplicate audit, snapshot, attempt, or media', async () => {
      const before = await download(PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH);
      const result = await execute(failures);
      assert(result.resultCode === 'ALREADY_COMPLETED' && await count('approval_records', 'project_id', failures.id) === 1 && await count('publication_attempts', 'project_id', failures.id) === 4 && (await download(PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH))?.equals(before!), 'Exact retry duplicated successful state.');
    });
    await scenario(27, 'anon and authenticated non-service clients cannot call publication RPCs', async () => {
      const anon = createClient(env.API_URL!, env.ANON_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
      const credentials = JSON.parse(fs.readFileSync(path.join(root, 'apps/admin-cms/.local-users.json'), 'utf8')) as { users: Record<string, string> };
      const authenticated = createClient(env.API_URL!, env.ANON_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
      const signIn = await authenticated.auth.signInWithPassword({ email: 'local.editor@capstone.test', password: credentials.users['local.editor@capstone.test'] });
      assert(!signIn.error, 'Could not create authenticated non-service session.');
      const args = { p_public_id: failures.publicId, p_admin_id: adminId, p_private_bucket: PRIVATE_BUCKET, p_confirmed_preview_id: failures.previewId, p_confirmed_at: failures.confirmedAt };
      const [a, b] = await Promise.all([anon.rpc('reserve_publication_attempt', args), authenticated.rpc('reserve_publication_attempt', args)]);
      const prepareArgs = { p_attempt_id: '11111111-1111-4111-8111-111111111111', p_execution_token: '11111111-1111-4111-8111-111111111111', p_private_bucket: PRIVATE_BUCKET, p_candidate_record_count: 1, p_candidate_feed_hash: '0'.repeat(64), p_candidate_feed_content: '[]', p_feed_storage_bucket: PUBLIC_FEED_BUCKET, p_feed_storage_path: PUBLIC_FEED_PATH, p_feed_public_url: publication.getPublicUrl(PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH), p_previous_feed_existed: false, p_previous_feed_content: null, p_media_manifest: [] };
      const [c, d] = await Promise.all([anon.rpc('prepare_publication_attempt', prepareArgs), authenticated.rpc('prepare_publication_attempt', prepareArgs)]);
      assert([a, b, c, d].every((result) => Boolean(result.error)), 'A non-service client executed publication RPC.');
    });
    await scenario(28, 'success changes public storage only at deterministic verifier paths', async () => {
      const additions = (await listTree(PUBLIC_ASSETS_BUCKET)).filter((item) => !JSON.parse(publicAssetBaseline).includes(item));
      assert(additions.every((item) => publicPaths.has(item)) && additions.length > 0, `Unexpected public asset changes: ${additions.join(',')}`);
    });
    // --- Reservation-before-baseline, historical retry, recovery and crash-safety hardening ---

    const raceA = await makeReady('race-a');
    const raceB = await makeReady('race-b');
    let snapshotAAfterPublish: Record<string, unknown> | null = null;
    let feedAfterA = '';

    await scenario(29, 'global reservation precedes every global baseline read under a real barrier', async () => {
      let releaseA: () => void = () => {};
      let signalReserved: () => void = () => {};
      const reserved = new Promise<void>((resolve) => { signalReserved = resolve; });
      const gate = new Promise<void>((resolve) => { releaseA = resolve; });
      // A is paused after it owns the reservation and before it observes any global baseline.
      const aRun = execute(raceA, 'admin', undefined, { afterReservation: async () => { signalReserved(); await gate; } });
      await reserved;

      const feedBefore = await download(PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH);
      const blocked = await execute(raceB);
      const blockedMedia = await Promise.all([...publicPaths].filter((item) => item.includes(raceB.publicId)).map((item) => download(PUBLIC_ASSETS_BUCKET, item)));
      const feedDuringBlock = await download(PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH);
      assert(blocked.resultCode === 'PUBLICATION_IN_PROGRESS', `Concurrent execution was not blocked at the reservation boundary: ${JSON.stringify(blocked)}`);
      assert(await count('publication_attempts', 'project_id', raceB.id) === 0, 'Blocked execution created a publication attempt.');
      assert(blockedMedia.every((item) => item === null), 'Blocked execution created public media.');
      assert((await db.from('projects').select('status').eq('id', raceB.id).single()).data?.status === 'approved', 'Blocked execution changed project state.');
      assert((feedBefore === null && feedDuringBlock === null) || (feedBefore !== null && feedDuringBlock?.equals(feedBefore)), 'Blocked execution changed the canonical feed.');

      releaseA();
      const aResult = await aRun;
      assert(aResult.resultCode === 'COMPLETED', `Barrier-held execution did not complete: ${JSON.stringify(aResult)}`);
      feedAfterA = (await download(PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH))!.toString('utf8');
      const attemptA = await attemptFor(raceA);
      snapshotAAfterPublish = (await db.from('published_snapshots').select('*').eq('id', attemptA.published_snapshot_id).single()).data;

      const bResult = await execute(raceB);
      assert(bResult.resultCode === 'COMPLETED', `Second execution did not complete after the slot was released: ${JSON.stringify(bResult)}`);
      const attemptB = await attemptFor(raceB);
      const candidateB = JSON.parse(String(attemptB.candidate_feed_content)) as { publicId: string }[];
      assert(candidateB.some((record) => record.publicId === raceA.publicId), 'Later candidate omitted the publication that completed first.');
      // Previous-feed evidence was necessarily captured after this attempt owned the slot.
      assert(String(attemptB.previous_feed_content) === feedAfterA, 'Bound previous feed did not equal the feed current at artifact-binding time.');
      const ordinary = serializePublicFeedArtifact(compilePublicFeed(await projects.listProjects()));
      assert(ordinary.content === (await download(PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH))?.toString('utf8'), 'Database and canonical feed did not converge after serialized publications.');
    });

    const durableState = async () => JSON.stringify({
      feed: (await download(PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH))?.toString('utf8') ?? null,
      statuses: (await db.from('projects').select('public_id,status').in('id', [raceA.id, raceB.id]).order('public_id')).data,
      attemptsA: await count('publication_attempts', 'project_id', raceA.id),
      auditsA: await count('approval_records', 'project_id', raceA.id),
      mediaA: (await db.from('media_assets').select('id,public_url,public_storage_bucket,public_storage_path,is_public_approved').eq('project_id', raceA.id).order('id')).data,
      snapshots: (await db.from('published_snapshots').select('id', { count: 'exact', head: true })).count ?? 0,
      assets: await listTree(PUBLIC_ASSETS_BUCKET),
    });

    await scenario(30, 'retrying an already-published target after a later publication is ALREADY_COMPLETED', async () => {
      const attemptABefore = await attemptFor(raceA);
      const before = await durableState();
      const retry = await execute(raceA);
      const after = await durableState();
      assert(retry.resultCode === 'ALREADY_COMPLETED', `Historical retry did not return ALREADY_COMPLETED: ${JSON.stringify(retry)}`);
      assert(before === after, 'Historical retry changed durable database or storage state.');
      assert(retry.attemptId === String(attemptABefore.id) && retry.feedHash === String(attemptABefore.candidate_feed_hash), 'Historical retry reported the wrong publication event evidence.');
      const currentFeed = (await download(PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH))!.toString('utf8');
      const parsed = JSON.parse(currentFeed) as { publicId: string }[];
      assert(parsed.some((record) => record.publicId === raceB.publicId), 'Later publication disappeared from the canonical feed.');
      // The historical artifact is event evidence, not today's expected global feed.
      assert(currentFeed !== String(attemptABefore.candidate_feed_content), 'Test premise failed: the canonical feed did not evolve past the historical artifact.');
      const ordinary = serializePublicFeedArtifact(compilePublicFeed(await projects.listProjects()));
      assert(ordinary.content === currentFeed, 'Current database state does not compile to the current canonical feed.');
    });

    const secondAdmin = await db.from('admin_users').insert({ email: `${prefix}-second-admin@capstone.test`, full_name: 'Synthetic Second Admin' }).select('id').single();
    if (secondAdmin.error || !secondAdmin.data) throw new Error(`Second admin fixture failed: ${secondAdmin.error?.message ?? 'missing row'}`);
    secondAdminId = String(secondAdmin.data.id);
    const secondRole = await db.from('user_roles').insert({ user_id: secondAdminId, role: 'admin' });
    if (secondRole.error) throw secondRole.error;
    assert(secondAdminId !== adminId, 'Second admin fixture is not a distinct identity.');

    const recovery = await makeReady('recovery-owner');
    const recoveryReservation = await reserveFor(recovery);
    assert(recoveryReservation.resultCode === 'ATTEMPT_RESERVED', `Recovery fixture could not reserve: ${JSON.stringify(recoveryReservation)}`);
    const recoveryAttemptId = String(recoveryReservation.attemptId);
    const recoveryTokenOne = String(recoveryReservation.executionToken);

    await scenario(31, 'an expired attempt cannot be reclaimed by a different admin', async () => {
      expireLease(recoveryAttemptId);
      const before = await attemptById(recoveryAttemptId);
      const wrongOwner = await publication.claimAttempt(recovery.publicId, secondAdminId);
      const after = await attemptById(recoveryAttemptId);
      assert(wrongOwner.resultCode === 'ATTEMPT_OWNER_MISMATCH', `Cross-admin recovery was not refused: ${JSON.stringify(wrongOwner)}`);
      assert(wrongOwner.executionToken === undefined && wrongOwner.attemptId === undefined, 'Refused recovery exposed attempt detail.');
      assert(String(after.execution_token) === String(before.execution_token), 'Refused recovery rotated the execution token.');
      assert(String(after.lease_expires_at) === String(before.lease_expires_at), 'Refused recovery changed the lease.');
      assert(String(after.state) === String(before.state) && String(after.updated_at) === String(before.updated_at), 'Refused recovery mutated the attempt.');
      assert(String(after.admin_id) === adminId, 'Refused recovery changed attempt ownership.');
    });

    await scenario(32, 'the original admin recovers the same attempt and keeps durable attribution', async () => {
      const claimed = await publication.claimAttempt(recovery.publicId, adminId);
      assert(claimed.resultCode === 'ATTEMPT_CLAIMED', `Owner recovery failed: ${JSON.stringify(claimed)}`);
      assert(String(claimed.attemptId) === recoveryAttemptId, 'Owner recovery targeted a different attempt.');
      assert(String(claimed.executionToken) !== recoveryTokenOne, 'Owner recovery did not rotate the execution token.');
      assert(String((await attemptById(recoveryAttemptId)).admin_id) === adminId, 'Owner recovery changed attempt ownership.');

      // Resume the still-exclusive reservation to completion through the coordinator.
      expireLease(recoveryAttemptId);
      const completed = await execute(recovery);
      assert(completed.resultCode === 'COMPLETED', `Recovered reservation did not complete: ${JSON.stringify(completed)}`);
      assert(await count('publication_attempts', 'project_id', recovery.id) === 1, 'Recovery created an additional attempt instead of resuming.');
      const finalRow = await attemptById(recoveryAttemptId);
      assert(String(finalRow.state) === 'completed' && String(finalRow.admin_id) === adminId, 'Recovered attempt lost its original owner.');
      const audit = await db.from('approval_records').select('admin_id').eq('project_id', recovery.id).eq('action_taken', 'publish');
      assert(!audit.error && audit.data?.length === 1 && String(audit.data[0].admin_id) === adminId, 'Publish audit was not attributed to the original admin.');
      const snapshot = await db.from('published_snapshots').select('created_by').eq('id', finalRow.published_snapshot_id).single();
      assert(!snapshot.error && String(snapshot.data.created_by) === adminId, 'Published snapshot was not attributed to the original admin.');
    });

    await scenario(33, 'an execution token invalidated by reclaim can no longer mutate the attempt', async () => {
      const tokenFixture = await makeReady('stale-token');
      const reservation = await reserveFor(tokenFixture);
      assert(reservation.resultCode === 'ATTEMPT_RESERVED', `Stale-token fixture could not reserve: ${JSON.stringify(reservation)}`);
      const attemptId = String(reservation.attemptId);
      const tokenOne = String(reservation.executionToken);
      expireLease(attemptId);
      const reclaim = await publication.claimAttempt(tokenFixture.publicId, adminId);
      const tokenTwo = String(reclaim.executionToken);
      assert(reclaim.resultCode === 'ATTEMPT_CLAIMED' && tokenTwo !== tokenOne, 'Reclaim did not issue a new execution token.');

      const staleMark = await publication.markStorageWritten(attemptId, tokenOne, '0'.repeat(64), 1);
      const staleFail = await publication.failAttempt(attemptId, tokenOne, 'VERIFIER_STALE');
      assert(staleMark.resultCode === 'ATTEMPT_TOKEN_MISMATCH' && staleFail.resultCode === 'ATTEMPT_TOKEN_MISMATCH', 'A stale execution token mutated a reclaimed attempt.');
      const untouched = await attemptById(attemptId);
      assert(String(untouched.state) === 'reserved' && untouched.failure_code === null, 'A stale token changed durable attempt state.');
      const authoritative = await publication.failAttempt(attemptId, tokenTwo, 'VERIFIER_RELEASE');
      assert(authoritative.resultCode === 'FAILED', `Rotated token was not authoritative: ${JSON.stringify(authoritative)}`);
    });

    await scenario(34, 'crash recovery removes public media created by a previous process invocation', async () => {
      const crash = await makeReady('crash-owned-media');
      const destinations = [...publicPaths].filter((item) => item.includes(crash.publicId));
      assert(destinations.length > 0, 'Crash fixture has no deterministic public destinations.');
      for (const destination of destinations) {
        assert((await download(PUBLIC_ASSETS_BUCKET, destination)) === null, `Destination existed before the attempt: ${destination}`);
      }

      let crashed = false;
      try {
        await execute(crash, 'admin', 'simulated_process_crash_after_media_write');
      } catch (error) {
        crashed = error instanceof Error && error.message === 'SIMULATED_PROCESS_CRASH';
        if (!crashed) throw error;
      }
      assert(crashed, 'Simulated process death did not abort the execution.');
      const written = await Promise.all(destinations.map((item) => download(PUBLIC_ASSETS_BUCKET, item)));
      assert(written.some((item) => item !== null), 'Crashed invocation wrote no public media.');
      const crashedRow = await attemptFor(crash);
      assert(String(crashedRow.state) === 'prepared' && crashedRow.artifact_bound_at !== null, 'Crashed attempt lost its durable binding.');

      // A completely fresh coordinator invocation owns nothing in process memory.
      expireLease(String(crashedRow.id));
      const recovered = await execute(crash, 'admin', 'before_finalize');
      assert(recovered.resultCode === 'EXECUTION_FAILED' && !('compensationFailureCode' in recovered && recovered.compensationFailureCode), `Recovered execution did not compensate cleanly: ${JSON.stringify(recovered)}`);
      const after = await Promise.all(destinations.map((item) => download(PUBLIC_ASSETS_BUCKET, item)));
      assert(after.every((item) => item === null), 'Compensation stranded public media created by the crashed process.');
      for (const sourcePath of [...privatePaths].filter((item) => item.includes(crash.publicId))) {
        const expected = sourcePath.includes('poster_pdf') ? PDF_BYTES : PNG_BYTES;
        assert((await download(PRIVATE_BUCKET, sourcePath))?.equals(expected), `Private source changed during crash recovery: ${sourcePath}`);
      }
      assert((await db.from('projects').select('status').eq('id', crash.id).single()).data?.status === 'approved', 'Crash recovery published project state.');
      assert(await count('approval_records', 'project_id', crash.id) === 0, 'Crash recovery created a publish audit record.');
      assert((await attemptFor(crash)).published_snapshot_id === null, 'Crash recovery created a publication snapshot.');
    });

    await scenario(35, 'compensation preserves a public object that pre-existed the attempt', async () => {
      const preserve = await makeReady('preserve-existing');
      const posterDestination = `published/${preserve.publicId}/poster_image/poster.png`;
      const pdfDestination = `published/${preserve.publicId}/poster_pdf/poster.pdf`;
      const seeded = await db.storage.from(PUBLIC_ASSETS_BUCKET).upload(posterDestination, PNG_BYTES, { contentType: 'image/png', upsert: false });
      if (seeded.error) throw seeded.error;

      const result = await execute(preserve, 'admin', 'before_finalize');
      assert(result.resultCode === 'EXECUTION_FAILED', `Pre-existing media fixture did not fail as injected: ${JSON.stringify(result)}`);
      const manifest = (await attemptFor(preserve)).media_manifest as { assetType: string; preExisting: boolean }[];
      assert(manifest.find((item) => item.assetType === 'poster_image')?.preExisting === true, 'Pre-existing destination was not recorded as pre-existing.');
      assert(manifest.find((item) => item.assetType === 'poster_pdf')?.preExisting === false, 'Attempt-owned destination was misrecorded as pre-existing.');
      assert((await download(PUBLIC_ASSETS_BUCKET, posterDestination))?.equals(PNG_BYTES), 'Compensation deleted a public object the attempt did not create.');
      assert((await download(PUBLIC_ASSETS_BUCKET, pdfDestination)) === null, 'Compensation stranded an attempt-owned object.');
      assert((await download(PRIVATE_BUCKET, `drafts/${preserve.publicId}/poster_image/poster.png`))?.equals(PNG_BYTES), 'Private source changed.');
      assert((await db.from('projects').select('status').eq('id', preserve.id).single()).data?.status === 'approved', 'Failed publication changed project state.');
      assert(await count('approval_records', 'project_id', preserve.id) === 0, 'Failed publication created a publish audit record.');
    });

    await scenario(36, 'historical publication snapshot evidence is immutable after a later publication', async () => {
      assert(snapshotAAfterPublish, 'Snapshot A evidence was not captured.');
      const attemptA = await attemptFor(raceA);
      const current = (await db.from('published_snapshots').select('*').eq('id', attemptA.published_snapshot_id).single()).data;
      assert(JSON.stringify(current) === JSON.stringify(snapshotAAfterPublish), 'Historical snapshot changed after a later publication.');
      const attemptB = await attemptFor(raceB);
      const snapshotB = (await db.from('published_snapshots').select('*').eq('id', attemptB.published_snapshot_id).single()).data;
      assert(String(snapshotB.id) !== String(current.id) && String(snapshotB.feed_hash) !== String(current.feed_hash), 'Later publication reused historical snapshot evidence.');
      assert(Number(snapshotB.record_count) === Number(current.record_count) + 1, 'Later snapshot did not record the evolved feed.');
    });

    await scenario(37, 'compensation after a newer publication restores the feed containing it', async () => {
      const newer = await makeReady('compensation-newer');
      const feedNow = (await download(PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH))!.toString('utf8');
      const parsedNow = JSON.parse(feedNow) as { publicId: string }[];
      assert(parsedNow.some((record) => record.publicId === raceA.publicId) && parsedNow.some((record) => record.publicId === raceB.publicId), 'Baseline feed did not contain both prior publications.');

      const result = await execute(newer, 'admin', 'after_feed_verification');
      assert(result.resultCode === 'EXECUTION_FAILED', `Newer-publication fixture did not fail as injected: ${JSON.stringify(result)}`);
      const bound = String((await attemptFor(newer)).previous_feed_content);
      const parsedBound = JSON.parse(bound) as { publicId: string }[];
      assert(parsedBound.some((record) => record.publicId === raceA.publicId) && parsedBound.some((record) => record.publicId === raceB.publicId), 'Bound previous feed omitted an already-completed publication.');
      const restored = (await download(PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH))!.toString('utf8');
      assert(restored === feedNow, 'Compensation restored a feed older than an already-completed publication.');
      const ordinary = serializePublicFeedArtifact(compilePublicFeed(await projects.listProjects()));
      assert(ordinary.content === restored, 'Database and canonical feed diverged after compensation.');
      assert((await db.from('projects').select('status').eq('id', newer.id).single()).data?.status === 'approved', 'Failed publication changed project state.');
    });

    // Intentionally last: this scenario leaves the global publication slot blocked.
    await scenario(38, 'compensation failure is reported separately and fails closed', async () => {
      const target = await makeReady('compensation-failure');
      const result = await execute(target, 'admin', 'during_compensation');
      assert(result.resultCode === 'EXECUTION_FAILED' && result.compensationFailureCode === 'COMPENSATION_FAILED' && (await db.from('projects').select('status').eq('id', target.id).single()).data?.status === 'approved' && (await attemptFor(target)).state === 'compensation_failed', 'Compensation failure was masked or published DB state.');
    });
  } catch (error) {
    primaryFailure = error;
    console.error('PRIMARY FAILURE:', error instanceof Error ? error.message : String(error));
  } finally {
    console.log('Scenario 39: independent cleanup restores DB and storage baselines');
    try {
      const ids = fixtures.map((fixture) => fixture.id);
      if (ids.length) {
        const attempts = await db.from('publication_attempts').select('published_snapshot_id').in('project_id', ids);
        if (attempts.error) throw attempts.error;
        for (const row of attempts.data ?? []) if (row.published_snapshot_id) snapshotIds.add(String(row.published_snapshot_id));
        const quotedIds = ids.map((id) => `'${id.replace(/'/g, "''")}'::uuid`).join(',');
        const quotedSnapshots = [...snapshotIds].map((id) => `'${id.replace(/'/g, "''")}'::uuid`).join(',') || 'NULL';
        const sql = `BEGIN; DELETE FROM public.publication_attempts WHERE project_id IN (${quotedIds}); DELETE FROM public.projects WHERE id IN (${quotedIds}); DELETE FROM public.published_snapshots WHERE id IN (${quotedSnapshots}); COMMIT;`;
        psql(sql);
      }
      if (secondAdminId) {
        psql(`BEGIN; DELETE FROM public.user_roles WHERE user_id = '${secondAdminId.replace(/'/g, "''")}'::uuid; DELETE FROM public.admin_users WHERE id = '${secondAdminId.replace(/'/g, "''")}'::uuid; COMMIT;`);
      }
      if (privatePaths.size) {
        const removed = await db.storage.from(PRIVATE_BUCKET).remove([...privatePaths]);
        if (removed.error) throw removed.error;
      }
      if (publicPaths.size) {
        const removed = await db.storage.from(PUBLIC_ASSETS_BUCKET).remove([...publicPaths]);
        if (removed.error) throw removed.error;
      }
      await restoreFeed();
      const remainingProjects = fixtures.length ? (await db.from('projects').select('id', { count: 'exact', head: true }).in('id', fixtures.map((item) => item.id))).count ?? 0 : 0;
      const attemptsNow = (await db.from('publication_attempts').select('id', { count: 'exact', head: true })).count ?? 0;
      const snapshotsNow = (await db.from('published_snapshots').select('id', { count: 'exact', head: true })).count ?? 0;
      const feedNow = await download(PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH);
      const remainingAdmins = secondAdminId
        ? (await db.from('admin_users').select('id', { count: 'exact', head: true }).eq('id', secondAdminId)).count ?? 0
        : 0;
      assert(remainingProjects === 0 && attemptsNow === databaseBaseline.attempts && snapshotsNow === databaseBaseline.snapshots, 'Verifier database residue remains.');
      assert(remainingAdmins === 0, 'Verifier admin fixture residue remains.');
      assert(JSON.stringify(await listTree(PUBLIC_ASSETS_BUCKET)) === publicAssetBaseline, 'Verifier public-media residue remains.');
      assert((feedBaseline === null && feedNow === null) || (feedBaseline !== null && feedNow?.equals(feedBaseline)), 'Canonical feed baseline was not restored exactly.');
      console.log('PASS: Scenario 39');
    } catch (error) {
      cleanupFailure = error;
      console.error('CLEANUP FAILURE:', error instanceof Error ? error.message : String(error));
    }
  }

  if (primaryFailure || cleanupFailure) throw primaryFailure || cleanupFailure;
  console.log('OVERALL CONTROLLED PUBLICATION RUNTIME VERIFICATION RESULT: PASS');
  return true;
}

runControlledPublicationRuntimeVerification().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
