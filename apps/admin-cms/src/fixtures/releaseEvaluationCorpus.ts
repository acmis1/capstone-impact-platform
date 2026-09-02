import { createHash } from 'node:crypto';

import type { Project } from '../domain/project';
import type { WorkflowStatus } from '../domain/workflowStatus';
import {
  createSyntheticAdminReferenceOptions,
  createSyntheticJsonBuffer,
  createSyntheticWorkbookBuffer,
  materializeSyntheticImportBatch,
  type SyntheticImportMaterializationFile,
  type SyntheticImportMaterializedBatch,
} from './syntheticImportPackages';
import {
  DEFAULT_SYNTHETIC_SEED,
  generateSyntheticProjects,
} from './syntheticProjects';

export const RELEASE_EVALUATION_CASE_COUNT = 132 as const;
export const RELEASE_EVALUATION_PERSISTED_COUNT = 120 as const;
export const RELEASE_EVALUATION_REJECTED_COUNT = 12 as const;
export const RELEASE_EVALUATION_BATCH_SIZE = 24 as const;

export const RELEASE_PACKAGE_PROFILES = [
  'xlsx-one-gallery',
  'xlsx-three-gallery',
  'xlsx-maximum-gallery',
  'xlsx-zero-gallery',
  'xlsx-duplicate-team-member',
  'legacy-json-missing-accessibility',
  'xlsx-missing-title',
  'xlsx-invalid-year',
  'admin-reference-field-mismatch',
  'admin-reference-no-match',
  'unknown-database-taxonomy',
  'missing-poster-image',
  'missing-poster-pdf',
  'missing-gallery-alt-text',
  'oversized-gallery-alt-text',
  'duplicate-gallery-position',
  'malformed-xlsx',
  'repeated-existing-public-id',
] as const;
export type ReleasePackageProfile = (typeof RELEASE_PACKAGE_PROFILES)[number];

export const RELEASE_LIFECYCLE_PROFILES = [
  'accessibility-blocked-draft',
  'eligible-preflight-only-draft',
  'already-submitted',
  'stale-approval-candidate',
  'already-approved',
  'successful-approval',
  'bulk-request-changes',
  'participant-correction',
  'archived',
] as const;
export type ReleaseLifecycleProfile = (typeof RELEASE_LIFECYCLE_PROFILES)[number];

export const RELEASE_STAGES = [
  'parse',
  'package-validation',
  'admin-reconciliation',
  'commit-intent',
  'server-revalidation',
  'metadata-staging',
  'media-staging',
  'final-persistence',
  'review-readiness',
  'workflow',
  'publication-readiness',
] as const;
export type ReleaseStage = (typeof RELEASE_STAGES)[number];

export type ReleaseExpectedOutcome = 'accepted' | 'rejected' | 'not_run';

export interface ReleaseExpectedStage {
  outcome: ReleaseExpectedOutcome;
  code?: string;
  severity?: 'error' | 'warning';
  fieldName?: string;
}

export interface SeededIssue {
  issueId: string;
  caseId: string;
  family: string;
  evaluationCriticality: 'critical' | 'non_critical';
  expectedDetectionStage: ReleaseStage;
  expectedProductionCode?: string;
  expectedFieldName?: string;
  expectedCurrentDetection: boolean;
}

export interface NegativeControlAssertion {
  assertionId: string;
  caseId: string;
  description: string;
  blocking: boolean;
}

export interface ReleaseExpectedAudit {
  action: 'submit_for_review' | 'approve' | 'request_changes' | 'archive';
  fromStatus: WorkflowStatus;
  toStatus: WorkflowStatus;
  comment?: string;
}

export interface ReleaseEvaluationCase {
  caseId: string;
  baseSyntheticPublicId: string;
  identityGroup: string;
  seed: number;
  packageProfile: ReleasePackageProfile;
  lifecycleProfile?: ReleaseLifecycleProfile;
  engineeredConditions: string[];
  galleryCount: number;
  expected: {
    parse: ReleaseExpectedStage;
    packageValidation: ReleaseExpectedStage;
    reconciliation: ReleaseExpectedStage;
    commitIntent: ReleaseExpectedStage;
    serverRevalidation: ReleaseExpectedStage;
    metadataStaging: ReleaseExpectedStage;
    mediaStaging: ReleaseExpectedStage;
    finalPersistence: ReleaseExpectedStage;
    persistence: 'persisted' | 'rejected';
    finalStatus?: WorkflowStatus;
    reviewReadiness?: string;
    reviewActions: ReleaseExpectedAudit[];
    publicationReadiness?: string;
    candidatePlan: 'included' | 'excluded' | 'not_applicable';
    ordinaryFeed: 'included' | 'excluded';
    archiveRemoval: 'archived_non_public' | 'not_applicable';
  };
  seededIssueIds: string[];
}

