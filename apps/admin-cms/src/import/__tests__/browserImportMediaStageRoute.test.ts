import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as rawMediaStagePOST } from '../../app/api/imports/stage-media/route';
import { computeCanonicalIntentHash } from '../browserImportMetadataStageServer';
import { SelectionManifest } from '../browserImportPreviewContract';
import { generateUploadKey } from '../browserSelection';
import type { AuthenticatedAdminContext } from '../../auth/authTypes';
import ExcelJS from 'exceljs';
import * as stageMediaModule from '../stageBrowserImportMedia';

// Mock requireAdmin auth helper
vi.mock('../../auth/requireAdmin', () => ({
  requireAdmin: vi.fn(),
}));

import { requireAdmin } from '../../auth/requireAdmin';

const mockRequireAdmin = requireAdmin as unknown as ReturnType<typeof vi.fn>;

function mediaStagePOST(request: NextRequest) {
  if (!request.headers.has('origin')) request.headers.set('origin', request.nextUrl.origin);
  return rawMediaStagePOST(request);
}

function makeMockAuthContext(
  permissions: AuthenticatedAdminContext['permissions'] = ['projects.edit']
): AuthenticatedAdminContext {
  return {
    authUserId: '00000000-0000-0000-0000-000000000001',
    adminUserId: '00000000-0000-0000-0000-000000000001',
    email: 'staff@example.com',
    fullName: 'Staff User',
    roles: ['admin'],
    permissions,
  };
}

const VALID_PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG Signature
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR header
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
  0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54,
  0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4,
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

const VALID_PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF', 'ascii');

async function createRefFixture(groupName = 'Group A', title = 'Valid Title') {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('REFERENCE');
  sheet.addRow(['Group Name', 'Academic Year', 'Official Project Title', 'Degree Program', 'Contact Email']);
  sheet.addRow([groupName, 2026, title, 'Software Engineering', 'a@b.com']);
  const refBuf = Buffer.from(await wb.xlsx.writeBuffer());
  const refMapping = {
    worksheet: 'REFERENCE',
    matchMappings: [{ canonicalField: 'groupName', referenceColumn: 'Group Name' }],
    comparisonMappings: [{ canonicalField: 'title', referenceColumn: 'Official Project Title' }],
    reconciliationContractVersion: 'admin-reference-reconciliation-v1' as const,
  };
  return { refBuf, refMapping };
}

interface SetupScenarioOptions {
  altText?: string;
  omitRefFile?: boolean;
  omitRefMapping?: boolean;
  corruptRefBytes?: boolean;
  tamperRefMapping?: boolean;
  duplicateRefFile?: boolean;
  duplicateRefMapping?: boolean;
}

