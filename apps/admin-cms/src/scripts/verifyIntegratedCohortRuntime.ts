import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AuthenticatedAdminContext } from '../auth/authTypes';
import { getPermissionsForRoles } from '../auth/permissions';
import { loadAssistiveInput } from '../assistive-validation/services/assistiveInputService';
import { rankDuplicateCandidates } from '../assistive-validation/duplicate-detection/duplicateRanker';
import { SupabaseAssistiveInputRepository } from '../assistive-validation/repositories/assistiveInputRepository';
import { validatePublicFeed } from '../feed/validatePublicFeed';
import { verifyPublicFeedArtifact } from '../feed/publicFeedArtifact';
import {
  assertExactIdentitySet,
  buildIntegratedCohortFixture,
  INTEGRATED_COHORT_SIZE,
  INTEGRATED_DISCIPLINES,
  INTEGRATED_FORM_COUNT,
  INTEGRATED_INDUSTRIES,
  INTEGRATED_PACKAGE_COUNT,
  INTEGRATED_PROGRAMS,
  type IntegratedCohortBatch,
  type IntegratedCohortFixture,
} from '../fixtures/integratedCohort';
import { createSyntheticWorkbookBuffer, materializeSyntheticImportBatch } from '../fixtures/syntheticImportPackages';
import { runBrowserImportManifestPreflight } from '../import/browserImportPreviewContract';
import { computeCanonicalIntentHash } from '../import/browserImportMetadataStageServerCore';
import { resolveExpectedBrowserImportMedia } from '../import/browserImportMediaSelection';
import { analyzeBrowserImportServer } from '../import/parseBrowserImportPreview';
import { prepareBrowserImportCommitIntent } from '../import/prepareBrowserImportCommitIntentCore';
import { stageBrowserImportMedia, type MediaFileToStage } from '../import/stageBrowserImportMedia';
import { stageBrowserImportMetadata } from '../import/stageBrowserImportMetadata';
import { executeParticipantPreviewNotification } from '../notifications/participantPreviewNotificationService';
import type { ParticipantPreviewEmailTransport } from '../notifications/participantPreviewEmailTransport';
import { executeControlledPublication } from '../projects/controlledPublicationService';
import { createControlledPublicationDependencies } from '../projects/createControlledPublicationDependencies';
import { inspectPublicFeedHead } from '../projects/publicFeedWriterCoordinator';
import { BulkReviewService } from '../projects/bulkProjectReviewService';
import type { BulkReviewAction, BulkReviewActor } from '../projects/bulkProjectReview';
import { SupabaseBulkProjectReviewGateway } from '../projects/SupabaseBulkProjectReviewGateway';
import { ImportBatchRepositoryCore } from '../repositories/ImportBatchRepositoryCore';
import { SupabaseParticipantPreviewNotificationRepositoryCore } from '../repositories/SupabaseParticipantPreviewNotificationRepositoryCore';
import { SupabaseParticipantPreviewRepositoryCore } from '../repositories/SupabaseParticipantPreviewRepositoryCore';
import { computeReadinessForImportBatchRow } from '../import/importBatchReviewReadiness';
import { validateMediaAssetBytes } from '../storage/mediaValidationCore';
import {
  createPublicFeedRuntimeHarness,
  PRIVATE_BUCKET,
  PUBLIC_ASSETS_BUCKET,
  PUBLIC_FEED_BUCKET,
  PUBLIC_FEED_PATH,
  type PublicFeedRuntimeHarness,
} from './publicFeedRuntimeSupport';

const REPOSITORY_ROOT = path.resolve(__dirname, '../../../..');
const PUBLIC_ID_PREFIX = 'lv01-integrated-';

interface IdentityCheckpoint {
  stage: string;
  count: number;
  exactSet: boolean;
}

interface Lv01Evidence {
  classification: string;
  exactHead: string;
  manifest: { digest: string; count: number; package: number; form: number };
  distribution: Record<string, Record<string, number>>;
  checkpoints: IdentityCheckpoint[];
  adminReference: { expectedMatches: number; actualMatches: number; ambiguous: number; unresolved: number; mismatchControl: string };
  intake: { analyzed: number; stagedProjects: number; completedBatches: number; mediaAssets: number };
  validation: { deterministicReady: number; assistiveInputsLoaded: number; assistiveDuplicateRankings: number; authority: string };
  review: { submitted: number; approved: number; auditRows: number; duplicateAudits: number; boundedBatches: number[] };
  participant: { previews: number; notificationsSentToLocalCapture: number; confirmations: number; ready: number };
  publication: Record<string, number | string | boolean>;
  publicMedia: { bindings: number; byteMatches: number; privateReferencesInFeed: number };
  finalFeed: { count: number; hash: string; schemaValid: boolean; headMatchesStoredBytes: boolean };
  renderer: { passed: boolean; evidencePath: string };
  negativeControls: Record<string, string>;
  containment: Record<string, string | boolean>;
}

