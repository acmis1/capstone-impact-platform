import {
  analyzeBrowserImportServer,
  parseBrowserImportPreview,
  type BrowserImportServerAnalysis,
} from '../import/parseBrowserImportPreview';
import {
  validateBrowserImportPreviewResponse,
  type BrowserImportIssue,
  type BrowserImportPreviewResponse,
} from '../import/browserImportPreviewContract';
import { prepareBrowserImportCommitIntent } from '../import/prepareBrowserImportCommitIntentCore';
import { stageBrowserImportMetadata } from '../import/stageBrowserImportMetadata';
import { validateMediaAsset } from '../storage/mediaValidationCore';
import type { AuthenticatedAdminContext } from '../auth/authTypes';
import {
  createSyntheticAdminReferenceOptions,
  createSyntheticStagingDuplicatePublicIdFixture,
  generateSyntheticImportBatch,
  SYNTHETIC_IMPORT_VARIANTS,
  type SyntheticImportBatchFixture,
  type SyntheticImportPackageVariant,
  type SyntheticImportPackageFixture,
  type SyntheticImportPackageCount,
  type SyntheticPreviewVariant,
} from './syntheticImportPackages';
import { DEFAULT_SYNTHETIC_SEED } from './syntheticProjects';

export interface SyntheticImportCounts {
  packageCount: number;
  validPackageCount: number;
  warningPackageCount: number;
  invalidPackageCount: number;
}

export interface SyntheticIssueDistributionEntry {
  code: string;
  severity: 'error' | 'warning';
  count: number;
}

export interface CanonicalSyntheticPreview {
  mode: 'single' | 'batch';
  selectedRootName: string;
  packageCount: number;
  selectedFileCount: number;
  validPackageCount: number;
  warningPackageCount: number;
  invalidPackageCount: number;
  totalWarnings: number;
  totalErrors: number;
  mediaValidationMode: 'descriptor_only';
  batchIssues: CanonicalSyntheticIssue[];
  packages: CanonicalSyntheticPackage[];
}

export interface CanonicalSyntheticIssue {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  packagePath?: string;
  fileName?: string;
  fieldName?: string;
  columnName?: string;
  rowNumber?: number;
}

export interface CanonicalSyntheticPackage {
  packagePath: string;
  folderName: string;
  proposedPublicId: string;
  metadataSource: 'xlsx' | 'json' | null;
  status: 'valid' | 'warning' | 'invalid';
  previewMetadata: BrowserImportPreviewResponse['batch']['packages'][number]['previewMetadata'];
  filePresence: BrowserImportResponseFilePresence;
  reconciliation?: BrowserImportResponseReconciliation;
  errors: CanonicalSyntheticIssue[];
  warnings: CanonicalSyntheticIssue[];
}

type BrowserImportResponseFilePresence = BrowserImportPreviewResponse['batch']['packages'][number]['filePresence'];
type BrowserImportResponseReconciliation = NonNullable<
  BrowserImportPreviewResponse['batch']['packages'][number]['reconciliation']
>;

export interface SyntheticImportScenarioReport {
  variant: SyntheticImportPackageVariant;
  counts: SyntheticImportCounts;
  expectedIssueCodes: readonly string[];
  issueDistribution: SyntheticIssueDistributionEntry[];
  passed: true;
  duplicateBoundary?: 'metadata-staging';
  duplicateStagingCode?: string;
}

