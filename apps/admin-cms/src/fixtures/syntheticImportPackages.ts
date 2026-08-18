import ExcelJS from 'exceljs';

import type { Project } from '../domain/project';
import {
  buildBrowserSelectionDescriptor,
  type SelectedFileDescriptor,
  type SelectionManifest,
} from '../import/browserImportPreviewContract';
import type { AdminReferenceAnalysisOptions } from '../import/parseBrowserImportPreview';
import { COLUMN_DEFINITIONS } from '../import/projectDetailsWorkbookContract';
import type { AdminReferenceMappingConfig } from '../import/adminReferenceSharedContract';
import {
  DEFAULT_SYNTHETIC_SEED,
  generateSyntheticProjects,
} from './syntheticProjects';

export const SYNTHETIC_IMPORT_PACKAGE_COUNTS = [1, 10, 25] as const;
export type SyntheticImportPackageCount = (typeof SYNTHETIC_IMPORT_PACKAGE_COUNTS)[number];

export const SYNTHETIC_IMPORT_VARIANTS = [
  'fully-valid',
  'optional-files-absent',
  'warning-level',
  'missing-required-metadata',
  'invalid-taxonomy',
  'duplicate-public-id',
  'unsupported-media-type',
  'oversized-metadata',
  'missing-required-media',
  'incomplete-workbook',
] as const;
export type SyntheticImportPackageVariant = (typeof SYNTHETIC_IMPORT_VARIANTS)[number];
export type SyntheticPreviewVariant = Exclude<
  SyntheticImportPackageVariant,
  'duplicate-public-id'
>;

const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const FIXED_WORKBOOK_DATE = new Date('2024-01-01T00:00:00.000Z');
const SYNTHETIC_BATCH_ROOT = 'synthetic-import-batch';
const SYNTHETIC_DUPLICATE_BATCH_ROOT = 'synthetic-import-duplicate-batch';

type SyntheticWorkbookValues = Record<string, string>;

export interface SyntheticImportPackageFixture {
  variant: SyntheticPreviewVariant;
  project: Project;
  publicId: string;
  packagePath: string;
  workbookBuffer: Buffer;
  metadataUploadKey: string;
  descriptors: SelectedFileDescriptor[];
  expectedIssueCodes: readonly string[];
}

export interface SyntheticImportBatchFixture {
  count: SyntheticImportPackageCount | 2;
  seed: number;
  selectedRootName: string;
  packages: SyntheticImportPackageFixture[];
  selectionManifest: SelectionManifest;
  uploadedMetadataFiles: Map<string, Buffer>;
}

export interface GenerateSyntheticImportBatchOptions {
  count: SyntheticImportPackageCount | 2;
  seed?: number;
  variants?: readonly SyntheticPreviewVariant[];
  selectedRootName?: string;
}

export interface SyntheticStagingDuplicatePublicIdFixture {
  batch: SyntheticImportBatchFixture;
  duplicatePublicId: string;
}

export interface SyntheticAdminReferenceOptions extends AdminReferenceAnalysisOptions {
  mapping: AdminReferenceMappingConfig;
}

function expectedIssueCodes(variant: SyntheticPreviewVariant): readonly string[] {
  switch (variant) {
    case 'fully-valid':
      return [];
    case 'optional-files-absent':
      return ['FILE_MISSING_RECOMMENDED'];
    case 'warning-level':
      return ['WORKBOOK_DUPLICATE_TEAM_MEMBER'];
    case 'missing-required-metadata':
      return ['WORKBOOK_MISSING_REQUIRED_VALUE'];
    case 'invalid-taxonomy':
      return ['ADMIN_REFERENCE_FIELD_MISMATCH'];
    case 'unsupported-media-type':
      return ['PACKAGE_UNKNOWN_FILE', 'FILE_MISSING_POSTER_IMAGE'];
    case 'oversized-metadata':
      return ['WORKBOOK_VALUE_TOO_LONG'];
    case 'missing-required-media':
      return ['FILE_MISSING_POSTER_PDF'];
    case 'incomplete-workbook':
      return ['WORKBOOK_MISSING_PROJECT_ROW'];
  }
}

function getSnapshotAltText(project: Project): string {
  return project.snapshotMedia[0]?.altText
    || `Synthetic snapshot description for ${project.publicId}.`;
}