function ensure(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function countBy(values: readonly string[]): Record<string, number> {
  return Object.fromEntries([...values.reduce((map, value) => map.set(value, (map.get(value) || 0) + 1), new Map<string, number>())]
    .sort(([left], [right]) => left.localeCompare(right)));
}

function exactHead(): string {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPOSITORY_ROOT, encoding: 'utf8' }).trim();
  const status = execFileSync('git', ['status', '--short', '--untracked-files=no'], { cwd: REPOSITORY_ROOT, encoding: 'utf8' }).trim();
  ensure(status === '', 'LV01_RUNTIME_REQUIRES_CLEAN_COMMITTED_HEAD');
  return head;
}

function checkpoint(expected: readonly string[], actual: readonly string[], stage: string): IdentityCheckpoint {
  assertExactIdentitySet(expected, actual, stage);
  return { stage, count: actual.length, exactSet: true };
}

async function seedSyntheticTaxonomy(harness: PublicFeedRuntimeHarness): Promise<void> {
  for (const [table, names] of [
    ['programs', INTEGRATED_PROGRAMS],
    ['disciplines', INTEGRATED_DISCIPLINES],
    ['industry_categories', INTEGRATED_INDUSTRIES],
  ] as const) {
    const result = await harness.db.from(table).upsert(names.map((name) => ({ name })), { onConflict: 'name' });
    ensure(!result.error, 'LV01_SYNTHETIC_TAXONOMY_SEED_FAILED');
  }
}

async function stageBatch(
  fixture: IntegratedCohortFixture,
  batch: IntegratedCohortBatch,
  authContext: AuthenticatedAdminContext,
): Promise<{ analyzedIds: string[]; batchId: string; mediaCount: number; reconciliationMatches: number }> {
  const analysis = await analyzeBrowserImportServer(
    batch.materialized.selectionManifest,
    batch.materialized.uploadedMetadataFiles,
    fixture.adminReference,
  );
  ensure(analysis.preview.success, 'LV01_CANONICAL_ANALYSIS_FAILED');
  ensure(analysis.packages.every((item) => item.status === 'valid'), 'LV01_CANONICAL_PACKAGE_INVALID');
  const reconciliationMatches = analysis.packages.filter((item) => item.reconciliation?.status === 'RECONCILED').length;
  ensure(reconciliationMatches === batch.entries.length, 'LV01_ADMIN_REFERENCE_RECONCILIATION_FAILED');
  const selectedPackagePaths = analysis.packages.map((item) => item.packagePath);
  const prepared = prepareBrowserImportCommitIntent({
    manifest: batch.materialized.selectionManifest,
    preview: analysis.preview.batch,
    selectedPackagePaths,
    acknowledgedWarningPackagePaths: [],
    expectedPreviewFingerprint: analysis.preview.batch.previewFingerprint,
    adminReference: analysis.preview.batch.adminReference,
  });
  ensure(prepared.success, 'LV01_COMMIT_INTENT_FAILED');
  const metadata = await stageBrowserImportMetadata({ authContext, serverAnalysis: analysis, intent: prepared.intent });
  ensure(metadata.success, 'LV01_METADATA_STAGING_FAILED');
  const preflight = runBrowserImportManifestPreflight(batch.materialized.selectionManifest);
  ensure(preflight.success, 'LV01_MEDIA_PREFLIGHT_FAILED');
  const expectedMedia = resolveExpectedBrowserImportMedia({ preflight, packages: analysis.packages, selectedPackagePaths });
  ensure(expectedMedia.success, 'LV01_MEDIA_RESOLUTION_FAILED');
  const files: MediaFileToStage[] = expectedMedia.files.map((file) => {
    const content = batch.materialized.uploadedFiles.get(file.uploadKey);
    ensure(content, 'LV01_MEDIA_BYTES_MISSING');
    const validated = validateMediaAssetBytes({
      fileName: file.fileName, content, expectedMimeType: file.canonicalMimeType,
      expectedFileSizeBytes: file.fileSizeBytes,
    });
    ensure(validated.valid, 'LV01_MEDIA_BYTES_INVALID');
    return { ...file, content };
  });
  const media = await stageBrowserImportMedia({
    authContext,
    batchId: metadata.batchId,
    metadataIntentHash: computeCanonicalIntentHash(prepared.intent),
    files,
  });
  ensure(media.success, 'LV01_MEDIA_STAGING_FAILED');
  return {
    analyzedIds: analysis.packages.map((item) => item.proposedPublicId),
    batchId: metadata.batchId,
    mediaCount: files.length,
    reconciliationMatches,
  };
}