export interface ReleaseEvaluationCorpus {
  seed: number;
  cases: ReleaseEvaluationCase[];
  seededIssues: SeededIssue[];
  negativeControls: NegativeControlAssertion[];
  manifestDigest: string;
}

export interface ReleaseMaterializedPackage {
  caseId: string;
  project: Project;
  publicId: string;
  packagePath: string;
  mediaFiles: SyntheticImportMaterializationFile[];
  batch: SyntheticImportMaterializedBatch;
}

export interface ReleaseMaterializedBatch {
  batchId: string;
  caseIds: string[];
  materialized: SyntheticImportMaterializedBatch;
  adminReferenceOptions: Awaited<ReturnType<typeof createSyntheticAdminReferenceOptions>>;
}

export interface MaterializedReleaseEvaluationCorpus extends ReleaseEvaluationCorpus {
  runNamespace: string;
  projects: Map<string, Project>;
  packages: Map<string, ReleaseMaterializedPackage>;
  acceptedBatches: ReleaseMaterializedBatch[];
  rejectedBatches: ReleaseMaterializedBatch[];
}

const VALID_XLSX_PROFILES: ReleasePackageProfile[] = [
  'xlsx-one-gallery',
  'xlsx-three-gallery',
  'xlsx-maximum-gallery',
  'xlsx-zero-gallery',
  'xlsx-duplicate-team-member',
];

const FIXED_MEDIA_BYTES = {
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
  jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  webp: Buffer.from('RIFF0000WEBP', 'ascii'),
  pdf: Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF', 'ascii'),
};

function caseId(index: number): string {
  return `release-case-${String(index + 1).padStart(3, '0')}`;
}

function expectedStage(outcome: ReleaseExpectedOutcome, code?: string, fieldName?: string): ReleaseExpectedStage {
  return { outcome, ...(code ? { code } : {}), ...(fieldName ? { fieldName } : {}) };
}

function workflowForLifecycle(profile: ReleaseLifecycleProfile | undefined): {
  finalStatus: WorkflowStatus;
  actions: ReleaseExpectedAudit[];
  readiness?: string;
  candidatePlan: ReleaseEvaluationCase['expected']['candidatePlan'];
  archiveRemoval: ReleaseEvaluationCase['expected']['archiveRemoval'];
} {
  switch (profile) {
    case 'accessibility-blocked-draft':
      return { finalStatus: 'draft', actions: [], readiness: 'INVALID_PROJECT_STATE', candidatePlan: 'excluded', archiveRemoval: 'not_applicable' };
    case 'eligible-preflight-only-draft':
      return { finalStatus: 'draft', actions: [], readiness: 'INVALID_PROJECT_STATE', candidatePlan: 'excluded', archiveRemoval: 'not_applicable' };
    case 'already-submitted':
      return {
        finalStatus: 'submitted',
        actions: [{ action: 'submit_for_review', fromStatus: 'draft', toStatus: 'submitted' }],
        readiness: 'INVALID_PROJECT_STATE', candidatePlan: 'excluded', archiveRemoval: 'not_applicable',
      };
    case 'stale-approval-candidate':
      return {
        finalStatus: 'submitted',
        actions: [{ action: 'submit_for_review', fromStatus: 'draft', toStatus: 'submitted' }],
        readiness: 'INVALID_PROJECT_STATE', candidatePlan: 'excluded', archiveRemoval: 'not_applicable',
      };
    case 'already-approved':
      return {
        finalStatus: 'approved',
        actions: [
          { action: 'submit_for_review', fromStatus: 'draft', toStatus: 'submitted' },
          { action: 'approve', fromStatus: 'submitted', toStatus: 'approved' },
        ],
        readiness: 'NO_ACTIVE_PREVIEW', candidatePlan: 'excluded', archiveRemoval: 'not_applicable',
      };
    case 'successful-approval':
      return {
        finalStatus: 'approved',
        actions: [
          { action: 'submit_for_review', fromStatus: 'draft', toStatus: 'submitted' },
          { action: 'approve', fromStatus: 'submitted', toStatus: 'approved' },
        ],
        readiness: 'NO_ACTIVE_PREVIEW', candidatePlan: 'included', archiveRemoval: 'not_applicable',
      };
    case 'bulk-request-changes':
      return {
        finalStatus: 'changes_requested',
        actions: [
          { action: 'submit_for_review', fromStatus: 'draft', toStatus: 'submitted' },
          { action: 'request_changes', fromStatus: 'submitted', toStatus: 'changes_requested', comment: 'Synthetic release evaluation correction request.' },
        ],
        readiness: 'INVALID_PROJECT_STATE', candidatePlan: 'excluded', archiveRemoval: 'not_applicable',
      };
    case 'participant-correction':
      return {
        finalStatus: 'changes_requested',
        actions: [
          { action: 'submit_for_review', fromStatus: 'draft', toStatus: 'submitted' },
          { action: 'approve', fromStatus: 'submitted', toStatus: 'approved' },
          { action: 'request_changes', fromStatus: 'approved', toStatus: 'changes_requested', comment: 'Resolution started for participant correction request' },
        ],
        readiness: 'CORRECTION_UNRESOLVED', candidatePlan: 'excluded', archiveRemoval: 'not_applicable',
      };
    case 'archived':
      return {
        finalStatus: 'archived',
        actions: [
          { action: 'submit_for_review', fromStatus: 'draft', toStatus: 'submitted' },
          { action: 'archive', fromStatus: 'submitted', toStatus: 'archived' },
        ],
        readiness: 'INVALID_PROJECT_STATE', candidatePlan: 'excluded', archiveRemoval: 'archived_non_public',
      };
    default:
      throw new Error(`Unknown release lifecycle profile: ${profile}`);
  }
}

