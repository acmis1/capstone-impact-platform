import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import type { SupabaseClient } from '@supabase/supabase-js';

import type { AuthenticatedAdminContext } from '../auth/authTypes';
import type { Project } from '../domain/project';
import { getPermissionsForRoles } from '../auth/permissions';
import { compilePublicFeed } from '../feed/compilePublicFeed';
import { validatePublicFeed } from '../feed/validatePublicFeed';
import { runBrowserImportManifestPreflight } from '../import/browserImportPreviewContract';
import { analyzeBrowserImportServer } from '../import/parseBrowserImportPreview';
import { prepareBrowserImportCommitIntent } from '../import/prepareBrowserImportCommitIntentCore';
import { computeCanonicalIntentHash } from '../import/browserImportMetadataStageServerCore';
import { resolveExpectedBrowserImportMedia } from '../import/browserImportMediaSelection';
import { stageBrowserImportMedia, type MediaFileToStage } from '../import/stageBrowserImportMedia';
import { stageBrowserImportMetadata } from '../import/stageBrowserImportMetadata';
import { validateMediaAssetBytes } from '../storage/mediaValidationCore';
import { getStagingBuckets } from '../lib/supabase/buckets';
import { createSupabaseAdminClientCore } from '../lib/supabase/adminCore';
import { ImportBatchRepositoryCore } from '../repositories/ImportBatchRepositoryCore';
import { computeReadinessForImportBatchRow } from '../import/importBatchReviewReadiness';
import { SupabaseBulkProjectReviewGateway } from '../projects/SupabaseBulkProjectReviewGateway';
import { BulkReviewService } from '../projects/bulkProjectReviewService';
import type { BulkReviewAction, BulkReviewActor } from '../projects/bulkProjectReview';
import { preparePublicationPlan } from '../projects/publicationPlanService';
import { SupabasePublicationExecutionRepositoryCore } from '../repositories/SupabasePublicationExecutionRepositoryCore';
import { SupabaseParticipantPreviewRepositoryCore } from '../repositories/SupabaseParticipantPreviewRepositoryCore';
import { SupabaseProjectRepositoryCore } from '../repositories/SupabaseProjectRepositoryCore';
import { parseProjectListQuery } from '../domain/projectQuery';
import type { BrowserImportIssue, BrowserImportPackagePreview } from '../import/browserImportPreviewContract';
import {
  buildReleaseEvaluationCorpus,
  materializeReleaseEvaluationCorpus,
  type MaterializedReleaseEvaluationCorpus,
  type ReleaseEvaluationCase,
  type ReleaseMaterializedBatch,
} from '../fixtures/releaseEvaluationCorpus';
import {
  createReleaseEvaluationReport,
  createReleaseEvidenceLedger,
  recordReleaseObservation,
  type ReleaseStageObservation,
  type ReleaseEvaluationReport,
  type ReleaseEvidenceLedger,
} from './releaseEvaluationReport';

export interface ReleaseEvaluationHarnessOptions {
  supabase: SupabaseClient;
  apiUrl: string;
  seed?: number;
  runNumber?: number;
  runNamespace?: string;
  runId?: string;
  npmVersion?: string;
  osRelease?: string;
  supabaseVersion?: string;
  migrationCount?: number;
  now?: () => number;
  evidenceMode?: boolean;
  pauseForEvidence?: () => Promise<void>;
  onRunNamespace?: (runNamespace: string) => void;
}

export interface ReleaseEvaluationRuntimeContext {
  admin: AuthenticatedAdminContext;
  privateBucket: string;
  publicBucket: string;
  publicFeedBucket: string;
  taxonomy: { program: string; discipline: string; industry: string };
  ownedPublicIds: Set<string>;
  ownedBatchIds: Set<string>;
  ownedStoragePaths: Set<string>;
  previewIds: Set<string>;
  sharedBaseline: ReleaseSharedBaseline;
}

export interface ReleaseCleanupRecoveryResult {
  completed: boolean;
  runNamespace: string;
  residue: Record<string, number>;
  scopesChecked: string[];
}

interface ReleaseSharedBaseline {
  admin: string;
  adminRoles: string;
  reference: Record<string, string>;
  publication: Record<string, string>;
  ordinary: Record<string, string>;
}

interface StageTotals {
  selected: number;
  accepted: number;
  rejected: number;
  warnings: number;
}

interface WorkflowSummary {
  preflight: Record<string, StageTotals>;
  execution: Record<string, StageTotals>;
  finalStatusCounts: Record<string, number>;
  expectedAuditCount: number;
  actualAuditCount: number;
  auditActorMatches: boolean;
  duplicateAudits: number;
  expectedFinalStatusCounts: Record<string, number>;
  finalStatusMismatches: string[];
  auditSignatures: string[];
  expectedAuditSignatures: string[];
  auditSignaturesMatch: boolean;
  auditComments: string[];
  expectedAuditComments: string[];
  auditCommentsMatch: boolean;
  staleExecution: { expected: number; reported: number; noTransition: boolean };
}

interface TimingContext {
  now: () => number;
  timings: Record<string, number | Record<string, number>>;
}

const RELEASE_RUN_NAMESPACE_PATTERN = /^run-[1-2]-[0-9a-f]{16}$/;

const IMPORT_STAGES = [
  'parse',
  'package-validation',
  'admin-reconciliation',
  'commit-intent',
  'server-revalidation',
  'metadata-staging',
  'media-staging',
  'final-persistence',
] as const;

export function assertReleaseLocalTarget(apiUrl: string, clientUrls: readonly string[] = []): void {
  const validate = (value: string): string => {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error('Release evaluation requires a loopback Local Supabase endpoint.'); }
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('Release evaluation requires a loopback Local Supabase endpoint.');
    }
    return url.origin;
  };
  const expected = validate(apiUrl);
  if (clientUrls.some((url) => validate(url) !== expected)) throw new Error('Release evaluation client targets must match the loopback endpoint.');
}

function clientUrl(client: SupabaseClient): string {
  return (client as unknown as { supabaseUrl: string }).supabaseUrl;
}

export function validateReleaseEvaluationRunNamespace(runNamespace: string): void {
  if (!RELEASE_RUN_NAMESPACE_PATTERN.test(runNamespace)) {
    throw new Error('Invalid release evaluation run namespace; use the exact namespace printed by a prior evaluator run.');
  }
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size) as T[]);
  return result;
}

export function assertCohortAccounting(requested: string[], returned: string[]): void {
  if (requested.length !== returned.length || new Set(returned).size !== returned.length
    || returned.some((id) => !requested.includes(id))) {
    throw new Error('Bulk review returned missing, duplicate, or unknown case identities.');
  }
}

/** Map production reasons to evidence fields, independently of the expected-issue manifest. */
export function readinessField(message: string): string | undefined {
  if (message.startsWith('Poster full text ')) return 'posterText';
  if (message.startsWith('Accessibility text ')) return 'accessibilityText';
  return undefined;
}

function addTiming(timings: Record<string, number | Record<string, number>>, name: string, elapsed: number): void {
  const current = timings[name];
  timings[name] = Number(((typeof current === 'number' ? current : 0) + elapsed).toFixed(3));
}

function sortedNumberRecord(values: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(values).sort(([left], [right]) => left.localeCompare(right)));
}

function isParseIssue(issue: BrowserImportIssue): boolean {
  return issue.code.startsWith('WORKBOOK_')
    || issue.code.startsWith('JSON_')
    || issue.code === 'PACKAGE_MALFORMED_JSON';
}

function isReconciliationIssue(issue: BrowserImportIssue): boolean {
  return issue.code.startsWith('ADMIN_REFERENCE_');
}

/** Derives import-stage observations from production preview output only. */
export function deriveActualPreviewObservations(
  caseId: string,
  pkg: Pick<BrowserImportPackagePreview, 'status' | 'reconciliation' | 'errors' | 'warnings'>,
): ReleaseStageObservation[] {
  const parseError = pkg.errors.find(isParseIssue);
  if (parseError) {
    return [{
      caseId,
      stage: 'parse',
      outcome: 'rejected',
      code: parseError.code,
      fieldName: parseError.fieldName,
    }];
  }

  const parseWarning = pkg.warnings.find(isParseIssue);
  const observations: ReleaseStageObservation[] = [{
    caseId,
    stage: 'parse',
    outcome: parseWarning ? 'warning' : 'accepted',
    code: parseWarning?.code,
    fieldName: parseWarning?.fieldName,
  }];

  const packageError = pkg.errors.find((issue) => !isReconciliationIssue(issue));
  if (packageError || (pkg.status === 'invalid' && !pkg.reconciliation)) {
    observations.push({
      caseId,
      stage: 'package-validation',
      outcome: 'rejected',
      code: packageError?.code,
      fieldName: packageError?.fieldName,
    });
    return observations;
  }

  const packageWarning = pkg.warnings.find((issue) => !isParseIssue(issue));
  observations.push({
    caseId,
    stage: 'package-validation',
    outcome: packageWarning ? 'warning' : 'accepted',
    code: packageWarning?.code,
    fieldName: packageWarning?.fieldName,
  });

  if (pkg.reconciliation && pkg.reconciliation.status !== 'RECONCILED') {
    const reconciliationIssue = pkg.errors.find(isReconciliationIssue);
    observations.push({
      caseId,
      stage: 'admin-reconciliation',
      outcome: 'rejected',
      code: reconciliationIssue?.code,
      fieldName: reconciliationIssue?.fieldName || pkg.reconciliation.mismatchedFields[0],
    });
  } else {
    observations.push({
      caseId,
      stage: 'admin-reconciliation',
      outcome: 'accepted',
      code: pkg.reconciliation?.status,
    });
  }

  return observations;
}