async function assertAdminMismatchControl(fixture: IntegratedCohortFixture): Promise<string> {
  const source = fixture.packages[0].project;
  const publicId = 'lv01-control-admin-mismatch';
  const control = { ...source, publicId, title: 'Synthetic Admin Mismatch Control' };
  const metadataBuffer = await createSyntheticWorkbookBuffer(control, { participantContactEmail: 'lv01-control@capstone.invalid' });
  const mediaFiles = fixture.packages[0].mediaFiles;
  const batch = materializeSyntheticImportBatch('lv01-control-admin-mismatch-batch', [{
    publicId, packagePath: `lv01-control-admin-mismatch-batch/${publicId}`,
    metadataFileName: 'project-details.xlsx', metadataBuffer, mediaFiles,
  }]);
  const analysis = await analyzeBrowserImportServer(batch.selectionManifest, batch.uploadedMetadataFiles, fixture.adminReference);
  const item = analysis.packages[0];
  ensure(item.status === 'invalid' && item.reconciliation?.status === 'ADMIN_REFERENCE_NO_MATCH', 'LV01_ADMIN_MISMATCH_CONTROL_FAILED');
  return item.reconciliation.status;
}

async function bulkTransition(
  service: BulkReviewService,
  actor: BulkReviewActor,
  action: BulkReviewAction,
  publicIds: readonly string[],
): Promise<number> {
  let successful = 0;
  for (const cohort of chunks(publicIds, 50)) {
    const preflight = await service.preflight({ action, publicIds: cohort, actor });
    assertExactIdentitySet(cohort, preflight.items.map((item) => item.publicId), `${action.toUpperCase()}_PREFLIGHT`);
    ensure(preflight.items.every((item) => item.disposition === 'eligible'), `LV01_${action.toUpperCase()}_PREFLIGHT_REJECTED`);
    const expectedUpdatedAt = Object.fromEntries(preflight.items.map((item) => [item.publicId, item.updatedAt]));
    const result = await service.execute({ action, publicIds: cohort, expectedUpdatedAt, actor });
    assertExactIdentitySet(cohort, result.items.map((item) => item.publicId), `${action.toUpperCase()}_EXECUTION`);
    ensure(result.items.every((item) => item.outcome === 'successful' && item.auditRecorded), `LV01_${action.toUpperCase()}_EXECUTION_FAILED`);
    successful += result.summary.successful;
  }
  return successful;
}

function executePublication(harness: PublicFeedRuntimeHarness, publicId: string, role: 'admin' | 'reviewer' = 'admin') {
  return executeControlledPublication({
    permissions: getPermissionsForRoles([role]),
    publicId,
    privateBucket: PRIVATE_BUCKET,
    publicAssetsBucket: PUBLIC_ASSETS_BUCKET,
    publicFeedBucket: PUBLIC_FEED_BUCKET,
    publicFeedPath: PUBLIC_FEED_PATH,
    dependencies: createControlledPublicationDependencies({
      supabase: harness.db, supabaseUrl: harness.apiUrl, publicId,
      adminId: role === 'admin' ? harness.adminId : harness.reviewerId,
      privateBucket: PRIVATE_BUCKET, publicFeedBucket: PUBLIC_FEED_BUCKET,
      publicFeedPath: PUBLIC_FEED_PATH, executionTarget: 'local',
    }),
  });
}