function packageProfileForIndex(index: number): ReleasePackageProfile {
  if (index < 55) return 'xlsx-one-gallery';
  if (index < 80) return 'xlsx-three-gallery';
  if (index < 90) return 'xlsx-maximum-gallery';
  if (index < 100) return 'xlsx-zero-gallery';
  if (index < 110) return 'xlsx-duplicate-team-member';
  return 'legacy-json-missing-accessibility';
}

function lifecycleProfileForIndex(index: number): ReleaseLifecycleProfile {
  if (index >= 110) return 'accessibility-blocked-draft';
  if (index < 10) return 'eligible-preflight-only-draft';
  if (index < 20) return 'already-submitted';
  if (index < 30) return 'stale-approval-candidate';
  if (index < 40) return 'already-approved';
  if (index < 85) return 'successful-approval';
  if (index < 95) return 'bulk-request-changes';
  if (index < 100) return 'participant-correction';
  return 'archived';
}

function galleryCountForProfile(profile: ReleasePackageProfile): number {
  switch (profile) {
    case 'xlsx-zero-gallery':
    case 'legacy-json-missing-accessibility':
      return 0;
    case 'xlsx-one-gallery':
    case 'xlsx-duplicate-team-member':
    case 'repeated-existing-public-id':
      return 1;
    case 'xlsx-three-gallery':
      return 3;
    case 'xlsx-maximum-gallery':
      return 10;
    case 'missing-gallery-alt-text':
      return 2;
    case 'duplicate-gallery-position':
      return 1;
    default:
      return 0;
  }
}