function getWorkbookValues(project: Project): SyntheticWorkbookValues {
  return {
    title: project.title,
    summary: project.summary,
    background: project.background,
    solution: project.solution,
    teamMembers: project.teamMembers.join('\n'),
    groupName: project.groupName,
    participantContactEmail: '',
    academicSupervisor: project.academicSupervisor,
    industryPartner: project.industryPartner,
    industry: project.industry,
    program: project.program,
    studyProgram: project.studyProgram,
    discipline: project.discipline,
    year: project.year,
    templateId: project.layoutConfig.templateId,
    featuredMedia: project.layoutConfig.featuredMedia,
    posterText: project.posterText,
    accessibilityText: project.accessibilityText,
    snapshotAltText: getSnapshotAltText(project),
  };
}

function getVariantWorkbookValues(
  project: Project,
  variant: SyntheticPreviewVariant,
): SyntheticWorkbookValues {
  const values = getWorkbookValues(project);

  switch (variant) {
    case 'warning-level':
      values.teamMembers = `${project.teamMembers[0]}\n${project.teamMembers[0]}`;
      return values;
    case 'missing-required-metadata':
      values.title = '';
      return values;
    case 'invalid-taxonomy':
      values.program = 'Synthetic Unlisted Program Fixture';
      return values;
    case 'oversized-metadata':
      values.accessibilityText = 'x'.repeat(2001);
      return values;
    case 'optional-files-absent':
      values.snapshotAltText = '';
      return values;
    case 'fully-valid':
    case 'unsupported-media-type':
    case 'missing-required-media':
    case 'incomplete-workbook':
      return values;
  }
}