export interface SyntheticImportValidationReport {
  seed: number;
  requestedCount: SyntheticImportPackageCount;
  baseline: {
    counts: SyntheticImportCounts;
    canonicalPreview: CanonicalSyntheticPreview;
    canonicalPreviewStable: true;
  };
  variantScenarios: SyntheticImportScenarioReport[];
  counts: SyntheticImportCounts;
  issueDistribution: SyntheticIssueDistributionEntry[];
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function sortIssues(issues: readonly BrowserImportIssue[]): CanonicalSyntheticIssue[] {
  return issues
    .map((issue) => ({
      code: issue.code,
      message: issue.message,
      severity: issue.severity,
      ...(issue.packagePath ? { packagePath: issue.packagePath } : {}),
      ...(issue.fileName ? { fileName: issue.fileName } : {}),
      ...(issue.fieldName ? { fieldName: issue.fieldName } : {}),
      ...(issue.columnName ? { columnName: issue.columnName } : {}),
      ...(issue.rowNumber !== undefined ? { rowNumber: issue.rowNumber } : {}),
    }))
    .sort((left, right) => {
      const codeOrder = compareText(left.code, right.code);
      if (codeOrder !== 0) return codeOrder;
      const severityOrder = compareText(left.severity, right.severity);
      if (severityOrder !== 0) return severityOrder;
      const packageOrder = compareText(left.packagePath || '', right.packagePath || '');
      if (packageOrder !== 0) return packageOrder;
      const fieldOrder = compareText(left.fieldName || '', right.fieldName || '');
      if (fieldOrder !== 0) return fieldOrder;
      return compareText(left.message, right.message);
    });
}

function getPreviewIssues(preview: BrowserImportPreviewResponse): BrowserImportIssue[] {
  return [
    ...preview.batch.batchIssues,
    ...preview.batch.packages.flatMap((pkg) => [...pkg.errors, ...pkg.warnings]),
  ];
}

function summarizePreview(preview: BrowserImportPreviewResponse): SyntheticImportCounts {
  return {
    packageCount: preview.batch.packageCount,
    validPackageCount: preview.batch.validPackageCount,
    warningPackageCount: preview.batch.warningPackageCount,
    invalidPackageCount: preview.batch.invalidPackageCount,
  };
}

function summarizeIssueDistribution(
  issues: readonly BrowserImportIssue[],
): SyntheticIssueDistributionEntry[] {
  const counts = new Map<string, SyntheticIssueDistributionEntry>();

  issues.forEach((issue) => {
    const key = `${issue.code}\u0000${issue.severity}`;
    const current = counts.get(key);
    if (current) {
      current.count += 1;
      return;
    }
    counts.set(key, { code: issue.code, severity: issue.severity, count: 1 });
  });

  return [...counts.values()].sort((left, right) => {
    const codeOrder = compareText(left.code, right.code);
    if (codeOrder !== 0) return codeOrder;
    return compareText(left.severity, right.severity);
  });
}

function summarizeCanonicalPreview(preview: BrowserImportPreviewResponse): CanonicalSyntheticPreview {
  const packages = preview.batch.packages
    .map((pkg) => ({
      packagePath: pkg.packagePath,
      folderName: pkg.folderName,
      proposedPublicId: pkg.proposedPublicId,
      metadataSource: pkg.metadataSource,
      status: pkg.status,
      previewMetadata: pkg.previewMetadata,
      filePresence: pkg.filePresence,
      ...(pkg.reconciliation
        ? {
            reconciliation: {
              ...pkg.reconciliation,
              mismatchedFields: [...pkg.reconciliation.mismatchedFields].sort(compareText),
            },
          }
        : {}),
      errors: sortIssues(pkg.errors),
      warnings: sortIssues(pkg.warnings),
    }))
    .sort((left, right) => compareText(left.packagePath, right.packagePath));

  return {
    mode: preview.batch.mode,
    selectedRootName: preview.batch.selectedRootName,
    packageCount: preview.batch.packageCount,
    selectedFileCount: preview.batch.selectedFileCount,
    validPackageCount: preview.batch.validPackageCount,
    warningPackageCount: preview.batch.warningPackageCount,
    invalidPackageCount: preview.batch.invalidPackageCount,
    totalWarnings: preview.batch.totalWarnings,
    totalErrors: preview.batch.totalErrors,
    mediaValidationMode: preview.batch.mediaValidationMode,
    batchIssues: sortIssues(preview.batch.batchIssues),
    packages,
  };
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertExpectedIssueCodes(
  fixture: SyntheticImportPackageFixture,
  preview: BrowserImportPreviewResponse,
): void {
  const issues = getPreviewIssues(preview);
  const issueCodes = new Set(issues.map((issue) => issue.code));

  fixture.expectedIssueCodes.forEach((expectedCode) => {
    assertCondition(
      issueCodes.has(expectedCode),
      `${fixture.variant} did not produce expected issue ${expectedCode}.`,
    );
  });
}

function assertMediaVariantIsUnsupported(): void {
  const result = validateMediaAsset({
    fileName: 'poster.gif',
    fileSizeBytes: 1024,
    mimeType: 'image/gif',
  });
  assertCondition(!result.valid, 'Unsupported synthetic media unexpectedly passed media validation.');
}

async function runPreviewScenario(
  fixture: SyntheticImportBatchFixture,
  adminReferenceOptions?: Parameters<typeof parseBrowserImportPreview>[2],
): Promise<SyntheticImportScenarioReport> {
  const preview = await parseBrowserImportPreview(
    fixture.selectionManifest,
    fixture.uploadedMetadataFiles,
    adminReferenceOptions,
  );
  assertCondition(
    validateBrowserImportPreviewResponse(preview) !== null,
    `${fixture.packages[0].variant} produced an invalid preview response shape.`,
  );
  assertExpectedIssueCodes(fixture.packages[0], preview);

  if (fixture.packages[0].variant === 'fully-valid') {
    assertCondition(
      preview.batch.validPackageCount === fixture.packages.length
      && preview.batch.warningPackageCount === 0
      && preview.batch.invalidPackageCount === 0,
      'Fully valid synthetic packages did not remain valid.',
    );
  }

  if (fixture.packages[0].variant === 'optional-files-absent') {
    assertCondition(
      preview.batch.warningPackageCount === fixture.packages.length
      && preview.batch.invalidPackageCount === 0,
      'Optional-file absence did not remain a warning-only result.',
    );
  }

  if (fixture.packages[0].variant === 'warning-level') {
    assertCondition(
      preview.batch.warningPackageCount === fixture.packages.length
      && preview.batch.invalidPackageCount === 0,
      'Warning-level synthetic package became invalid or valid.',
    );
  }

  if (fixture.packages[0].variant === 'unsupported-media-type') {
    assertMediaVariantIsUnsupported();
  }

  const issues = getPreviewIssues(preview);
  return {
    variant: fixture.packages[0].variant,
    counts: summarizePreview(preview),
    expectedIssueCodes: fixture.packages[0].expectedIssueCodes,
    issueDistribution: summarizeIssueDistribution(issues),
    passed: true,
  };
}

function addCounts(left: SyntheticImportCounts, right: SyntheticImportCounts): SyntheticImportCounts {
  return {
    packageCount: left.packageCount + right.packageCount,
    validPackageCount: left.validPackageCount + right.validPackageCount,
    warningPackageCount: left.warningPackageCount + right.warningPackageCount,
    invalidPackageCount: left.invalidPackageCount + right.invalidPackageCount,
  };
}

function flattenIssueDistribution(
  distributions: readonly SyntheticIssueDistributionEntry[],
): SyntheticIssueDistributionEntry[] {
  const issues: BrowserImportIssue[] = distributions.map((entry) => ({
    code: entry.code,
    severity: entry.severity,
    message: `${entry.code} synthetic count`,
  }));
  const expanded: BrowserImportIssue[] = [];
  distributions.forEach((entry) => {
    for (let index = 0; index < entry.count; index += 1) {
      expanded.push(issues[distributions.indexOf(entry)]);
    }
  });
  return summarizeIssueDistribution(expanded);
}

async function runDuplicateScenario(seed: number): Promise<SyntheticImportScenarioReport> {
  const duplicateFixture = await createSyntheticStagingDuplicatePublicIdFixture({ seed });
  const referenceOptions = await createSyntheticAdminReferenceOptions(
    duplicateFixture.batch.packages.map((pkg) => pkg.project),
  );
  const analysis = await analyzeBrowserImportServer(
    duplicateFixture.batch.selectionManifest,
    duplicateFixture.batch.uploadedMetadataFiles,
    referenceOptions,
  );

  const originalIds = analysis.packages.map((pkg) => pkg.proposedPublicId);
  assertCondition(
    new Set(originalIds).size === originalIds.length
      && analysis.packages.every((pkg) => pkg.proposedPublicId === pkg.folderName),
    'Folder-derived package selection did not preserve unique authoritative public IDs.',
  );

  const prepared = prepareBrowserImportCommitIntent({
    manifest: duplicateFixture.batch.selectionManifest,
    preview: analysis.preview.batch,
    selectedPackagePaths: analysis.packages.map((pkg) => pkg.packagePath),
    acknowledgedWarningPackagePaths: [],
    expectedPreviewFingerprint: analysis.preview.batch.previewFingerprint,
  });
  assertCondition(prepared.success, 'Could not prepare a valid duplicate-ID staging intent.');

  // A duplicate cannot be represented by the supported folder-derived selection contract. Inject
  // it only at the metadata-staging function boundary to verify that this independent production
  // guard rejects it before the Supabase admin client (and therefore any persistence) is created.
  const duplicatedAnalysis: BrowserImportServerAnalysis = {
    preview: analysis.preview,
    packages: analysis.packages.map((pkg, index) =>
      index === 0 || !pkg.manifest
        ? pkg
        : {
            ...pkg,
            proposedPublicId: duplicateFixture.duplicatePublicId,
            manifest: { ...pkg.manifest, publicId: duplicateFixture.duplicatePublicId },
          }),
  };
  const stagingResult = await stageBrowserImportMetadata({
    authContext: {
      authUserId: '00000000-0000-0000-0000-000000000001',
      adminUserId: '00000000-0000-0000-0000-000000000001',
      email: 'synthetic-admin@synthetic.invalid',
      fullName: 'Synthetic Admin',
      roles: ['admin'],
      permissions: ['projects.edit'],
    } as AuthenticatedAdminContext,
    serverAnalysis: duplicatedAnalysis,
    intent: prepared.intent,
  });
  assertCondition(
    !stagingResult.success && stagingResult.code === 'INVALID_SELECTION',
    'Production staging did not reject the duplicate public ID selection.',
  );

  return {
    variant: 'duplicate-public-id',
    counts: {
      packageCount: 2,
      validPackageCount: 0,
      warningPackageCount: 0,
      invalidPackageCount: 2,
    },
    expectedIssueCodes: [],
    issueDistribution: [],
    passed: true,
    duplicateBoundary: 'metadata-staging',
    duplicateStagingCode: stagingResult.code,
  };
}

export function canonicalizeSyntheticPreview(
  preview: BrowserImportPreviewResponse,
): CanonicalSyntheticPreview {
  return summarizeCanonicalPreview(preview);
}

export async function runSyntheticImportValidationHarness({
  count,
  seed = DEFAULT_SYNTHETIC_SEED,
}: {
  count: SyntheticImportPackageCount;
  seed?: number;
}): Promise<SyntheticImportValidationReport> {
  const baselineVariants = Array.from({ length: count }, () => 'fully-valid' as const);
  const baselineFixture = await generateSyntheticImportBatch({ count, seed, variants: baselineVariants });
  const baselineRepeatFixture = await generateSyntheticImportBatch({ count, seed, variants: baselineVariants });
  const baselinePreview = await parseBrowserImportPreview(
    baselineFixture.selectionManifest,
    baselineFixture.uploadedMetadataFiles,
  );
  const baselineRepeatPreview = await parseBrowserImportPreview(
    baselineRepeatFixture.selectionManifest,
    baselineRepeatFixture.uploadedMetadataFiles,
  );
  const canonicalPreview = summarizeCanonicalPreview(baselinePreview);
  const canonicalRepeatPreview = summarizeCanonicalPreview(baselineRepeatPreview);
  assertCondition(
    JSON.stringify(canonicalPreview) === JSON.stringify(canonicalRepeatPreview),
    'Same-seed synthetic import previews were not canonically stable.',
  );
  assertCondition(
    validateBrowserImportPreviewResponse(baselinePreview) !== null,
    'Baseline synthetic preview failed response validation.',
  );
  assertCondition(
    baselinePreview.batch.validPackageCount === count
      && baselinePreview.batch.warningPackageCount === 0
      && baselinePreview.batch.invalidPackageCount === 0,
    'Baseline synthetic package batch did not produce all valid packages.',
  );

  const variantScenarios: SyntheticImportScenarioReport[] = [];
  for (const variant of SYNTHETIC_IMPORT_VARIANTS) {
    if (variant === 'duplicate-public-id') {
      variantScenarios.push(await runDuplicateScenario(seed));
      continue;
    }

    const fixture = await generateSyntheticImportBatch({
      count: 1,
      seed,
      variants: [variant as SyntheticPreviewVariant],
    });
    const adminReferenceOptions = variant === 'invalid-taxonomy'
      ? await createSyntheticAdminReferenceOptions([fixture.packages[0].project])
      : undefined;
    variantScenarios.push(await runPreviewScenario(fixture, adminReferenceOptions));
  }

  const counts = variantScenarios.reduce(
    (total, scenario) => addCounts(total, scenario.counts),
    { packageCount: 0, validPackageCount: 0, warningPackageCount: 0, invalidPackageCount: 0 },
  );
  const issueDistribution = flattenIssueDistribution(
    variantScenarios.flatMap((scenario) => scenario.issueDistribution),
  );

  return {
    seed,
    requestedCount: count,
    baseline: {
      counts: summarizePreview(baselinePreview),
      canonicalPreview,
      canonicalPreviewStable: true,
    },
    variantScenarios,
    counts,
    issueDistribution,
  };
}

export function formatSyntheticImportValidationReport(
  report: SyntheticImportValidationReport,
): string {
  const lines = [
    'Synthetic import validation harness',
    `seed: ${report.seed}`,
    `baseline packages: ${report.baseline.counts.packageCount}`,
    `baseline valid: ${report.baseline.counts.validPackageCount}`,
    `baseline warning: ${report.baseline.counts.warningPackageCount}`,
    `baseline invalid: ${report.baseline.counts.invalidPackageCount}`,
    `canonical preview stable: ${report.baseline.canonicalPreviewStable ? 'yes' : 'no'}`,
    '',
    'variant scenarios:',
  ];

  report.variantScenarios.forEach((scenario) => {
    lines.push(
      `  ${scenario.variant}: packages=${scenario.counts.packageCount}, valid=${scenario.counts.validPackageCount}, warning=${scenario.counts.warningPackageCount}, invalid=${scenario.counts.invalidPackageCount}, passed=${scenario.passed ? 'yes' : 'no'}`,
    );
    if (scenario.duplicateBoundary) {
      lines.push(`    duplicate boundary: ${scenario.duplicateBoundary}`);
    }
    if (scenario.duplicateStagingCode) {
      lines.push(`    duplicate staging result: ${scenario.duplicateStagingCode}`);
    }
  });

  lines.push(
    '',
    `variant total packages: ${report.counts.packageCount}`,
    `variant total valid: ${report.counts.validPackageCount}`,
    `variant total warning: ${report.counts.warningPackageCount}`,
    `variant total invalid: ${report.counts.invalidPackageCount}`,
    '',
    'issue distribution:',
  );

  report.issueDistribution.forEach((entry) => {
    lines.push(`  ${entry.code} [${entry.severity}]: ${entry.count}`);
  });

  return lines.join('\n');
}