function completeImportStageObservations(
  corpus: MaterializedReleaseEvaluationCorpus,
  ledger: ReleaseEvidenceLedger,
  item: ReleaseEvaluationCase,
): void {
  const entry = ledger.entries.get(item.caseId);
  if (!entry) return;
  const observedStages = new Set(entry.observations
    .filter((observation) => (observation.attempt || 'primary') === 'primary')
    .map((observation) => observation.stage));
  for (const stage of IMPORT_STAGES) {
    if (observedStages.has(stage)) continue;
    recordReleaseObservation(ledger, {
      caseId: item.caseId,
      stage,
      outcome: 'not_run',
    });
  }
  // Keep the helper explicitly tied to the materialized corpus so a missing lineage entry cannot
  // silently turn into an unowned observation during future fixture changes.
  if (!corpus.packages.has(item.caseId)) throw new Error(`Case ${item.caseId} has no materialized package.`);
}

async function resolveAdminContext(supabase: SupabaseClient): Promise<AuthenticatedAdminContext> {
  const result = await supabase.from('admin_users').select('id,email,full_name').limit(1).single();
  if (result.error || !result.data) throw new Error('A Local admin identity is required for release evaluation.');
  const adminId = String(result.data.id);
  const rolesResult = await supabase.from('user_roles').select('role').eq('user_id', adminId);
  const roles = ['admin'] as const;
  if (rolesResult.error || !rolesResult.data?.some((row) => row.role === 'admin')) {
    throw new Error('A Local admin role is required for release evaluation.');
  }
  return {
    authUserId: adminId,
    adminUserId: adminId,
    email: String(result.data.email || 'release-evaluation-admin@example.invalid'),
    fullName: String(result.data.full_name || 'Release Evaluation Admin'),
    roles: [...roles],
    permissions: getPermissionsForRoles([...roles]),
  };
}

async function resolveSeededTaxonomy(supabase: SupabaseClient): Promise<{ program: string; discipline: string; industry: string }> {
  const [program, discipline, industry] = await Promise.all([
    supabase.from('programs').select('name').order('name', { ascending: true }).limit(1).single(),
    supabase.from('disciplines').select('name').order('name', { ascending: true }).limit(1).single(),
    supabase.from('industry_categories').select('name').order('name', { ascending: true }).limit(1).single(),
  ]);
  if (program.error || discipline.error || industry.error || !program.data || !discipline.data || !industry.data) {
    throw new Error('Release evaluation requires existing Local seeded taxonomy values; no taxonomy rows were created.');
  }
  return { program: String(program.data.name), discipline: String(discipline.data.name), industry: String(industry.data.name) };
}

async function fingerprintRows(supabase: SupabaseClient, table: string, columns: string): Promise<string> {
  const data: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += 1000) {
    const result = await supabase.from(table).select(columns).range(offset, offset + 999);
    if (result.error) throw new Error(`Release evaluation could not snapshot ${table}.`);
    data.push(...(result.data || []) as unknown as Record<string, unknown>[]);
    if ((result.data?.length || 0) < 1000) break;
  }
  const rows = data.map((row) => Object.fromEntries(
    Object.entries(row).sort(([left], [right]) => left.localeCompare(right)),
  )).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return createHash('sha256').update(JSON.stringify(rows), 'utf8').digest('hex');
}

async function captureSharedBaseline(supabase: SupabaseClient, admin: AuthenticatedAdminContext): Promise<ReleaseSharedBaseline> {
  const [adminFingerprint, adminRolesFingerprint, programFingerprint, disciplineFingerprint, industryFingerprint, snapshotsFingerprint, attemptsFingerprint, operationsFingerprint, versionsFingerprint, membersFingerprint, headFingerprint, rollbackFingerprint, eventsFingerprint] = await Promise.all([
    fingerprintRows(supabase, 'admin_users', 'id,email,full_name'),
    fingerprintRows(supabase, 'user_roles', 'user_id,role'),
    fingerprintRows(supabase, 'programs', 'id,name'),
    fingerprintRows(supabase, 'disciplines', 'id,name'),
    fingerprintRows(supabase, 'industry_categories', 'id,name'),
    fingerprintRows(supabase, 'published_snapshots', 'id,feed_file_name,storage_bucket,storage_path,public_url,record_count,feed_hash,created_by,rollback_of_snapshot_id,created_at'),
    fingerprintRows(supabase, 'publication_attempts', 'id,project_id,public_id,admin_id,confirmed_preview_id,confirmed_at,state,published_snapshot_id,publish_audit_record_id,failure_code,created_at,updated_at,completed_at,failed_at'),
    fingerprintRows(supabase, 'public_feed_operations', 'id,operation_key,kind,publication_mode,authorizing_actor_id,completion_actor_id,project_id,public_id,rollback_preparation_id,confirmed_preview_id,confirmed_at,private_media_bucket,archive_reason,rollback_capability_requested,baseline_version_id,baseline_storage_existed,baseline_feed_hash,baseline_record_count,candidate_feed_hash,candidate_record_count,state,owner_epoch,lease_expires_at,storage_request_generation,storage_uncertainty_until,recovery_from_state,storage_bucket,storage_path,feed_public_url,failure_code,created_at,updated_at,finalized_at,completed_at,failed_at'),
    fingerprintRows(supabase, 'public_feed_versions', 'id,version_number,operation,publication_mode,operation_id,previous_version_id,restored_from_version_id,project_id,affected_public_id,authorizing_actor_id,completion_actor_id,byte_count,feed_hash,record_count,published_snapshot_id,audit_record_id,created_at'),
    fingerprintRows(supabase, 'public_feed_version_members', 'version_id,ordinal,public_id,record_hash'),
    fingerprintRows(supabase, 'public_feed_head', 'singleton,current_version_id,generation,activated_by_id,activated_at,transitioned_by_id,transitioned_at,rollback_enabled,last_operation_id'),
    fingerprintRows(supabase, 'feed_rollback_preparations', 'handle,actor_id,target_version_id,baseline_version_id,acknowledgement_digest,operation_key,operation_id,created_at,expires_at,consumed_at'),
    fingerprintRows(supabase, 'public_feed_operation_events', 'operation_id,sequence,from_state,to_state,actor_id,owner_epoch,observed_storage_hash,observed_storage_record_count,code,created_at'),
  ]);
  return {
    admin: adminFingerprint,
    ordinary: Object.fromEntries(await Promise.all([
      'projects', 'import_batches', 'browser_import_commits', 'browser_import_media_commits', 'media_assets',
      'approval_records', 'validation_flags', 'project_disciplines', 'project_industry_categories',
      'participant_previews', 'participant_preview_confirmations', 'participant_preview_correction_requests',
    ].map(async (table) => [table, await fingerprintRows(supabase, table, '*')]))),
    adminRoles: adminRolesFingerprint,
    reference: { programs: programFingerprint, disciplines: disciplineFingerprint, industryCategories: industryFingerprint, adminIdentity: createHash('sha256').update(`${admin.adminUserId}:${admin.email}:${admin.fullName}`, 'utf8').digest('hex') },
    publication: { publishedSnapshots: snapshotsFingerprint, publicationAttempts: attemptsFingerprint, operations: operationsFingerprint, versions: versionsFingerprint, members: membersFingerprint, head: headFingerprint, rollbackPreparations: rollbackFingerprint, operationEvents: eventsFingerprint },
  };
}

async function verifySharedBaseline(
  supabase: SupabaseClient,
  runtime: Pick<ReleaseEvaluationRuntimeContext, 'admin' | 'sharedBaseline'>,
): Promise<Record<string, boolean>> {
  const current = await captureSharedBaseline(supabase, runtime.admin);
  return {
    ordinaryLocalRowsUnchanged: Object.entries(runtime.sharedBaseline.ordinary).every(([table, digest]) => current.ordinary[table] === digest),
    localAdminUnchanged: current.admin === runtime.sharedBaseline.admin
      && current.adminRoles === runtime.sharedBaseline.adminRoles
      && current.reference.adminIdentity === runtime.sharedBaseline.reference.adminIdentity,
    referenceTaxonomyUnchanged: current.reference.programs === runtime.sharedBaseline.reference.programs
      && current.reference.disciplines === runtime.sharedBaseline.reference.disciplines
      && current.reference.industryCategories === runtime.sharedBaseline.reference.industryCategories,
    publishedSnapshotsUnchanged: current.publication.publishedSnapshots === runtime.sharedBaseline.publication.publishedSnapshots,
    publicationAttemptsUnchanged: current.publication.publicationAttempts === runtime.sharedBaseline.publication.publicationAttempts,
    publicFeedLedgerUnchanged: Object.keys(runtime.sharedBaseline.publication)
      .filter((key) => !['publishedSnapshots', 'publicationAttempts'].includes(key))
      .every((key) => current.publication[key] === runtime.sharedBaseline.publication[key]),
  };
}

function itemByPackagePath(corpus: MaterializedReleaseEvaluationCorpus, batch: ReleaseMaterializedBatch, packagePath: string): ReleaseEvaluationCase {
  const caseId = batch.caseIds.find((id) => corpus.packages.get(id)?.packagePath === packagePath);
  if (!caseId) throw new Error(`Package path ${packagePath} has no case lineage.`);
  const item = corpus.cases.find((candidate) => candidate.caseId === caseId);
  if (!item) throw new Error(`Case ${caseId} is missing from the release manifest.`);
  return item;
}