function buildExpectedForProfile(profile: ReleasePackageProfile, lifecycle?: ReleaseLifecycleProfile): ReleaseEvaluationCase['expected'] {
  const accepted = VALID_XLSX_PROFILES.includes(profile) || profile === 'legacy-json-missing-accessibility' || profile === 'repeated-existing-public-id';
  const warning = profile === 'xlsx-zero-gallery' || profile === 'xlsx-duplicate-team-member' || profile === 'legacy-json-missing-accessibility';
  const packageCode = profile === 'xlsx-zero-gallery' ? 'FILE_MISSING_RECOMMENDED'
    : profile === 'xlsx-duplicate-team-member' ? 'WORKBOOK_DUPLICATE_TEAM_MEMBER'
      : undefined;
  const workflow = lifecycle ? workflowForLifecycle(lifecycle) : undefined;

  if (accepted) {
    if (profile === 'repeated-existing-public-id') {
      return {
        parse: expectedStage('accepted'),
        packageValidation: expectedStage('accepted'),
        reconciliation: expectedStage('accepted', 'RECONCILED'),
        commitIntent: expectedStage('accepted'),
        serverRevalidation: expectedStage('accepted'),
        metadataStaging: expectedStage('rejected', 'PROJECT_ALREADY_EXISTS'),
        mediaStaging: expectedStage('not_run'),
        finalPersistence: expectedStage('not_run'),
        persistence: 'rejected',
        reviewActions: [],
        candidatePlan: 'not_applicable',
        ordinaryFeed: 'excluded',
        archiveRemoval: 'not_applicable',
      };
    }
    return {
      parse: expectedStage('accepted'),
      packageValidation: expectedStage(warning ? 'accepted' : 'accepted', packageCode),
      reconciliation: expectedStage('accepted', 'RECONCILED'),
      commitIntent: expectedStage('accepted'),
      serverRevalidation: expectedStage('accepted'),
      metadataStaging: expectedStage('accepted'),
      mediaStaging: expectedStage('accepted'),
      finalPersistence: expectedStage('accepted'),
      persistence: 'persisted',
      finalStatus: workflow?.finalStatus,
      reviewReadiness: workflow?.readiness,
      reviewActions: workflow?.actions || [],
      publicationReadiness: lifecycle === 'successful-approval' ? 'READY' : workflow?.readiness,
      candidatePlan: lifecycle === 'successful-approval' ? 'included' : workflow?.candidatePlan || 'excluded',
      ordinaryFeed: 'excluded',
      archiveRemoval: workflow?.archiveRemoval || 'not_applicable',
    };
  }

  const rejection: { stage: keyof ReleaseEvaluationCase['expected']; code: string; fieldName?: string } = (() => {
    switch (profile) {
      case 'xlsx-missing-title': return { stage: 'parse', code: 'WORKBOOK_MISSING_REQUIRED_VALUE', fieldName: 'title' };
      case 'xlsx-invalid-year': return { stage: 'parse', code: 'WORKBOOK_INVALID_YEAR', fieldName: 'year' };
      case 'admin-reference-field-mismatch': return { stage: 'reconciliation', code: 'ADMIN_REFERENCE_FIELD_MISMATCH', fieldName: 'program' };
      case 'admin-reference-no-match': return { stage: 'reconciliation', code: 'ADMIN_REFERENCE_NO_MATCH' };
      case 'unknown-database-taxonomy': return { stage: 'metadataStaging', code: 'LOOKUP_NOT_FOUND' };
      case 'missing-poster-image': return { stage: 'packageValidation', code: 'FILE_MISSING_POSTER_IMAGE' };
      case 'missing-poster-pdf': return { stage: 'packageValidation', code: 'FILE_MISSING_POSTER_PDF' };
      case 'missing-gallery-alt-text': return { stage: 'packageValidation', code: 'METADATA_MISSING_GALLERY_ALT_TEXT' };
      case 'oversized-gallery-alt-text': return { stage: 'parse', code: 'WORKBOOK_VALUE_TOO_LONG', fieldName: 'snapshot2AltText' };
      case 'duplicate-gallery-position': return { stage: 'packageValidation', code: 'FILE_GALLERY_DUPLICATE_POSITION' };
      case 'malformed-xlsx': return { stage: 'parse', code: 'WORKBOOK_MALFORMED' };
      default: throw new Error(`No rejection contract for ${profile}`);
    }
  })();
  const stageNames = ['parse', 'packageValidation', 'reconciliation', 'commitIntent', 'serverRevalidation', 'metadataStaging', 'mediaStaging', 'finalPersistence'] as const;
  const stageIndex = stageNames.indexOf(rejection.stage as typeof stageNames[number]);
  const stages = Object.fromEntries(stageNames.map((name, index) => [
    name,
    index < stageIndex ? expectedStage('accepted') : index === stageIndex ? expectedStage('rejected', rejection.code, rejection.fieldName) : expectedStage('not_run'),
  ])) as Pick<ReleaseEvaluationCase['expected'], typeof stageNames[number]>;
  return {
    ...stages,
    persistence: 'rejected',
    reviewActions: [],
    candidatePlan: 'not_applicable',
    ordinaryFeed: 'excluded',
    archiveRemoval: 'not_applicable',
  };
}

