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

/**
 * Requires the operation guard specifically. `expectPsqlFailure` deliberately accepts several
 * refusal families; a mapping-race claim is only disproved by the guard itself firing.
 */
function expectOperationGuardRejection(sql: string, marker: string): void {
  try {
    psql(sql);
    assert.fail(`${marker} unexpectedly succeeded.`);
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '');
    assert.match(stderr, /PUBLIC_FEED_OPERATION_IN_PROGRESS/, `${marker}: ${stderr}`);
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

async function createReadyPublicationProject(
  client: SupabaseClient,
  publicId: string,
  snapshotCount = 0,
  taxonomy?: { discipline: string; industryCategory: string },
): Promise<string> {
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
    const storagePath = `drafts/${publicId}/${asset.type}/${asset.name}`;
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

  // Gallery snapshots. The readiness authorities require every snapshot to be privately staged
  // under drafts/<publicId>/snapshot_image/, to hold a distinct gallery position from 1 through 10,
  // and to carry usable alt text -- so the fixture has to satisfy the real contract, not a
  // convenient approximation of it.
  for (let position = 1; position <= snapshotCount; position += 1) {
    const name = `snapshot-${position}.png`;
    const storagePath = `drafts/${publicId}/snapshot_image/${name}`;
    const uploaded = await client.storage.from(privateBucket).upload(storagePath, PNG_BYTES, {
      contentType: 'image/png', upsert: false,
    });
    assert.equal(uploaded.error, null, uploaded.error?.message);
    const media = await client.from('media_assets').insert({
      project_id: projectId, asset_type: 'snapshot_image', file_name: name,
      storage_bucket: privateBucket, storage_path: storagePath, public_url: null,
      mime_type: 'image/png', file_size_bytes: PNG_BYTES.length, is_public_approved: false,
      gallery_position: position,
      alt_text_public: `Synthetic gallery image ${position}.`,
    });
    assert.equal(media.error, null, media.error?.message);
  }

  if (taxonomy) {
    const discipline = await client.from('disciplines')
      .insert({ name: taxonomy.discipline }).select('id').single();
    assert.equal(discipline.error, null, discipline.error?.message);
    const disciplineLink = await client.from('project_disciplines').insert({
      project_id: projectId, discipline_id: discipline.data?.id,
    });
    assert.equal(disciplineLink.error, null, disciplineLink.error?.message);

    const industryCategory = await client.from('industry_categories')
      .insert({ name: taxonomy.industryCategory }).select('id').single();
    assert.equal(industryCategory.error, null, industryCategory.error?.message);
    const industryLink = await client.from('project_industry_categories').insert({
      project_id: projectId, industry_category_id: industryCategory.data?.id,
    });
    assert.equal(industryLink.error, null, industryLink.error?.message);
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
    cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
  });
  const local = parseSupabaseCliEnv(raw);
  assert.equal(isLoopbackUrl(local.API_URL ?? ''), true);
  assert.ok(local.SERVICE_ROLE_KEY && local.ANON_KEY);
  runtimeApiUrl = local.API_URL!;
  const client = createClient(local.API_URL!, local.SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const anon = createClient(local.API_URL!, local.ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const ledger = new SupabasePublicFeedLedgerRepositoryCore(client);

  assert.equal(psql('SELECT count(*) FROM supabase_migrations.schema_migrations;'), '43');
  assert.equal(psql("SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version IN ('20260824180000','20260824183000','20260825030000');"), '3');
  assert.equal(psql("SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('public_feed_operations','public_feed_versions','public_feed_version_members','public_feed_head','feed_rollback_preparations','public_feed_operation_events');"), '6');
  assert.equal(psql("SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='public_feed_operations' AND column_name IN ('owner_token_hash','recovery_from_state')"), '2');
  assert.equal(psql("SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='public_feed_operations' AND column_name IN ('owner_token','execution_token')"), '0');
  assert.equal(
    psql("SELECT count(*) FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND c.relname IN ('disciplines','industry_categories') AND t.tgname IN ('guard_discipline_lookup_during_public_feed_operation','guard_industry_category_lookup_during_public_feed_operation');"),
    '2',
  );
  assert.equal(
    psql("SELECT p.prosecdef::text || '|' || COALESCE(pg_catalog.array_to_string(p.proconfig, ','),'') FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='guard_active_public_feed_taxonomy';"),
    'true|search_path=""',
  );
  assert.equal(
    psql("SELECT pg_catalog.has_function_privilege('service_role','public.guard_active_public_feed_taxonomy()','EXECUTE');"),
    'f',
  );
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

  const medical = project('186-rollback-publication');
  const confirmedDiscipline = 'Taxonomy Discipline B';
  const confirmedIndustryCategory = 'Taxonomy Industry B';
  await createReadyPublicationProject(client, medical.publicId, 3, {
    discipline: confirmedDiscipline,
    industryCategory: confirmedIndustryCategory,
  });
  const publication = await executeControlledPublication({
    permissions: ['projects.publish'], publicId: medical.publicId,
    privateBucket: 'project-drafts-private', publicAssetsBucket: 'project-public-assets',
    publicFeedBucket: feedBucket, publicFeedPath: feedPath,
    dependencies: createControlledPublicationDependencies({
      supabase: client, supabaseUrl: runtimeApiUrl, publicId: medical.publicId, adminId,
      privateBucket, publicFeedBucket: feedBucket, publicFeedPath: feedPath, executionTarget: 'local',
    }),
  });
  await assertCompleted(publication, 'rollback-fixture normal publication');
  assert.deepEqual((await exactStored(client)).feed.map(({ publicId }) => publicId), [traffic.publicId, medical.publicId]);

  const removal = await executeControlledPublicRemoval({
    permissions: ['projects.archive'], publicId: traffic.publicId, archiveReason: 'Runtime removal',
    dependencies: {
      supabase: client, adminId, feedBucket, feedPath,
      assertExecutionEnvironment: () => undefined, listProjects: async () => [traffic],
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

  const feedBeforeReconciliation = await exactStored(client);
  const medicalProjectId = psql(`SELECT id FROM public.projects WHERE public_id=${sqlLiteral(medical.publicId)};`);
  const reconciliationEvidenceBefore = {
    operations: psql('SELECT count(*) FROM public.public_feed_operations;'),
    writeStarted: psql("SELECT count(*) FROM public.public_feed_operations WHERE state='WRITE_STARTED';"),
    events: psql('SELECT count(*) FROM public.public_feed_operation_events;'),
    versions: psql('SELECT count(*) FROM public.public_feed_versions;'),
    snapshots: psql('SELECT count(*) FROM public.published_snapshots;'),
    audits: psql(`SELECT count(*) FROM public.approval_records WHERE project_id=(SELECT id FROM public.projects WHERE public_id=${sqlLiteral(medical.publicId)});`),
    generation: psql('SELECT generation FROM public.public_feed_head WHERE singleton=true;'),
    lifecycle: psql(`SELECT status FROM public.projects WHERE public_id=${sqlLiteral(medical.publicId)};`),
    publicMedia: await publicMediaCount(client, medical.publicId),
  };
  // A direct reservation that supplies no confirmation evidence must be refused by the database
  // itself, before any operation row exists. Lifecycle 'published' alone is never authority.
  const evidencelessReconciliation = await ledger.reserve({
    operationKey: randomUUID(), kind: 'publication', mode: 'deployment_reconciliation',
    adminId, publicId: medical.publicId, ownerToken: token(), storageBucket: feedBucket,
    storagePath: feedPath, rollbackCapability: false,
  });
  assert.equal(evidencelessReconciliation.resultCode, 'NOT_READY');
  assert.equal(psql('SELECT count(*) FROM public.public_feed_operations;'), reconciliationEvidenceBefore.operations);

  // Metadata drift since the participant confirmation must be refused with zero side effects, and
  // must be refused by the database gate rather than only by the TypeScript preflight.
  const confirmedTitle = psql(`SELECT title FROM public.projects WHERE public_id=${sqlLiteral(medical.publicId)};`);
  psql(`UPDATE public.projects SET title='Drifted after confirmation' WHERE public_id=${sqlLiteral(medical.publicId)};`);
  const driftedReadiness = await new SupabaseParticipantPreviewRepositoryCore(client)
    .getReconciliationReadiness({ publicId: medical.publicId, adminId, privateBucket });
  assert.equal(driftedReadiness.resultCode, 'PROJECT_SNAPSHOT_STALE');
  assert.equal(driftedReadiness.ready, false);
  const driftedReconciliation = await executeControlledPublication({
    permissions: ['projects.publish'], publicId: medical.publicId,
    privateBucket, publicAssetsBucket, publicFeedBucket: feedBucket, publicFeedPath: feedPath,
    publicationMode: 'deployment_reconciliation',
    dependencies: publicationDependencies(client, medical.publicId),
  });
  assert.equal(driftedReconciliation.resultCode, 'NOT_READY');
  assert.equal((await exactStored(client)).content, feedBeforeReconciliation.content);
  psql(`UPDATE public.projects SET title=${sqlLiteral(confirmedTitle)} WHERE public_id=${sqlLiteral(medical.publicId)};`);

  // Gallery alt-text drift is participant-content drift: position and alt travel with the image.
  const confirmedAlt = psql(`SELECT alt_text_public FROM public.media_assets
    WHERE project_id=(SELECT id FROM public.projects WHERE public_id=${sqlLiteral(medical.publicId)})
      AND asset_type='snapshot_image' AND gallery_position=2;`);
  psql(`UPDATE public.media_assets SET alt_text_public='Drifted alt text.'
    WHERE project_id=(SELECT id FROM public.projects WHERE public_id=${sqlLiteral(medical.publicId)})
      AND asset_type='snapshot_image' AND gallery_position=2;`);
  const altDrift = await new SupabaseParticipantPreviewRepositoryCore(client)
    .getReconciliationReadiness({ publicId: medical.publicId, adminId, privateBucket });
  assert.equal(altDrift.resultCode, 'MEDIA_SNAPSHOT_STALE');
  psql(`UPDATE public.media_assets SET alt_text_public=${sqlLiteral(confirmedAlt)}
    WHERE project_id=(SELECT id FROM public.projects WHERE public_id=${sqlLiteral(medical.publicId)})
      AND asset_type='snapshot_image' AND gallery_position=2;`);

  // A gallery reorder changes snapshot identity even though every file is unchanged. The merged
  // uniqueness constraint is not deferrable, so even a synthetic swap has to move through a free
  // position -- which is itself evidence that position is real identity rather than presentation.
  const swapGalleryPositions = (first: number, second: number) => {
    const scope = `WHERE project_id=(SELECT id FROM public.projects WHERE public_id=${sqlLiteral(medical.publicId)})
      AND asset_type='snapshot_image'`;
    psql(`UPDATE public.media_assets SET gallery_position=10 ${scope} AND gallery_position=${first};`);
    psql(`UPDATE public.media_assets SET gallery_position=${first} ${scope} AND gallery_position=${second};`);
    psql(`UPDATE public.media_assets SET gallery_position=${second} ${scope} AND gallery_position=10;`);
  };
  swapGalleryPositions(1, 3);
  const reorderDrift = await new SupabaseParticipantPreviewRepositoryCore(client)
    .getReconciliationReadiness({ publicId: medical.publicId, adminId, privateBucket });
  assert.equal(reorderDrift.resultCode, 'MEDIA_SNAPSHOT_STALE');
  swapGalleryPositions(1, 3);

  // Adding a fully valid fourth image is still drift: the participant confirmed a three-image
  // gallery, and the confirmed set is what may be redeployed.
  const addedSnapshotPath = `drafts/${medical.publicId}/snapshot_image/snapshot-4.png`;
  const addedUpload = await client.storage.from(privateBucket).upload(addedSnapshotPath, PNG_BYTES, {
    contentType: 'image/png', upsert: false,
  });
  assert.equal(addedUpload.error, null, addedUpload.error?.message);
  const addedSnapshot = await client.from('media_assets').insert({
    project_id: medicalProjectId, asset_type: 'snapshot_image', file_name: 'snapshot-4.png',
    storage_bucket: privateBucket, storage_path: addedSnapshotPath, public_url: null,
    mime_type: 'image/png', file_size_bytes: PNG_BYTES.length, is_public_approved: false,
    gallery_position: 4, alt_text_public: 'Synthetic gallery image 4.',
  }).select('id').single();
  assert.equal(addedSnapshot.error, null, addedSnapshot.error?.message);
  const addDrift = await new SupabaseParticipantPreviewRepositoryCore(client)
    .getReconciliationReadiness({ publicId: medical.publicId, adminId, privateBucket });
  assert.equal(addDrift.resultCode, 'MEDIA_SNAPSHOT_STALE');
  psql(`DELETE FROM public.media_assets WHERE id=${sqlLiteral(String(addedSnapshot.data?.id))}::uuid;`);
  await client.storage.from(privateBucket).remove([addedSnapshotPath]);

  // Removing a confirmed image is drift as well, and the exact row is restored afterwards so the
  // authoritative media identity the participant confirmed is unchanged.
  const removedSnapshot = psql(`SELECT pg_catalog.to_jsonb(ma.*)::text FROM public.media_assets ma
    WHERE ma.project_id=${sqlLiteral(medicalProjectId)}::uuid
      AND ma.asset_type='snapshot_image' AND ma.gallery_position=3;`);
  psql(`DELETE FROM public.media_assets
    WHERE project_id=${sqlLiteral(medicalProjectId)}::uuid
      AND asset_type='snapshot_image' AND gallery_position=3;`);
  const removeDrift = await new SupabaseParticipantPreviewRepositoryCore(client)
    .getReconciliationReadiness({ publicId: medical.publicId, adminId, privateBucket });
  assert.equal(removeDrift.resultCode, 'MEDIA_SNAPSHOT_STALE');
  psql(`INSERT INTO public.media_assets SELECT * FROM pg_catalog.jsonb_populate_record(
    null::public.media_assets, ${sqlLiteral(removedSnapshot)}::jsonb);`);
  const restored = await new SupabaseParticipantPreviewRepositoryCore(client)
    .getReconciliationReadiness({ publicId: medical.publicId, adminId, privateBucket });
  assert.equal(restored.resultCode, 'READY');

  // Nothing above may have touched the deployed artifact or the ledger.
  assert.equal((await exactStored(client)).content, feedBeforeReconciliation.content);
  assert.deepEqual({
    writeStarted: psql("SELECT count(*) FROM public.public_feed_operations WHERE state='WRITE_STARTED';"),
    versions: psql('SELECT count(*) FROM public.public_feed_versions;'),
    snapshots: psql('SELECT count(*) FROM public.published_snapshots;'),
    audits: psql(`SELECT count(*) FROM public.approval_records WHERE project_id=(SELECT id FROM public.projects WHERE public_id=${sqlLiteral(medical.publicId)});`),
    generation: psql('SELECT generation FROM public.public_feed_head WHERE singleton=true;'),
    lifecycle: psql(`SELECT status FROM public.projects WHERE public_id=${sqlLiteral(medical.publicId)};`),
    publicMedia: await publicMediaCount(client, medical.publicId),
  }, {
    writeStarted: reconciliationEvidenceBefore.writeStarted,
    versions: reconciliationEvidenceBefore.versions,
    snapshots: reconciliationEvidenceBefore.snapshots,
    audits: reconciliationEvidenceBefore.audits,
    generation: reconciliationEvidenceBefore.generation,
    lifecycle: reconciliationEvidenceBefore.lifecycle,
    publicMedia: reconciliationEvidenceBefore.publicMedia,
  });

  // Sol review finding 2 alleged that, after PREPARED, a concurrent mutation of the target media
  // row's public_storage_bucket and/or public_url could still pass mark_public_feed_write_started
  // and strand finalization. guard_active_public_feed_operation makes that mutation unreachable for
  // any session that is not already this exact operation, so the claimed ordinary application race
  // is not demonstrated. This scenario is permanent evidence for that, and would fail loudly if the
  // guard were ever narrowed.
  const mappingGuardToken = token();
  const mappingGuardReadiness = await new SupabaseParticipantPreviewRepositoryCore(client)
    .getReconciliationReadiness({ publicId: medical.publicId, adminId, privateBucket });
  assert.equal(mappingGuardReadiness.resultCode, 'READY');
  const mappingGuardReservation = await ledger.reserve({
    operationKey: randomUUID(), kind: 'publication', mode: 'deployment_reconciliation',
    adminId, publicId: medical.publicId, ownerToken: mappingGuardToken,
    confirmedPreviewId: mappingGuardReadiness.confirmedPreviewId,
    confirmedAt: mappingGuardReadiness.confirmedAt, privateBucket,
    storageBucket: feedBucket, storagePath: feedPath, rollbackCapability: false,
  });
  assert.equal(mappingGuardReservation.resultCode, 'OPERATION_RESERVED', JSON.stringify(mappingGuardReservation));
  const mappingGuardOperationId = String(mappingGuardReservation.operationId);
  const mappingGuardEpoch = Number(mappingGuardReservation.ownerEpoch);
  assert.equal(
    psql(`SELECT state FROM public.public_feed_operations WHERE id=${sqlLiteral(mappingGuardOperationId)}::uuid;`),
    'RESERVED',
  );

  // The target already carries a complete public mapping, so neither mutation below can be refused
  // by the all-or-nothing mapping constraint. Only the operation guard can reject them.
  const mappingScope = `WHERE project_id=${sqlLiteral(medicalProjectId)}::uuid AND asset_type='poster_image'`;
  const mappingSelect = `SELECT COALESCE(public_storage_bucket,'') || '|' || COALESCE(public_storage_path,'')
    || '|' || COALESCE(public_url,'') || '|' || is_public_approved::text
    FROM public.media_assets ${mappingScope};`;
  const mappingBefore = psql(mappingSelect);
  assert.ok(mappingBefore.startsWith(`${publicAssetsBucket}|`), `Expected an existing public mapping, got ${mappingBefore}`);
  const feedBeforeMappingGuard = await exactStored(client);
  const headGenerationBeforeMappingGuard = psql('SELECT generation FROM public.public_feed_head WHERE singleton=true;');
  const publicMediaBeforeMappingGuard = await publicMediaCount(client, medical.publicId);

  // The participant confirmed the lookup names, not merely the relationship-row identifiers.
  // Before this forward guard, B -> C could happen after reservation, candidate preparation could
  // bind C, and C -> B could restore the final readiness snapshot before WRITE_STARTED. Freezing
  // only project_disciplines/project_industry_categories did not close that ABA window.
  const disciplineId = psql(`SELECT d.id::text FROM public.disciplines d
    JOIN public.project_disciplines pd ON pd.discipline_id=d.id
    WHERE pd.project_id=${sqlLiteral(medicalProjectId)}::uuid;`);
  const industryCategoryId = psql(`SELECT ic.id::text FROM public.industry_categories ic
    JOIN public.project_industry_categories pic ON pic.industry_category_id=ic.id
    WHERE pic.project_id=${sqlLiteral(medicalProjectId)}::uuid;`);
  const taxonomyEvidence = psql(`SELECT (pp.snapshot->'disciplines')::text || '|' ||
      (pp.snapshot->'industryCategories')::text
    FROM public.participant_previews pp
    WHERE pp.project_id=${sqlLiteral(medicalProjectId)}::uuid AND pp.status='active';`);
  assert.equal(
    taxonomyEvidence,
    `${JSON.stringify([confirmedDiscipline])}|${JSON.stringify([confirmedIndustryCategory])}`,
  );
  const disciplineLinkBefore = psql(`SELECT project_id::text || '|' || discipline_id::text
    FROM public.project_disciplines WHERE project_id=${sqlLiteral(medicalProjectId)}::uuid;`);
  const industryLinkBefore = psql(`SELECT project_id::text || '|' || industry_category_id::text
    FROM public.project_industry_categories WHERE project_id=${sqlLiteral(medicalProjectId)}::uuid;`);

  // Raw service-role-equivalent SQL is fenced for both UPDATE and DELETE.
  expectOperationGuardRejection(
    `UPDATE public.disciplines SET name='Taxonomy Discipline C' WHERE id=${sqlLiteral(disciplineId)}::uuid;`,
    'post-reservation referenced discipline rename',
  );
  expectOperationGuardRejection(
    `DELETE FROM public.disciplines WHERE id=${sqlLiteral(disciplineId)}::uuid;`,
    'post-reservation referenced discipline delete',
  );
  expectOperationGuardRejection(
    `UPDATE public.industry_categories SET name='Taxonomy Industry C' WHERE id=${sqlLiteral(industryCategoryId)}::uuid;`,
    'post-reservation referenced industry-category rename',
  );
  expectOperationGuardRejection(
    `DELETE FROM public.industry_categories WHERE id=${sqlLiteral(industryCategoryId)}::uuid;`,
    'post-reservation referenced industry-category delete',
  );

  // PostgREST's normal service-role path reaches the same bounded trigger refusal.
  const restDisciplineMutation = await client.from('disciplines')
    .update({ name: 'Taxonomy Discipline C' }).eq('id', disciplineId);
  assert.ok(restDisciplineMutation.error, 'Service-role discipline rename unexpectedly succeeded.');
  assert.match(String(restDisciplineMutation.error?.message ?? ''), /PUBLIC_FEED_OPERATION_IN_PROGRESS/);
  const restIndustryMutation = await client.from('industry_categories')
    .update({ name: 'Taxonomy Industry C' }).eq('id', industryCategoryId);
  assert.ok(restIndustryMutation.error, 'Service-role industry-category rename unexpectedly succeeded.');
  assert.match(String(restIndustryMutation.error?.message ?? ''), /PUBLIC_FEED_OPERATION_IN_PROGRESS/);

  // An active operation freezes only taxonomy referenced by its target. Independent lookup rows
  // remain mutable, and INSERT remains available because a new row alone changes no project.
  const unrelatedDiscipline = await client.from('disciplines')
    .insert({ name: 'Unrelated Discipline B' }).select('id').single();
  assert.equal(unrelatedDiscipline.error, null, unrelatedDiscipline.error?.message);
  const unrelatedDisciplineId = String(unrelatedDiscipline.data?.id);
  assert.equal((await client.from('disciplines').update({ name: 'Unrelated Discipline C' })
    .eq('id', unrelatedDisciplineId)).error, null);
  assert.equal(psql(`SELECT name FROM public.disciplines WHERE id=${sqlLiteral(unrelatedDisciplineId)}::uuid;`), 'Unrelated Discipline C');
  assert.equal((await client.from('disciplines').update({ name: 'Unrelated Discipline B' })
    .eq('id', unrelatedDisciplineId)).error, null);

  const unrelatedIndustry = await client.from('industry_categories')
    .insert({ name: 'Unrelated Industry B' }).select('id').single();
  assert.equal(unrelatedIndustry.error, null, unrelatedIndustry.error?.message);
  const unrelatedIndustryId = String(unrelatedIndustry.data?.id);
  assert.equal((await client.from('industry_categories').update({ name: 'Unrelated Industry C' })
    .eq('id', unrelatedIndustryId)).error, null);
  assert.equal(psql(`SELECT name FROM public.industry_categories WHERE id=${sqlLiteral(unrelatedIndustryId)}::uuid;`), 'Unrelated Industry C');
  assert.equal((await client.from('industry_categories').update({ name: 'Unrelated Industry B' })
    .eq('id', unrelatedIndustryId)).error, null);

  assert.equal((await client.from('disciplines').delete().eq('id', unrelatedDisciplineId)).error, null);
  assert.equal((await client.from('industry_categories').delete().eq('id', unrelatedIndustryId)).error, null);

  assert.equal(psql(`SELECT name FROM public.disciplines WHERE id=${sqlLiteral(disciplineId)}::uuid;`), confirmedDiscipline);
  assert.equal(psql(`SELECT name FROM public.industry_categories WHERE id=${sqlLiteral(industryCategoryId)}::uuid;`), confirmedIndustryCategory);
  assert.equal(psql(`SELECT project_id::text || '|' || discipline_id::text
    FROM public.project_disciplines WHERE project_id=${sqlLiteral(medicalProjectId)}::uuid;`), disciplineLinkBefore);
  assert.equal(psql(`SELECT project_id::text || '|' || industry_category_id::text
    FROM public.project_industry_categories WHERE project_id=${sqlLiteral(medicalProjectId)}::uuid;`), industryLinkBefore);

  // Service-role SQL path, without the operation's internal app.public_feed_operation_id marker.
  expectOperationGuardRejection(
    `UPDATE public.media_assets SET public_storage_bucket='verifier-remapped-bucket' ${mappingScope};`,
    'post-reservation public_storage_bucket mutation',
  );
  expectOperationGuardRejection(
    `UPDATE public.media_assets SET public_url='https://remapped.invalid/poster.png' ${mappingScope};`,
    'post-reservation public_url mutation',
  );

  // Service-role PostgREST path -- the normal application/verifier route, not just raw SQL.
  const restBucketMutation = await client.from('media_assets')
    .update({ public_storage_bucket: 'verifier-remapped-bucket' })
    .eq('project_id', medicalProjectId).eq('asset_type', 'poster_image');
  assert.ok(restBucketMutation.error, 'Service-role public_storage_bucket mutation unexpectedly succeeded.');
  assert.match(String(restBucketMutation.error?.message ?? ''), /PUBLIC_FEED_OPERATION_IN_PROGRESS/);
  const restUrlMutation = await client.from('media_assets')
    .update({ public_url: 'https://remapped.invalid/poster.png' })
    .eq('project_id', medicalProjectId).eq('asset_type', 'poster_image');
  assert.ok(restUrlMutation.error, 'Service-role public_url mutation unexpectedly succeeded.');
  assert.match(String(restUrlMutation.error?.message ?? ''), /PUBLIC_FEED_OPERATION_IN_PROGRESS/);

  // The media row is unchanged, the operation is still valid, and the rejected mutations produced
  // no public media object and no canonical feed write.
  assert.equal(psql(mappingSelect), mappingBefore);
  assert.equal(
    psql(`SELECT state || '|' || COALESCE(failure_code,'') || '|' || owner_epoch::text
      FROM public.public_feed_operations WHERE id=${sqlLiteral(mappingGuardOperationId)}::uuid;`),
    `RESERVED||${mappingGuardEpoch}`,
  );
  assert.equal(await publicMediaCount(client, medical.publicId), publicMediaBeforeMappingGuard);
  assert.equal((await exactStored(client)).content, feedBeforeMappingGuard.content);
  assert.equal(psql('SELECT generation FROM public.public_feed_head WHERE singleton=true;'), headGenerationBeforeMappingGuard);

  // Released through the real owner-authenticated RPC, which also re-proves the operation was still
  // owned and valid rather than collaterally damaged by the rejected mutations.
  const mappingGuardRelease = await ledger.fail(
    mappingGuardOperationId, mappingGuardEpoch, mappingGuardToken, adminId, 'VERIFIER_MAPPING_GUARD_PROBE',
  );
  assert.equal(mappingGuardRelease.resultCode, 'FAILED', JSON.stringify(mappingGuardRelease));
  assert.equal(await publicMediaCount(client, medical.publicId), publicMediaBeforeMappingGuard);

  // The legitimate case: lifecycle-published, absent from the current head after a rollback, and
  // still backed by the exact participant confirmation it was published under.
  const postRollback = await executeControlledPublication({
    permissions: ['projects.publish'], publicId: medical.publicId,
    privateBucket, publicAssetsBucket, publicFeedBucket: feedBucket, publicFeedPath: feedPath,
    publicationMode: 'deployment_reconciliation',
    dependencies: publicationDependencies(client, medical.publicId),
  });
  await assertCompleted(postRollback, 'deployment reconciliation after rollback');

  // The head changed and the target is deployed again.
  head = await ledger.getHead();
  assert.ok(head);
  assert.equal(head.currentVersion.operation, 'publication');
  assert.equal(head.currentVersion.publicationMode, 'deployment_reconciliation');
  assert.equal(head.currentVersion.affectedPublicId, medical.publicId);
  const reconciledFeed = await exactStored(client);
  assert.equal(reconciledFeed.content, head.currentVersion.artifactContent);
  assert.deepEqual(reconciledFeed.feed.map(({ publicId }) => publicId), [traffic.publicId, medical.publicId]);
  assert.equal(
    psql(`SELECT count(*) FROM public.public_feed_version_members WHERE version_id=(SELECT current_version_id FROM public.public_feed_head WHERE singleton=true) AND public_id=${sqlLiteral(medical.publicId)};`),
    '1',
  );

  // The reconciled record carries the exact multi-image representation, in deterministic gallery
  // order, with each URL and its text alternative travelling as one unit.
  const reconciledRecord = reconciledFeed.feed.find((record) => record.publicId === medical.publicId);
  assert.ok(reconciledRecord, 'Reconciled target missing from the deployed feed.');
  const expectedSnapshotUrls = [1, 2, 3].map((position) =>
    `${runtimeApiUrl}/storage/v1/object/public/${publicAssetsBucket}/published/${medical.publicId}/snapshot_image/snapshot-${position}.png`);
  assert.deepEqual(reconciledRecord.snapshots, expectedSnapshotUrls);
  assert.deepEqual(reconciledRecord.snapshotMedia, [1, 2, 3].map((position) => ({
    url: expectedSnapshotUrls[position - 1],
    altText: `Synthetic gallery image ${position}.`,
    galleryPosition: position,
  })));

  // Reconciliation is deployment-only: no lifecycle transition and no fabricated publish audit.
  assert.equal(psql(`SELECT status FROM public.projects WHERE public_id=${sqlLiteral(medical.publicId)};`), 'published');
  assert.equal(
    psql(`SELECT count(*) FROM public.approval_records WHERE project_id=(SELECT id FROM public.projects WHERE public_id=${sqlLiteral(medical.publicId)});`),
    reconciliationEvidenceBefore.audits,
  );
  assert.equal(
    psql("SELECT count(*) FROM public.public_feed_versions WHERE operation='publication' AND publication_mode='deployment_reconciliation';"),
    '1',
  );
  // The already-promoted public objects were re-asserted, never duplicated or overwritten.
  assert.equal(await publicMediaCount(client, medical.publicId), 5);

  // A retry answers with the target's OWN completion evidence rather than whichever operation
  // happens to own the head.
  const reconciliationEvidence = targetEvidence(medical.publicId);
  const retriedReconciliation = await executeControlledPublication({
    permissions: ['projects.publish'], publicId: medical.publicId,
    privateBucket, publicAssetsBucket, publicFeedBucket: feedBucket, publicFeedPath: feedPath,
    publicationMode: 'deployment_reconciliation',
    dependencies: publicationDependencies(client, medical.publicId),
  });
  assert.equal(retriedReconciliation.resultCode, 'ALREADY_COMPLETED');
  assert.equal(
    retriedReconciliation.resultCode === 'ALREADY_COMPLETED' ? retriedReconciliation.attemptId : null,
    reconciliationEvidence.operationId,
  );
  assert.equal((await exactStored(client)).content, reconciledFeed.content);

  await assertCompleted(await executeControlledPublicRemoval({
    permissions: ['projects.archive'], publicId: traffic.publicId, archiveReason: 'Create empty rollback target',
    dependencies: {
      supabase: client, adminId, feedBucket, feedPath,
      assertExecutionEnvironment: () => undefined,
      listProjects: async () => [project(traffic.publicId, 'archived')],
    },
  }), 'remove rollback-restored archived member');
  await assertCompleted(await executeControlledPublicRemoval({
    permissions: ['projects.archive'], publicId: medical.publicId, archiveReason: 'Create empty rollback target',
    dependencies: {
      supabase: client, adminId, feedBucket, feedPath,
      assertExecutionEnvironment: () => undefined, listProjects: async () => [medical],
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
      assertExecutionEnvironment: () => undefined,
      listProjects: async () => [project(crashPublicId)],
    },
  }), 'remove media crash fixture');
  for (const publicId of [normalPublicId, laterPublicId]) {
    await assertCompleted(await executeControlledPublicRemoval({
      permissions: ['projects.archive'], publicId, archiveReason: 'Restore rollback baseline',
      dependencies: {
        supabase: client, adminId, feedBucket, feedPath,
        assertExecutionEnvironment: () => undefined,
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

  const responseLossPublicId = '186-response-loss-target';
  await createReadyPublicationProject(client, responseLossPublicId);
  const postZeroRollback = await executeControlledPublication({
    permissions: ['projects.publish'], publicId: responseLossPublicId,
    privateBucket, publicAssetsBucket, publicFeedBucket: feedBucket, publicFeedPath: feedPath,
    dependencies: createControlledPublicationDependencies({
      supabase: client, supabaseUrl: runtimeApiUrl, publicId: responseLossPublicId, adminId,
      privateBucket, publicFeedBucket: feedBucket, publicFeedPath: feedPath, executionTarget: 'local',
    }),
  });
  await assertCompleted(postZeroRollback, 'post-zero-rollback normal publication');
  assert.deepEqual((await exactStored(client)).feed.map(({ publicId }) => publicId), [responseLossPublicId]);

  const committedLoss = await stageCommittedRemovalResponseLoss(client, ledger, responseLossPublicId);
  assert.equal(
    (await resumeRemoval(client, responseLossPublicId, RESPONSE_LOSS_REASON)).resultCode,
    'PUBLICATION_IN_PROGRESS',
  );
  psql(`UPDATE public.public_feed_operations
    SET lease_expires_at=pg_catalog.now()-interval '1 second', storage_uncertainty_until=pg_catalog.now()-interval '1 second'
    WHERE id=${sqlLiteral(committedLoss.operationId)}::uuid;`);
  // An expired durable operation is only adoptable by a request carrying the identical immutable
  // intent; a different archive reason is a different authorization and must stay fenced out.
  assert.equal(
    (await resumeRemoval(client, responseLossPublicId, 'Materially different archive reason')).resultCode,
    'PUBLICATION_IN_PROGRESS',
  );
  assert.equal(
    (await ledger.getOperation(committedLoss.operationId))?.archiveReason,
    RESPONSE_LOSS_REASON,
  );
  await assertCompleted(
    await resumeRemoval(client, responseLossPublicId, RESPONSE_LOSS_REASON),
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
  console.log('Public feed ledger runtime verification passed: fresh 43-migration schema, exact Storage/head, activation, normal publication, multi-image gallery publication, deployment reconciliation of a lifecycle-published target with exact snapshot/alt/position representation and no lifecycle or audit replay, database-enforced refusal of evidence-less reservation, metadata, alt-text, gallery reorder, gallery add and gallery remove drift refused with zero durable, external or lifecycle effects, referenced discipline and industry-category UPDATE/DELETE refusal through raw SQL and PostgREST, unrelated taxonomy mutability, removal, no-change removal, rollback, rollback-to-empty, post-rollback normal publication, target-specific idempotent evidence after later head evolution, pre-intent media authorization and readiness/permission fencing, pre-intent private-source change, media promotion crash with forward recovery and preserved pre-existing objects, committed-response ambiguity, incompatible recovery intent, five crash boundaries, uncertainty fence, explicit phase-safe recovery, concurrency, stale-owner fencing, grants, and immutable history.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Public feed ledger runtime verification failed.');
  process.exitCode = 1;
});