async function createWorkbookBuffer(
  project: Project,
  variant: SyntheticPreviewVariant,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Synthetic Import Fixture Generator';
  workbook.lastModifiedBy = 'Synthetic Import Fixture Generator';
  workbook.created = FIXED_WORKBOOK_DATE;
  workbook.modified = FIXED_WORKBOOK_DATE;
  workbook.lastPrinted = FIXED_WORKBOOK_DATE;

  const worksheet = workbook.addWorksheet('Project details');
  const headers = COLUMN_DEFINITIONS.map((definition) => definition.canonicalName);

  worksheet.addRow(headers);

  if (variant !== 'incomplete-workbook') {
    const values = getVariantWorkbookValues(project, variant);
    worksheet.addRow(
      COLUMN_DEFINITIONS.map((definition) => {
        const field = definition.internalField;
        if (field === 'templateId' || field === 'featuredMedia') {
          return values[field];
        }
        return values[field];
      }),
    );
  }

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

function createDescriptor(
  originalPath: string,
  fileSizeBytes: number,
  browserMimeType: string,
): SelectedFileDescriptor {
  const descriptor = buildBrowserSelectionDescriptor(
    originalPath,
    fileSizeBytes,
    browserMimeType,
  );

  if (!descriptor) {
    throw new Error(`Unable to create safe synthetic descriptor for ${originalPath}.`);
  }

  return descriptor;
}

function createMediaSpecs(variant: SyntheticPreviewVariant): Array<{
  fileName: string;
  fileSizeBytes: number;
  browserMimeType: string;
}> {
  const specs = [
    { fileName: 'poster.png', fileSizeBytes: 1024, browserMimeType: 'image/png' },
    { fileName: 'poster.pdf', fileSizeBytes: 2048, browserMimeType: 'application/pdf' },
    { fileName: 'snapshot-1.png', fileSizeBytes: 512, browserMimeType: 'image/png' },
  ];

  if (variant === 'optional-files-absent') {
    return specs.slice(0, 2);
  }

  if (variant === 'missing-required-media') {
    return [specs[0], specs[2]];
  }

  if (variant === 'unsupported-media-type') {
    return [
      { fileName: 'poster.gif', fileSizeBytes: 1024, browserMimeType: 'image/gif' },
      specs[1],
      specs[2],
    ];
  }

  return specs;
}

async function createSyntheticPackage(
  project: Project,
  variant: SyntheticPreviewVariant,
  selectedRootName: string,
  batchMode: boolean,
): Promise<SyntheticImportPackageFixture> {
  const workbookBuffer = await createWorkbookBuffer(project, variant);
  const packagePath = batchMode
    ? `${selectedRootName}/${project.publicId}`
    : project.publicId || '';
  const filePrefix = `${packagePath}/`;
  const workbookPath = `${filePrefix}project-details.xlsx`;
  const workbookDescriptor = createDescriptor(
    workbookPath,
    workbookBuffer.length,
    XLSX_MIME_TYPE,
  );
  const mediaDescriptors = createMediaSpecs(variant).map((spec) =>
    createDescriptor(
      `${filePrefix}${spec.fileName}`,
      spec.fileSizeBytes,
      spec.browserMimeType,
    ));

  return {
    variant,
    project,
    publicId: project.publicId || '',
    packagePath,
    workbookBuffer,
    metadataUploadKey: workbookDescriptor.uploadKey,
    descriptors: [workbookDescriptor, ...mediaDescriptors],
    expectedIssueCodes: expectedIssueCodes(variant),
  };
}

export async function generateSyntheticImportBatch({
  count,
  seed = DEFAULT_SYNTHETIC_SEED,
  variants,
  selectedRootName,
}: GenerateSyntheticImportBatchOptions): Promise<SyntheticImportBatchFixture> {
  if (!SYNTHETIC_IMPORT_PACKAGE_COUNTS.includes(count as SyntheticImportPackageCount) && count !== 2) {
    throw new Error(`Synthetic import package count must be one of: ${SYNTHETIC_IMPORT_PACKAGE_COUNTS.join(', ')}.`);
  }

  if (variants && variants.length > count) {
    throw new Error('Synthetic import variant assignments cannot exceed the package count.');
  }

  const projects = generateSyntheticProjects({ count: 100, seed }).slice(0, count);
  const root = selectedRootName || (count === 1 ? projects[0].publicId || '' : SYNTHETIC_BATCH_ROOT);
  const batchMode = count > 1;
  const packages: SyntheticImportPackageFixture[] = [];

  for (const [index, project] of projects.entries()) {
    const variant = variants?.[index] || 'fully-valid';
    packages.push(await createSyntheticPackage(project, variant, root, batchMode));
  }

  const descriptors = packages.flatMap((pkg) => pkg.descriptors);
  const selectionManifest: SelectionManifest = {
    selectedRootName: root,
    fileCount: descriptors.length,
    declaredTotalBytes: descriptors.reduce((total, descriptor) => total + descriptor.fileSizeBytes, 0),
    ignoredSystemFilesCount: 0,
    descriptors,
  };
  const uploadedMetadataFiles = new Map(
    packages.map((pkg) => [pkg.metadataUploadKey, pkg.workbookBuffer]),
  );

  return {
    count,
    seed,
    selectedRootName: root,
    packages,
    selectionManifest,
    uploadedMetadataFiles,
  };
}

/**
 * Folder names are the authoritative public IDs at the supported package-selection boundary, so
 * two sibling packages cannot legitimately produce the same public ID. This fixture therefore
 * keeps the selected packages valid and unique and supplies the ID used to exercise the first
 * production boundary that independently defends against duplicates: metadata staging.
 */
export async function createSyntheticStagingDuplicatePublicIdFixture({
  seed = DEFAULT_SYNTHETIC_SEED,
}: { seed?: number } = {}): Promise<SyntheticStagingDuplicatePublicIdFixture> {
  const batch = await generateSyntheticImportBatch({
    count: 2,
    seed,
    selectedRootName: SYNTHETIC_DUPLICATE_BATCH_ROOT,
    variants: ['fully-valid', 'fully-valid'],
  });

  return {
    batch,
    duplicatePublicId: [...batch.packages]
      .map((pkg) => pkg.publicId)
      .sort()[0],
  };
}

export async function createSyntheticAdminReferenceOptions(
  projects: readonly Project[],
  programOverrides: ReadonlyMap<string, string> = new Map(),
): Promise<SyntheticAdminReferenceOptions> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Synthetic Import Fixture Generator';
  workbook.lastModifiedBy = 'Synthetic Import Fixture Generator';
  workbook.created = FIXED_WORKBOOK_DATE;
  workbook.modified = FIXED_WORKBOOK_DATE;
  workbook.lastPrinted = FIXED_WORKBOOK_DATE;

  const worksheetName = 'Synthetic Admin Reference';
  const worksheet = workbook.addWorksheet(worksheetName);
  worksheet.addRow(['Public ID', 'Study Program']);

  projects.forEach((project) => {
    const publicId = project.publicId || '';
    worksheet.addRow([
      publicId,
      programOverrides.get(publicId) || project.program,
    ]);
  });

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  const mapping: AdminReferenceMappingConfig = {
    worksheet: worksheetName,
    matchMappings: [{ canonicalField: 'publicId', referenceColumn: 'Public ID' }],
    comparisonMappings: [{ canonicalField: 'program', referenceColumn: 'Study Program' }],
    reconciliationContractVersion: 'admin-reference-reconciliation-v1',
  };

  return {
    referenceFileBuffer: Buffer.from(arrayBuffer),
    mapping,
  };
}