function recordPreviewStages(
  corpus: MaterializedReleaseEvaluationCorpus,
  ledger: ReleaseEvidenceLedger,
  batch: ReleaseMaterializedBatch,
  analysis: Awaited<ReturnType<typeof analyzeBrowserImportServer>>,
): void {
  for (const pkg of analysis.preview.batch.packages) {
    const item = itemByPackagePath(corpus, batch, pkg.packagePath);
    deriveActualPreviewObservations(item.caseId, pkg).forEach((observation) => recordReleaseObservation(ledger, observation));
  }
  for (const control of corpus.negativeControls) {
    const pkg = analysis.preview.batch.packages.find((candidate) => candidate.packagePath === corpus.packages.get(control.caseId)?.packagePath);
    if (!pkg) continue;
    const blocking = pkg.errors.length > 0 || pkg.status === 'invalid';
    recordReleaseObservation(ledger, {
      caseId: control.caseId,
      stage: 'package-validation',
      attempt: `control-${control.assertionId}`,
      outcome: blocking ? 'rejected' : pkg.status === 'warning' ? 'warning' : 'accepted',
      controlAssertionId: control.assertionId,
      blocking,
    });
  }
}

async function stageAcceptedBatch(
  corpus: MaterializedReleaseEvaluationCorpus,
  ledger: ReleaseEvidenceLedger,
  batch: ReleaseMaterializedBatch,
  authContext: AuthenticatedAdminContext,
  runtime: ReleaseEvaluationRuntimeContext,
  selectedOverride?: string[],
  timing?: TimingContext,
): Promise<void> {
  const analysisStarted = timing?.now();
  const analysis = await analyzeBrowserImportServer(batch.materialized.selectionManifest, batch.materialized.uploadedMetadataFiles, batch.adminReferenceOptions);
  if (timing && analysisStarted !== undefined) {
    const elapsed = timing.now() - analysisStarted;
    addTiming(timing.timings, 'importAnalysis', elapsed);
    addTiming(timing.timings, 'packageParsingValidationAndReconciliation', elapsed);
  }
  recordPreviewStages(corpus, ledger, batch, analysis);
  const selectedPackagePaths = selectedOverride || analysis.packages.filter((pkg) => pkg.status === 'valid' || pkg.status === 'warning').map((pkg) => pkg.packagePath);
  const acknowledgedWarningPackagePaths = analysis.packages.filter((pkg) => pkg.status === 'warning').map((pkg) => pkg.packagePath);
  const prepared = prepareBrowserImportCommitIntent({
    manifest: batch.materialized.selectionManifest,
    preview: analysis.preview.batch,
    selectedPackagePaths,
    acknowledgedWarningPackagePaths,
    expectedPreviewFingerprint: analysis.preview.batch.previewFingerprint,
    adminReference: analysis.preview.batch.adminReference,
  });
  if (!prepared.success) throw new Error(`Commit intent preparation failed for ${batch.batchId}: ${prepared.code}`);
  selectedPackagePaths.forEach((packagePath) => {
    const item = itemByPackagePath(corpus, batch, packagePath);
    recordReleaseObservation(ledger, { caseId: item.caseId, stage: 'commit-intent', outcome: 'accepted' });
  });
  const metadataStarted = timing?.now();
  const metadata = await stageBrowserImportMetadata({ authContext, serverAnalysis: analysis, intent: prepared.intent });
  if (timing && metadataStarted !== undefined) addTiming(timing.timings, 'metadataStaging', timing.now() - metadataStarted);
  if (!metadata.success) throw new Error(`Metadata staging failed for ${batch.batchId}: ${metadata.code}`);
  runtime.ownedBatchIds.add(metadata.batchId);
  selectedPackagePaths.forEach((packagePath) => {
    const item = itemByPackagePath(corpus, batch, packagePath);
    runtime.ownedPublicIds.add(corpus.packages.get(item.caseId)!.publicId);
  });
  selectedPackagePaths.forEach((packagePath) => {
    const item = itemByPackagePath(corpus, batch, packagePath);
    recordReleaseObservation(ledger, { caseId: item.caseId, stage: 'server-revalidation', outcome: 'accepted' });
    recordReleaseObservation(ledger, { caseId: item.caseId, stage: 'metadata-staging', outcome: 'accepted' });
  });
  const preflight = runBrowserImportManifestPreflight(batch.materialized.selectionManifest);
  if (!preflight.success) throw new Error(`Media manifest preflight failed for ${batch.batchId}.`);
  const expectedMedia = resolveExpectedBrowserImportMedia({ preflight, packages: analysis.packages, selectedPackagePaths });
  if (!expectedMedia.success) throw new Error(`Expected media resolution failed for ${batch.batchId}: ${expectedMedia.code}`);
  const files: MediaFileToStage[] = expectedMedia.files.map((file) => {
    const content = batch.materialized.uploadedFiles.get(file.uploadKey);
    if (!content) throw new Error(`Synthetic media content is missing for ${file.uploadKey}.`);
    const validation = validateMediaAssetBytes({ fileName: file.fileName, content, expectedMimeType: file.canonicalMimeType, expectedFileSizeBytes: file.fileSizeBytes });
    if (!validation.valid) throw new Error(`Synthetic media bytes failed validation for ${file.fileName}.`);
    runtime.ownedStoragePaths.add(`drafts/${file.projectPublicId}/${file.assetType}/${file.fileName}`);
    return { ...file, content };
  });
  const mediaStarted = timing?.now();
  const media = await stageBrowserImportMedia({ authContext, batchId: metadata.batchId, metadataIntentHash: computeCanonicalIntentHash(prepared.intent), files });
  if (timing && mediaStarted !== undefined) addTiming(timing.timings, 'mediaStaging', timing.now() - mediaStarted);
  if (!media.success) throw new Error(`Media staging failed for ${batch.batchId}: ${media.code}`);
  selectedPackagePaths.forEach((packagePath) => {
    const item = itemByPackagePath(corpus, batch, packagePath);
    recordReleaseObservation(ledger, { caseId: item.caseId, stage: 'media-staging', outcome: 'accepted' });
    recordReleaseObservation(ledger, { caseId: item.caseId, stage: 'final-persistence', outcome: 'accepted', persisted: true });
  });
  batch.caseIds.forEach((caseId) => {
    const item = corpus.cases.find((candidate) => candidate.caseId === caseId);
    if (item) completeImportStageObservations(corpus, ledger, item);
  });
}

async function inspectAndStageSpecialBatch(
  supabase: SupabaseClient,
  corpus: MaterializedReleaseEvaluationCorpus,
  ledger: ReleaseEvidenceLedger,
  batch: ReleaseMaterializedBatch,
  authContext: AuthenticatedAdminContext,
  runtime: ReleaseEvaluationRuntimeContext,
  timing?: TimingContext,
): Promise<void> {
  const analysisStarted = timing?.now();
  const analysis = await analyzeBrowserImportServer(batch.materialized.selectionManifest, batch.materialized.uploadedMetadataFiles, batch.adminReferenceOptions);
  if (timing && analysisStarted !== undefined) {
    const elapsed = timing.now() - analysisStarted;
    addTiming(timing.timings, 'importAnalysis', elapsed);
    addTiming(timing.timings, 'packageParsingValidationAndReconciliation', elapsed);
  }
  recordPreviewStages(corpus, ledger, batch, analysis);
  for (const item of batch.caseIds.map((id) => corpus.cases.find((candidate) => candidate.caseId === id)!)) {
    const pkg = analysis.packages.find((candidate) => candidate.packagePath === corpus.packages.get(item.caseId)?.packagePath);
    if (!pkg) throw new Error(`Special case ${item.caseId} has no preview package.`);
    if (pkg.status !== 'valid' && pkg.status !== 'warning') continue;
    const selectedPackagePaths = [pkg.packagePath];
    const prepared = prepareBrowserImportCommitIntent({
      manifest: batch.materialized.selectionManifest,
      preview: analysis.preview.batch,
      selectedPackagePaths,
      acknowledgedWarningPackagePaths: pkg.status === 'warning' ? selectedPackagePaths : [],
      expectedPreviewFingerprint: analysis.preview.batch.previewFingerprint,
      adminReference: analysis.preview.batch.adminReference,
    });
    if (!prepared.success) {
      recordReleaseObservation(ledger, { caseId: item.caseId, stage: 'commit-intent', outcome: 'rejected', code: prepared.code });
      continue;
    }
    recordReleaseObservation(ledger, { caseId: item.caseId, stage: 'commit-intent', outcome: 'accepted' });
    recordReleaseObservation(ledger, { caseId: item.caseId, stage: 'server-revalidation', outcome: 'accepted' });
    const metadataStarted = timing?.now();
    const result = await stageBrowserImportMetadata({ authContext, serverAnalysis: analysis, intent: prepared.intent });
    if (timing && metadataStarted !== undefined) addTiming(timing.timings, 'metadataStaging', timing.now() - metadataStarted);
    if (result.success) {
      runtime.ownedBatchIds.add(result.batchId);
      runtime.ownedPublicIds.add(corpus.packages.get(item.caseId)!.publicId);
      recordReleaseObservation(ledger, { caseId: item.caseId, stage: 'metadata-staging', outcome: 'accepted' });
      recordReleaseObservation(ledger, { caseId: item.caseId, stage: 'final-persistence', outcome: 'accepted', persisted: true });
    } else {
      const persistenceEvidence = await verifyRejectedStagingPersistence(supabase, corpus, batch, item, runtime);
      recordReleaseObservation(ledger, {
        caseId: item.caseId,
        stage: 'metadata-staging',
        outcome: 'rejected',
        code: result.code,
        persisted: false,
        evidence: persistenceEvidence,
      });
    }
  }
  batch.caseIds.forEach((caseId) => {
    const item = corpus.cases.find((candidate) => candidate.caseId === caseId);
    if (item) completeImportStageObservations(corpus, ledger, item);
  });
}

