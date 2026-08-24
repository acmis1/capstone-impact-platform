import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Project } from '../domain/project';
import { parseSupabaseCliEnv, isLoopbackUrl } from '../local-development/localEnvironmentFile';
import { createMockProject } from '../test/projectFixtures';
import { toPublicFeedRecord } from '../feed/compilePublicFeed';
import {
  composePublicFeedRemoval,
  createPublicFeedArtifact,
  verifyPublicFeedArtifact,
  type VerifiedPublicFeedArtifact,
} from '../feed/publicFeedArtifact';
import { promoteBoundPublicMedia } from '../projects/boundPublicMediaPromotion';
import { executeControlledPublication } from '../projects/controlledPublicationService';
import { createControlledPublicationDependencies } from '../projects/createControlledPublicationDependencies';
import { executeControlledPublicRemoval } from '../projects/controlledPublicRemovalService';
import {
  activatePublicFeedHistory,
  executePublicFeedRollback,
  preparePublicFeedRollback,
  recoverPublicFeedOperation,
  type PublicFeedHistoryServiceDependencies,
} from '../projects/publicFeedHistoryService';
import { executePublicFeedWriter } from '../projects/publicFeedWriterCoordinator';
import { readPublicFeedHistory } from '../projects/publicFeedHistoryRepository';
import {
  SupabasePublicFeedLedgerRepositoryCore,
  type PublicFeedOperationState,
} from '../repositories/SupabasePublicFeedLedgerRepositoryCore';
import { SupabaseParticipantPreviewRepositoryCore } from '../repositories/SupabaseParticipantPreviewRepositoryCore';
import { SupabasePublicationExecutionRepositoryCore } from '../repositories/SupabasePublicationExecutionRepositoryCore';

const repositoryRoot = path.resolve(__dirname, '../../../..');
const workdir = process.env.CAPSTONE_VERIFY_SUPABASE_WORKDIR?.trim();
const projectId = process.env.CAPSTONE_VERIFY_SUPABASE_PROJECT_ID?.trim();
const feedBucket = 'public-feeds';
const feedPath = 'runtime/issue-186-public-feed.json';
const privateBucket = 'project-drafts-private';
const publicAssetsBucket = 'project-public-assets';
const adminId = '18600000-0000-4000-8000-000000000001';
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF', 'ascii');
const CRASH_BOUNDARY_REASON = 'Runtime crash-boundary verification';
const RESPONSE_LOSS_REASON = 'Committed response-loss verification';
let runtimeApiUrl = '';

