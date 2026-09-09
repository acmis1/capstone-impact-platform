import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { getPermissionsForRoles } from '../auth/permissions';
import { validatePublicFeed } from '../feed/validatePublicFeed';
import { verifyPublicFeedArtifact } from '../feed/publicFeedArtifact';
import { executeControlledPublication } from '../projects/controlledPublicationService';
import { createControlledPublicationDependencies } from '../projects/createControlledPublicationDependencies';
import { inspectPublicFeedHead } from '../projects/publicFeedWriterCoordinator';
import {
  createPublicFeedRuntimeHarness,
  PUBLIC_ASSETS_BUCKET,
  PUBLIC_FEED_BUCKET,
  PUBLIC_FEED_PATH,
  PRIVATE_BUCKET,
  PNG_BYTES,
  PDF_BYTES,
  type PublicFeedRuntimeHarness,
  type RuntimeFixture,
} from './publicFeedRuntimeSupport';
import {
  ANNUAL_PUBLICATION_TARGET,
  assertAnnualPublicationEvidence,
  expectedPublicationVersionMemberCount,
  type AnnualPublicationEvidenceSnapshot,
} from './annualPublicationEvidence';

const TARGET_PREFIX = `annual-publication-${Date.now()}-${randomUUID().slice(0, 8)}`;

interface LedgerCounts {
  publicationOperations: number;
  completedPublications: number;
  publicationVersions: number;
  publicationVersionMembers: number;
  publicationAuditRecords: number;
  publishedProjects: number;
  activePublicationOperations: number;
}

interface PublicationEvidenceSample {
  operationId: string;
  snapshotId: string | null;
  auditRecordId: string | null;
}

function ensure(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

function durationMs(started: number): number {
  return Number((performance.now() - started).toFixed(3));
}

function safeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : 'ANNUAL_PUBLICATION_RUNTIME_FAILED';
  return message
    .replace(/https?:\/\/[^\s]+/gi, '[endpoint]')
    .replace(/drafts\/[A-Za-z0-9_.\-/]+/gi, '[private-object]')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[internal-id]')
    .replace(/annual-publication-[A-Za-z0-9_-]+/gi, '[verifier-id]')
    .replace(/\s+/g, ' ')
    .slice(0, 180);
}

function targetPublicId(index: number): string {
  return `${TARGET_PREFIX}-target-${String(index).padStart(3, '0')}`;
}

function targetPattern(harness: PublicFeedRuntimeHarness): string {
  return harness.quoted(`${TARGET_PREFIX}-target-%`);
}

function readLedgerCounts(harness: PublicFeedRuntimeHarness): LedgerCounts {
  const pattern = targetPattern(harness);
  const raw = harness.psql(`
    SELECT
      (SELECT count(*) FROM public.public_feed_operations
        WHERE kind = 'publication' AND public_id LIKE ${pattern})::text || '|' ||
      (SELECT count(*) FROM public.public_feed_operations
        WHERE kind = 'publication' AND public_id LIKE ${pattern} AND state = 'COMPLETED')::text || '|' ||
      (SELECT count(*) FROM public.public_feed_versions
        WHERE operation = 'publication' AND affected_public_id LIKE ${pattern})::text || '|' ||
      (SELECT count(*) FROM public.public_feed_version_members m
        JOIN public.public_feed_versions v ON v.id = m.version_id
        WHERE v.operation = 'publication' AND v.affected_public_id LIKE ${pattern})::text || '|' ||
      (SELECT count(*) FROM public.approval_records ar
        JOIN public.public_feed_versions v ON v.audit_record_id = ar.id
        WHERE v.operation = 'publication' AND v.affected_public_id LIKE ${pattern}
          AND ar.action_taken = 'publish')::text || '|' ||
      (SELECT count(*) FROM public.projects
        WHERE public_id LIKE ${pattern} AND status = 'published')::text || '|' ||
      (SELECT count(*) FROM public.public_feed_operations
        WHERE state IN ('RESERVED', 'PREPARED', 'WRITE_STARTED', 'CANDIDATE_OBSERVED', 'DB_FINALIZED', 'RECOVERY_REQUIRED'))::text;
  `);
  const values = raw.split('|').map((value) => Number(value));
  ensure(values.length === 7 && values.every(Number.isSafeInteger), 'ANNUAL_LEDGER_COUNT_UNAVAILABLE');
  return {
    publicationOperations: values[0],
    completedPublications: values[1],
    publicationVersions: values[2],
    publicationVersionMembers: values[3],
    publicationAuditRecords: values[4],
    publishedProjects: values[5],
    activePublicationOperations: values[6],
  };
}