async function verifyRejectedStagingPersistence(
  supabase: SupabaseClient,
  corpus: MaterializedReleaseEvaluationCorpus,
  batch: ReleaseMaterializedBatch,
  item: ReleaseEvaluationCase,
  runtime: ReleaseEvaluationRuntimeContext,
): Promise<Record<string, number | boolean>> {
  const targetPublicId = corpus.packages.get(item.caseId)?.publicId;
  if (!targetPublicId) throw new Error(`Rejected staging case ${item.caseId} has no runtime public ID.`);

  const projectResult = await supabase.from('projects').select('id').eq('public_id', targetPublicId);
  const batchResult = await supabase
    .from('import_batches')
    .select('id')
    .eq('source_folder', batch.materialized.selectionManifest.selectedRootName);
  if (projectResult.error || batchResult.error) {
    throw new Error(`Could not verify rejected staging persistence for ${item.caseId}.`);
  }

  const existingDuplicateProject = item.packageProfile === 'repeated-existing-public-id';
  const projectCount = projectResult.data?.length || 0;
  const batchCount = batchResult.data?.length || 0;
  if (
    (existingDuplicateProject && projectCount !== 1)
    || (!existingDuplicateProject && projectCount !== 0)
    || batchCount !== 0
  ) {
    throw new Error(`Rejected staging case ${item.caseId} left unexpected persisted rows.`);
  }

  return {
    persistenceChecked: true,
    projectRowsAfterAttempt: projectCount,
    importBatchRowsAfterAttempt: batchCount,
    existingDuplicateProjectPreserved: existingDuplicateProject
      && runtime.ownedPublicIds.has(targetPublicId),
  };
}

function actionOutcome(outcome: string): 'accepted' | 'rejected' | 'warning' {
  if (outcome === 'successful') return 'accepted';
  if (outcome === 'already_complete') return 'warning';
  return 'rejected';
}

async function runBulkAction(params: {
  service: BulkReviewService;
  actor: BulkReviewActor;
  action: BulkReviewAction;
  preflightIds: string[];
  executeIds: string[];
  attempt: string;
  comments?: string;
  ledger: ReleaseEvidenceLedger;
  caseByPublicId: Map<string, ReleaseEvaluationCase>;
  beforeExecute?: () => Promise<void>;
  timing?: TimingContext;
}): Promise<{ preflight: StageTotals; execution: StageTotals; resultCodes: Record<string, number> }> {
  const expectedUpdatedAt: Record<string, string | null> = {};
  const preflight: StageTotals = { selected: params.preflightIds.length, accepted: 0, rejected: 0, warnings: 0 };
  const preflightStarted = params.timing?.now();
  for (const cohort of chunks(params.preflightIds, 50)) {
    const response = await params.service.preflight({ action: params.action, publicIds: cohort, actor: params.actor });
    assertCohortAccounting(cohort, response.items.map((item) => item.publicId));
    response.items.forEach((item) => {
      expectedUpdatedAt[item.publicId] = item.updatedAt;
      if (item.disposition === 'eligible') preflight.accepted += 1;
      else if (item.disposition === 'already_complete') preflight.warnings += 1;
      else preflight.rejected += 1;
      const caseItem = params.caseByPublicId.get(item.publicId);
      if (caseItem) {
        recordReleaseObservation(params.ledger, { caseId: caseItem.caseId, stage: 'workflow', attempt: `${params.attempt}-preflight`, outcome: item.disposition === 'eligible' ? 'accepted' : item.disposition === 'already_complete' ? 'warning' : 'rejected', code: item.reasons[0]?.code, finalStatus: item.status || undefined });
      }
    });
  }
  if (params.timing && preflightStarted !== undefined) addTiming(params.timing.timings, 'bulkPreflight', params.timing.now() - preflightStarted);
  if (params.beforeExecute) await params.beforeExecute();
  const execution: StageTotals = { selected: params.executeIds.length, accepted: 0, rejected: 0, warnings: 0 };
  const resultCodes: Record<string, number> = {};
  const executionStarted = params.timing?.now();
  for (const cohort of chunks(params.executeIds, 50)) {
    const response = await params.service.execute({ action: params.action, publicIds: cohort, expectedUpdatedAt, comments: params.comments, actor: params.actor });
    assertCohortAccounting(cohort, response.items.map((item) => item.publicId));
    response.items.forEach((item) => {
      if (item.outcome === 'successful') execution.accepted += 1;
      else if (item.outcome === 'already_complete') execution.warnings += 1;
      else execution.rejected += 1;
      const resultCode = item.reasons[0]?.code;
      if (resultCode) resultCodes[resultCode] = (resultCodes[resultCode] || 0) + 1;
      const caseItem = params.caseByPublicId.get(item.publicId);
      if (caseItem) recordReleaseObservation(params.ledger, { caseId: caseItem.caseId, stage: 'workflow', attempt: `${params.attempt}-execution`, outcome: actionOutcome(item.outcome), code: item.reasons[0]?.code, finalStatus: item.status || undefined });
    });
  }
  if (params.timing && executionStarted !== undefined) addTiming(params.timing.timings, 'bulkExecution', params.timing.now() - executionStarted);
  return { preflight, execution, resultCodes };
}

async function updateStaleProjects(supabase: SupabaseClient, publicIds: string[]): Promise<void> {
  if (publicIds.length === 0) return;
  const result = await supabase.from('projects').update({ summary: 'Synthetic release evaluation stale-version mutation.' }).in('public_id', publicIds);
  if (result.error) throw new Error('The deterministic stale-version mutation failed.');
}

async function runParticipantEvidence(
  corpus: MaterializedReleaseEvaluationCorpus,
  runtime: ReleaseEvaluationRuntimeContext,
  supabase: SupabaseClient,
  approvedCases: ReleaseEvaluationCase[],
): Promise<{ ready: number; unconfirmed: number; noPreview: number; corrections: number }> {
  const previews = new SupabaseParticipantPreviewRepositoryCore(supabase);
  const correctionCases = approvedCases.filter((item) => item.lifecycleProfile === 'participant-correction');
  const regularCases = approvedCases.filter((item) => item.lifecycleProfile === 'successful-approval');
  for (const [index, item] of regularCases.entries()) {
    if (index >= 30) continue;
    const publicId = corpus.packages.get(item.caseId)!.publicId;
    const tokenHash = createHash('sha256').update(`release-evaluation:${corpus.runNamespace}:${item.caseId}`, 'utf8').digest('hex');
    const preview = await previews.generatePreview({ publicId, adminId: runtime.admin.adminUserId, tokenHash, privateBucket: runtime.privateBucket });
    runtime.previewIds.add(preview.previewId);
    if (index < 20) await previews.confirmPreview(tokenHash);
    else {
      // An unconfirmed preview is intentionally retained to exercise PREVIEW_NOT_CONFIRMED.
    }
  }
  for (const item of correctionCases) {
    const publicId = corpus.packages.get(item.caseId)!.publicId;
    const tokenHash = createHash('sha256').update(`release-evaluation:${corpus.runNamespace}:${item.caseId}`, 'utf8').digest('hex');
    const preview = await previews.generatePreview({ publicId, adminId: runtime.admin.adminUserId, tokenHash, privateBucket: runtime.privateBucket });
    runtime.previewIds.add(preview.previewId);
    const correction = await previews.requestCorrection(tokenHash, 'Synthetic participant correction request.');
    if (!correction) throw new Error(`Participant correction request failed for ${item.caseId}.`);
    await previews.startCorrectionResolution({ publicId, adminId: runtime.admin.adminUserId });
  }
  return { ready: Math.min(20, regularCases.length), unconfirmed: Math.max(0, Math.min(10, regularCases.length - 20)), noPreview: Math.max(0, regularCases.length - 30) + approvedCases.filter((item) => item.lifecycleProfile === 'already-approved').length, corrections: correctionCases.length };
}

async function verifyIndex(
  repository: SupabaseProjectRepositoryCore,
  corpus: MaterializedReleaseEvaluationCorpus,
  taxonomy: { program: string; discipline: string },
  evidenceMode: boolean,
): Promise<Record<string, unknown>> {
  const prefix = `release-${corpus.runNamespace}`;
  const evidence: Record<string, unknown> = {
    total: 0,
    pageSizes: {},
    search: false,
    exactFilters: false,
    sorting: false,
    finalPage: false,
    screenshotCapture: {
      status: 'not_captured_by_automation',
      evidenceModeAvailable: true,
      evidenceModeRequested: evidenceMode,
      requiredViewports: ['1440x900', '390x844'],
    },
  };
  const pageSizes: Record<string, number> = {};
  for (const pageSize of [10, 25, 50] as const) {
    const result = await repository.listProjectsPage(parseProjectListQuery({ q: prefix, pageSize: String(pageSize), page: '1' }));
    if (result.total !== 120 || result.projects.length > pageSize) throw new Error(`Repository index bounded query failed at page size ${pageSize}.`);
    pageSizes[String(pageSize)] = result.projects.length;
  }
  const sample = corpus.packages.get('release-case-001')!.publicId;
  const sampleResult = await repository.listProjectsPage(parseProjectListQuery({ q: prefix, pageSize: '10' }));
  const sampleProject = sampleResult.projects.find((project) => project.publicId === sample) || sampleResult.projects[0];
  if (!sampleProject) throw new Error('Repository index returned no verifier-owned sample project.');
  const searchTerms = [sampleProject.title, sampleProject.publicId, sampleProject.industryPartner, sampleProject.groupName].map((term) => typeof term === 'string' ? term : '');
  if (searchTerms.some((term) => term.trim() === '')) throw new Error('Repository index sample is missing a searchable field.');
  const searchResults = await Promise.all(searchTerms.map((term) => repository.listProjectsPage(parseProjectListQuery({ q: term.toUpperCase(), pageSize: '10' }))));
  const search = searchResults.every((result) => result.total > 0);
  const filterInputs = [
    { status: 'approved' },
    { year: sampleProject.year },
    { program: taxonomy.program },
    { discipline: taxonomy.discipline },
  ];
  const filterResults = await Promise.all(filterInputs.map((filter) => repository.listProjectsPage(parseProjectListQuery({ q: prefix, ...filter, pageSize: '50' }))));
  const exactFilters = filterResults.every((result) => result.total > 0 && result.projects.every((project) => (
    filterResults.indexOf(result) === 0 ? project.status === 'approved' :
      filterResults.indexOf(result) === 1 ? project.year === sampleProject.year :
        filterResults.indexOf(result) === 2 ? project.program === taxonomy.program : project.discipline === taxonomy.discipline
  )));
  const sorted = await repository.listProjectsPage(parseProjectListQuery({ q: prefix, sort: 'title', direction: 'asc', pageSize: '50' }));
  const sorting = sorted.projects.every((project, index, projects) => {
    const next = projects[index + 1];
    if (!next) return true;
    return project.title < next.title || (project.title === next.title && (project.publicId || '') <= (next.publicId || ''));
  });
  const finalPage = await repository.listProjectsPage(parseProjectListQuery({ q: prefix, pageSize: '50', page: '3' }));
  evidence.total = 120;
  evidence.pageSizes = pageSizes;
  evidence.search = search;
  evidence.exactFilters = exactFilters;
  evidence.sorting = sorting;
  evidence.finalPage = finalPage.page === finalPage.pageCount
    && finalPage.pageCount === 3
    && finalPage.projects.length === 20
    && finalPage.projects.length <= 50;
  if (!search || !exactFilters || !sorting || !Boolean(evidence.finalPage)) throw new Error('Repository index query semantics failed.');
  return evidence;
}