function issueForCase(profile: ReleasePackageProfile, currentCaseId: string): SeededIssue[] {
  const critical = (issueId: string, family: string, stage: ReleaseStage, code: string, fieldName?: string): SeededIssue => ({
    issueId,
    caseId: currentCaseId,
    family,
    evaluationCriticality: 'critical',
    expectedDetectionStage: stage,
    expectedProductionCode: code,
    expectedFieldName: fieldName,
    expectedCurrentDetection: true,
  });
  const nonCritical = (issueId: string, family: string, stage: ReleaseStage, code: string): SeededIssue => ({
    issueId,
    caseId: currentCaseId,
    family,
    evaluationCriticality: 'non_critical',
    expectedDetectionStage: stage,
    expectedProductionCode: code,
    expectedCurrentDetection: true,
  });

  switch (profile) {
    case 'legacy-json-missing-accessibility':
      return [
        critical(`${currentCaseId}-missing-poster-text`, 'missing-accessible-poster-full-text', 'review-readiness', 'READINESS_BLOCKED'),
        critical(`${currentCaseId}-missing-accessibility-text`, 'missing-poster-accessibility-text', 'review-readiness', 'READINESS_BLOCKED'),
      ];
    case 'xlsx-zero-gallery':
      return [nonCritical(`${currentCaseId}-empty-gallery`, 'empty-gallery', 'package-validation', 'FILE_MISSING_RECOMMENDED')];
    case 'xlsx-duplicate-team-member':
      return [nonCritical(`${currentCaseId}-duplicate-team-member`, 'duplicate-team-member', 'parse', 'WORKBOOK_DUPLICATE_TEAM_MEMBER')];
    case 'xlsx-missing-title':
      return [critical(`${currentCaseId}-missing-title`, 'missing-required-title', 'parse', 'WORKBOOK_MISSING_REQUIRED_VALUE', 'title')];
    case 'xlsx-invalid-year':
      return [critical(`${currentCaseId}-invalid-year`, 'invalid-year', 'parse', 'WORKBOOK_INVALID_YEAR', 'year')];
    case 'admin-reference-field-mismatch':
      return [critical(`${currentCaseId}-reference-field-mismatch`, 'admin-reference-field-mismatch', 'admin-reconciliation', 'ADMIN_REFERENCE_FIELD_MISMATCH', 'program')];
    case 'admin-reference-no-match':
      return [critical(`${currentCaseId}-reference-no-match`, 'admin-reference-no-match', 'admin-reconciliation', 'ADMIN_REFERENCE_NO_MATCH')];
    case 'unknown-database-taxonomy':
      return [critical(`${currentCaseId}-unknown-taxonomy`, 'unknown-database-taxonomy', 'metadata-staging', 'LOOKUP_NOT_FOUND')];
    case 'missing-poster-image':
      return [critical(`${currentCaseId}-missing-poster-image`, 'missing-poster-image', 'package-validation', 'FILE_MISSING_POSTER_IMAGE')];
    case 'missing-poster-pdf':
      return [critical(`${currentCaseId}-missing-poster-pdf`, 'missing-poster-pdf', 'package-validation', 'FILE_MISSING_POSTER_PDF')];
    case 'missing-gallery-alt-text':
      return [critical(`${currentCaseId}-missing-gallery-alt`, 'missing-gallery-alt-text', 'package-validation', 'METADATA_MISSING_GALLERY_ALT_TEXT')];
    case 'oversized-gallery-alt-text':
      return [critical(`${currentCaseId}-oversized-gallery-alt`, 'oversized-gallery-alt-text', 'parse', 'WORKBOOK_VALUE_TOO_LONG', 'snapshot2AltText')];
    case 'duplicate-gallery-position':
      return [critical(`${currentCaseId}-duplicate-gallery-position`, 'duplicate-gallery-position', 'package-validation', 'FILE_GALLERY_DUPLICATE_POSITION')];
    case 'malformed-xlsx':
      return [critical(`${currentCaseId}-malformed-xlsx`, 'malformed-xlsx', 'parse', 'WORKBOOK_MALFORMED')];
    case 'repeated-existing-public-id':
      return [critical(`${currentCaseId}-repeated-public-id`, 'repeated-existing-public-id', 'metadata-staging', 'PROJECT_ALREADY_EXISTS')];
    default:
      return [];
  }
}