function executeFor(
  harness: PublicFeedRuntimeHarness,
  fixture: RuntimeFixture,
  role: 'admin' | 'reviewer',
) {
  return executeControlledPublication({
    permissions: getPermissionsForRoles([role]),
    publicId: fixture.publicId,
    privateBucket: PRIVATE_BUCKET,
    publicAssetsBucket: PUBLIC_ASSETS_BUCKET,
    publicFeedBucket: PUBLIC_FEED_BUCKET,
    publicFeedPath: PUBLIC_FEED_PATH,
    dependencies: createControlledPublicationDependencies({
      supabase: harness.db,
      supabaseUrl: harness.apiUrl,
      publicId: fixture.publicId,
      adminId: role === 'admin' ? harness.adminId : harness.reviewerId,
      privateBucket: PRIVATE_BUCKET,
      publicFeedBucket: PUBLIC_FEED_BUCKET,
      publicFeedPath: PUBLIC_FEED_PATH,
      executionTarget: 'local',
    }),
  });
}

async function assertNegativeControl(
  harness: PublicFeedRuntimeHarness,
  fixture: RuntimeFixture,
  expectedResultCode: 'NOT_READY' | 'PERMISSION_DENIED',
  baselineContent: string,
): Promise<void> {
  const result = expectedResultCode === 'NOT_READY'
    ? await executeFor(harness, fixture, 'admin')
    : await executeFor(harness, fixture, 'reviewer');
  ensure(result.resultCode === expectedResultCode, 'ANNUAL_NEGATIVE_CONTROL_RESULT_INVALID');
  ensure(await harness.count('public_feed_operations', 'project_id', fixture.id) === 0, 'ANNUAL_NEGATIVE_CONTROL_OPERATION_CREATED');
  ensure(await harness.count('public_feed_versions', 'project_id', fixture.id) === 0, 'ANNUAL_NEGATIVE_CONTROL_VERSION_CREATED');
  ensure(harness.psql(`SELECT status FROM public.projects WHERE id = ${harness.quoted(fixture.id)}::uuid;`) === 'approved', 'ANNUAL_NEGATIVE_CONTROL_LIFECYCLE_CHANGED');
  const inspected = await inspectPublicFeedHead(harness.db, PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH);
  ensure(inspected.artifact?.content === baselineContent, 'ANNUAL_NEGATIVE_CONTROL_FEED_CHANGED');

  for (const path of [
    `published/${fixture.publicId}/poster_image/poster.png`,
    `published/${fixture.publicId}/poster_pdf/poster.pdf`,
  ]) {
    const publicObject = await harness.db.storage.from(PUBLIC_ASSETS_BUCKET).download(path);
    ensure(Boolean(publicObject.error) && !publicObject.data, 'ANNUAL_NEGATIVE_CONTROL_MEDIA_PROMOTED');
  }
}