async function countOwnedRows(supabase: SupabaseClient, table: string, column: string, values: string[]): Promise<number> {
  if (values.length === 0) return 0;
  const result = await supabase.from(table).select(column, { count: 'exact', head: true }).in(column, values);
  if (result.error) return -1;
  return result.count || 0;
}

async function countOwnedStorageObjects(supabase: SupabaseClient, bucket: string, publicIds: string[]): Promise<number> {
  const listed = await listOwnedStoragePaths(supabase, bucket, publicIds);
  return listed.failed ? -1 : listed.paths.length;
}

async function listReleaseStorageDirectory(supabase: SupabaseClient, bucket: string, prefix: string) {
  const entries: { name: string; id: string | null }[] = [];
  for (let offset = 0; ; offset += 1000) {
    const result = await supabase.storage.from(bucket).list(prefix, {
      limit: 1000, offset, sortBy: { column: 'name', order: 'asc' },
    });
    if (result.error || !result.data) return { entries, failed: true };
    entries.push(...result.data);
    if (result.data.length < 1000) return { entries, failed: false };
  }
}

async function listOwnedStoragePaths(
  supabase: SupabaseClient,
  bucket: string,
  publicIds: string[],
): Promise<{ paths: string[]; failed: boolean }> {
  const paths = new Set<string>();
  let failed = false;
  const assetTypes = ['poster_image', 'poster_pdf', 'snapshot_image'];
  for (const publicId of publicIds) {
    const directory = await listReleaseStorageDirectory(supabase, bucket, `drafts/${publicId}`);
    // Unexpected objects/folders are ambiguous, not evaluator media to adopt and delete.
    failed = directory.failed || directory.entries.some((entry) => entry.id !== null || !assetTypes.includes(entry.name)) || failed;
    for (const assetType of assetTypes) {
      const result = await listReleaseStorageDirectory(supabase, bucket, `drafts/${publicId}/${assetType}`);
      failed = result.failed || failed;
      result.entries.forEach((entry) => {
        if (!entry.id || !entry.name || entry.name === '.' || entry.name === '..' || /[/\\]/.test(entry.name)) {
          failed = true;
          return;
        }
        paths.add(`drafts/${publicId}/${assetType}/${entry.name}`);
      });
    }
  }
  return { paths: [...paths].sort(), failed };
}

interface ReleaseCleanupContext {
  privateBucket: string;
  ownedPublicIds: Set<string>;
  ownedBatchIds: Set<string>;
  ownedStoragePaths: Set<string>;
  previewIds: Set<string>;
  sharedBaseline?: ReleaseSharedBaseline;
  admin?: AuthenticatedAdminContext;
}

export async function cleanupOwnedState(supabase: SupabaseClient, runtime: ReleaseCleanupContext): Promise<{ completed: boolean; residue: Record<string, number>; scopesChecked: string[]; baselineChecks: Record<string, boolean> }> {
  const ownedIds = [...runtime.ownedPublicIds].sort();
  const batchIds = [...runtime.ownedBatchIds].sort();
  let cleanupFailed = false;
  const namespace = /^release-(run-[1-2]-[0-9a-f]{16})-/.exec(ownedIds[0] || '')?.[1];
  if (ownedIds.length && (!namespace || ownedIds.some((id) => !id.startsWith(`release-${namespace}-`)))) {
    throw new Error('Release cleanup refused identities outside a single verifier namespace.');
  }
  if (namespace) {
    const discovered = await supabase.from('import_batches').select('id').like('source_folder', `release-${namespace}-%`);
    cleanupFailed ||= Boolean(discovered.error);
    (discovered.data || []).forEach((row) => { if (!batchIds.includes(String(row.id))) batchIds.push(String(row.id)); });
  }
  const projectResult = ownedIds.length ? await supabase.from('projects').select('id').in('public_id', ownedIds) : { data: [], error: null };
  cleanupFailed ||= Boolean(projectResult.error);
  const projectIds = (projectResult.data || []).map((row) => String(row.id));
  const media = projectIds.length ? await supabase.from('media_assets').select('storage_bucket,storage_path').in('project_id', projectIds) : { data: [], error: null };
  cleanupFailed ||= Boolean(media.error);
  const privatePaths = new Set<string>(runtime.ownedStoragePaths);
  (media.data || []).forEach((row) => {
    if (String(row.storage_bucket) !== runtime.privateBucket) {
      cleanupFailed = true;
      return;
    }
    const storagePath = String(row.storage_path);
    if (ownedIds.some((publicId) => storagePath.startsWith(`drafts/${publicId}/`))) privatePaths.add(storagePath);
    else cleanupFailed = true;
  });
  const listedStorage = await listOwnedStoragePaths(supabase, runtime.privateBucket, ownedIds);
  cleanupFailed ||= listedStorage.failed;
  listedStorage.paths.forEach((storagePath) => privatePaths.add(storagePath));
  if (privatePaths.size) {
    if ([...privatePaths].some((storagePath) => !ownedIds.some((id) => storagePath.startsWith(`drafts/${id}/`)))) {
      throw new Error('Release cleanup refused a storage path outside the owned project scope.');
    }
    const storageRemoval = await supabase.storage.from(runtime.privateBucket).remove([...privatePaths]);
    cleanupFailed ||= Boolean(storageRemoval.error);
  }
  const discoveredPreviews = projectIds.length ? await supabase.from('participant_previews').select('id').in('project_id', projectIds) : { data: [], error: null };
  cleanupFailed ||= Boolean(discoveredPreviews.error);
  const previews = [...new Set([...runtime.previewIds, ...(discoveredPreviews.data || []).map((row) => String(row.id))])];
  if (previews.length) {
    cleanupFailed = Boolean((await supabase.from('participant_preview_correction_requests').delete().in('participant_preview_id', previews)).error) || cleanupFailed;
    cleanupFailed = Boolean((await supabase.from('participant_preview_confirmations').delete().in('participant_preview_id', previews)).error) || cleanupFailed;
    cleanupFailed = Boolean((await supabase.from('participant_previews').delete().in('id', previews)).error) || cleanupFailed;
  }
  if (projectIds.length) {
    cleanupFailed = Boolean((await supabase.from('approval_records').delete().in('project_id', projectIds)).error) || cleanupFailed;
    cleanupFailed = Boolean((await supabase.from('validation_flags').delete().in('project_id', projectIds)).error) || cleanupFailed;
    cleanupFailed = Boolean((await supabase.from('project_disciplines').delete().in('project_id', projectIds)).error) || cleanupFailed;
    cleanupFailed = Boolean((await supabase.from('project_industry_categories').delete().in('project_id', projectIds)).error) || cleanupFailed;
    cleanupFailed = Boolean((await supabase.from('media_assets').delete().in('project_id', projectIds)).error) || cleanupFailed;
    cleanupFailed = Boolean((await supabase.from('projects').delete().in('id', projectIds)).error) || cleanupFailed;
  }
  if (batchIds.length) {
    cleanupFailed = Boolean((await supabase.from('browser_import_media_commits').delete().in('batch_id', batchIds)).error) || cleanupFailed;
    cleanupFailed = Boolean((await supabase.from('browser_import_commits').delete().in('batch_id', batchIds)).error) || cleanupFailed;
    cleanupFailed = Boolean((await supabase.from('import_batches').delete().in('id', batchIds)).error) || cleanupFailed;
  }
  const residue: Record<string, number> = {
    projects: await countOwnedRows(supabase, 'projects', 'public_id', ownedIds),
    importBatches: await countOwnedRows(supabase, 'import_batches', 'id', batchIds),
    browserImportCommits: await countOwnedRows(supabase, 'browser_import_commits', 'batch_id', batchIds),
    browserImportMediaCommits: await countOwnedRows(supabase, 'browser_import_media_commits', 'batch_id', batchIds),
    mediaAssets: projectIds.length ? await countOwnedRows(supabase, 'media_assets', 'project_id', projectIds) : 0,
    projectDisciplines: projectIds.length ? await countOwnedRows(supabase, 'project_disciplines', 'project_id', projectIds) : 0,
    projectIndustryCategories: projectIds.length ? await countOwnedRows(supabase, 'project_industry_categories', 'project_id', projectIds) : 0,
    validationFlags: projectIds.length ? await countOwnedRows(supabase, 'validation_flags', 'project_id', projectIds) : 0,
    approvalRecords: projectIds.length ? await countOwnedRows(supabase, 'approval_records', 'project_id', projectIds) : 0,
    previews: previews.length ? await countOwnedRows(supabase, 'participant_previews', 'id', previews) : 0,
    previewConfirmations: previews.length ? await countOwnedRows(supabase, 'participant_preview_confirmations', 'participant_preview_id', previews) : 0,
    correctionRequests: previews.length ? await countOwnedRows(supabase, 'participant_preview_correction_requests', 'participant_preview_id', previews) : 0,
    privateStorageObjects: await countOwnedStorageObjects(supabase, runtime.privateBucket, ownedIds),
  };
  const baselineChecks = runtime.admin && runtime.sharedBaseline
    ? await verifySharedBaseline(supabase, runtime as Pick<ReleaseEvaluationRuntimeContext, 'admin' | 'sharedBaseline'>)
    : {};
  return {
    completed: !cleanupFailed && Object.values(residue).every((value) => value === 0) && Object.values(baselineChecks).every(Boolean),
    residue,
    scopesChecked: ['projects', 'import_batches', 'browser_import_commits', 'browser_import_media_commits', 'media_assets', 'project_disciplines', 'project_industry_categories', 'validation_flags', 'approval_records', 'participant_previews', 'participant_preview_confirmations', 'participant_preview_correction_requests', 'private draft storage paths', 'Local admin identity', 'shared taxonomy references', 'publication/feed ledger'],
    baselineChecks,
  };
}