export function buildReleaseEvaluationCorpus(seed = DEFAULT_SYNTHETIC_SEED): ReleaseEvaluationCorpus {
  const projects = generateSyntheticProjects({ count: 500, seed });
  const cases: ReleaseEvaluationCase[] = [];
  const seededIssues: SeededIssue[] = [];

  for (let index = 0; index < RELEASE_EVALUATION_CASE_COUNT; index += 1) {
    const id = caseId(index);
    const profile = index < RELEASE_EVALUATION_PERSISTED_COUNT
      ? packageProfileForIndex(index)
      : RELEASE_PACKAGE_PROFILES[index - RELEASE_EVALUATION_PERSISTED_COUNT + 6];
    const lifecycle = index < RELEASE_EVALUATION_PERSISTED_COUNT ? lifecycleProfileForIndex(index) : undefined;
    const baseProject = index === 131 ? projects[0] : projects[index];
    const issues = issueForCase(profile, id);
    const item: ReleaseEvaluationCase = {
      caseId: id,
      baseSyntheticPublicId: baseProject.publicId || '',
      identityGroup: index === 131 ? 'release-case-001-identity' : id,
      seed,
      packageProfile: profile,
      ...(lifecycle ? { lifecycleProfile: lifecycle } : {}),
      engineeredConditions: profile === 'legacy-json-missing-accessibility'
        ? ['posterText omitted from JSON', 'accessibilityText omitted from JSON']
        : profile === 'xlsx-zero-gallery'
          ? ['no snapshot image descriptors']
          : profile === 'xlsx-duplicate-team-member'
            ? ['the first synthetic team member is repeated']
            : [],
      galleryCount: galleryCountForProfile(profile),
      expected: buildExpectedForProfile(profile, lifecycle),
      seededIssueIds: issues.map((issue) => issue.issueId),
    };
    if (lifecycle === 'successful-approval') {
      if (index < 60) {
        item.expected.publicationReadiness = 'READY';
        item.expected.candidatePlan = 'included';
      } else if (index < 70) {
        item.expected.publicationReadiness = 'PREVIEW_NOT_CONFIRMED';
        item.expected.candidatePlan = 'excluded';
      } else {
        item.expected.publicationReadiness = 'NO_ACTIVE_PREVIEW';
        item.expected.candidatePlan = 'excluded';
      }
    }
    cases.push(item);
    seededIssues.push(...issues);
  }

  const negativeControls: NegativeControlAssertion[] = [
    ...cases.filter((item) => VALID_XLSX_PROFILES.includes(item.packageProfile)
      && item.packageProfile !== 'xlsx-zero-gallery'
      && item.packageProfile !== 'xlsx-duplicate-team-member')
      .map((item) => ({ assertionId: `${item.caseId}-no-blocking-import-error`, caseId: item.caseId, description: 'A valid XLSX package is not blocked by package intake.', blocking: true })),
    ...cases.filter((item) => item.packageProfile === 'xlsx-zero-gallery')
      .map((item) => ({ assertionId: `${item.caseId}-warning-is-nonblocking`, caseId: item.caseId, description: 'The zero-gallery recommendation remains nonblocking.', blocking: true })),
    ...cases.filter((item) => item.packageProfile === 'xlsx-duplicate-team-member')
      .map((item) => ({ assertionId: `${item.caseId}-warning-is-nonblocking`, caseId: item.caseId, description: 'The duplicate-team warning remains nonblocking.', blocking: true })),
  ];
  const manifestForDigest = { seed, cases, seededIssues, negativeControls };
  const manifestDigest = createHash('sha256').update(JSON.stringify(manifestForDigest), 'utf8').digest('hex');

  return { seed, cases, seededIssues, negativeControls, manifestDigest };
}

function runtimePublicId(runNamespace: string, baseSyntheticPublicId: string): string {
  return `release-${runNamespace}-${baseSyntheticPublicId}`;
}

function mediaFilesForCase(item: ReleaseEvaluationCase): SyntheticImportMaterializationFile[] {
  const files: SyntheticImportMaterializationFile[] = [];
  if (item.packageProfile !== 'missing-poster-image') {
    files.push({ fileName: 'poster.png', browserMimeType: 'image/png', content: FIXED_MEDIA_BYTES.png });
  }
  if (item.packageProfile !== 'missing-poster-pdf') {
    files.push({ fileName: 'poster.pdf', browserMimeType: 'application/pdf', content: FIXED_MEDIA_BYTES.pdf });
  }
  if (item.packageProfile === 'duplicate-gallery-position') {
    files.push({ fileName: 'snapshot-1.png', browserMimeType: 'image/png', content: FIXED_MEDIA_BYTES.png });
    files.push({ fileName: 'snapshot-1.jpg', browserMimeType: 'image/jpeg', content: FIXED_MEDIA_BYTES.jpeg });
    return files;
  }
  for (let position = 1; position <= item.galleryCount; position += 1) {
    const extension = position % 3 === 1 ? 'png' : position % 3 === 2 ? 'jpg' : 'webp';
    const content = extension === 'png' ? FIXED_MEDIA_BYTES.png : extension === 'jpg' ? FIXED_MEDIA_BYTES.jpeg : FIXED_MEDIA_BYTES.webp;
    files.push({ fileName: `snapshot-${position}.${extension}`, browserMimeType: extension === 'png' ? 'image/png' : extension === 'jpg' ? 'image/jpeg' : 'image/webp', content });
  }
  return files;
}