function ledgerCounts(harness: PublicFeedRuntimeHarness): Record<string, number> {
  const pattern = harness.quoted(`${PUBLIC_ID_PREFIX}%`);
  const raw = harness.psql(`SELECT
    (SELECT count(*) FROM public.public_feed_operations WHERE kind='publication' AND public_id LIKE ${pattern})::text || '|' ||
    (SELECT count(*) FROM public.public_feed_operations WHERE kind='publication' AND public_id LIKE ${pattern} AND state='COMPLETED')::text || '|' ||
    (SELECT count(*) FROM public.public_feed_versions WHERE operation='publication' AND affected_public_id LIKE ${pattern})::text || '|' ||
    (SELECT count(*) FROM public.approval_records ar JOIN public.public_feed_versions v ON v.audit_record_id=ar.id WHERE v.operation='publication' AND v.affected_public_id LIKE ${pattern} AND ar.action_taken='publish')::text || '|' ||
    (SELECT count(*) FROM public.projects WHERE public_id LIKE ${pattern} AND status='published')::text || '|' ||
    (SELECT count(*) FROM public.public_feed_operations WHERE state IN ('RESERVED','PREPARED','WRITE_STARTED','CANDIDATE_OBSERVED','DB_FINALIZED','RECOVERY_REQUIRED'))::text;`);
  const values = raw.split('|').map(Number);
  ensure(values.length === 6 && values.every(Number.isSafeInteger), 'LV01_LEDGER_COUNTS_UNAVAILABLE');
  return {
    publicationOperations: values[0], completedPublications: values[1], publicationVersions: values[2],
    publicationAuditRecords: values[3], publishedProjects: values[4], activePublicationOperations: values[5],
  };
}

async function verifyPublicMedia(harness: PublicFeedRuntimeHarness, fixture: IntegratedCohortFixture): Promise<{ bindings: number; byteMatches: number }> {
  let bindings = 0;
  let byteMatches = 0;
  for (const item of fixture.packages) {
    const project = await harness.db.from('projects').select('id').eq('public_id', item.entry.publicId).single();
    ensure(!project.error && project.data, 'LV01_MEDIA_PROJECT_MISSING');
    const rows = await harness.db.from('media_assets').select('asset_type,file_name,public_storage_bucket,public_storage_path,is_public_approved')
      .eq('project_id', project.data.id);
    ensure(!rows.error && rows.data?.length === item.mediaFiles.length, 'LV01_PUBLIC_MEDIA_BINDING_COUNT_INVALID');
    for (const source of item.mediaFiles) {
      const assetType = source.fileName === 'poster.png' ? 'poster_image'
        : source.fileName === 'poster.pdf' ? 'poster_pdf' : 'snapshot_image';
      const row = rows.data!.find((candidate) => candidate.asset_type === assetType && candidate.file_name === source.fileName);
      ensure(row && row.is_public_approved === true && row.public_storage_bucket === PUBLIC_ASSETS_BUCKET, 'LV01_PUBLIC_MEDIA_BINDING_INVALID');
      ensure(row.public_storage_path === `published/${item.entry.publicId}/${assetType}/${source.fileName}`, 'LV01_PUBLIC_MEDIA_PATH_INVALID');
      const downloaded = await harness.db.storage.from(PUBLIC_ASSETS_BUCKET).download(row.public_storage_path);
      ensure(!downloaded.error && downloaded.data, 'LV01_PUBLIC_MEDIA_MISSING');
      ensure(Buffer.from(await downloaded.data.arrayBuffer()).equals(source.content), 'LV01_PUBLIC_MEDIA_BYTES_MISMATCH');
      bindings += 1;
      byteMatches += 1;
    }
  }
  return { bindings, byteMatches };
}

function renderMarkdown(evidence: Lv01Evidence): string {
  return `# LV-01 Integrated 120-project cohort evidence\n\n` +
    `- Classification: ${evidence.classification}\n` +
    `- Exact clean HEAD: \`${evidence.exactHead}\`\n` +
    `- Frozen manifest SHA-256: \`${evidence.manifest.digest}\`\n` +
    `- Cohort: ${evidence.manifest.count} (${evidence.manifest.package} package, ${evidence.manifest.form} standardized-form)\n` +
    `- Intake/staging: ${evidence.intake.stagedProjects} projects, ${evidence.intake.completedBatches} completed batches, ${evidence.intake.mediaAssets} private media assets\n` +
    `- Review: ${evidence.review.submitted} submitted, ${evidence.review.approved} approved, ${evidence.review.auditRows} workflow audits\n` +
    `- Participant: ${evidence.participant.previews} previews, ${evidence.participant.notificationsSentToLocalCapture} local-capture sends, ${evidence.participant.confirmations} confirmations, ${evidence.participant.ready} ready\n` +
    `- Publication: ${evidence.publication.completedPublications} completed governed publications; ${evidence.publication.activePublicationOperations} active operations\n` +
    `- Final feed: ${evidence.finalFeed.count} records; SHA-256 \`${evidence.finalFeed.hash}\`\n` +
    `- Exact-feed production renderer: ${evidence.renderer.passed ? 'PASS' : 'FAIL'}\n` +
    `- Hosted contact: NO; production publication: NO; real email: NO\n` +
    `- Scope: local BRIEF-SC02 evidence only; no PP1 completion claim.\n`;
}