/**
 * Recover a prior evaluator run, including Storage left after database cleanup.
 * The namespace is deliberately strict so this path cannot become a general-purpose cleanup.
 */
export async function cleanupInterruptedReleaseEvaluationRun(params: {
  supabase: SupabaseClient;
  apiUrl: string;
  runNamespace: string;
}): Promise<ReleaseCleanupRecoveryResult> {
  assertReleaseLocalTarget(params.apiUrl, [clientUrl(params.supabase)]);
  validateReleaseEvaluationRunNamespace(params.runNamespace);
  const prefix = `release-${params.runNamespace}-`;
  const projectsResult = await params.supabase
    .from('projects')
    .select('id,public_id')
    .like('public_id', `${prefix}%`);
  const batchesResult = await params.supabase
    .from('import_batches')
    .select('id,source_folder')
    .like('source_folder', `${prefix}%`);
  if (projectsResult.error || batchesResult.error) {
    throw new Error('Could not discover the requested release evaluation namespace safely.');
  }
  const ownedPublicIds = new Set((projectsResult.data || []).map((row) => String(row.public_id)).filter(Boolean));
  // Storage survives independently of projects/media_assets. Discover folders by the exact
  // reserved namespace and synthetic identity shape, never a substring or a DB-only join.
  const bucket = getStagingBuckets().DRAFT_PRIVATE;
  const storageFolders = await listReleaseStorageDirectory(params.supabase, bucket, 'drafts');
  if (storageFolders.failed) throw new Error('Could not discover evaluator private storage safely; no cleanup was attempted.');
  for (const entry of storageFolders.entries) {
    if (!entry.name.startsWith(prefix)) continue;
    if (entry.id !== null || !/^synthetic-[0-9]{4}-[0-9]{4}$/.test(entry.name.slice(prefix.length))) {
      throw new Error('Ambiguous object in evaluator storage namespace; no cleanup was attempted.');
    }
    ownedPublicIds.add(entry.name);
  }
  const ownedBatchIds = new Set((batchesResult.data || []).map((row) => String(row.id)).filter(Boolean));
  const projectIds = (projectsResult.data || []).map((row) => String(row.id)).filter(Boolean);
  const previewsResult = projectIds.length
    ? await params.supabase.from('participant_previews').select('id').in('project_id', projectIds)
    : { data: [], error: null };
  if (previewsResult.error) throw new Error('Could not discover evaluator preview rows safely.');
  const listedStorage = await listOwnedStoragePaths(params.supabase, bucket, [...ownedPublicIds].sort());
  if (listedStorage.failed) throw new Error('Could not inspect evaluator private storage safely; no cleanup was attempted.');
  const cleanup = await cleanupOwnedState(params.supabase, {
    privateBucket: bucket,
    ownedPublicIds,
    ownedBatchIds,
    ownedStoragePaths: new Set(listedStorage.paths),
    previewIds: new Set((previewsResult.data || []).map((row) => String(row.id)).filter(Boolean)),
  });
  return { completed: cleanup.completed, runNamespace: params.runNamespace, residue: cleanup.residue, scopesChecked: cleanup.scopesChecked };
}