function workbookOverridesForCase(item: ReleaseEvaluationCase): Record<string, string> {
  const overrides: Record<string, string> = {};
  if (item.galleryCount === 0) overrides.snapshotAltText = '';
  switch (item.packageProfile) {
    case 'xlsx-missing-title':
      overrides.title = '';
      break;
    case 'xlsx-invalid-year':
      overrides.year = 'not-a-year';
      break;
    case 'admin-reference-field-mismatch':
      overrides.program = 'Synthetic Mismatched Program';
      overrides.studyProgram = 'Synthetic Mismatched Program';
      break;
    case 'unknown-database-taxonomy':
      overrides.program = 'Synthetic Unknown Database Taxonomy';
      overrides.studyProgram = 'Synthetic Unknown Database Taxonomy';
      break;
    case 'missing-gallery-alt-text':
      overrides.snapshot2AltText = '';
      break;
    case 'oversized-gallery-alt-text':
      overrides.snapshot2AltText = 'x'.repeat(2001);
      break;
    case 'xlsx-duplicate-team-member':
      overrides.teamMembers = 'Synthetic Member duplicate\nSynthetic Member duplicate';
      break;
    case 'xlsx-zero-gallery':
      overrides.snapshotAltText = '';
      break;
    default:
      break;
  }
  for (let position = 1; position <= item.galleryCount; position += 1) {
    const fieldName = position === 1 ? 'snapshotAltText' : `snapshot${position}AltText`;
    if (!Object.prototype.hasOwnProperty.call(overrides, fieldName)) {
      overrides[fieldName] = `Synthetic gallery alt ${item.caseId} position ${position}.`;
    }
  }
  return overrides;
}

function projectWithPublicId(project: Project, publicId: string, program = project.program): Project {
  return { ...project, publicId, program, studyProgram: program, teamMembers: [...project.teamMembers], snapshotMedia: [...project.snapshotMedia] };
}

function referenceProjectForCase(item: ReleaseEvaluationCase, project: Project, publicId: string): Project {
  if (item.packageProfile === 'admin-reference-field-mismatch') return projectWithPublicId(project, publicId);
  if (item.packageProfile === 'unknown-database-taxonomy') return projectWithPublicId(project, publicId, 'Synthetic Unknown Database Taxonomy');
  return projectWithPublicId(project, publicId);
}