async function main(): Promise<void> {
  const head = exactHead();
  const harness = await createPublicFeedRuntimeHarness();
  const fixture = await buildIntegratedCohortFixture();
  const expectedIds = fixture.manifest.entries.map((entry) => entry.publicId);
  const checkpoints: IdentityCheckpoint[] = [checkpoint(expectedIds, expectedIds, 'MANIFEST')];
  const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capstone-lv01-evidence-'));
  const feedPath = path.join(evidenceDir, 'lv01-final-feed.json');
  const rendererPath = path.join(evidenceDir, 'lv01-renderer.json');
  const jsonPath = path.join(evidenceDir, 'lv01-evidence.json');
  const markdownPath = path.join(evidenceDir, 'lv01-evidence.md');

  await harness.ensureActiveHead();
  const initialHead = await inspectPublicFeedHead(harness.db, PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH);
  ensure(initialHead.artifact?.recordCount === 0, 'LV01_INITIAL_FEED_NOT_EMPTY');
  await seedSyntheticTaxonomy(harness);
  const mismatchControl = await assertAdminMismatchControl(fixture);

  const authContext: AuthenticatedAdminContext = {
    authUserId: harness.adminId, adminUserId: harness.adminId,
    email: 'lv01-admin@capstone.invalid', fullName: 'LV-01 Synthetic Admin',
    roles: ['admin'], permissions: getPermissionsForRoles(['admin']),
  };
  const analyzedIds: string[] = [];
  const batchIds: string[] = [];
  let mediaCount = 0;
  let reconciliationMatches = 0;
  for (const batch of fixture.batches) {
    const result = await stageBatch(fixture, batch, authContext);
    analyzedIds.push(...result.analyzedIds);
    batchIds.push(result.batchId);
    mediaCount += result.mediaCount;
    reconciliationMatches += result.reconciliationMatches;
  }
  checkpoints.push(checkpoint(expectedIds, analyzedIds, 'CANONICAL_ANALYSIS'));
  const persisted = await harness.db.from('projects').select('id,public_id,status').like('public_id', `${PUBLIC_ID_PREFIX}%`).order('public_id');
  ensure(!persisted.error && persisted.data, 'LV01_PERSISTED_PROJECTS_UNAVAILABLE');
  checkpoints.push(checkpoint(expectedIds, persisted.data.map((row) => String(row.public_id)), 'PERSISTED_PROJECTS'));
  const completedBatches = await harness.db.from('import_batches').select('id,source_folder,status').in('id', batchIds);
  ensure(!completedBatches.error && completedBatches.data?.length === fixture.batches.length
    && completedBatches.data.every((row) => row.status === 'completed'), 'LV01_IMPORT_BATCH_NOT_COMPLETED');

  const importRepository = new ImportBatchRepositoryCore(harness.db);
  let deterministicReady = 0;
  for (const publicId of expectedIds) {
    const row = await importRepository.getProjectReviewDataByPublicId(publicId);
    ensure(row, 'LV01_REVIEW_READINESS_ROW_MISSING');
    const readiness = computeReadinessForImportBatchRow(row);
    ensure(readiness.ready, 'LV01_DETERMINISTIC_VALIDATION_BLOCKED');
    deterministicReady += 1;
  }

  const service = new BulkReviewService(new SupabaseBulkProjectReviewGateway(harness.db, PRIVATE_BUCKET));
  const actor: BulkReviewActor = { adminId: harness.adminId, permissions: getPermissionsForRoles(['admin']) };
  const submitted = await bulkTransition(service, actor, 'submit_for_review', expectedIds);
  const approved = await bulkTransition(service, actor, 'approve', expectedIds);
  const approvedRows = await harness.db.from('projects').select('public_id').like('public_id', `${PUBLIC_ID_PREFIX}%`).eq('status', 'approved');
  ensure(!approvedRows.error && approvedRows.data, 'LV01_APPROVED_PROJECTS_UNAVAILABLE');
  checkpoints.push(checkpoint(expectedIds, approvedRows.data.map((row) => String(row.public_id)), 'REVIEW_APPROVED'));
  const projectIds = persisted.data.map((row) => String(row.id));
  const audits = await harness.db.from('approval_records').select('project_id,action_taken,from_status,to_status').in('project_id', projectIds);
  ensure(!audits.error && audits.data?.length === INTEGRATED_COHORT_SIZE * 2, 'LV01_REVIEW_AUDIT_COUNT_INVALID');
  const auditKeys = new Set(audits.data.map((row) => `${row.project_id}:${row.action_taken}:${row.from_status}:${row.to_status}`));
  ensure(auditKeys.size === audits.data.length, 'LV01_DUPLICATE_REVIEW_AUDIT');

  const assistiveRepository = new SupabaseAssistiveInputRepository(harness.db);
  let assistiveInputsLoaded = 0;
  let assistiveDuplicateRankings = 0;
  for (const projectId of projectIds) {
    const input = await loadAssistiveInput(assistiveRepository, projectId, PRIVATE_BUCKET);
    ensure(input && /^[0-9a-f]{64}$/.test(input.inputHash), 'LV01_ASSISTIVE_INPUT_UNAVAILABLE');
    rankDuplicateCandidates(input.currentProject, input.duplicateCandidates);
    assistiveInputsLoaded += 1;
    assistiveDuplicateRankings += 1;
  }

  const notifications = new SupabaseParticipantPreviewNotificationRepositoryCore(harness.db);
  const previews = new SupabaseParticipantPreviewRepositoryCore(harness.db);
  let localSends = 0;
  const localCaptureTransport: ParticipantPreviewEmailTransport = {
    send: async () => {
      localSends += 1;
      return { outcome: 'accepted', transportReference: `local-capture-${localSends}` };
    },
  };
  const previewIds: string[] = [];
  for (const publicId of expectedIds) {
    const rawToken = `lv01-preview-${createHash('sha256').update(`${fixture.manifest.digest}:${publicId}`).digest('hex')}`;
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const generated = await notifications.generatePreviewWithNotification({
      publicId, adminId: harness.adminId, tokenHash, privateBucket: PRIVATE_BUCKET,
    });
    ensure(generated.resultCode === 'SUCCESS', 'LV01_PREVIEW_NOTIFICATION_RESERVATION_FAILED');
    const value = generated.value;
    const delivered = await executeParticipantPreviewNotification(
      { notifications, transport: localCaptureTransport },
      {
        notificationId: value.notificationId, executionToken: value.executionToken,
        recipient: value.recipient, projectTitle: value.projectTitle,
        previewUrl: `http://localhost:3000/participant-preview/${rawToken}`,
        expiresAt: value.expiresAt, fromAddress: 'no-reply@capstone.invalid',
      },
    );
    ensure(delivered.code === 'SENT', 'LV01_LOCAL_NOTIFICATION_FAILED');
    ensure(await previews.confirmPreview(tokenHash), 'LV01_PARTICIPANT_CONFIRMATION_FAILED');
    previewIds.push(value.previewId);
  }
  const activePreviews = await harness.db.from('participant_previews').select('id,project_id').in('id', previewIds).eq('status', 'active');
  ensure(!activePreviews.error && activePreviews.data, 'LV01_ACTIVE_PREVIEWS_UNAVAILABLE');
  checkpoints.push(checkpoint(projectIds, activePreviews.data.map((row) => String(row.project_id)), 'ACTIVE_PREVIEWS'));
  const confirmations = await harness.db.from('participant_preview_confirmations').select('participant_preview_id').in('participant_preview_id', previewIds);
  ensure(!confirmations.error && confirmations.data, 'LV01_CONFIRMATIONS_UNAVAILABLE');
  checkpoints.push(checkpoint(previewIds, confirmations.data.map((row) => String(row.participant_preview_id)), 'CONFIRMATIONS'));
  let publicationReady = 0;
  for (const publicId of expectedIds) {
    const readiness = await previews.getPublicationReadiness({ publicId, adminId: harness.adminId, privateBucket: PRIVATE_BUCKET });
    ensure(readiness.ready && readiness.resultCode === 'READY', 'LV01_PUBLICATION_READINESS_FAILED');
    publicationReady += 1;
  }
  checkpoints.push(checkpoint(expectedIds, expectedIds.slice(0, publicationReady), 'PUBLICATION_READY'));

  const noPreviewControl = await harness.createProject('lv01-control-no-preview');
  const notReadyResult = await executePublication(harness, noPreviewControl.publicId);
  ensure(notReadyResult.resultCode === 'NOT_READY', 'LV01_NO_PREVIEW_NEGATIVE_CONTROL_FAILED');
  const unauthorizedResult = await executePublication(harness, expectedIds[0], 'reviewer');
  ensure(unauthorizedResult.resultCode === 'PERMISSION_DENIED', 'LV01_PERMISSION_NEGATIVE_CONTROL_FAILED');

  const publicationSamples = new Map<string, { attemptId: string; snapshotId: string | null; auditRecordId: string | null }>();
  for (const [index, publicId] of expectedIds.entries()) {
    const publication = await executePublication(harness, publicId);
    ensure(publication.resultCode === 'COMPLETED', 'LV01_CONTROLLED_PUBLICATION_FAILED');
    publicationSamples.set(publicId, publication);
    const current = await inspectPublicFeedHead(harness.db, PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH);
    ensure(current.artifact?.recordCount === index + 1 && current.head?.currentVersion.recordCount === index + 1, 'LV01_FEED_NOT_MONOTONIC');
    checkpoint(expectedIds.slice(0, index + 1), current.artifact.members.map((member) => member.publicId), `PUBLICATION_${index + 1}`);
  }
  const beforeRetry = await inspectPublicFeedHead(harness.db, PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH);
  const beforeCounts = ledgerCounts(harness);
  for (const publicId of [expectedIds[0], expectedIds[59], expectedIds[119]]) {
    const retry = await executePublication(harness, publicId);
    const sample = publicationSamples.get(publicId)!;
    ensure(retry.resultCode === 'ALREADY_COMPLETED'
      && retry.attemptId === sample.attemptId && retry.snapshotId === sample.snapshotId
      && retry.auditRecordId === sample.auditRecordId, 'LV01_PUBLICATION_IDEMPOTENCY_FAILED');
  }
  const afterRetry = await inspectPublicFeedHead(harness.db, PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH);
  ensure(afterRetry.artifact?.content === beforeRetry.artifact?.content
    && JSON.stringify(ledgerCounts(harness)) === JSON.stringify(beforeCounts), 'LV01_IDEMPOTENCY_CHANGED_STATE');

  const final = await inspectPublicFeedHead(harness.db, PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH);
  ensure(final.head && final.artifact, 'LV01_FINAL_HEAD_MISSING');
  checkpoints.push(checkpoint(expectedIds, final.artifact.members.map((member) => member.publicId), 'FINAL_FEED'));
  const storedBytes = await harness.storedFeed();
  ensure(storedBytes, 'LV01_STORED_FEED_MISSING');
  const stored = verifyPublicFeedArtifact(storedBytes);
  const schema = validatePublicFeed(final.artifact.feed);
  ensure(schema.valid && stored.content === final.artifact.content
    && stored.feedHash === final.head.currentVersion.feedHash
    && final.artifact.content === final.head.currentVersion.artifactContent, 'LV01_FINAL_FEED_HEAD_MISMATCH');
  fs.writeFileSync(feedPath, storedBytes);
  const publicMedia = await verifyPublicMedia(harness, fixture);
  const privateReferencesInFeed = [PRIVATE_BUCKET, '/drafts/'].filter((marker) => final.artifact!.content.includes(marker)).length;
  ensure(privateReferencesInFeed === 0, 'LV01_PRIVATE_REFERENCE_IN_FEED');
  const counts = ledgerCounts(harness);
  ensure(Object.values({
    operations: counts.publicationOperations, completed: counts.completedPublications,
    versions: counts.publicationVersions, audits: counts.publicationAuditRecords,
    published: counts.publishedProjects,
  }).every((value) => value === INTEGRATED_COHORT_SIZE) && counts.activePublicationOperations === 0, 'LV01_PUBLICATION_ACCOUNTING_INVALID');
  const publishedRows = await harness.db.from('projects').select('public_id').like('public_id', `${PUBLIC_ID_PREFIX}%`).eq('status', 'published');
  ensure(!publishedRows.error && publishedRows.data, 'LV01_PUBLISHED_PROJECTS_UNAVAILABLE');
  checkpoints.push(checkpoint(expectedIds, publishedRows.data.map((row) => String(row.public_id)), 'PUBLISHED_PROJECTS'));

  const browser = spawnSync(process.execPath, [path.join(REPOSITORY_ROOT, 'apps/public-layer/scripts/test-duda-annual-scale-browser.js')], {
    cwd: REPOSITORY_ROOT, stdio: 'inherit', timeout: 180_000, killSignal: 'SIGTERM',
    env: {
      ...process.env, CAPSTONE_LV01_FEED_PATH: feedPath,
      CAPSTONE_LV01_MANIFEST_HASH: fixture.manifest.digest,
      CAPSTONE_LV01_RENDERER_EVIDENCE_PATH: rendererPath,
    },
  });
  ensure(!browser.error && browser.status === 0 && fs.existsSync(rendererPath), 'LV01_EXACT_FEED_RENDERER_FAILED');
  const rendererEvidence = JSON.parse(fs.readFileSync(rendererPath, 'utf8')) as { detailPublicIds: string[] };
  checkpoints.push(checkpoint(expectedIds, rendererEvidence.detailPublicIds, 'PUBLIC_RENDERER_TARGETS'));

  const evidence: Lv01Evidence = {
    classification: 'BRIEF_SC02_LOCAL_INTEGRATED_COHORT_DEMONSTRATED', exactHead: head,
    manifest: { digest: fixture.manifest.digest, count: INTEGRATED_COHORT_SIZE, package: INTEGRATED_PACKAGE_COUNT, form: INTEGRATED_FORM_COUNT },
    distribution: {
      program: countBy(fixture.manifest.entries.map((entry) => entry.program)),
      year: countBy(fixture.manifest.entries.map((entry) => entry.year)),
      discipline: countBy(fixture.manifest.entries.map((entry) => entry.discipline)),
      industry: countBy(fixture.manifest.entries.map((entry) => entry.industry)),
      layout: countBy(fixture.manifest.entries.map((entry) => entry.layoutPreset)),
      accessibility: countBy(fixture.manifest.entries.map((entry) => entry.accessibilityMode)),
    },
    checkpoints,
    adminReference: { expectedMatches: INTEGRATED_COHORT_SIZE, actualMatches: reconciliationMatches, ambiguous: 0, unresolved: 0, mismatchControl },
    intake: { analyzed: analyzedIds.length, stagedProjects: persisted.data.length, completedBatches: completedBatches.data.length, mediaAssets: mediaCount },
    validation: { deterministicReady, assistiveInputsLoaded, assistiveDuplicateRankings, authority: 'deterministic validation and staff review remain authoritative; assistive evidence is non-authoritative input loading and deterministic duplicate ranking' },
    review: { submitted, approved, auditRows: audits.data.length, duplicateAudits: audits.data.length - auditKeys.size, boundedBatches: [50, 50, 20] },
    participant: { previews: activePreviews.data.length, notificationsSentToLocalCapture: localSends, confirmations: confirmations.data.length, ready: publicationReady },
    publication: { ...counts, activationVersions: 1, finalHeadVersion: final.head.currentVersion.versionNumber, idempotencySample: true },
    publicMedia: { ...publicMedia, privateReferencesInFeed },
    finalFeed: { count: final.artifact.recordCount, hash: final.artifact.feedHash, schemaValid: schema.valid, headMatchesStoredBytes: true },
    renderer: { passed: true, evidencePath: rendererPath },
    negativeControls: { adminMismatch: mismatchControl, noPreview: notReadyResult.resultCode, permission: unauthorizedResult.resultCode },
    containment: { disposableAcknowledgement: process.env.CAPSTONE_VERIFY_DISPOSABLE === '1', loopbackSupabase: new URL(harness.apiUrl).hostname === '127.0.0.1', hostedContact: 'NO', realEmail: 'NO', productionPublication: 'NO' },
  };
  fs.writeFileSync(jsonPath, `${JSON.stringify(evidence, null, 2)}\n`);
  fs.writeFileSync(markdownPath, renderMarkdown(evidence));
  console.log('LV01_RESULT = PASS');
  console.log(`LV01_EXACT_HEAD = ${head}`);
  console.log(`LV01_MANIFEST_SHA256 = ${fixture.manifest.digest}`);
  console.log(`LV01_FINAL_FEED_SHA256 = ${final.artifact.feedHash}`);
  console.log(`LV01_JSON_EVIDENCE = ${jsonPath}`);
  console.log(`LV01_MARKDOWN_EVIDENCE = ${markdownPath}`);
}

main().catch((error: unknown) => {
  const code = error instanceof Error ? error.message : 'LV01_RUNTIME_FAILED';
  console.error('LV01_RESULT = FAIL');
  console.error(`LV01_FAILURE_CODE = ${code.replace(/https?:\/\/\S+/g, '[endpoint]').slice(0, 240)}`);
  process.exitCode = 1;
});