export async function runReleaseEvaluation(options: ReleaseEvaluationHarnessOptions): Promise<ReleaseEvaluationReport> {
  assertReleaseLocalTarget(options.apiUrl, [clientUrl(options.supabase)]);
  assertReleaseLocalTarget(options.apiUrl, [process.env.NEXT_PUBLIC_SUPABASE_URL || '']);
  assertReleaseLocalTarget(options.apiUrl, [clientUrl(createSupabaseAdminClientCore())]);
  const now = options.now || (() => performance.now());
  const runNumber = options.runNumber || 1;
  const runToken = randomBytes(8).toString('hex');
  const runNamespace = options.runNamespace || `run-${runNumber}-${runToken}`;
  const runId = options.runId || `release-${runNumber}-${runToken}`;
  validateReleaseEvaluationRunNamespace(runNamespace);
  options.onRunNamespace?.(runNamespace);
  const start = now();
  const timings: Record<string, number | Record<string, number>> = {};
  const corpusStarted = now();
  const corpus = buildReleaseEvaluationCorpus(options.seed);
  timings.corpusGeneration = Number((now() - corpusStarted).toFixed(3));
  const ledger = createReleaseEvidenceLedger(corpus);
  const admin = await resolveAdminContext(options.supabase);
  const buckets = getStagingBuckets();
  const privateBucket = await options.supabase.storage.getBucket(buckets.DRAFT_PRIVATE);
  if (privateBucket.error || !privateBucket.data || privateBucket.data.public
    || [buckets.PUBLIC_ASSETS, buckets.PUBLIC_FEEDS].includes(buckets.DRAFT_PRIVATE)) {
    throw new Error('Release evaluation requires a verified private draft bucket.');
  }
  const sharedBaseline = await captureSharedBaseline(options.supabase, admin);
  const runtime: ReleaseEvaluationRuntimeContext = {
    admin,
    privateBucket: buckets.DRAFT_PRIVATE,
    publicBucket: buckets.PUBLIC_ASSETS,
    publicFeedBucket: buckets.PUBLIC_FEEDS,
    taxonomy: await resolveSeededTaxonomy(options.supabase),
    ownedPublicIds: new Set(),
    ownedBatchIds: new Set(),
    ownedStoragePaths: new Set(),
    previewIds: new Set(),
    sharedBaseline,
  };
  const time = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
    const started = now();
    const value = await operation();
    timings[name] = Number((now() - started).toFixed(3));
    return value;
  };
  let cleanup: ReleaseEvaluationReport['cleanup'] = { completed: false, residue: {}, scopesChecked: [] };
  try {
    const materialized = await time('packageMaterialization', () => materializeReleaseEvaluationCorpus({ seed: corpus.seed, runNamespace, metadataTaxonomy: runtime.taxonomy }));
    const prefix = `release-${runNamespace}-`;
    const existingProjects = await options.supabase.from('projects').select('id', { count: 'exact', head: true }).like('public_id', `${prefix}%`);
    const existingBatches = await options.supabase.from('import_batches').select('id', { count: 'exact', head: true }).like('source_folder', `${prefix}%`);
    const intendedIds = [...new Set([...materialized.packages.values()].map((pkg) => pkg.publicId))];
    if (existingProjects.error || existingBatches.error || existingProjects.count || existingBatches.count
      || await countOwnedStorageObjects(options.supabase, runtime.privateBucket, intendedIds) !== 0) {
      throw new Error('Release namespace is not empty; refusing to adopt pre-existing data.');
    }
    // Own intended identities before any RPC: a committed write with a lost response must still be cleaned.
    intendedIds.forEach((id) => runtime.ownedPublicIds.add(id));
    const probeRuntime: ReleaseEvaluationRuntimeContext = {
      ...runtime,
      ownedPublicIds: new Set([materialized.packages.get('release-case-001')!.publicId]),
      ownedBatchIds: new Set(),
      ownedStoragePaths: new Set(),
      previewIds: new Set(),
      sharedBaseline,
    };
    const probeLedger = createReleaseEvidenceLedger(corpus);
    const probePackagePath = materialized.acceptedBatches[0].materialized.packages[0].packagePath;
    const forcedFailureProbe = await runForcedFailureCleanupProbe({
      createOwnedState: () => stageAcceptedBatch(materialized, probeLedger, materialized.acceptedBatches[0], admin, probeRuntime, [probePackagePath]),
      cleanupOwnedState: () => cleanupOwnedState(options.supabase, probeRuntime),
    });
    if (!forcedFailureProbe.completed) throw new Error('Forced-failure cleanup did not prove zero residue and unchanged baseline.');
    const acceptedStart = now();
    const importTiming = { now, timings };
    for (const batch of materialized.acceptedBatches) await stageAcceptedBatch(materialized, ledger, batch, admin, runtime, undefined, importTiming);
    timings.importAndStaging = Number((now() - acceptedStart).toFixed(3));
    for (const batch of materialized.rejectedBatches) await inspectAndStageSpecialBatch(options.supabase, materialized, ledger, batch, admin, runtime, importTiming);

    const caseByPublicId = new Map<string, ReleaseEvaluationCase>();
    materialized.cases.forEach((item) => {
      const pkg = materialized.packages.get(item.caseId);
      if (pkg && item.expected.persistence === 'persisted' && !caseByPublicId.has(pkg.publicId)) {
        caseByPublicId.set(pkg.publicId, item);
      }
    });
    const bulkService = new BulkReviewService(new SupabaseBulkProjectReviewGateway(options.supabase, runtime.privateBucket));
    const actor: BulkReviewActor = { adminId: admin.adminUserId, permissions: admin.permissions };
    const persistedItems = materialized.cases.filter((item) => item.expected.persistence === 'persisted');
    const readinessStartedAt = now();
    const importRepository = new ImportBatchRepositoryCore(options.supabase);
    for (const item of persistedItems) {
      const row = await importRepository.getProjectReviewDataByPublicId(materialized.packages.get(item.caseId)!.publicId);
      if (!row) throw new Error(`Missing persisted readiness case ${item.caseId}.`);
      const readiness = computeReadinessForImportBatchRow(row);
      recordReleaseObservation(ledger, { caseId: item.caseId, stage: 'review-readiness', outcome: readiness.ready ? readiness.warnings.length ? 'warning' : 'accepted' : 'rejected', code: readiness.ready ? 'READY' : 'READINESS_BLOCKED' });
      readiness.blockingReasons.forEach((message, index) => recordReleaseObservation(ledger, {
        caseId: item.caseId, stage: 'review-readiness', attempt: `reason-${index}`, outcome: 'rejected', code: 'READINESS_BLOCKED', fieldName: readinessField(message),
      }));
    }
    timings.validationReadiness = Number((now() - readinessStartedAt).toFixed(3));
    const publicIds = [...new Set(persistedItems.map((item) => materialized.packages.get(item.caseId)!.publicId))];
    const alreadySubmitted = persistedItems.filter((item) => item.lifecycleProfile === 'already-submitted').map((item) => materialized.packages.get(item.caseId)!.publicId);
    const alreadyApproved = persistedItems.filter((item) => item.lifecycleProfile === 'already-approved').map((item) => materialized.packages.get(item.caseId)!.publicId);
    const stale = persistedItems.filter((item) => item.lifecycleProfile === 'stale-approval-candidate').map((item) => materialized.packages.get(item.caseId)!.publicId);
    const mainSubmit = persistedItems.filter((item) => ['stale-approval-candidate', 'successful-approval', 'bulk-request-changes', 'participant-correction', 'archived'].includes(item.lifecycleProfile || '')).map((item) => materialized.packages.get(item.caseId)!.publicId);
    const bulkTiming = { now, timings };
    const setupSubmitted = await runBulkAction({ service: bulkService, actor, action: 'submit_for_review', preflightIds: alreadySubmitted, executeIds: alreadySubmitted, attempt: 'setup-submitted', ledger, caseByPublicId, timing: bulkTiming });
    const setupApprovedSubmit = await runBulkAction({ service: bulkService, actor, action: 'submit_for_review', preflightIds: alreadyApproved, executeIds: alreadyApproved, attempt: 'setup-approved-submit', ledger, caseByPublicId, timing: bulkTiming });
    const setupApproved = await runBulkAction({ service: bulkService, actor, action: 'approve', preflightIds: alreadyApproved, executeIds: alreadyApproved, attempt: 'setup-approved', ledger, caseByPublicId, timing: bulkTiming });
    const submitAll = await runBulkAction({ service: bulkService, actor, action: 'submit_for_review', preflightIds: publicIds, executeIds: mainSubmit, attempt: 'bulk-submit', ledger, caseByPublicId, timing: bulkTiming });
    const approvalCases = persistedItems.filter((item) => ['stale-approval-candidate', 'already-approved', 'successful-approval', 'participant-correction', 'already-submitted'].includes(item.lifecycleProfile || ''));
    const approvalPreflightIds = approvalCases.map((item) => materialized.packages.get(item.caseId)!.publicId);
    const approveExecuteIds = approvalCases.filter((item) => item.lifecycleProfile !== 'already-submitted' && item.lifecycleProfile !== 'already-approved').map((item) => materialized.packages.get(item.caseId)!.publicId);
    const approval = await runBulkAction({ service: bulkService, actor, action: 'approve', preflightIds: approvalPreflightIds, executeIds: approveExecuteIds, attempt: 'bulk-approve', ledger, caseByPublicId, beforeExecute: () => updateStaleProjects(options.supabase, stale), timing: bulkTiming });
    const requestCases = persistedItems.filter((item) => item.lifecycleProfile === 'bulk-request-changes');
    const requestIds = requestCases.map((item) => materialized.packages.get(item.caseId)!.publicId);
    const requestChanges = await runBulkAction({ service: bulkService, actor, action: 'request_changes', preflightIds: requestIds, executeIds: requestIds, attempt: 'bulk-request-changes', comments: 'Synthetic release evaluation correction request.', ledger, caseByPublicId, timing: bulkTiming });
    const participantStarted = now();
    const correctionResult = await runParticipantEvidence(materialized, runtime, options.supabase, persistedItems.filter((item) => item.lifecycleProfile === 'successful-approval' || item.lifecycleProfile === 'already-approved' || item.lifecycleProfile === 'participant-correction'));
    timings.participantAndCorrection = Number((now() - participantStarted).toFixed(3));
    const archiveCases = persistedItems.filter((item) => item.lifecycleProfile === 'archived');
    const archiveIds = archiveCases.map((item) => materialized.packages.get(item.caseId)!.publicId);
    const archiveResults: StageTotals = { selected: archiveIds.length, accepted: 0, rejected: 0, warnings: 0 };
    for (const id of archiveIds) {
      const result = await new SupabaseProjectRepositoryCore(options.supabase).performReviewAction({ publicId: id, action: 'archive', adminId: admin.adminUserId });
      archiveResults.accepted += 1;
      const item = caseByPublicId.get(id);
      if (item) recordReleaseObservation(ledger, { caseId: item.caseId, stage: 'workflow', attempt: 'archive-execution', outcome: 'accepted', finalStatus: result.status });
    }
    const repository = new SupabaseProjectRepositoryCore(options.supabase);
    const projectRows = await options.supabase.from('projects').select('id,public_id,status').in('public_id', publicIds);
    if (projectRows.error) throw new Error('Release evaluation could not verify final project states.');
    const projectIdByPublicId = new Map<string, string>();
    const statusByPublicId = new Map<string, string>();
    (projectRows.data || []).forEach((row) => {
      projectIdByPublicId.set(String(row.public_id), String(row.id));
      statusByPublicId.set(String(row.public_id), String(row.status));
    });
    const finalStatusCounts: Record<string, number> = {};
    (projectRows.data || []).forEach((row) => { const status = String(row.status); finalStatusCounts[status] = (finalStatusCounts[status] || 0) + 1; });
    const normalizedFinalStatusCounts = sortedNumberRecord(finalStatusCounts);
    const projectIds = [...projectIdByPublicId.values()];
    const auditRows = await options.supabase.from('approval_records').select('admin_id,action_taken,from_status,to_status,comments,project_id').in('project_id', projectIds);
    if (auditRows.error) throw new Error('Release evaluation could not verify workflow audit records.');
    const expectedAuditCount = corpus.cases.reduce((total, item) => total + item.expected.reviewActions.length, 0);
    const duplicateAuditKeys = new Set<string>();
    (auditRows.data || []).forEach((row) => duplicateAuditKeys.add(`${row.project_id}:${row.action_taken}:${row.from_status}:${row.to_status}`));
    const caseByProjectId = new Map<string, string>();
    projectIdByPublicId.forEach((projectId, publicId) => {
      const item = caseByPublicId.get(publicId);
      if (item) caseByProjectId.set(projectId, item.caseId);
    });
    const auditSignatures = (auditRows.data || []).map((row) => `${caseByProjectId.get(String(row.project_id)) || 'unknown-case'}:${row.action_taken}:${row.from_status}:${row.to_status}`).sort();
    const expectedAuditSignatures = persistedItems.flatMap((item) => item.expected.reviewActions.map((action) => `${item.caseId}:${action.action}:${action.fromStatus}:${action.toStatus}`)).sort();
    const auditComments = (auditRows.data || []).map((row) => `${caseByProjectId.get(String(row.project_id)) || 'unknown-case'}:${row.action_taken}:${row.comments === null ? '' : String(row.comments)}`).sort();
    const expectedAuditComments = persistedItems.flatMap((item) => item.expected.reviewActions.map((action) => `${item.caseId}:${action.action}:${action.comment || ''}`)).sort();
    const expectedFinalStatusCounts: Record<string, number> = {};
    persistedItems.forEach((item) => {
      const status = item.expected.finalStatus || 'unknown';
      expectedFinalStatusCounts[status] = (expectedFinalStatusCounts[status] || 0) + 1;
    });
    const finalStatusMismatches = persistedItems.filter((item) => statusByPublicId.get(materialized.packages.get(item.caseId)!.publicId) !== item.expected.finalStatus).map((item) => item.caseId).sort();
    const staleExecution = {
      expected: stale.length,
      reported: approval.resultCodes.STALE_VERSION || 0,
      noTransition: stale.every((publicId) => statusByPublicId.get(publicId) === 'submitted'),
    };
    const workflowEvidence: WorkflowSummary = {
      preflight: { 'setup-submitted': setupSubmitted.preflight, 'setup-approved-submit': setupApprovedSubmit.preflight, 'setup-approved': setupApproved.preflight, 'bulk-submit': submitAll.preflight, 'bulk-approve': approval.preflight, 'bulk-request-changes': requestChanges.preflight },
      execution: { 'setup-submitted': setupSubmitted.execution, 'setup-approved-submit': setupApprovedSubmit.execution, 'setup-approved': setupApproved.execution, 'bulk-submit': submitAll.execution, 'bulk-approve': approval.execution, 'bulk-request-changes': requestChanges.execution, archive: archiveResults },
      finalStatusCounts: normalizedFinalStatusCounts,
      expectedAuditCount,
      actualAuditCount: auditRows.data?.length || 0,
      auditActorMatches: (auditRows.data || []).every((row) => String(row.admin_id) === admin.adminUserId),
      duplicateAudits: Math.max(0, (auditRows.data?.length || 0) - duplicateAuditKeys.size),
      expectedFinalStatusCounts: sortedNumberRecord(expectedFinalStatusCounts),
      finalStatusMismatches,
      auditSignatures,
      expectedAuditSignatures,
      auditSignaturesMatch: JSON.stringify(auditSignatures) === JSON.stringify(expectedAuditSignatures),
      auditComments,
      expectedAuditComments,
      auditCommentsMatch: JSON.stringify(auditComments) === JSON.stringify(expectedAuditComments),
      staleExecution,
    };
    const previews = new SupabaseParticipantPreviewRepositoryCore(options.supabase);
    const readinessCounts: Record<string, number> = {};
    const readinessStarted = now();
    for (const item of persistedItems) {
      const publicId = materialized.packages.get(item.caseId)!.publicId;
      const result = await previews.getPublicationReadiness({ publicId, adminId: admin.adminUserId, privateBucket: runtime.privateBucket });
      readinessCounts[result.resultCode] = (readinessCounts[result.resultCode] || 0) + 1;
      recordReleaseObservation(ledger, { caseId: item.caseId, stage: 'publication-readiness', attempt: 'readiness', outcome: result.ready ? 'accepted' : 'rejected', code: result.resultCode });
    }
    timings.publicationReadiness = Number((now() - readinessStarted).toFixed(3));
    const publicationRepo = new SupabasePublicationExecutionRepositoryCore(options.supabase, options.apiUrl);
    const ownedProjects: Project[] = [];
    for (let page = 1; ; page += 1) {
      const result = await repository.listProjectsPage(parseProjectListQuery({ q: `release-${runNamespace}-`, page: String(page), pageSize: '50' }));
      ownedProjects.push(...result.projects);
      if (page >= result.pageCount) break;
    }
    assertCohortAccounting(publicIds, ownedProjects.map((project) => project.publicId || ''));
    const candidateResults: Record<string, string> = {};
    const candidateStarted = now();
    for (const item of persistedItems) {
      const publicId = materialized.packages.get(item.caseId)!.publicId;
      const plan = await preparePublicationPlan(admin.permissions, publicId, {
        getReadiness: () => previews.getPublicationReadiness({ publicId, adminId: admin.adminUserId, privateBucket: runtime.privateBucket }),
        // Keep the candidate artifact self-contained: unrelated legacy published rows in a local
        // seed are outside this evaluator's ownership and must not affect its feed validation.
        listProjects: () => Promise.resolve(ownedProjects),
        listProjectMedia: () => publicationRepo.listProjectMedia(publicId),
        privateBucket: runtime.privateBucket,
        publicBucket: runtime.publicBucket,
        getPublicUrl: (bucket, path) => publicationRepo.getPublicUrl(bucket, path),
      });
      candidateResults[item.caseId] = plan.resultCode;
      recordReleaseObservation(ledger, { caseId: item.caseId, stage: 'candidate-planning', outcome: plan.resultCode === 'READY_TO_STAGE' ? 'accepted' : 'rejected', code: plan.resultCode,
        evidence: plan.resultCode === 'READY_TO_STAGE' ? { recordCount: plan.recordCount } : undefined });
    }
    const ordinaryFeed = compilePublicFeed(ownedProjects);
    for (const item of persistedItems) {
      const included = ordinaryFeed.some((record) => record.publicId === materialized.packages.get(item.caseId)!.publicId);
      recordReleaseObservation(ledger, { caseId: item.caseId, stage: 'ordinary-feed', outcome: included ? 'accepted' : 'rejected', code: included ? 'included' : 'excluded' });
    }
    const ordinaryFeedValidation = validatePublicFeed(ordinaryFeed);
    timings.candidatePlanningAndFeed = Number((now() - candidateStarted).toFixed(3));
    const candidateDistribution = Object.values(candidateResults).reduce<Record<string, number>>((result, value) => { result[value] = (result[value] || 0) + 1; return result; }, {});
    const publicationEvidence = { approved: normalizedFinalStatusCounts.approved || 0, readinessCounts: sortedNumberRecord(readinessCounts), candidateArtifactCount: Object.values(candidateResults).filter((value) => value === 'READY_TO_STAGE').length, candidateResults: sortedNumberRecord(candidateDistribution), ordinaryFeedRecordCount: ordinaryFeed.length, ordinaryFeedValid: ordinaryFeedValidation.errors.length === 0, productionPublished: false, participantCorrectionCases: correctionResult.corrections };
    const uiStarted = now();
    const uiEvidence = await verifyIndex(repository, materialized, runtime.taxonomy, Boolean(options.evidenceMode));
    timings.uiQuery = Number((now() - uiStarted).toFixed(3));
    if (options.evidenceMode && options.pauseForEvidence) {
      process.stdout.write(`Release evaluation evidence prefix: ${runNamespace}\n`);
      await options.pauseForEvidence();
    }
    const cleanupStarted = now();
    cleanup = await cleanupOwnedState(options.supabase, runtime);
    cleanup = { ...cleanup, completed: cleanup.completed && forcedFailureProbe.completed, forcedFailureProbe };
    timings.cleanup = Number((now() - cleanupStarted).toFixed(3));
    timings.total = Number((now() - start).toFixed(3));
    const report = createReleaseEvaluationReport({ corpus, ledger, runtime: { seed: corpus.seed, corpusSize: corpus.cases.length, runNumber, runId, nodeVersion: process.version, npmVersion: options.npmVersion, platform: process.platform, osRelease: options.osRelease, architecture: process.arch, supabaseVersion: options.supabaseVersion, migrationCount: options.migrationCount }, workflowEvidence: { ...workflowEvidence }, publicationEvidence, uiEvidence, timings, cleanup });
    if (workflowEvidence.actualAuditCount !== expectedAuditCount) report.gate.failureReasons.push(`audit count ${workflowEvidence.actualAuditCount} did not match manifest-derived ${expectedAuditCount}`);
    if (workflowEvidence.duplicateAudits !== 0 || !workflowEvidence.auditActorMatches) report.gate.failureReasons.push('audit attribution or uniqueness verification failed');
    if (workflowEvidence.finalStatusMismatches.length > 0 || !workflowEvidence.auditSignaturesMatch) report.gate.failureReasons.push('per-case final status or audit transition signatures did not match the manifest');
    if (!workflowEvidence.auditCommentsMatch) report.gate.failureReasons.push('audit comments did not match the manifest');
    if (ordinaryFeedValidation.errors.length || ordinaryFeed.length !== 0) report.gate.failureReasons.push('ordinary feed did not preserve exclusion of non-published cases');
    if (Object.values(candidateResults).filter((code) => code === 'READY_TO_STAGE').length !== 20) report.gate.failureReasons.push('publication candidate count did not match the manifest');
    if (workflowEvidence.staleExecution.expected !== workflowEvidence.staleExecution.reported || !workflowEvidence.staleExecution.noTransition) report.gate.failureReasons.push('stale review execution did not remain version-fenced');
    report.gate.passed = report.gate.failureReasons.length === 0;
    return report;
  } catch (error) {
    cleanup = await cleanupOwnedState(options.supabase, runtime);
    timings.total = Number((now() - start).toFixed(3));
    const report = createReleaseEvaluationReport({ corpus, ledger,
      runtime: { seed: corpus.seed, corpusSize: corpus.cases.length, runNumber, runId, nodeVersion: process.version, platform: process.platform },
      timings, cleanup });
    const message = error instanceof Error ? error.message : 'Release evaluation failed.';
    report.gate.failureReasons.push(message.replace(/https?:\/\/\S+/g, '[endpoint]').replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi, '[internal identity]').slice(0, 400));
    report.gate.passed = false;
    return report;
  } finally {
    if (!cleanup.completed && (runtime.ownedPublicIds.size > 0 || runtime.ownedBatchIds.size > 0)) {
      cleanup = await cleanupOwnedState(options.supabase, runtime);
      if (!cleanup.completed) throw new Error(`Release cleanup failed for ${runNamespace}: ${JSON.stringify(cleanup.residue)}`);
    }
  }
}

export interface ForcedFailureProbeResult {
  completed: boolean;
  residue: Record<string, number>;
}

/** Tooling-only failure hook used by unit tests and release operators to prove finally cleanup. */
export async function runForcedFailureCleanupProbe(params: {
  createOwnedState(): Promise<void>;
  cleanupOwnedState(): Promise<{ completed: boolean; residue: Record<string, number> }>;
}): Promise<ForcedFailureProbeResult> {
  let created = false;
  try {
    await params.createOwnedState();
    created = true;
    throw new Error('RELEASE_EVALUATION_FORCED_FAILURE_AFTER_MEDIA_STAGE');
  } catch {
    const cleanup = await params.cleanupOwnedState();
    return { completed: created && cleanup.completed && Object.values(cleanup.residue).every((value) => value === 0), residue: cleanup.residue };
  }
}