export async function materializeReleaseEvaluationCorpus(params: {
  seed?: number;
  runNamespace: string;
  metadataTaxonomy?: { program: string; discipline: string; industry: string };
}): Promise<MaterializedReleaseEvaluationCorpus> {
  const corpus = buildReleaseEvaluationCorpus(params.seed);
  const sourceProjects = generateSyntheticProjects({ count: 500, seed: corpus.seed });
  const projects = new Map<string, Project>();
  const packages = new Map<string, ReleaseMaterializedPackage>();
  const acceptedInputs: Array<{ item: ReleaseEvaluationCase; project: Project; publicId: string }> = [];
  const rejectedInputs: Array<{ item: ReleaseEvaluationCase; project: Project; publicId: string }> = [];

  corpus.cases.forEach((item, index) => {
    const source = index === 131 ? sourceProjects[0] : sourceProjects[index];
    const publicId = runtimePublicId(params.runNamespace, item.baseSyntheticPublicId);
    const project = projectWithPublicId(source, publicId, params.metadataTaxonomy?.program || source.program);
    projects.set(item.caseId, project);
    (item.expected.persistence === 'persisted' ? acceptedInputs : rejectedInputs).push({ item, project, publicId });
  });

  const makeBatches = async (
    inputItems: Array<{ item: ReleaseEvaluationCase; project: Project; publicId: string }>,
    batchPrefix: string,
  ): Promise<ReleaseMaterializedBatch[]> => {
    const result: ReleaseMaterializedBatch[] = [];
    for (let offset = 0; offset < inputItems.length; offset += RELEASE_EVALUATION_BATCH_SIZE) {
      const entries = inputItems.slice(offset, offset + RELEASE_EVALUATION_BATCH_SIZE);
      const batchId = `${batchPrefix}-${Math.floor(offset / RELEASE_EVALUATION_BATCH_SIZE) + 1}`;
      const inputs = await Promise.all(entries.map(async ({ item, project, publicId }) => {
        const packagePath = `${batchId}/${publicId}`;
        const metadataOverrides = {
          ...(params.metadataTaxonomy && item.packageProfile !== 'unknown-database-taxonomy'
            ? {
                program: params.metadataTaxonomy.program,
                studyProgram: params.metadataTaxonomy.program,
                discipline: params.metadataTaxonomy.discipline,
                industry: params.metadataTaxonomy.industry,
              }
            : {}),
          ...workbookOverridesForCase(item),
        };
        const metadataBuffer = item.packageProfile === 'legacy-json-missing-accessibility'
          ? createSyntheticJsonBuffer(project, {
              posterText: undefined,
              accessibilityText: undefined,
              ...(params.metadataTaxonomy
                ? {
                    program: params.metadataTaxonomy.program,
                    studyProgram: params.metadataTaxonomy.program,
                    discipline: params.metadataTaxonomy.discipline,
                    industry: params.metadataTaxonomy.industry,
                  }
                : {}),
            })
          : item.packageProfile === 'malformed-xlsx'
            ? Buffer.from('synthetic malformed workbook', 'utf8')
            : await createSyntheticWorkbookBuffer(project, metadataOverrides);
        const mediaFiles = mediaFilesForCase(item);
        return { item, project, publicId, packagePath, metadataBuffer, mediaFiles };
      }));
      const materialized = materializeSyntheticImportBatch(batchId, inputs.map((entry) => ({
        publicId: entry.publicId,
        packagePath: entry.packagePath,
        metadataFileName: entry.item.packageProfile === 'legacy-json-missing-accessibility' ? 'project.json' : 'project-details.xlsx',
        metadataBuffer: entry.metadataBuffer,
        mediaFiles: entry.mediaFiles,
      })));
      const refs = entries
        .filter(({ item }) => item.packageProfile !== 'admin-reference-no-match')
        .map(({ item, project, publicId }) => referenceProjectForCase(item, project, publicId));
      const adminReferenceOptions = await createSyntheticAdminReferenceOptions(refs);
      const batch: ReleaseMaterializedBatch = {
        batchId,
        caseIds: entries.map(({ item }) => item.caseId),
        materialized,
        adminReferenceOptions,
      };
      result.push(batch);
      materialized.packages.forEach((pkg, index) => {
        const entry = inputs[index];
        packages.set(entry.item.caseId, {
          caseId: entry.item.caseId,
          project: entry.project,
          publicId: entry.publicId,
          packagePath: pkg.packagePath,
          mediaFiles: entry.mediaFiles,
          batch: materialized,
        });
      });
    }
    return result;
  };

  const acceptedBatches = await makeBatches(acceptedInputs, `release-${params.runNamespace}-accepted`);
  const rejectedBatches = await makeBatches(rejectedInputs.slice(0, 10), `release-${params.runNamespace}-rejected`);
  const specialBatches = await makeBatches(rejectedInputs.slice(10), `release-${params.runNamespace}-special`);

  return { ...corpus, runNamespace: params.runNamespace, projects, packages, acceptedBatches, rejectedBatches: [...rejectedBatches, ...specialBatches] };
}

export function countReleasePackageProfiles(cases: readonly ReleaseEvaluationCase[]): Map<ReleasePackageProfile, number> {
  const counts = new Map<ReleasePackageProfile, number>();
  cases.forEach((item) => counts.set(item.packageProfile, (counts.get(item.packageProfile) || 0) + 1));
  return counts;
}

export function countReleaseLifecycleProfiles(cases: readonly ReleaseEvaluationCase[]): Map<ReleaseLifecycleProfile, number> {
  const counts = new Map<ReleaseLifecycleProfile, number>();
  cases.forEach((item) => {
    if (item.lifecycleProfile) counts.set(item.lifecycleProfile, (counts.get(item.lifecycleProfile) || 0) + 1);
  });
  return counts;
}

export function countReleaseGalleryDistribution(cases: readonly ReleaseEvaluationCase[]): { zero: number; one: number; multiple: number; maximum: number } {
  return cases.filter((item) => item.expected.persistence === 'persisted').reduce((result, item) => {
    if (item.galleryCount === 0) result.zero += 1;
    else if (item.galleryCount === 1) result.one += 1;
    else if (item.galleryCount === 10) result.maximum += 1;
    else result.multiple += 1;
    return result;
  }, { zero: 0, one: 0, multiple: 0, maximum: 0 });
}