function requireDisposableInputs(): void {
  assert.equal(process.env.CAPSTONE_VERIFY_DISPOSABLE, '1', 'Disposable verifier acknowledgement is required.');
  assert.ok(workdir && path.isAbsolute(workdir), 'A disposable absolute Supabase workdir is required.');
  assert.ok(projectId && /^capstone-pp1-[a-z0-9-]+$/.test(projectId), 'A verifier-only project ID is required.');
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function databaseContainer(): string {
  const rows = execFileSync('docker', [
    'ps', '--filter', `label=com.supabase.cli.project=${projectId}`,
    '--filter', 'name=supabase_db_', '--format', '{{.Names}}',
  ], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);
  assert.equal(rows.length, 1, 'Expected exactly one verifier-owned database container.');
  return rows[0];
}

function psql(sql: string): string {
  return execFileSync('docker', [
    'exec', databaseContainer(), 'psql', '-U', 'postgres', '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function expectPsqlFailure(sql: string, marker: string): void {
  try {
    psql(sql);
    assert.fail(`${marker} unexpectedly succeeded.`);
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '');
    assert.match(stderr, /PUBLIC_FEED_IMMUTABLE_HISTORY|PUBLIC_FEED_OPERATION_IN_PROGRESS|permission denied|violates/i, marker);
  }
}

function assertLoopbackBindings(): void {
  const containerNames = execFileSync('docker', [
    'ps', '--filter', `label=com.supabase.cli.project=${projectId}`, '--format', '{{.Names}}',
  ], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);
  assert.ok(containerNames.length > 0);
  for (const container of containerNames) {
    const raw = execFileSync('docker', ['inspect', '--format', '{{json .NetworkSettings.Ports}}', container], { encoding: 'utf8' }).trim();
    const ports = JSON.parse(raw) as Record<string, Array<{ HostIp?: string }> | null>;
    for (const bindings of Object.values(ports)) {
      for (const binding of bindings ?? []) assert.equal(binding.HostIp, '127.0.0.1');
    }
  }
}

function token(): string {
  return randomBytes(32).toString('base64url');
}

function project(publicId: string, status: 'published' | 'archived' = 'published'): Project & { publicId: string } {
  return createMockProject({
    id: Number.parseInt(Buffer.from(publicId).toString('hex').slice(0, 8), 16),
    publicId, title: `Runtime ${publicId}`, status,
  }) as Project & { publicId: string };
}

async function uploadExact(client: SupabaseClient, artifact: VerifiedPublicFeedArtifact): Promise<void> {
  const result = await client.storage.from(feedBucket).upload(feedPath, artifact.bytes, {
    contentType: 'application/json', upsert: true,
  });
  assert.equal(result.error, null, result.error?.message);
}

async function exactStored(client: SupabaseClient): Promise<VerifiedPublicFeedArtifact> {
  const result = await client.storage.from(feedBucket).download(feedPath);
  assert.equal(result.error, null, result.error?.message);
  assert.ok(result.data);
  return verifyPublicFeedArtifact(Buffer.from(await result.data.arrayBuffer()));
}

async function createReadyPublicationProject(client: SupabaseClient, publicId: string): Promise<string> {
  const inserted = await client.from('projects').insert({
    public_id: publicId, title: `Runtime ${publicId}`, slug: publicId,
    summary: 'Synthetic public summary.', background: 'Synthetic public background.',
    solution: 'Synthetic public solution.', year: 2026,
    program_name: 'Bachelor of Software Engineering', study_program: 'Bachelor of Software Engineering',
    discipline: 'Software Engineering', industry: 'Technology', industry_partner: 'Synthetic Partner',
    academic_supervisor: 'Synthetic Supervisor', group_name: 'Synthetic Group',
    team_members: ['Synthetic Member'], poster_url: '', poster_pdf_url: '', snapshots: [],
    poster_text_public: 'Synthetic poster text.', accessibility_text_public: 'Synthetic accessible text.',
    external_links: [], citations: [], layout_config: {}, status: 'approved',
  }).select('id').single();
  assert.equal(inserted.error, null, inserted.error?.message);
  const projectId = String(inserted.data?.id);
  for (const asset of [
    { type: 'poster_image', name: 'poster.png', mime: 'image/png', bytes: PNG_BYTES },
    { type: 'poster_pdf', name: 'poster.pdf', mime: 'application/pdf', bytes: PDF_BYTES },
  ]) {
    const storagePath = `runtime/${publicId}/${asset.type}/${asset.name}`;
    const uploaded = await client.storage.from(privateBucket).upload(storagePath, asset.bytes, {
      contentType: asset.mime, upsert: false,
    });
    assert.equal(uploaded.error, null, uploaded.error?.message);
    const media = await client.from('media_assets').insert({
      project_id: projectId, asset_type: asset.type, file_name: asset.name,
      storage_bucket: privateBucket, storage_path: storagePath, public_url: null,
      mime_type: asset.mime, file_size_bytes: asset.bytes.length, is_public_approved: false,
    });
    assert.equal(media.error, null, media.error?.message);
  }
  const previews = new SupabaseParticipantPreviewRepositoryCore(client);
  const generated = await previews.generatePreview({
    publicId, adminId,
    tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
    privateBucket,
  });
  const token = await client.from('participant_previews').select('token_hash').eq('id', generated.previewId).single();
  assert.equal(token.error, null, token.error?.message);
  const confirmed = await previews.confirmPreview(String(token.data?.token_hash));
  assert.ok(confirmed, 'Synthetic participant confirmation failed.');
  return projectId;
}

function historyDependencies(
  client: SupabaseClient,
  projects: ReturnType<typeof project>[],
): PublicFeedHistoryServiceDependencies {
  const publication = new SupabasePublicationExecutionRepositoryCore(client, runtimeApiUrl);
  return {
    supabase: client, supabaseUrl: runtimeApiUrl, adminId,
    permissions: ['projects.publish'], feedBucket, feedPath,
    listProjects: async () => projects,
    assertActivationEnvironment: () => undefined,
    promoteBoundPublicMedia: (manifest) => promoteBoundPublicMedia({
      downloadObject: (bucket, path) => publication.downloadObject(bucket, path),
      uploadNewObject: (bucket, path, content, contentType) =>
        publication.uploadNewObject(bucket, path, content, contentType),
    }, manifest),
    environment: {
      CAPSTONE_RUNTIME_ENV: 'local',
      CAPSTONE_LOCAL_PUBLIC_FEED_ROLLBACK_ENABLED: 'true',
    },
  };
}

function publicationDependencies(client: SupabaseClient, publicId: string) {
  return createControlledPublicationDependencies({
    supabase: client, supabaseUrl: runtimeApiUrl, publicId, adminId,
    privateBucket, publicFeedBucket: feedBucket, publicFeedPath: feedPath, executionTarget: 'local',
  });
}

/**
 * Revokes an authorization after the operation has already reserved and while its candidate is
 * being prepared, so the revocation lands between reservation and the durable write-intent gate.
 */
function revokeDuringPreparation(client: SupabaseClient, publicId: string, revoke: () => void) {
  const dependencies = publicationDependencies(client, publicId);
  return {
    ...dependencies,
    listProjectMedia: async () => {
      const media = await dependencies.listProjectMedia();
      revoke();
      return media;
    },
  };
}

/** Rewrites the bound private source between binding and the pre-intent validation read. */
function mutateSourceAfterBinding(client: SupabaseClient, publicId: string) {
  const dependencies = publicationDependencies(client, publicId);
  const bindingReads = new Set<string>();
  return {
    ...dependencies,
    downloadObject: async (bucket: string, path: string) => {
      const original = await dependencies.downloadObject(bucket, path);
      if (bucket !== privateBucket || !original) return original;
      if (!bindingReads.has(path)) {
        bindingReads.add(path);
        return original;
      }
      return Buffer.concat([original, Buffer.from([0x00])]);
    },
  };
}

/** Simulates a process failure after the first bound asset is already publicly readable. */
function failSecondMediaUpload(client: SupabaseClient, publicId: string) {
  const dependencies = publicationDependencies(client, publicId);
  let uploads = 0;
  return {
    ...dependencies,
    uploadNewObject: async (bucket: string, path: string, content: Buffer, contentType: string) => {
      uploads += 1;
      if (uploads > 1) throw new Error('SIMULATED_MEDIA_PROMOTION_CRASH');
      return dependencies.uploadNewObject(bucket, path, content, contentType);
    },
  };
}

async function publicMediaCount(client: SupabaseClient, publicId: string): Promise<number> {
  const result = await client.storage.from(publicAssetsBucket).list(`published/${publicId}`, { limit: 100 });
  if (result.error) return 0;
  let total = 0;
  for (const entry of result.data ?? []) {
    const nested = await client.storage.from(publicAssetsBucket)
      .list(`published/${publicId}/${entry.name}`, { limit: 100 });
    total += (nested.data ?? []).filter((item) => item.id !== null).length;
  }
  return total;
}

function targetEvidence(publicId: string): { operationId: string; snapshotId: string | null; auditRecordId: string | null } {
  const row = psql(`SELECT operation_id::text || '|' || COALESCE(published_snapshot_id::text,'') || '|' || COALESCE(audit_record_id::text,'')
    FROM public.public_feed_versions
    WHERE operation='publication' AND affected_public_id=${sqlLiteral(publicId)}
    ORDER BY version_number DESC LIMIT 1;`);
  const [operationId, snapshotId, auditRecordId] = row.split('|');
  assert.ok(operationId, `No publication version recorded for ${publicId}.`);
  return {
    operationId,
    snapshotId: snapshotId === '' ? null : snapshotId,
    auditRecordId: auditRecordId === '' ? null : auditRecordId,
  };
}

/** Clears a durable operation left blocking by a deliberately failed authorization scenario. */
async function releaseBlockingOperation(
  client: SupabaseClient,
  ledger: SupabasePublicFeedLedgerRepositoryCore,
): Promise<void> {
  const blocking = await ledger.getBlockingOperation();
  if (!blocking) return;
  psql(`UPDATE public.public_feed_operations
    SET state='FAILED', failure_code='VERIFIER_RELEASE', failed_at=pg_catalog.now(),
        lease_expires_at=pg_catalog.now()
    WHERE id=${sqlLiteral(blocking.id)}::uuid AND state IN ('RESERVED','PREPARED');`);
  void client;
}

async function assertCompleted(result: { resultCode: string }, label: string): Promise<void> {
  assert.ok(['COMPLETED', 'ALREADY_COMPLETED'].includes(result.resultCode), `${label}: ${JSON.stringify(result)}`);
}

async function reserveNoChangeRemoval(
  ledger: SupabasePublicFeedLedgerRepositoryCore,
  publicId: string,
  ownerToken: string,
) {
  const head = await ledger.getHead();
  assert.ok(head);
  const baseline = verifyPublicFeedArtifact(head.currentVersion.artifactContent);
  const reserved = await ledger.reserve({
    operationKey: randomUUID(), kind: 'removal', mode: null, adminId, publicId,
    ownerToken, archiveReason: CRASH_BOUNDARY_REASON,
    storageBucket: feedBucket, storagePath: feedPath, rollbackCapability: false,
  });
  assert.equal(reserved.resultCode, 'OPERATION_RESERVED');
  return {
    id: String(reserved.operationId), epoch: Number(reserved.ownerEpoch), baseline, head,
  };
}

async function bindNoChangeRemoval(
  ledger: SupabasePublicFeedLedgerRepositoryCore,
  staged: Awaited<ReturnType<typeof reserveNoChangeRemoval>>,
  ownerToken: string,
): Promise<void> {
  const bound = await ledger.bind({
    operationId: staged.id, epoch: staged.epoch, token: ownerToken, actorId: adminId,
    baselineVersionId: staged.head.currentVersion.id, baselineStorageExisted: true,
    baselineHash: staged.baseline.feedHash, baselineCount: staged.baseline.recordCount,
    baselineContent: staged.baseline.content, candidateHash: staged.baseline.feedHash,
    candidateCount: staged.baseline.recordCount, candidateContent: staged.baseline.content,
    candidateMembers: staged.baseline.members,
    feedPublicUrl: `${runtimeApiUrl}/storage/v1/object/public/${feedBucket}/${feedPath}`,
    mediaManifest: [],
  });
  assert.equal(bound.resultCode, 'ARTIFACT_BOUND');
}

async function stageCrashBoundary(
  ledger: SupabasePublicFeedLedgerRepositoryCore,
  publicId: string,
  state: PublicFeedOperationState,
) {
  const ownerToken = token();
  const staged = await reserveNoChangeRemoval(ledger, publicId, ownerToken);
  if (state !== 'RESERVED') await bindNoChangeRemoval(ledger, staged, ownerToken);
  if (state === 'WRITE_STARTED') {
    const started = await ledger.markWriteStarted(staged.id, staged.epoch, ownerToken, adminId);
    assert.equal(started.resultCode, 'WRITE_STARTED');
  }
  if (state === 'CANDIDATE_OBSERVED' || state === 'DB_FINALIZED') {
    const observed = await ledger.observeCandidate(
      staged.id, staged.epoch, ownerToken, adminId,
      staged.baseline.feedHash, staged.baseline.recordCount,
    );
    assert.equal(observed.resultCode, 'CANDIDATE_OBSERVED');
  }
  if (state === 'DB_FINALIZED') {
    const finalized = await ledger.finalize(staged.id, staged.epoch, ownerToken, adminId);
    assert.equal(finalized.resultCode, 'DB_FINALIZED');
  }
  return { ...staged, ownerToken };
}

async function stageCommittedRemovalResponseLoss(
  client: SupabaseClient,
  ledger: SupabasePublicFeedLedgerRepositoryCore,
  publicId: string,
) {
  const ownerToken = token();
  const head = await ledger.getHead();
  assert.ok(head);
  const baseline = verifyPublicFeedArtifact(head.currentVersion.artifactContent);
  const candidate = composePublicFeedRemoval(baseline, publicId);
  assert.notEqual(candidate.feedHash, baseline.feedHash, 'Committed-response-loss candidate must change bytes.');
  const reserved = await ledger.reserve({
    operationKey: randomUUID(), kind: 'removal', mode: null, adminId, publicId,
    ownerToken, archiveReason: RESPONSE_LOSS_REASON,
    storageBucket: feedBucket, storagePath: feedPath, rollbackCapability: false,
  });
  assert.equal(reserved.resultCode, 'OPERATION_RESERVED');
  const operationId = String(reserved.operationId);
  const epoch = Number(reserved.ownerEpoch);
  const bound = await ledger.bind({
    operationId, epoch, token: ownerToken, actorId: adminId,
    baselineVersionId: head.currentVersion.id, baselineStorageExisted: true,
    baselineHash: baseline.feedHash, baselineCount: baseline.recordCount,
    baselineContent: baseline.content, candidateHash: candidate.feedHash,
    candidateCount: candidate.recordCount, candidateContent: candidate.content,
    candidateMembers: candidate.members,
    feedPublicUrl: `${runtimeApiUrl}/storage/v1/object/public/${feedBucket}/${feedPath}`,
    mediaManifest: [],
  });
  assert.equal(bound.resultCode, 'ARTIFACT_BOUND');
  const started = await ledger.markWriteStarted(operationId, epoch, ownerToken, adminId);
  assert.equal(started.resultCode, 'WRITE_STARTED');
  await uploadExact(client, candidate);
  return { operationId, candidate };
}

async function resumeRemoval(
  client: SupabaseClient,
  publicId: string,
  archiveReason = CRASH_BOUNDARY_REASON,
) {
  return await executePublicFeedWriter({
    supabase: client, adminId, kind: 'removal', publicId,
    archiveReason, feedBucket, feedPath,
    prepareCandidate: async (baseline) => {
      assert.ok(baseline);
      return { artifact: composePublicFeedRemoval(baseline, publicId) };
    },
  });
}

async function main(): Promise<void> {
  requireDisposableInputs();
  const verifierWorkdir = workdir as string;
  assertLoopbackBindings();
  const cli = path.resolve(repositoryRoot, 'node_modules/supabase/dist/supabase.js');
  const raw = execFileSync(process.execPath, [cli, 'status', '--workdir', verifierWorkdir, '-o', 'env'], {
    cwd: repositoryRoot, encoding: 'utf8', env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
  });
  const local = parseSupabaseCliEnv(raw);
  assert.equal(isLoopbackUrl(local.API_URL ?? ''), true);
  assert.ok(local.SERVICE_ROLE_KEY && local.ANON_KEY);
  runtimeApiUrl = local.API_URL!;
  const client = createClient(local.API_URL!, local.SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const anon = createClient(local.API_URL!, local.ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const ledger = new SupabasePublicFeedLedgerRepositoryCore(client);

  assert.equal(psql("SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version IN ('20260824180000','20260824183000');"), '2');
  assert.equal(psql("SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('public_feed_operations','public_feed_versions','public_feed_version_members','public_feed_head','feed_rollback_preparations','public_feed_operation_events');"), '6');
  assert.equal(psql("SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='public_feed_operations' AND column_name IN ('owner_token_hash','recovery_from_state')"), '2');
  assert.equal(psql("SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='public_feed_operations' AND column_name IN ('owner_token','execution_token')"), '0');
  const preservedPublicId = process.env.CAPSTONE_VERIFY_PRESERVED_PUBLIC_ID?.trim();
  if (preservedPublicId) {
    assert.equal(psql(`SELECT count(*) FROM public.projects WHERE public_id=${sqlLiteral(preservedPublicId)};`), '1');
  }

  psql(`
    INSERT INTO public.admin_users(id,email,full_name) VALUES
      (${sqlLiteral(adminId)}::uuid,'issue-186-admin@example.invalid','Issue 186 Runtime Admin')
      ON CONFLICT (id) DO UPDATE SET full_name=EXCLUDED.full_name;
    INSERT INTO public.user_roles(user_id,role) VALUES (${sqlLiteral(adminId)}::uuid,'admin')
      ON CONFLICT (user_id,role) DO NOTHING;
  `);
  const anonWrite = await anon.from('public_feed_operations').insert({});
  assert.ok(anonWrite.error, 'Anonymous direct ledger mutation unexpectedly succeeded.');
  const serviceWrite = await client.from('public_feed_versions').insert({});
  assert.ok(serviceWrite.error, 'Service-role direct history mutation unexpectedly succeeded.');
  const legacy = await client.rpc('reserve_publication_attempt', {
    p_public_id: '2026-medical-drone', p_admin_id: adminId, p_private_bucket: 'project-drafts-private',
    p_confirmed_preview_id: randomUUID(), p_confirmed_at: new Date().toISOString(),
  });
  assert.equal((legacy.data as { resultCode?: string })?.resultCode, 'LEDGER_PROTOCOL_REQUIRED');

  const traffic = project('2026-traffic-engine');
  const trafficArtifact = createPublicFeedArtifact([toPublicFeedRecord(traffic)]);
  await uploadExact(client, trafficArtifact);
  const activation = await activatePublicFeedHistory(historyDependencies(client, [traffic]));
  assert.equal(activation.resultCode, 'COMPLETED', JSON.stringify(activation));
  let head = await ledger.getHead();
  assert.ok(head?.rollbackEnabled);
  assert.equal(head.currentVersion.operation, 'baseline');
  assert.equal((await exactStored(client)).content, head.currentVersion.artifactContent);

  psql("UPDATE public.projects SET status='published' WHERE public_id='2026-medical-drone';");
  const medical = project('2026-medical-drone');
  const publication = await executeControlledPublication({
    permissions: ['projects.publish'], publicId: medical.publicId,
    privateBucket: 'project-drafts-private', publicAssetsBucket: 'project-public-assets',
    publicFeedBucket: feedBucket, publicFeedPath: feedPath, publicationMode: 'deployment_reconciliation',
    dependencies: {
      supabase: client, adminId, assertExecutionEnvironment: () => undefined,
      getReadiness: async () => { throw new Error('UNEXPECTED_READINESS_CALL'); },
      listProjects: async () => [medical], listProjectMedia: async () => [],
      getPublicUrl: () => '', downloadObject: async () => null,
      uploadNewObject: async () => false,
    },
  });
  await assertCompleted(publication, 'deployment reconciliation');
  assert.deepEqual((await exactStored(client)).feed.map(({ publicId }) => publicId), [traffic.publicId, medical.publicId]);

  const removal = await executeControlledPublicRemoval({
    permissions: ['projects.archive'], publicId: traffic.publicId, archiveReason: 'Runtime removal',
    dependencies: {
      supabase: client, adminId, feedBucket, feedPath,
      assertDisposableLocalEnvironment: () => undefined, listProjects: async () => [traffic],
    },
  });
  await assertCompleted(removal, 'controlled removal');
  const versionCountBeforeNoChange = Number(psql('SELECT count(*) FROM public.public_feed_versions;'));
  const noChange = await executePublicFeedWriter({
    supabase: client, adminId, kind: 'removal', publicId: traffic.publicId,
    archiveReason: 'Runtime no-change removal', feedBucket, feedPath,
    prepareCandidate: async (baseline) => {
      assert.ok(baseline);
      return { artifact: composePublicFeedRemoval(baseline, traffic.publicId) };
    },
  });
  await assertCompleted(noChange, 'no-change removal');
  assert.equal(Number(psql('SELECT count(*) FROM public.public_feed_versions;')), versionCountBeforeNoChange);

  const preparation = await preparePublicFeedRollback(historyDependencies(client, [
    project(traffic.publicId, 'archived'), medical,
  ]), 1);
  assert.equal(preparation.resultCode, 'PREPARED', JSON.stringify(preparation));
  if (preparation.resultCode !== 'PREPARED') throw new Error('ROLLBACK_PREPARATION_FAILED');
  const rollback = await executePublicFeedRollback(
    historyDependencies(client, [project(traffic.publicId, 'archived'), medical]),
    preparation.preparationHandle, preparation.requiredAcknowledgement,
  );
  assert.equal(rollback.resultCode, 'COMPLETED', JSON.stringify(rollback));
  assert.deepEqual((await exactStored(client)).feed.map(({ publicId }) => publicId), [traffic.publicId]);

  const postRollback = await executeControlledPublication({
    permissions: ['projects.publish'], publicId: medical.publicId,
    privateBucket: 'project-drafts-private', publicAssetsBucket: 'project-public-assets',
    publicFeedBucket: feedBucket, publicFeedPath: feedPath, publicationMode: 'deployment_reconciliation',
    dependencies: {
      supabase: client, adminId, assertExecutionEnvironment: () => undefined,
      getReadiness: async () => { throw new Error('UNEXPECTED_READINESS_CALL'); },
      listProjects: async () => [medical], listProjectMedia: async () => [],
      getPublicUrl: () => '', downloadObject: async () => null,
      uploadNewObject: async () => false,
    },
  });
  await assertCompleted(postRollback, 'post-rollback publication');
  assert.deepEqual((await exactStored(client)).feed.map(({ publicId }) => publicId), [traffic.publicId, medical.publicId]);

  await assertCompleted(await executeControlledPublicRemoval({
    permissions: ['projects.archive'], publicId: traffic.publicId, archiveReason: 'Create empty rollback target',
    dependencies: {
      supabase: client, adminId, feedBucket, feedPath,
      assertDisposableLocalEnvironment: () => undefined,
      listProjects: async () => [project(traffic.publicId, 'archived')],
    },
  }), 'remove rollback-restored archived member');
  await assertCompleted(await executeControlledPublicRemoval({
    permissions: ['projects.archive'], publicId: medical.publicId, archiveReason: 'Create empty rollback target',
    dependencies: {
      supabase: client, adminId, feedBucket, feedPath,
      assertDisposableLocalEnvironment: () => undefined, listProjects: async () => [medical],
    },
  }), 'remove final member');
  head = await ledger.getHead();
  assert.ok(head);
  const emptyVersionNumber = head.currentVersion.versionNumber;
  assert.equal(head.currentVersion.recordCount, 0);
  assert.deepEqual((await exactStored(client)).feed, []);

  const normalPublicId = '186-normal-publication';
  const normalProjectId = await createReadyPublicationProject(client, normalPublicId);
  const normalPublication = await executeControlledPublication({
    permissions: ['projects.publish'], publicId: normalPublicId,
    privateBucket, publicAssetsBucket, publicFeedBucket: feedBucket, publicFeedPath: feedPath,
    dependencies: createControlledPublicationDependencies({
      supabase: client, supabaseUrl: runtimeApiUrl, publicId: normalPublicId, adminId,
      privateBucket, publicFeedBucket: feedBucket, publicFeedPath: feedPath, executionTarget: 'local',
    }),
  });
  await assertCompleted(normalPublication, 'normal controlled publication');
  assert.equal(psql(`SELECT status FROM public.projects WHERE id=${sqlLiteral(normalProjectId)}::uuid;`), 'published');
  assert.equal(psql(`SELECT count(*) FROM public.approval_records WHERE project_id=${sqlLiteral(normalProjectId)}::uuid AND action_taken='publish';`), '1');
  assert.equal(await publicMediaCount(client, normalPublicId), 2, 'Normal publication did not promote its bound media.');
  const normalEvidence = targetEvidence(normalPublicId);

  // Target A completes, an unrelated target B changes the head, and retrying A must still answer
  // with A's own operation, snapshot and audit identifiers rather than the head's.
  const laterPublicId = '186-later-publication';
  await createReadyPublicationProject(client, laterPublicId);
  await assertCompleted(await executeControlledPublication({
    permissions: ['projects.publish'], publicId: laterPublicId,
    privateBucket, publicAssetsBucket, publicFeedBucket: feedBucket, publicFeedPath: feedPath,
    dependencies: createControlledPublicationDependencies({
      supabase: client, supabaseUrl: runtimeApiUrl, publicId: laterPublicId, adminId,
      privateBucket, publicFeedBucket: feedBucket, publicFeedPath: feedPath, executionTarget: 'local',
    }),
  }), 'later unrelated publication');
  const laterEvidence = targetEvidence(laterPublicId);
  assert.notEqual(normalEvidence.operationId, laterEvidence.operationId);
  head = await ledger.getHead();
  assert.ok(head);
  assert.equal(head.currentVersion.operationId, laterEvidence.operationId, 'Head should belong to the later target.');

  const retriedA = await executeControlledPublication({
    permissions: ['projects.publish'], publicId: normalPublicId,
    privateBucket, publicAssetsBucket, publicFeedBucket: feedBucket, publicFeedPath: feedPath,
    dependencies: createControlledPublicationDependencies({
      supabase: client, supabaseUrl: runtimeApiUrl, publicId: normalPublicId, adminId,
      privateBucket, publicFeedBucket: feedBucket, publicFeedPath: feedPath, executionTarget: 'local',
    }),
  });
  assert.equal(retriedA.resultCode, 'ALREADY_COMPLETED', JSON.stringify(retriedA));
  if (retriedA.resultCode !== 'ALREADY_COMPLETED') throw new Error('TARGET_EVIDENCE_RETRY_FAILED');
  assert.equal(retriedA.attemptId, normalEvidence.operationId, 'Retry borrowed the head operation identifier.');
  assert.equal(retriedA.snapshotId, normalEvidence.snapshotId, 'Retry borrowed the head snapshot identifier.');
  assert.equal(retriedA.auditRecordId, normalEvidence.auditRecordId, 'Retry borrowed the head audit identifier.');
  assert.notEqual(retriedA.attemptId, laterEvidence.operationId);

  // Media authorization boundary: readiness revoked after reservation but before write intent.
  const revokedReadinessId = '186-readiness-revoked';
  await createReadyPublicationProject(client, revokedReadinessId);
  const revokedReadiness = await executeControlledPublication({
    permissions: ['projects.publish'], publicId: revokedReadinessId,
    privateBucket, publicAssetsBucket, publicFeedBucket: feedBucket, publicFeedPath: feedPath,
    dependencies: revokeDuringPreparation(client, revokedReadinessId, () => {
      // An unmarked revocation is refused outright: readiness inputs are frozen for the duration
      // of an active operation. The marked form below simulates the revocation the write-intent
      // gate exists to catch anyway.
      expectPsqlFailure(
        `UPDATE public.participant_previews SET status='revoked', revoked_at=pg_catalog.now(),
           revoked_by=${sqlLiteral(adminId)}::uuid
         WHERE project_id=(SELECT id FROM public.projects WHERE public_id=${sqlLiteral(revokedReadinessId)})
           AND status='active';`,
        'Unfenced readiness revocation during an active operation',
      );
      psql(`DO $$
        DECLARE v_operation uuid;
        BEGIN
          SELECT id INTO v_operation FROM public.public_feed_operations
           WHERE state IN ('RESERVED','PREPARED','WRITE_STARTED','CANDIDATE_OBSERVED','DB_FINALIZED','RECOVERY_REQUIRED')
           LIMIT 1;
          PERFORM pg_catalog.set_config('app.public_feed_operation_id', v_operation::text, true);
          UPDATE public.participant_previews
             SET status='revoked', revoked_at=pg_catalog.now(), revoked_by=${sqlLiteral(adminId)}::uuid
           WHERE project_id=(SELECT id FROM public.projects WHERE public_id=${sqlLiteral(revokedReadinessId)})
             AND status='active';
        END $$;`);
    }),
  });
  assert.equal(revokedReadiness.resultCode, 'NOT_READY', JSON.stringify(revokedReadiness));
  assert.equal(await publicMediaCount(client, revokedReadinessId), 0, 'Revoked readiness still exposed public media.');

  // Media authorization boundary: publication authority revoked before write intent.
  const revokedPermissionId = '186-permission-revoked';
  await createReadyPublicationProject(client, revokedPermissionId);
  const revokedPermission = await executeControlledPublication({
    permissions: ['projects.publish'], publicId: revokedPermissionId,
    privateBucket, publicAssetsBucket, publicFeedBucket: feedBucket, publicFeedPath: feedPath,
    dependencies: revokeDuringPreparation(client, revokedPermissionId, () => {
      psql(`DELETE FROM public.user_roles WHERE user_id=${sqlLiteral(adminId)}::uuid AND role='admin';`);
    }),
  });
  psql(`INSERT INTO public.user_roles(user_id,role) VALUES (${sqlLiteral(adminId)}::uuid,'admin')
    ON CONFLICT (user_id,role) DO NOTHING;`);
  assert.equal(revokedPermission.resultCode, 'PERMISSION_DENIED', JSON.stringify(revokedPermission));
  assert.equal(await publicMediaCount(client, revokedPermissionId), 0, 'Revoked authority still exposed public media.');
  await releaseBlockingOperation(client, ledger);

  // Pre-intent failure: private source bytes changed between binding and the authorization gate.
  const mutatedSourceId = '186-source-mutated';
  await createReadyPublicationProject(client, mutatedSourceId);
  const mutatedSource = await executeControlledPublication({
    permissions: ['projects.publish'], publicId: mutatedSourceId,
    privateBucket, publicAssetsBucket, publicFeedBucket: feedBucket, publicFeedPath: feedPath,
    dependencies: mutateSourceAfterBinding(client, mutatedSourceId),
  });
  assert.deepEqual(mutatedSource, { resultCode: 'EXECUTION_FAILED', failureCode: 'PRIVATE_MEDIA_CHANGED' });
  assert.equal(await publicMediaCount(client, mutatedSourceId), 0, 'A pre-intent failure created public media.');

  // Crash during media promotion, after durable write intent: forward recovery completes the
  // remaining media and the canonical feed, and nothing that predates the operation is deleted.
  const crashPublicId = '186-media-crash';
  await createReadyPublicationProject(client, crashPublicId);
  const preservedPath = 'published/186-preserved/poster_image/poster.png';
  const preserved = await client.storage.from(publicAssetsBucket)
    .upload(preservedPath, PNG_BYTES, { contentType: 'image/png', upsert: true });
  assert.equal(preserved.error, null, preserved.error?.message);
  const feedBeforeCrash = (await exactStored(client)).feedHash;
  const crashed = await executeControlledPublication({
    permissions: ['projects.publish'], publicId: crashPublicId,
    privateBucket, publicAssetsBucket, publicFeedBucket: feedBucket, publicFeedPath: feedPath,
    dependencies: failSecondMediaUpload(client, crashPublicId),
  });
  assert.equal(crashed.resultCode, 'RECOVERY_REQUIRED', JSON.stringify(crashed));
  assert.equal(await publicMediaCount(client, crashPublicId), 1, 'Expected exactly one promoted asset before the crash.');
  assert.equal((await exactStored(client)).feedHash, feedBeforeCrash, 'A crashed promotion changed the canonical feed.');
  assert.ok(await client.storage.from(publicAssetsBucket).download(preservedPath).then((result) => result.data !== null),
    'Recovery deleted a public object that predated the operation.');
  const crashRecovery = await recoverPublicFeedOperation(historyDependencies(client, [traffic, medical]));
  assert.equal(crashRecovery.resultCode, 'COMPLETED', JSON.stringify(crashRecovery));
  assert.equal(await publicMediaCount(client, crashPublicId), 2, 'Recovery did not complete the bound media manifest.');
  assert.ok((await exactStored(client)).feed.some(({ publicId }) => publicId === crashPublicId));
  assert.ok(await client.storage.from(publicAssetsBucket).download(preservedPath).then((result) => result.data !== null));

  await assertCompleted(await executeControlledPublicRemoval({
    permissions: ['projects.archive'], publicId: crashPublicId, archiveReason: 'Restore rollback baseline',
    dependencies: {
      supabase: client, adminId, feedBucket, feedPath,
      assertDisposableLocalEnvironment: () => undefined,
      listProjects: async () => [project(crashPublicId)],
    },
  }), 'remove media crash fixture');
  for (const publicId of [normalPublicId, laterPublicId]) {
    await assertCompleted(await executeControlledPublicRemoval({
      permissions: ['projects.archive'], publicId, archiveReason: 'Restore rollback baseline',
      dependencies: {
        supabase: client, adminId, feedBucket, feedPath,
        assertDisposableLocalEnvironment: () => undefined,
        listProjects: async () => [project(publicId)],
      },
    }), `remove ${publicId}`);
  }

  const zeroPreparation = await preparePublicFeedRollback(historyDependencies(client, []), emptyVersionNumber);
  assert.equal(zeroPreparation.resultCode, 'PREPARED', JSON.stringify(zeroPreparation));
  if (zeroPreparation.resultCode !== 'PREPARED') throw new Error('ZERO_ROLLBACK_PREPARATION_FAILED');
  const zeroRollback = await executePublicFeedRollback(
    historyDependencies(client, []),
    zeroPreparation.preparationHandle, zeroPreparation.requiredAcknowledgement,
  );
  assert.equal(zeroRollback.resultCode, 'COMPLETED', JSON.stringify(zeroRollback));
  assert.deepEqual((await exactStored(client)).feed, []);

  psql(`UPDATE public.projects SET status='published', archived_at=NULL, archived_from_status=NULL,
    archive_reason=NULL, pending_removal_from_public=false
    WHERE public_id=${sqlLiteral(medical.publicId)};`);
  const postZeroRollback = await executeControlledPublication({
    permissions: ['projects.publish'], publicId: medical.publicId,
    privateBucket, publicAssetsBucket, publicFeedBucket: feedBucket, publicFeedPath: feedPath,
    publicationMode: 'deployment_reconciliation',
    dependencies: {
      supabase: client, adminId, assertExecutionEnvironment: () => undefined,
      getReadiness: async () => { throw new Error('UNEXPECTED_READINESS_CALL'); },
      listProjects: async () => [medical], listProjectMedia: async () => [],
      getPublicUrl: () => '', downloadObject: async () => null,
      uploadNewObject: async () => false,
    },
  });
  await assertCompleted(postZeroRollback, 'post-zero-rollback publication');
  assert.deepEqual((await exactStored(client)).feed.map(({ publicId }) => publicId), [medical.publicId]);

  const committedLoss = await stageCommittedRemovalResponseLoss(client, ledger, medical.publicId);
  assert.equal(
    (await resumeRemoval(client, medical.publicId, RESPONSE_LOSS_REASON)).resultCode,
    'PUBLICATION_IN_PROGRESS',
  );
  psql(`UPDATE public.public_feed_operations
    SET lease_expires_at=pg_catalog.now()-interval '1 second', storage_uncertainty_until=pg_catalog.now()-interval '1 second'
    WHERE id=${sqlLiteral(committedLoss.operationId)}::uuid;`);
  // An expired durable operation is only adoptable by a request carrying the identical immutable
  // intent; a different archive reason is a different authorization and must stay fenced out.
  assert.equal(
    (await resumeRemoval(client, medical.publicId, 'Materially different archive reason')).resultCode,
    'PUBLICATION_IN_PROGRESS',
  );
  assert.equal(
    (await ledger.getOperation(committedLoss.operationId))?.archiveReason,
    RESPONSE_LOSS_REASON,
  );
  await assertCompleted(
    await resumeRemoval(client, medical.publicId, RESPONSE_LOSS_REASON),
    'committed Storage response-loss reconciliation',
  );
  assert.equal((await exactStored(client)).feedHash, committedLoss.candidate.feedHash);

  const crashIds = ['reserved', 'prepared', 'write-started', 'candidate-observed', 'db-finalized', 'explicit-recovery', 'same-a', 'same-b', 'different'];
  for (const suffix of crashIds) {
    psql(`INSERT INTO public.projects(id,public_id,title,slug,year,status)
      VALUES (${sqlLiteral(randomUUID())}::uuid,${sqlLiteral(`186-${suffix}`)},${sqlLiteral(`Runtime ${suffix}`)},${sqlLiteral(`runtime-${suffix}`)},2026,'archived');`);
  }

  for (const state of ['RESERVED', 'PREPARED', 'CANDIDATE_OBSERVED', 'DB_FINALIZED'] as const) {
    const publicId = `186-${state.toLowerCase().replaceAll('_', '-')}`;
    const staged = await stageCrashBoundary(ledger, publicId, state);
    psql(`UPDATE public.public_feed_operations SET lease_expires_at=pg_catalog.now()-interval '1 second' WHERE id=${sqlLiteral(staged.id)}::uuid;`);
    await assertCompleted(await resumeRemoval(client, publicId), `crash recovery ${state}`);
  }
  const writeCrash = await stageCrashBoundary(ledger, '186-write-started', 'WRITE_STARTED');
  psql(`UPDATE public.public_feed_operations SET lease_expires_at=pg_catalog.now()-interval '1 second' WHERE id=${sqlLiteral(writeCrash.id)}::uuid;`);
  assert.equal((await resumeRemoval(client, '186-write-started')).resultCode, 'PUBLICATION_IN_PROGRESS');
  psql(`UPDATE public.public_feed_operations SET lease_expires_at=pg_catalog.now()-interval '1 second', storage_uncertainty_until=pg_catalog.now()-interval '1 second' WHERE id=${sqlLiteral(writeCrash.id)}::uuid;`);
  await assertCompleted(await resumeRemoval(client, '186-write-started'), 'crash recovery WRITE_STARTED');

  const recovery = await stageCrashBoundary(ledger, '186-explicit-recovery', 'DB_FINALIZED');
  const versionsBeforeRecovery = Number(psql('SELECT count(*) FROM public.public_feed_versions;'));
  const held = await ledger.requireRecovery(recovery.id, recovery.epoch, recovery.ownerToken, adminId, 'SIMULATED_RESPONSE_LOSS', recovery.baseline.feedHash, recovery.baseline.recordCount);
  assert.equal(held.resultCode, 'RECOVERY_REQUIRED');
  assert.equal((await ledger.getOperation(recovery.id))?.recoveryFromState, 'DB_FINALIZED');
  const recovered = await recoverPublicFeedOperation(historyDependencies(client, [traffic, medical]));
  assert.equal(recovered.resultCode, 'COMPLETED', JSON.stringify(recovered));
  assert.equal(Number(psql('SELECT count(*) FROM public.public_feed_versions;')), versionsBeforeRecovery);

  async function concurrency(publicIds: [string, string]): Promise<void> {
    const attempts = await Promise.all(publicIds.map(async (publicId) => {
      const ownerToken = token();
      const result = await ledger.reserve({
        operationKey: randomUUID(), kind: 'removal', mode: null, adminId, publicId,
        ownerToken, archiveReason: 'Concurrency verification', storageBucket: feedBucket,
        storagePath: feedPath, rollbackCapability: false,
      });
      return { result, ownerToken };
    }));
    assert.equal(attempts.filter(({ result }) => result.resultCode === 'OPERATION_RESERVED').length, 1);
    assert.equal(attempts.filter(({ result }) => result.resultCode === 'PUBLICATION_IN_PROGRESS').length, 1);
    const winner = attempts.find(({ result }) => result.resultCode === 'OPERATION_RESERVED')!;
    const operation = await ledger.getOperation(String(winner.result.operationId));
    assert.ok(operation);
    const storedOwnerHash = psql(`SELECT owner_token_hash FROM public.public_feed_operations WHERE id=${sqlLiteral(operation.id)}::uuid;`);
    assert.match(storedOwnerHash, /^[0-9a-f]{64}$/);
    assert.notEqual(storedOwnerHash, winner.ownerToken);
    const failed = await ledger.fail(operation.id, operation.ownerEpoch, winner.ownerToken, adminId, 'VERIFIER_RELEASE');
    assert.equal(failed.resultCode, 'FAILED');
  }
  await concurrency(['186-same-a', '186-same-a']);
  await concurrency(['186-same-b', '186-different']);

  const staleToken = token();
  const fenced = await ledger.reserve({
    operationKey: randomUUID(), kind: 'removal', mode: null, adminId, publicId: '186-same-b',
    ownerToken: staleToken, archiveReason: 'Stale-owner fencing verification',
    storageBucket: feedBucket, storagePath: feedPath, rollbackCapability: false,
  });
  assert.equal(fenced.resultCode, 'OPERATION_RESERVED');
  assert.equal((await resumeRemoval(client, '186-different')).resultCode, 'PUBLICATION_IN_PROGRESS');
  const fencedId = String(fenced.operationId);
  psql(`UPDATE public.public_feed_operations SET lease_expires_at=pg_catalog.now()-interval '1 second'
    WHERE id=${sqlLiteral(fencedId)}::uuid;`);
  const newToken = token();
  const claimed = await ledger.claim(fencedId, adminId, newToken);
  assert.equal(claimed.resultCode, 'OPERATION_CLAIMED');
  const newEpoch = Number(claimed.ownerEpoch);
  assert.equal((await ledger.renew(fencedId, Number(fenced.ownerEpoch), staleToken, adminId)).resultCode, 'STALE_OWNER');
  assert.equal((await ledger.fail(fencedId, Number(fenced.ownerEpoch), staleToken, adminId, 'STALE_RELEASE')).resultCode, 'STALE_OWNER');
  assert.equal((await ledger.fail(fencedId, newEpoch, newToken, adminId, 'VERIFIER_RELEASE')).resultCode, 'FAILED');

  head = await ledger.getHead();
  assert.ok(head);
  const history = await readPublicFeedHistory(client, head.currentVersion.versionNumber);
  assert.ok(history.active && history.versions.length >= 5 && history.detail);
  assert.equal(JSON.stringify(history).includes('artifactContent'), false);
  const firstVersionId = psql('SELECT id::text FROM public.public_feed_versions ORDER BY version_number LIMIT 1;');
  const firstOperationId = psql('SELECT operation_id::text FROM public.public_feed_operation_events ORDER BY created_at LIMIT 1;');
  expectPsqlFailure(`UPDATE public.public_feed_versions SET feed_hash=repeat('0',64) WHERE id=${sqlLiteral(firstVersionId)}::uuid;`, 'Version mutation');
  expectPsqlFailure(`DELETE FROM public.public_feed_version_members WHERE version_id=${sqlLiteral(firstVersionId)}::uuid;`, 'Member mutation');
  expectPsqlFailure(`UPDATE public.public_feed_operation_events SET code='MUTATED' WHERE operation_id=${sqlLiteral(firstOperationId)}::uuid;`, 'Event mutation');

  const memberHash = psql(`SELECT record_hash FROM public.public_feed_version_members WHERE version_id=${sqlLiteral(firstVersionId)}::uuid ORDER BY ordinal LIMIT 1;`);
  assert.equal(memberHash, trafficArtifact.members[0].recordHash);
  assert.equal((await exactStored(client)).content, head.currentVersion.artifactContent);
  console.log('Public feed ledger runtime verification passed: fresh schema, exact Storage/head, activation, normal publication, reconciliation, removal, no-change removal, rollback, rollback-to-empty, post-rollback publication, target-specific idempotent evidence after later head evolution, pre-intent media authorization and readiness/permission fencing, pre-intent private-source change, media promotion crash with forward recovery and preserved pre-existing objects, committed-response ambiguity, incompatible recovery intent, five crash boundaries, uncertainty fence, explicit phase-safe recovery, concurrency, stale-owner fencing, grants, and immutable history.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Public feed ledger runtime verification failed.');
  process.exitCode = 1;
});