async function verifyPublishedMedia(
  harness: PublicFeedRuntimeHarness,
  fixtures: readonly RuntimeFixture[],
): Promise<void> {
  const expectedAssets = [
    { type: 'poster_image', name: 'poster.png', mime: 'image/png', bytes: PNG_BYTES },
    { type: 'poster_pdf', name: 'poster.pdf', mime: 'application/pdf', bytes: PDF_BYTES },
  ] as const;

  for (const fixture of fixtures) {
    const result = await harness.db.from('media_assets').select(
      'asset_type,file_name,storage_bucket,storage_path,public_url,public_storage_bucket,public_storage_path,mime_type,file_size_bytes,is_public_approved',
    ).eq('project_id', fixture.id).order('asset_type', { ascending: true });
    ensure(!result.error && result.data?.length === expectedAssets.length, 'ANNUAL_MEDIA_BINDING_COUNT_INVALID');

    for (const expected of expectedAssets) {
      const row = result.data!.find((candidate) => candidate.asset_type === expected.type);
      ensure(Boolean(row), 'ANNUAL_MEDIA_BINDING_MISSING');
      const publicPath = `published/${fixture.publicId}/${expected.type}/${expected.name}`;
      const publicUrl = harness.db.storage.from(PUBLIC_ASSETS_BUCKET).getPublicUrl(publicPath).data.publicUrl;
      ensure(
        row!.file_name === expected.name
          && row!.storage_bucket === PRIVATE_BUCKET
          && row!.public_storage_bucket === PUBLIC_ASSETS_BUCKET
          && row!.public_storage_path === publicPath
          && row!.public_url === publicUrl
          && row!.mime_type === expected.mime
          && row!.file_size_bytes === expected.bytes.length
          && row!.is_public_approved === true,
        'ANNUAL_MEDIA_BINDING_INVALID',
      );
      const publicObject = await harness.db.storage.from(PUBLIC_ASSETS_BUCKET).download(publicPath);
      ensure(!publicObject.error && Boolean(publicObject.data), 'ANNUAL_PUBLIC_MEDIA_MISSING');
      const publicBytes = Buffer.from(await publicObject.data!.arrayBuffer());
      ensure(publicBytes.equals(expected.bytes), 'ANNUAL_PUBLIC_MEDIA_BYTES_INVALID');
    }
  }
}