async function setupValidScenario(options: SetupScenarioOptions = {}) {
  const { refBuf, refMapping } = await createRefFixture('Group A', 'Valid Title');

  const jsonContent = JSON.stringify({
    publicId: 'pkg1',
    title: 'Valid Title',
    summary: 'Valid Summary',
    background: 'Valid Background',
    solution: 'Valid Solution',
    year: 2026,
    program: 'Software Engineering',
    studyProgram: 'Software Engineering',
    discipline: 'Software Engineering',
    industry: 'Software Industry',
    industryPartner: 'Partner',
    academicSupervisor: 'Supervisor',
    groupName: 'Group A',
    teamMembers: ['Alice'],
    posterText: 'Poster content text',
    accessibilityText: 'Accessibility text content',
    snapshotAltText: options.altText !== undefined ? options.altText : 'Accessible snapshot description',
    layoutConfig: { templateId: 'poster_showcase', featuredMedia: 'poster' },
  });
  const jsonBytes = Buffer.from(jsonContent, 'utf8').length;

  const manifest: SelectionManifest = {
    selectedRootName: 'pkg1',
    fileCount: 4,
    declaredTotalBytes: jsonBytes + VALID_PNG_BYTES.length + VALID_PDF_BYTES.length + VALID_PNG_BYTES.length,
    ignoredSystemFilesCount: 0,
    descriptors: [
      { uploadKey: generateUploadKey('pkg1/project.json'), originalPath: 'pkg1/project.json', fileSizeBytes: jsonBytes, browserMimeType: 'application/json' },
      { uploadKey: generateUploadKey('pkg1/poster.png'), originalPath: 'pkg1/poster.png', fileSizeBytes: VALID_PNG_BYTES.length, browserMimeType: 'image/png' },
      { uploadKey: generateUploadKey('pkg1/poster.pdf'), originalPath: 'pkg1/poster.pdf', fileSizeBytes: VALID_PDF_BYTES.length, browserMimeType: 'application/pdf' },
      { uploadKey: generateUploadKey('pkg1/snapshot-1.png'), originalPath: 'pkg1/snapshot-1.png', fileSizeBytes: VALID_PNG_BYTES.length, browserMimeType: 'image/png' },
    ],
  };

  const { analyzeBrowserImportServer } = await import('../parseBrowserImportPreview');
  const metadataFiles = new Map<string, Buffer>();
  metadataFiles.set(generateUploadKey('pkg1/project.json'), Buffer.from(jsonContent, 'utf8'));
  const analysis = await analyzeBrowserImportServer(manifest, metadataFiles, { referenceFileBuffer: refBuf, mapping: refMapping });

  const { prepareBrowserImportCommitIntent } = await import('../prepareBrowserImportCommitIntent');
  const warningPaths = analysis.preview.batch.packages[0].status === 'warning' ? ['pkg1'] : [];
  const plannerRes = prepareBrowserImportCommitIntent({
    manifest,
    preview: analysis.preview.batch,
    selectedPackagePaths: ['pkg1'],
    acknowledgedWarningPackagePaths: warningPaths,
    expectedPreviewFingerprint: analysis.preview.batch.previewFingerprint,
    adminReference: analysis.preview.batch.adminReference,
  });
  if (!plannerRes.success) {
    throw new Error(`Planner failed: ${plannerRes.code} - ${plannerRes.message}`);
  }

  const formData = new FormData();
  formData.append('batchId', '11111111-1111-1111-1111-111111111111');
  formData.append('manifest', JSON.stringify(manifest));
  formData.append('intent', JSON.stringify(plannerRes.intent));

  if (!options.omitRefFile) {
    const bytesToSend = options.corruptRefBytes ? Buffer.from('not an excel file') : refBuf;
    formData.append(
      'referenceFile',
      new File([bytesToSend], 'ref.xlsx', {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
    );
    if (options.duplicateRefFile) {
      formData.append(
        'referenceFile',
        new File([bytesToSend], 'ref.xlsx', {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        })
      );
    }
  }

  if (!options.omitRefMapping) {
    const mappingToSend = options.tamperRefMapping
      ? { ...refMapping, worksheet: 'TAMPERED_SHEET' }
      : refMapping;
    formData.append('adminReferenceMapping', JSON.stringify(mappingToSend));
    if (options.duplicateRefMapping) {
      formData.append('adminReferenceMapping', JSON.stringify(mappingToSend));
    }
  }

  formData.append(generateUploadKey('pkg1/project.json'), new File([jsonContent], 'project.json', { type: 'application/json' }));
  formData.append(generateUploadKey('pkg1/poster.png'), new File([VALID_PNG_BYTES], 'poster.png', { type: 'image/png' }));
  formData.append(generateUploadKey('pkg1/poster.pdf'), new File([VALID_PDF_BYTES], 'poster.pdf', { type: 'application/pdf' }));
  formData.append(generateUploadKey('pkg1/snapshot-1.png'), new File([VALID_PNG_BYTES], 'snapshot-1.png', { type: 'image/png' }));

  return {
    refBuf,
    refMapping,
    manifest,
    intent: plannerRes.intent,
    formData,
    expectedIntentHash: computeCanonicalIntentHash(plannerRes.intent),
  };
}

describe('Browser Import Media Staging Route Handler & Admin Reference Tests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
    mockRequireAdmin.mockResolvedValue(makeMockAuthContext());
  });

  it('1. A legitimate reconciled Admin Reference request progresses past canonical intent reconstruction and completes media staging', async () => {
    const { formData, expectedIntentHash } = await setupValidScenario({
      altText: 'Authoritative server snapshot alt text',
    });

    const mockStageMedia = vi.spyOn(stageMediaModule, 'stageBrowserImportMedia').mockResolvedValue({
      success: true,
      result: 'completed',
      batchId: '11111111-1111-1111-1111-111111111111',
      mediaAssetCount: 3,
      batchStatus: 'completed',
    });

    const req = new NextRequest('http://localhost:3000/api/imports/stage-media', {
      method: 'POST',
      headers: { 'content-length': '10000' },
      body: formData,
    });

    const res = await mediaStagePOST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      success: true,
      result: 'completed',
      batchId: '11111111-1111-1111-1111-111111111111',
      mediaAssetCount: 3,
      batchStatus: 'completed',
    });

    expect(mockStageMedia).toHaveBeenCalledTimes(1);
    const stageArgs = mockStageMedia.mock.calls[0][0];
    expect(stageArgs.batchId).toBe('11111111-1111-1111-1111-111111111111');
    expect(stageArgs.metadataIntentHash).toBe(expectedIntentHash);
    expect(stageArgs.files).toHaveLength(3);

    const snapshotMedia = stageArgs.files.find((f) => f.assetType === 'snapshot_image');
    expect(snapshotMedia).toBeDefined();
    expect(snapshotMedia?.snapshotAltText).toBe('Authoritative server snapshot alt text');
  });

  it('2. Missing reference workbook fails closed with MISSING_METADATA_UPLOAD', async () => {
    const { formData } = await setupValidScenario({ omitRefFile: true });

    const req = new NextRequest('http://localhost:3000/api/imports/stage-media', {
      method: 'POST',
      headers: { 'content-length': '10000' },
      body: formData,
    });

    const res = await mediaStagePOST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe('MISSING_METADATA_UPLOAD');
  });

  it('3. Missing reference mapping fails closed with MISSING_METADATA_UPLOAD', async () => {
    const { formData } = await setupValidScenario({ omitRefMapping: true });

    const req = new NextRequest('http://localhost:3000/api/imports/stage-media', {
      method: 'POST',
      headers: { 'content-length': '10000' },
      body: formData,
    });

    const res = await mediaStagePOST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe('MISSING_METADATA_UPLOAD');
  });

  it('4. Changed workbook bytes / fingerprint mismatch fails closed with PREVIEW_FINGERPRINT_MISMATCH', async () => {
    const { formData } = await setupValidScenario({ corruptRefBytes: true });

    const req = new NextRequest('http://localhost:3000/api/imports/stage-media', {
      method: 'POST',
      headers: { 'content-length': '10000' },
      body: formData,
    });

    const res = await mediaStagePOST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe('PREVIEW_FINGERPRINT_MISMATCH');
  });

  it('5. Changed worksheet or mapping fails closed with PREVIEW_FINGERPRINT_MISMATCH', async () => {
    const { formData } = await setupValidScenario({ tamperRefMapping: true });

    const req = new NextRequest('http://localhost:3000/api/imports/stage-media', {
      method: 'POST',
      headers: { 'content-length': '10000' },
      body: formData,
    });

    const res = await mediaStagePOST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe('PREVIEW_FINGERPRINT_MISMATCH');
  });

  it('6. Browser-supplied intent with tampered fingerprint cannot override server verification', async () => {
    const { formData, intent } = await setupValidScenario();
    const tamperedIntent = { ...intent, previewFingerprint: 'f'.repeat(64) };
    formData.set('intent', JSON.stringify(tamperedIntent));

    const req = new NextRequest('http://localhost:3000/api/imports/stage-media', {
      method: 'POST',
      headers: { 'content-length': '10000' },
      body: formData,
    });

    const res = await mediaStagePOST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe('PREVIEW_FINGERPRINT_MISMATCH');
  });

  it('7. Duplicate referenceFile or adminReferenceMapping form fields are rejected with DUPLICATE_UPLOAD_FIELD', async () => {
    const scenario1 = await setupValidScenario({ duplicateRefFile: true });
    const req1 = new NextRequest('http://localhost:3000/api/imports/stage-media', {
      method: 'POST',
      headers: { 'content-length': '10000' },
      body: scenario1.formData,
    });
    const res1 = await mediaStagePOST(req1);
    expect(res1.status).toBe(400);
    expect((await res1.json()).code).toBe('DUPLICATE_UPLOAD_FIELD');

    const scenario2 = await setupValidScenario({ duplicateRefMapping: true });
    const req2 = new NextRequest('http://localhost:3000/api/imports/stage-media', {
      method: 'POST',
      headers: { 'content-length': '10000' },
      body: scenario2.formData,
    });
    const res2 = await mediaStagePOST(req2);
    expect(res2.status).toBe(400);
    expect((await res2.json()).code).toBe('DUPLICATE_UPLOAD_FIELD');
  });

  it('8. referenceFile is reserved and never treated as a candidate media file', async () => {
    const { formData } = await setupValidScenario();

    const mockStageMedia = vi.spyOn(stageMediaModule, 'stageBrowserImportMedia').mockResolvedValue({
      success: true,
      result: 'completed',
      batchId: '11111111-1111-1111-1111-111111111111',
      mediaAssetCount: 3,
      batchStatus: 'completed',
    });

    const req = new NextRequest('http://localhost:3000/api/imports/stage-media', {
      method: 'POST',
      headers: { 'content-length': '10000' },
      body: formData,
    });

    const res = await mediaStagePOST(req);
    expect(res.status).toBe(200);
    expect(mockStageMedia).toHaveBeenCalledTimes(1);

    const stagedFiles = mockStageMedia.mock.calls[0][0].files;
    expect(stagedFiles.some((f) => f.fileName.includes('ref.xlsx'))).toBe(false);
  });

  it('9. Existing unexpected-media-field rejection remains intact', async () => {
    const { formData } = await setupValidScenario();
    formData.append('unexpected_key', new File(['unknown'], 'rogue.png', { type: 'image/png' }));

    const req = new NextRequest('http://localhost:3000/api/imports/stage-media', {
      method: 'POST',
      headers: { 'content-length': '10000' },
      body: formData,
    });

    const res = await mediaStagePOST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe('UNEXPECTED_UPLOAD_FIELD');
  });

  it('10. Existing metadata file size validation remains intact', async () => {
    const { formData } = await setupValidScenario();
    // Tamper the metadata file size to mismatch descriptor
    const jsonKey = generateUploadKey('pkg1/project.json');
    formData.set(jsonKey, new File(['{}'], 'project.json', { type: 'application/json' }));

    const req = new NextRequest('http://localhost:3000/api/imports/stage-media', {
      method: 'POST',
      headers: { 'content-length': '10000' },
      body: formData,
    });

    const res = await mediaStagePOST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe('METADATA_SIZE_MISMATCH');
  });

  it('11. Existing media byte/signature checks remain intact', async () => {
    const { formData } = await setupValidScenario();
    // Tamper the poster file with text content (invalid PNG signature) of same length
    const fakeBytes = Buffer.alloc(VALID_PNG_BYTES.length, 0x41); // 'A's
    const posterKey = generateUploadKey('pkg1/poster.png');
    formData.set(posterKey, new File([fakeBytes], 'poster.png', { type: 'image/png' }));

    const req = new NextRequest('http://localhost:3000/api/imports/stage-media', {
      method: 'POST',
      headers: { 'content-length': '10000' },
      body: formData,
    });

    const res = await mediaStagePOST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe('MEDIA_UNSUPPORTED_TYPE');
  });
  it('11a. Rejects poster PDF when actual bytes are an image despite the PDF filename and MIME', async () => {
    const { formData } = await setupValidScenario();

    const fakePdfBytes = Buffer.alloc(VALID_PDF_BYTES.length, 0);

    VALID_PNG_BYTES.copy(
      fakePdfBytes,
      0,
      0,
      Math.min(VALID_PNG_BYTES.length, fakePdfBytes.length),
    );

    const pdfKey = generateUploadKey('pkg1/poster.pdf');

    formData.set(
      pdfKey,
      new File([fakePdfBytes], 'poster.pdf', {
        type: 'application/pdf',
      }),
    );

    const req = new NextRequest(
      'http://localhost:3000/api/imports/stage-media',
      {
        method: 'POST',
        headers: { 'content-length': '10000' },
        body: formData,
      },
    );

    const res = await mediaStagePOST(req);

    expect(res.status).toBe(400);

    const json = await res.json();

    expect(json.code).toBe('MEDIA_SIGNATURE_MISMATCH');
  });

  it('12. Existing snapshot alt-text binding remains intact (server-authoritative from manifest)', async () => {
    const { formData } = await setupValidScenario({
      altText: 'Server bound alt text',
    });

    const mockStageMedia = vi.spyOn(stageMediaModule, 'stageBrowserImportMedia').mockResolvedValue({
      success: true,
      result: 'completed',
      batchId: '11111111-1111-1111-1111-111111111111',
      mediaAssetCount: 3,
      batchStatus: 'completed',
    });

    const req = new NextRequest('http://localhost:3000/api/imports/stage-media', {
      method: 'POST',
      headers: { 'content-length': '10000' },
      body: formData,
    });

    const res = await mediaStagePOST(req);
    expect(res.status).toBe(200);

    const snapshot = mockStageMedia.mock.calls[0][0].files.find((f) => f.assetType === 'snapshot_image');
    expect(snapshot?.snapshotAltText).toBe('Server bound alt text');
  });

  it('13. Existing browser_import_commits metadata-intent binding remains intact (BATCH_INTENT_MISMATCH)', async () => {
    const { formData } = await setupValidScenario();

    vi.spyOn(stageMediaModule, 'stageBrowserImportMedia').mockResolvedValue({
      success: false,
      code: 'BATCH_INTENT_MISMATCH',
      error: 'The import batch could not be verified for this request.',
    });

    const req = new NextRequest('http://localhost:3000/api/imports/stage-media', {
      method: 'POST',
      headers: { 'content-length': '10000' },
      body: formData,
    });

    const res = await mediaStagePOST(req);
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.code).toBe('BATCH_INTENT_MISMATCH');
  });

  it('14. Exact retry/idempotency behavior returns already_completed with HTTP 200', async () => {
    const { formData } = await setupValidScenario();

    vi.spyOn(stageMediaModule, 'stageBrowserImportMedia').mockResolvedValue({
      success: true,
      result: 'already_completed',
      batchId: '11111111-1111-1111-1111-111111111111',
      mediaAssetCount: 3,
      batchStatus: 'completed',
    });

    const req = new NextRequest('http://localhost:3000/api/imports/stage-media', {
      method: 'POST',
      headers: { 'content-length': '10000' },
      body: formData,
    });

    const res = await mediaStagePOST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      success: true,
      result: 'already_completed',
      batchId: '11111111-1111-1111-1111-111111111111',
      mediaAssetCount: 3,
      batchStatus: 'completed',
    });
  });
});
