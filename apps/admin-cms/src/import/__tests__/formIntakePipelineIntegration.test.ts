import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import {
  createInitialFormIntakeMetadata,
  createInitialFormIntakeMediaState,
} from '../formIntakeContract';
import { validateFormIntake } from '../formIntakeValidation';
import { materializeFormIntakeWorkbook } from '../formIntakeWorkbookMaterializer';
import { analyzeBrowserImportServer } from '../parseBrowserImportPreview';
import {
  SelectionManifest,
  buildBrowserSelectionDescriptor,
} from '../browserImportPreviewContract';
import { generateUploadKey } from '../browserSelection';
import type { AdminReferenceMappingConfig } from '../adminReferenceSharedContract';

function createDummyPngBuffer(): Buffer {
  const buf = Buffer.alloc(100);
  buf.writeUInt32BE(0x89504e47, 0); // PNG header
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  return buf;
}

function createDummyPdfBuffer(): Buffer {
  return Buffer.from('%PDF-1.4\n%EOF\n');
}

async function createAdminReferenceWorkbookBuffer(
  rows: Array<{
    group: string;
    title: string;
    program: string;
    discipline: string;
    year: string;
  }>
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Projects');

  sheet.addRow([
    'Group Name',
    'Project Title',
    'Program',
    'Discipline',
    'Year',
  ]);

  for (const row of rows) {
    sheet.addRow([row.group, row.title, row.program, row.discipline, row.year]);
  }

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

describe('Form Intake to Server Pipeline Integration (MG-05 Compliant)', () => {
  const metadata = {
    ...createInitialFormIntakeMetadata(),
    publicId: 'autonomous-rover-2026',
    title: 'Autonomous Rover Navigation',
    summary: 'Autonomous traversal algorithms for uneven terrain.',
    background: 'Rough terrain challenges planetary exploration rovers.',
    solution: 'Multi-camera visual odometry and real-time obstacle avoidance.',
    teamMembers: 'Alice Smith, Bob Jones',
    groupName: 'Rover Dynamics',
    participantContactEmail: 'rover@example.edu',
    academicSupervisor: 'Prof. Alan Turing',
    industryPartner: 'Space Robotics Lab',
    industry: 'Aerospace',
    program: 'Bachelor of Engineering (Robotics)',
    discipline: 'Robotics Engineering',
    year: '2026',
    templateId: 'poster_showcase',
    featuredMedia: 'poster',
    posterText: 'Autonomous Rover Navigation Research Poster Full Text',
    accessibilityText: 'Poster with photos and architecture diagrams of the rover',
    snapshotAltText: 'Front camera photo of the rover',
    snapshot1ContentKind: 'ordinary',
    snapshot1FullText: '',
    snapshot2AltText: 'Real-time telemetry and obstacle detection screen',
    snapshot2ContentKind: 'text_bearing',
    snapshot2FullText: 'Telemetry screen showing obstacle distance 1.2m, waypoint (12.4, 55.1).',
  };

  it('runs complete form-to-server preview pipeline without admin reference', async () => {
    // 1. Client-side validation
    const mediaState = createInitialFormIntakeMediaState();
    mediaState.posterImage = new File([new Uint8Array(createDummyPngBuffer())], 'poster.png', { type: 'image/png' });
    mediaState.posterPdf = new File([new Uint8Array(createDummyPdfBuffer())], 'poster.pdf', { type: 'application/pdf' });
    mediaState.galleryImages[0].file = new File([new Uint8Array(createDummyPngBuffer())], 'snap1.png', { type: 'image/png' });
    mediaState.galleryImages[0].altText = metadata.snapshotAltText;
    mediaState.galleryImages[0].contentKind = 'ordinary';
    mediaState.galleryImages[0].fullText = '';

    mediaState.galleryImages[1].file = new File([new Uint8Array(createDummyPngBuffer())], 'snap2.png', { type: 'image/png' });
    mediaState.galleryImages[1].altText = metadata.snapshot2AltText;
    mediaState.galleryImages[1].contentKind = 'text_bearing';
    mediaState.galleryImages[1].fullText = metadata.snapshot2FullText;

    const validation = validateFormIntake(metadata, mediaState);
    expect(validation.valid).toBe(true);

    // 2. Server materializes canonical workbook
    const workbookBuf = await materializeFormIntakeWorkbook(metadata);
    expect(workbookBuf.length).toBeGreaterThan(0);

    // 3. Prepare client manifest & uploaded files
    const posterBuf = createDummyPngBuffer();
    const pdfBuf = createDummyPdfBuffer();
    const snap1Buf = createDummyPngBuffer();
    const snap2Buf = createDummyPngBuffer();

    const publicId = metadata.publicId;
    const descriptors = [
      buildBrowserSelectionDescriptor(
        `${publicId}/project-details.xlsx`,
        workbookBuf.length,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      )!,
      buildBrowserSelectionDescriptor(`${publicId}/poster.png`, posterBuf.length, 'image/png')!,
      buildBrowserSelectionDescriptor(`${publicId}/poster.pdf`, pdfBuf.length, 'application/pdf')!,
      buildBrowserSelectionDescriptor(`${publicId}/snapshot-1.png`, snap1Buf.length, 'image/png')!,
      buildBrowserSelectionDescriptor(`${publicId}/snapshot-2.png`, snap2Buf.length, 'image/png')!,
    ];

    const totalBytes = workbookBuf.length + posterBuf.length + pdfBuf.length + snap1Buf.length + snap2Buf.length;

    const manifest: SelectionManifest = {
      selectedRootName: publicId,
      fileCount: descriptors.length,
      declaredTotalBytes: totalBytes,
      ignoredSystemFilesCount: 0,
      descriptors,
    };

    const uploadedMetadataFiles = new Map<string, Buffer>();
    uploadedMetadataFiles.set(generateUploadKey(`${publicId}/project-details.xlsx`), workbookBuf);

    // 4. Server preview analysis
    const serverAnalysis = await analyzeBrowserImportServer(manifest, uploadedMetadataFiles);
    expect(serverAnalysis.preview.success).toBe(true);
    expect(serverAnalysis.preview.batch.validPackageCount).toBe(1);
    expect(serverAnalysis.preview.batch.invalidPackageCount).toBe(0);
    expect(serverAnalysis.preview.batch.packages).toHaveLength(1);

    const pkg = serverAnalysis.preview.batch.packages[0];
    expect(pkg.status).toBe('valid');
    expect(pkg.proposedPublicId).toBe(publicId);
    expect(pkg.previewMetadata?.title).toBe('Autonomous Rover Navigation');
    expect(pkg.filePresence.posterImagePresent).toBe(true);
    expect(pkg.filePresence.posterPdfPresent).toBe(true);
    expect(pkg.filePresence.snapshotPresent).toBe(true);
  });

  it('runs complete form-to-server preview pipeline with matching Admin Reference reconciliation', async () => {
    const metaWithoutSnapshots = {
      ...metadata,
      snapshotAltText: '',
      snapshot1ContentKind: '',
      snapshot1FullText: '',
      snapshot2AltText: '',
      snapshot2ContentKind: '',
      snapshot2FullText: '',
    };
    const workbookBuf = await materializeFormIntakeWorkbook(metaWithoutSnapshots);
    const posterBuf = createDummyPngBuffer();
    const pdfBuf = createDummyPdfBuffer();

    const publicId = metadata.publicId;
    const descriptors = [
      buildBrowserSelectionDescriptor(
        `${publicId}/project-details.xlsx`,
        workbookBuf.length,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      )!,
      buildBrowserSelectionDescriptor(`${publicId}/poster.png`, posterBuf.length, 'image/png')!,
      buildBrowserSelectionDescriptor(`${publicId}/poster.pdf`, pdfBuf.length, 'application/pdf')!,
    ];

    const manifest: SelectionManifest = {
      selectedRootName: publicId,
      fileCount: descriptors.length,
      declaredTotalBytes: workbookBuf.length + posterBuf.length + pdfBuf.length,
      ignoredSystemFilesCount: 0,
      descriptors,
    };

    const uploadedMetadataFiles = new Map<string, Buffer>();
    uploadedMetadataFiles.set(generateUploadKey(`${publicId}/project-details.xlsx`), workbookBuf);

    // Admin Reference spreadsheet with matching group name and title
    const refBuffer = await createAdminReferenceWorkbookBuffer([
      {
        group: 'Rover Dynamics',
        title: 'Autonomous Rover Navigation',
        program: 'Bachelor of Engineering (Robotics)',
        discipline: 'Robotics Engineering',
        year: '2026',
      },
    ]);

    const mapping: AdminReferenceMappingConfig = {
      worksheet: 'Projects',
      reconciliationContractVersion: 'admin-reference-reconciliation-v1',
      matchMappings: [
        { canonicalField: 'groupName', referenceColumn: 'Group Name' },
      ],
      comparisonMappings: [
        { canonicalField: 'title', referenceColumn: 'Project Title' },
      ],
    };

    const serverAnalysis = await analyzeBrowserImportServer(
      manifest,
      uploadedMetadataFiles,
      { referenceFileBuffer: refBuffer, mapping }
    );

    expect(serverAnalysis.preview.success).toBe(true);
    const pkg = serverAnalysis.preview.batch.packages[0];
    expect(pkg.status).toBe('warning');
    expect(pkg.warnings.some((w) => w.code === 'FILE_MISSING_RECOMMENDED')).toBe(true);
    expect(pkg.reconciliation?.status).toBe('RECONCILED');
  });

  it('correctly marks package invalid when Admin Reference comparison mismatches', async () => {
    const metaWithoutSnapshots = {
      ...metadata,
      snapshotAltText: '',
      snapshot1ContentKind: '',
      snapshot1FullText: '',
      snapshot2AltText: '',
      snapshot2ContentKind: '',
      snapshot2FullText: '',
    };
    const workbookBuf = await materializeFormIntakeWorkbook(metaWithoutSnapshots);
    const posterBuf = createDummyPngBuffer();
    const pdfBuf = createDummyPdfBuffer();

    const publicId = metadata.publicId;
    const descriptors = [
      buildBrowserSelectionDescriptor(
        `${publicId}/project-details.xlsx`,
        workbookBuf.length,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      )!,
      buildBrowserSelectionDescriptor(`${publicId}/poster.png`, posterBuf.length, 'image/png')!,
      buildBrowserSelectionDescriptor(`${publicId}/poster.pdf`, pdfBuf.length, 'application/pdf')!,
    ];

    const manifest: SelectionManifest = {
      selectedRootName: publicId,
      fileCount: descriptors.length,
      declaredTotalBytes: workbookBuf.length + posterBuf.length + pdfBuf.length,
      ignoredSystemFilesCount: 0,
      descriptors,
    };

    const uploadedMetadataFiles = new Map<string, Buffer>();
    uploadedMetadataFiles.set(generateUploadKey(`${publicId}/project-details.xlsx`), workbookBuf);

    // Reference workbook has matching group, but mismatched title
    const refBuffer = await createAdminReferenceWorkbookBuffer([
      {
        group: 'Rover Dynamics',
        title: 'Completely Different Title in Official School Spreadsheet',
        program: 'Bachelor of Engineering (Robotics)',
        discipline: 'Robotics Engineering',
        year: '2026',
      },
    ]);

    const mapping: AdminReferenceMappingConfig = {
      worksheet: 'Projects',
      reconciliationContractVersion: 'admin-reference-reconciliation-v1',
      matchMappings: [
        { canonicalField: 'groupName', referenceColumn: 'Group Name' },
      ],
      comparisonMappings: [
        { canonicalField: 'title', referenceColumn: 'Project Title' },
      ],
    };

    const serverAnalysis = await analyzeBrowserImportServer(
      manifest,
      uploadedMetadataFiles,
      { referenceFileBuffer: refBuffer, mapping }
    );

    expect(serverAnalysis.preview.success).toBe(true);
    const pkg = serverAnalysis.preview.batch.packages[0];
    expect(pkg.status).toBe('invalid');
    expect(pkg.reconciliation?.status).toBe('ADMIN_REFERENCE_FIELD_MISMATCH');
    expect(pkg.errors.some((e) => e.code === 'ADMIN_REFERENCE_FIELD_MISMATCH')).toBe(true);
  });
});
