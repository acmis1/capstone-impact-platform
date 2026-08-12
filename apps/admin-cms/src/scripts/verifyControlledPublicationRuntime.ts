import crypto from 'node:crypto';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { getPermissionsForRoles } from '../auth/permissions';
import { compilePublicFeed } from '../feed/compilePublicFeed';
import { serializePublicFeedArtifact } from '../feed/serializePublicFeedArtifact';
import { isLoopbackUrl, parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';
import { executeControlledPublication, ControlledPublicationFailurePoint } from '../projects/controlledPublicationService';
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
  const execute = (fixture: Fixture, role: 'admin' | 'reviewer' | 'editor' = 'admin', failurePoint?: ControlledPublicationFailurePoint) => {
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
    });
  };
  const attemptFor = async (fixture: Fixture) => {
    const result = await db.from('publication_attempts').select('*').eq('project_id', fixture.id).order('created_at', { ascending: false }).limit(1).single();
    if (result.error) throw result.error;
    if (result.data.published_snapshot_id) snapshotIds.add(String(result.data.published_snapshot_id));
    return result.data;
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
    await scenario(18, 'stale confirmation evidence is rejected by the DB boundary', async () => {
      const readiness = await previews.getPublicationReadiness({ publicId: stale.publicId, adminId, privateBucket: PRIVATE_BUCKET });
      assert(readiness.ready && readiness.confirmedPreviewId && readiness.confirmedAt, 'Stale fixture was not ready.');
      const stalePlan = planPublicationArtifact({ projects: await projects.listProjects(), targetPublicId: stale.publicId, mediaAssets: await publication.listProjectMedia(stale.publicId), privateBucket: PRIVATE_BUCKET, publicBucket: PUBLIC_ASSETS_BUCKET, getPublicUrl: (bucket, objectPath) => publication.getPublicUrl(bucket, objectPath) });
      const result = await publication.beginAttempt({ publicId: stale.publicId, adminId, privateBucket: PRIVATE_BUCKET, confirmedPreviewId: readiness.confirmedPreviewId, confirmedAt: '2000-01-01T00:00:00.000Z', recordCount: stalePlan.recordCount, feedHash: stalePlan.feedHash, content: stalePlan.content, feedBucket: PUBLIC_FEED_BUCKET, feedPath: PUBLIC_FEED_PATH, feedPublicUrl: publication.getPublicUrl(PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH), previousFeedContent: (await download(PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH))?.toString('utf8') ?? null, mediaManifest: stalePlan.mediaPromotions });
      assert(result.resultCode === 'STALE_EVIDENCE' && await count('publication_attempts', 'project_id', stale.id) === 0, 'Stale evidence created an attempt.');
    });

    const frozen = await makeReady('frozen');
    const frozenReadiness = await previews.getPublicationReadiness({ publicId: frozen.publicId, adminId, privateBucket: PRIVATE_BUCKET });
    assert(frozenReadiness.ready && frozenReadiness.confirmedPreviewId && frozenReadiness.confirmedAt, 'Frozen fixture was not ready.');
    const frozenPlan = planPublicationArtifact({ projects: await projects.listProjects(), targetPublicId: frozen.publicId, mediaAssets: await publication.listProjectMedia(frozen.publicId), privateBucket: PRIVATE_BUCKET, publicBucket: PUBLIC_ASSETS_BUCKET, getPublicUrl: (bucket, objectPath) => publication.getPublicUrl(bucket, objectPath) });
    const frozenBegin = await publication.beginAttempt({ publicId: frozen.publicId, adminId, privateBucket: PRIVATE_BUCKET, confirmedPreviewId: frozenReadiness.confirmedPreviewId, confirmedAt: frozenReadiness.confirmedAt, recordCount: frozenPlan.recordCount, feedHash: frozenPlan.feedHash, content: frozenPlan.content, feedBucket: PUBLIC_FEED_BUCKET, feedPath: PUBLIC_FEED_PATH, feedPublicUrl: publication.getPublicUrl(PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH), previousFeedContent: (await download(PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH))?.toString('utf8') ?? null, mediaManifest: frozenPlan.mediaPromotions });
    assert(frozenBegin.resultCode === 'ATTEMPT_STARTED', 'Could not establish active frozen attempt.');
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
      const args = { p_public_id: failures.publicId, p_admin_id: adminId, p_private_bucket: PRIVATE_BUCKET, p_confirmed_preview_id: failures.previewId, p_confirmed_at: failures.confirmedAt, p_candidate_record_count: 1, p_candidate_feed_hash: '0'.repeat(64), p_candidate_feed_content: '[]', p_feed_storage_bucket: PUBLIC_FEED_BUCKET, p_feed_storage_path: PUBLIC_FEED_PATH, p_feed_public_url: publication.getPublicUrl(PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH), p_previous_feed_existed: false, p_previous_feed_content: null, p_media_manifest: [] };
      const [a, b] = await Promise.all([anon.rpc('begin_publication_attempt', args), authenticated.rpc('begin_publication_attempt', args)]);
      assert(Boolean(a.error) && Boolean(b.error), 'A non-service client executed publication RPC.');
    });
    await scenario(28, 'success changes public storage only at deterministic verifier paths', async () => {
      const additions = (await listTree(PUBLIC_ASSETS_BUCKET)).filter((item) => !JSON.parse(publicAssetBaseline).includes(item));
      assert(additions.every((item) => publicPaths.has(item)) && additions.length > 0, `Unexpected public asset changes: ${additions.join(',')}`);
    });
    await scenario(29, 'compensation failure is reported separately and fails closed', async () => {
      const target = await makeReady('compensation-failure');
      const result = await execute(target, 'admin', 'during_compensation');
      assert(result.resultCode === 'EXECUTION_FAILED' && result.compensationFailureCode === 'COMPENSATION_FAILED' && (await db.from('projects').select('status').eq('id', target.id).single()).data?.status === 'approved' && (await attemptFor(target)).state === 'compensation_failed', 'Compensation failure was masked or published DB state.');
    });
  } catch (error) {
    primaryFailure = error;
    console.error('PRIMARY FAILURE:', error instanceof Error ? error.message : String(error));
  } finally {
    console.log('Scenario 30: independent cleanup restores DB and storage baselines');
    try {
      const ids = fixtures.map((fixture) => fixture.id);
      if (ids.length) {
        const attempts = await db.from('publication_attempts').select('published_snapshot_id').in('project_id', ids);
        if (attempts.error) throw attempts.error;
        for (const row of attempts.data ?? []) if (row.published_snapshot_id) snapshotIds.add(String(row.published_snapshot_id));
        const quotedIds = ids.map((id) => `'${id.replace(/'/g, "''")}'::uuid`).join(',');
        const quotedSnapshots = [...snapshotIds].map((id) => `'${id.replace(/'/g, "''")}'::uuid`).join(',') || 'NULL';
        const sql = `BEGIN; DELETE FROM public.publication_attempts WHERE project_id IN (${quotedIds}); DELETE FROM public.projects WHERE id IN (${quotedIds}); DELETE FROM public.published_snapshots WHERE id IN (${quotedSnapshots}); COMMIT;`;
        execSync(`docker exec supabase_db_capstone-impact-platform psql -U postgres -d postgres -At -v ON_ERROR_STOP=1 -c "${sql}"`, { cwd: root, encoding: 'utf8' });
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
      assert(remainingProjects === 0 && attemptsNow === databaseBaseline.attempts && snapshotsNow === databaseBaseline.snapshots, 'Verifier database residue remains.');
      assert(JSON.stringify(await listTree(PUBLIC_ASSETS_BUCKET)) === publicAssetBaseline, 'Verifier public-media residue remains.');
      assert((feedBaseline === null && feedNow === null) || (feedBaseline !== null && feedNow?.equals(feedBaseline)), 'Canonical feed baseline was not restored exactly.');
      console.log('PASS: Scenario 30');
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