async function main(): Promise<void> {
  const totalStarted = performance.now();
  const prefixPattern = `${TARGET_PREFIX}-target-%`;
  const setupStarted = performance.now();
  const harness = await createPublicFeedRuntimeHarness();
  await harness.ensureActiveHead();
  const baseline = await inspectPublicFeedHead(harness.db, PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH);
  ensure(Boolean(baseline.head && baseline.artifact), 'ANNUAL_BASELINE_HEAD_MISSING');
  ensure(baseline.artifact!.recordCount === 0, 'ANNUAL_BASELINE_NOT_EMPTY');
  const baselineContent = baseline.artifact!.content;
  const notReady = await harness.createProject(`${TARGET_PREFIX}-not-ready`);
  const unauthorized = await harness.makeReady(`${TARGET_PREFIX}-unauthorized`);
  await assertNegativeControl(harness, notReady, 'NOT_READY', baselineContent);
  await assertNegativeControl(harness, unauthorized, 'PERMISSION_DENIED', baselineContent);
  const setupDuration = durationMs(setupStarted);

  const readinessStarted = performance.now();
  const fixtures: RuntimeFixture[] = [];
  for (let index = 1; index <= ANNUAL_PUBLICATION_TARGET; index += 1) {
    fixtures.push(await harness.makeReady(targetPublicId(index)));
  }
  ensure(fixtures.every((fixture) => Boolean(fixture.confirmedPreviewId && fixture.confirmedAt)), 'ANNUAL_READINESS_EVIDENCE_MISSING');
  const readinessCounts = harness.psql(`
    SELECT
      (SELECT count(*) FROM public.projects WHERE public_id LIKE ${harness.quoted(prefixPattern)} AND status = 'approved')::text || '|' ||
      (SELECT count(*) FROM public.media_assets ma JOIN public.projects p ON p.id = ma.project_id
        WHERE p.public_id LIKE ${harness.quoted(prefixPattern)} AND ma.storage_bucket = ${harness.quoted(PRIVATE_BUCKET)})::text || '|' ||
      (SELECT count(*) FROM public.participant_previews pp JOIN public.projects p ON p.id = pp.project_id
        WHERE p.public_id LIKE ${harness.quoted(prefixPattern)} AND pp.status = 'active')::text || '|' ||
      (SELECT count(*) FROM public.participant_preview_confirmations c JOIN public.participant_previews pp ON pp.id = c.participant_preview_id
        JOIN public.projects p ON p.id = pp.project_id WHERE p.public_id LIKE ${harness.quoted(prefixPattern)})::text;
  `).split('|').map(Number);
  ensure(readinessCounts.length === 4 && readinessCounts.every(Number.isSafeInteger), 'ANNUAL_READINESS_ACCOUNTING_UNAVAILABLE');
  ensure(readinessCounts[0] === ANNUAL_PUBLICATION_TARGET, 'ANNUAL_SOURCE_LIFECYCLE_NOT_APPROVED');
  ensure(readinessCounts[1] === ANNUAL_PUBLICATION_TARGET * 2, 'ANNUAL_PRIVATE_MEDIA_ACCOUNTING_INVALID');
  ensure(readinessCounts[2] === ANNUAL_PUBLICATION_TARGET, 'ANNUAL_ACTIVE_PREVIEW_ACCOUNTING_INVALID');
  ensure(readinessCounts[3] === ANNUAL_PUBLICATION_TARGET, 'ANNUAL_PREVIEW_CONFIRMATION_ACCOUNTING_INVALID');
  const readinessDuration = durationMs(readinessStarted);

  const publicationStarted = performance.now();
  const publicationSamples: PublicationEvidenceSample[] = [];
  const intendedPublicIds = fixtures.map((fixture) => fixture.publicId);
  const intended = new Set(intendedPublicIds);
  for (const [index, fixture] of fixtures.entries()) {
    const publication = await executeFor(harness, fixture, 'admin');
    ensure(publication.resultCode === 'COMPLETED', 'ANNUAL_PUBLICATION_DID_NOT_COMPLETE');
    if (publication.resultCode !== 'COMPLETED') throw new Error('ANNUAL_PUBLICATION_RESULT_INVALID');
    publicationSamples.push({
      operationId: publication.attemptId,
      snapshotId: publication.snapshotId,
      auditRecordId: publication.auditRecordId,
    });

    const inspected = await inspectPublicFeedHead(harness.db, PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH);
    ensure(Boolean(inspected.head && inspected.artifact), 'ANNUAL_HEAD_MISSING_AFTER_PUBLICATION');
    const memberIds = inspected.artifact!.members.map((member) => member.publicId);
    const expectedIds = new Set(fixtures.slice(0, index + 1).map((item) => item.publicId));
    ensure(inspected.artifact!.recordCount === index + 1, 'ANNUAL_FEED_COUNT_NOT_MONOTONIC');
    ensure(inspected.head!.currentVersion.recordCount === index + 1, 'ANNUAL_HEAD_COUNT_NOT_MONOTONIC');
    ensure(inspected.head!.currentVersion.versionNumber === index + 2, 'ANNUAL_HEAD_VERSION_NOT_MONOTONIC');
    ensure(inspected.head!.currentVersion.operation === 'publication', 'ANNUAL_HEAD_OPERATION_INVALID');
    ensure(inspected.head!.currentVersion.affectedPublicId === fixture.publicId, 'ANNUAL_HEAD_TARGET_INVALID');
    ensure(publication.recordCount === index + 1 && publication.feedHash === inspected.artifact!.feedHash, 'ANNUAL_PUBLICATION_RESULT_EVIDENCE_INVALID');
    ensure(Boolean(publication.snapshotId && publication.auditRecordId), 'ANNUAL_PUBLICATION_LEDGER_EVIDENCE_MISSING');
    ensure(new Set(memberIds).size === memberIds.length, 'ANNUAL_FEED_DUPLICATE_PUBLIC_ID');
    ensure(memberIds.every((publicId) => intended.has(publicId)), 'ANNUAL_UNEXPECTED_VERIFIER_MEMBER');
    ensure(memberIds.length === expectedIds.size && [...expectedIds].every((publicId) => memberIds.includes(publicId)), 'ANNUAL_PRIOR_MEMBER_DISAPPEARED');
  }
  const publicationDuration = durationMs(publicationStarted);

  const beforeRetries = await inspectPublicFeedHead(harness.db, PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH);
  const beforeRetryCounts = readLedgerCounts(harness);
  let idempotencyChangedEvidence = false;
  for (const index of [0, Math.floor(ANNUAL_PUBLICATION_TARGET / 2), ANNUAL_PUBLICATION_TARGET - 1]) {
    const fixture = fixtures[index];
    const retry = await executeFor(harness, fixture, 'admin');
    const sample = publicationSamples[index];
    ensure(retry.resultCode === 'ALREADY_COMPLETED', 'ANNUAL_IDEMPOTENCY_RESULT_INVALID');
    if (retry.resultCode !== 'ALREADY_COMPLETED') throw new Error('ANNUAL_IDEMPOTENCY_RESULT_UNAVAILABLE');
    ensure(
      retry.attemptId === sample.operationId
        && retry.snapshotId === sample.snapshotId
        && retry.auditRecordId === sample.auditRecordId,
      'ANNUAL_IDEMPOTENCY_TARGET_EVIDENCE_INVALID',
    );
    const afterRetry = await inspectPublicFeedHead(harness.db, PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH);
    const afterRetryCounts = readLedgerCounts(harness);
    const unchanged = afterRetry.artifact?.content === beforeRetries.artifact?.content
      && afterRetry.artifact?.feedHash === beforeRetries.artifact?.feedHash
      && afterRetry.head?.currentVersion.id === beforeRetries.head?.currentVersion.id
      && JSON.stringify(afterRetryCounts) === JSON.stringify(beforeRetryCounts);
    if (!unchanged) idempotencyChangedEvidence = true;
    ensure(unchanged, 'ANNUAL_IDEMPOTENCY_CHANGED_EVIDENCE');
  }

  const finalVerificationStarted = performance.now();
  const final = await inspectPublicFeedHead(harness.db, PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH);
  ensure(Boolean(final.head && final.artifact), 'ANNUAL_FINAL_HEAD_MISSING');
  const storedBytes = await harness.storedFeed();
  ensure(Boolean(storedBytes), 'ANNUAL_CANONICAL_FEED_MISSING');
  const storedArtifact = verifyPublicFeedArtifact(storedBytes!);
  const feedValidation = validatePublicFeed(final.artifact!.feed);
  ensure(feedValidation.valid, 'ANNUAL_FINAL_FEED_SCHEMA_INVALID');
  ensure(
    storedArtifact.content === final.artifact!.content
      && storedArtifact.feedHash === final.head!.currentVersion.feedHash
      && storedArtifact.recordCount === final.head!.currentVersion.recordCount
      && final.artifact!.content === final.head!.currentVersion.artifactContent,
    'ANNUAL_CANONICAL_FEED_HEAD_MISMATCH',
  );
  await verifyPublishedMedia(harness, fixtures);

  const counts = readLedgerCounts(harness);
  const finalFeedPublicIds = final.artifact!.members.map((member) => member.publicId);
  const privateFeedReferences = [PRIVATE_BUCKET, '/drafts/']
    .filter((marker) => final.artifact!.content.includes(marker)).length;
  const mediaBindings = Number(harness.psql(`
    SELECT count(*) FROM public.media_assets ma JOIN public.projects p ON p.id = ma.project_id
    WHERE p.public_id LIKE ${harness.quoted(prefixPattern)}
      AND ma.is_public_approved = true
      AND ma.public_storage_bucket = ${harness.quoted(PUBLIC_ASSETS_BUCKET)}
      AND ma.public_storage_path LIKE 'published/' || p.public_id || '/%';
  `));
  ensure(mediaBindings === ANNUAL_PUBLICATION_TARGET * 2, 'ANNUAL_MEDIA_BINDING_ACCOUNTING_INVALID');
  ensure(Number(harness.psql(`SELECT count(*) FROM public.projects WHERE public_id LIKE ${harness.quoted(prefixPattern)} AND status <> 'published';`)) === 0, 'ANNUAL_UNPUBLISHED_COHORT_PROJECT');
  ensure(Number(harness.psql(`SELECT count(*) FROM public.projects WHERE public_id LIKE ${harness.quoted(prefixPattern)};`)) === ANNUAL_PUBLICATION_TARGET, 'ANNUAL_COHORT_PROJECT_COUNT_INVALID');
  ensure(Number(harness.psql(`SELECT count(*) FROM public.projects WHERE public_id LIKE ${harness.quoted(prefixPattern)} AND public_id IN (${fixtures.map((fixture) => harness.quoted(fixture.publicId)).join(',')});`)) === ANNUAL_PUBLICATION_TARGET, 'ANNUAL_COHORT_ID_ACCOUNTING_INVALID');

  const snapshot: AnnualPublicationEvidenceSnapshot = {
    intendedPublicIds,
    finalFeedPublicIds,
    finalFeedRecordCount: final.artifact!.recordCount,
    ...counts,
    feedValid: feedValidation.valid,
    headMatchesStorage: storedArtifact.content === final.head!.currentVersion.artifactContent,
    idempotencyChangedEvidence,
    privateFeedReferences,
    negativeControlCreatedDeploymentState: false,
  };
  assertAnnualPublicationEvidence(snapshot);
  ensure(counts.publicationVersionMembers === expectedPublicationVersionMemberCount(), 'ANNUAL_VERSION_MEMBER_FORMULA_INVALID');
  const finalVerificationDuration = durationMs(finalVerificationStarted);
  const totalDuration = durationMs(totalStarted);

  console.log('ANNUAL_PUBLICATION_EVIDENCE = LOCAL_DISPOSABLE_GOVERNED_PUBLICATION_VERIFIED');
  console.log(`TARGET_PROJECTS = ${ANNUAL_PUBLICATION_TARGET}`);
  console.log(`PUBLICATION_OPERATIONS = ${counts.publicationOperations}`);
  console.log(`COMPLETED_PUBLICATIONS = ${counts.completedPublications}`);
  console.log(`PUBLICATION_VERSIONS = ${counts.publicationVersions}`);
  console.log(`PUBLICATION_VERSION_MEMBERS = ${counts.publicationVersionMembers}`);
  console.log(`PUBLICATION_AUDIT_RECORDS = ${counts.publicationAuditRecords}`);
  console.log(`PUBLISHED_PROJECTS = ${counts.publishedProjects}`);
  console.log(`FINAL_FEED_RECORDS = ${final.artifact!.recordCount}`);
  console.log('FEED_VALID = YES');
  console.log('MONOTONIC_PUBLIC_FEED = PASS');
  console.log('MEDIA_BINDINGS = PASS');
  console.log('UNACCOUNTED_PROJECTS = 0');
  console.log(`PRIVATE_FEED_REFERENCES = ${privateFeedReferences}`);
  console.log(`ACTIVE_PUBLICATION_OPERATIONS = ${counts.activePublicationOperations}`);
  console.log('IDEMPOTENCY_SAMPLE = PASS');
  console.log('NEGATIVE_CONTROLS = PASS');
  console.log(`FINAL_HEAD_VERSION = ${final.head!.currentVersion.versionNumber}`);
  console.log(`LOCAL_DURATION_TOTAL_MS = ${totalDuration}`);
  console.log(`LOCAL_DURATION_SETUP_MS = ${setupDuration}`);
  console.log(`LOCAL_DURATION_READINESS_PREPARATION_MS = ${readinessDuration}`);
  console.log(`LOCAL_DURATION_GOVERNED_PUBLICATION_MS = ${publicationDuration}`);
  console.log(`LOCAL_DURATION_FINAL_VERIFICATION_MS = ${finalVerificationDuration}`);
  console.log('HOSTED_CONTACT = NO');
  console.log('PRODUCTION_PUBLICATION = NO');
  console.log('STAFF_EFFORT_MEASURED = NO');
}

main().catch((error: unknown) => {
  console.error('ANNUAL_PUBLICATION_EVIDENCE = FAILURE');
  console.error(`FAILURE_CODE = ${safeFailure(error)}`);
  process.exitCode = 1;
});
