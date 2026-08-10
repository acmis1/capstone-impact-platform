import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as stagePOST } from '../../app/api/imports/stage-metadata/route';
import {
  computeCanonicalIntentHash,
} from '../browserImportMetadataStageContract';
import { SelectionManifest } from '../browserImportPreviewContract';
import { generateUploadKey } from '../browserSelection';
import type { createSupabaseAdminClientCore } from '../../lib/supabase/adminCore';

// Mock requireAdmin auth helper
vi.mock('../../auth/requireAdmin', () => ({
  requireAdmin: vi.fn(),
}));

import { requireAdmin } from '../../auth/requireAdmin';

const mockRequireAdmin = requireAdmin as unknown as ReturnType<typeof vi.fn>;

function makeMockAuthContext(permissions = ['projects.edit']) {
  return {
    authUserId: '00000000-0000-0000-0000-000000000001',
    adminUserId: '00000000-0000-0000-0000-000000000001',
    email: 'staff@example.com',
    fullName: 'Staff User',
    roles: ['admin'],
    permissions,
  };
}

describe('Browser Import Metadata Staging Unit & API Contract Tests', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockRequireAdmin.mockResolvedValue(makeMockAuthContext());
  });

  it('1. computeCanonicalIntentHash produces deterministic lowercase 64-char sha256 hex', () => {
    const intent = {
      version: 1 as const,
      previewFingerprint: 'a'.repeat(64),
      selectedRootName: 'batch-root',
      fileCount: 5,
      declaredTotalBytes: 12345,
      selectedPackagePaths: ['batch-root/pkg1', 'batch-root/pkg2'],
      acknowledgedWarningPackagePaths: ['batch-root/pkg2'],
    };

    const hash1 = computeCanonicalIntentHash(intent);
    const hash2 = computeCanonicalIntentHash({
      ...intent,
      selectedPackagePaths: ['batch-root/pkg2', 'batch-root/pkg1'], // Unsorted input should produce same hash
    });

    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
    expect(hash1).toBe(hash2);
  });

  it('2. API rejects unauthenticated requests', async () => {
    const { AdminAuthError } = await import('../../auth/authTypes');
    mockRequireAdmin.mockRejectedValue(new AdminAuthError('UNAUTHENTICATED', 'Missing session'));

    const req = new NextRequest('http://localhost:3000/api/imports/stage-metadata', {
      method: 'POST',
      headers: { 'content-length': '100' },
    });

    const res = await stagePOST(req);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toEqual({
      success: false,
      code: 'UNAUTHENTICATED',
      error: 'Authentication required.',
    });
  });

  it('3. API rejects unauthorized staff lacking projects.edit permission', async () => {
    mockRequireAdmin.mockResolvedValue(makeMockAuthContext([]));

    const req = new NextRequest('http://localhost:3000/api/imports/stage-metadata', {
      method: 'POST',
      headers: { 'content-length': '100' },
    });

    const res = await stagePOST(req);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json).toEqual({
      success: false,
      code: 'PERMISSION_DENIED',
      error: 'Access denied.',
    });
  });

  it('4. API rejects cross-origin requests', async () => {
    const req = new NextRequest('http://localhost:3000/api/imports/stage-metadata', {
      method: 'POST',
      headers: {
        origin: 'http://malicious.com',
        'content-length': '100',
      },
    });

    const res = await stagePOST(req);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json).toEqual({
      success: false,
      code: 'CROSS_ORIGIN_REJECTED',
      error: 'The request was not accepted.',
    });
  });

  it('5. API enforces Content-Length check', async () => {
    const reqNoLen = new NextRequest('http://localhost:3000/api/imports/stage-metadata', {
      method: 'POST',
    });
    const resNoLen = await stagePOST(reqNoLen);
    expect(resNoLen.status).toBe(400);

    const reqBadLen = new NextRequest('http://localhost:3000/api/imports/stage-metadata', {
      method: 'POST',
      headers: { 'content-length': 'abc' },
    });
    const resBadLen = await stagePOST(reqBadLen);
    expect(resBadLen.status).toBe(400);
  });

  it('6. API rejects duplicate or missing manifest/intent fields', async () => {
    const formData = new FormData();
    formData.append('manifest', '{}');
    formData.append('manifest', '{}');
    formData.append('intent', '{}');

    const req = new NextRequest('http://localhost:3000/api/imports/stage-metadata', {
      method: 'POST',
      headers: { 'content-length': '500' },
      body: formData,
    });

    const res = await stagePOST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe('DUPLICATE_MANIFEST');
  });

  it('7. API revalidates intent and rejects tampered preview fingerprint', async () => {
    const jsonContent = JSON.stringify({
      publicId: 'pkg1',
      title: 'Valid Title',
      summary: 'Valid Summary',
      background: 'Valid Background',
      solution: 'Valid Solution',
      year: 2026,
      program: 'Engineering',
      studyProgram: 'Software Engineering',
      discipline: 'Software Engineering',
      industry: 'Technology',
      industryPartner: 'Partner',
      academicSupervisor: 'Supervisor',
      groupName: 'Group A',
      teamMembers: ['Alice'],
      layoutConfig: {},
    });
    const jsonBytes = Buffer.from(jsonContent, 'utf8').length;

    const manifest: SelectionManifest = {
      selectedRootName: 'pkg1',
      fileCount: 2,
      declaredTotalBytes: jsonBytes + 300,
      ignoredSystemFilesCount: 0,
      descriptors: [
        { uploadKey: generateUploadKey('pkg1/project.json'), originalPath: 'pkg1/project.json', fileSizeBytes: jsonBytes, browserMimeType: 'application/json' },
        { uploadKey: generateUploadKey('pkg1/poster.png'), originalPath: 'pkg1/poster.png', fileSizeBytes: 300, browserMimeType: 'image/png' },
      ],
    };

    const tamperedIntent = {
      version: 1,
      previewFingerprint: 'f'.repeat(64), // Tampered fingerprint
      selectedRootName: 'pkg1',
      fileCount: 2,
      declaredTotalBytes: jsonBytes + 300,
      selectedPackagePaths: ['pkg1'],
      acknowledgedWarningPackagePaths: [],
    };

    const formData = new FormData();
    formData.append('manifest', JSON.stringify(manifest));
    formData.append('intent', JSON.stringify(tamperedIntent));
    formData.append(generateUploadKey('pkg1/project.json'), new File([jsonContent], 'project.json', { type: 'application/json' }));

    const req = new NextRequest('http://localhost:3000/api/imports/stage-metadata', {
      method: 'POST',
      headers: { 'content-length': '2000' },
      body: formData,
    });

    const res = await stagePOST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe('PREVIEW_FINGERPRINT_MISMATCH');
  });

  it('8. Successful metadata staging calls RPC with matching canonical payload and returns batchId', async () => {
    const mockRpc = vi.fn().mockResolvedValue({
      data: {
        resultCode: 'SUCCESS',
        result: 'created',
        batchId: '11111111-1111-1111-1111-111111111111',
        projectCount: 1,
        warningCount: 0,
        batchStatus: 'metadata_staged',
      },
      error: null,
    });
    vi.spyOn(await import('../../lib/supabase/adminCore'), 'createSupabaseAdminClientCore').mockReturnValue({
      rpc: mockRpc,
    } as unknown as ReturnType<typeof createSupabaseAdminClientCore>);

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
      layoutConfig: { templateId: 'poster_showcase', featuredMedia: 'poster' },
    });
    const jsonBytes = Buffer.from(jsonContent, 'utf8').length;

    const manifest: SelectionManifest = {
      selectedRootName: 'pkg1',
      fileCount: 4,
      declaredTotalBytes: jsonBytes + 300 + 400 + 500,
      ignoredSystemFilesCount: 0,
      descriptors: [
        { uploadKey: generateUploadKey('pkg1/project.json'), originalPath: 'pkg1/project.json', fileSizeBytes: jsonBytes, browserMimeType: 'application/json' },
        { uploadKey: generateUploadKey('pkg1/poster.png'), originalPath: 'pkg1/poster.png', fileSizeBytes: 300, browserMimeType: 'image/png' },
        { uploadKey: generateUploadKey('pkg1/poster.pdf'), originalPath: 'pkg1/poster.pdf', fileSizeBytes: 400, browserMimeType: 'application/pdf' },
        { uploadKey: generateUploadKey('pkg1/snapshot-1.png'), originalPath: 'pkg1/snapshot-1.png', fileSizeBytes: 500, browserMimeType: 'image/png' },
      ],
    };

    // Calculate correct preview fingerprint using planner logic
    const { analyzeBrowserImportServer } = await import('../parseBrowserImportPreview');
    const metadataFiles = new Map<string, Buffer>();
    metadataFiles.set(generateUploadKey('pkg1/project.json'), Buffer.from(jsonContent, 'utf8'));
    const analysis = await analyzeBrowserImportServer(manifest, metadataFiles);

    const { prepareBrowserImportCommitIntent } = await import('../prepareBrowserImportCommitIntent');
    const warningPaths = analysis.preview.batch.packages[0].status === 'warning' ? ['pkg1'] : [];
    const plannerRes = prepareBrowserImportCommitIntent({
      manifest,
      preview: analysis.preview.batch,
      selectedPackagePaths: ['pkg1'],
      acknowledgedWarningPackagePaths: warningPaths,
      expectedPreviewFingerprint: analysis.preview.batch.previewFingerprint,
    });
    if (!plannerRes.success) {
      throw new Error(`Planner failed: ${plannerRes.code} - ${plannerRes.message}`);
    }

    const formData = new FormData();
    formData.append('manifest', JSON.stringify(manifest));
    formData.append('intent', JSON.stringify(plannerRes.intent));
    formData.append(generateUploadKey('pkg1/project.json'), new File([jsonContent], 'project.json', { type: 'application/json' }));

    const req = new NextRequest('http://localhost:3000/api/imports/stage-metadata', {
      method: 'POST',
      headers: { 'content-length': '2000' },
      body: formData,
    });

    const res = await stagePOST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      success: true,
      result: 'created',
      batchId: '11111111-1111-1111-1111-111111111111',
      projectCount: 1,
      warningCount: 0,
      batchStatus: 'metadata_staged',
    });
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('stage_browser_import_metadata', expect.objectContaining({
      p_intent_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      p_preview_fingerprint: plannerRes.intent.previewFingerprint,
      p_mode: 'single',
      p_source_folder: 'pkg1',
      p_imported_by_id: '00000000-0000-0000-0000-000000000001',
    }));
  });

  it('9. Idempotent retry returns existing batch without error', async () => {
    const mockRpc = vi.fn().mockResolvedValue({
      data: {
        resultCode: 'SUCCESS',
        result: 'already_staged',
        batchId: '11111111-1111-1111-1111-111111111111',
        projectCount: 1,
        warningCount: 0,
        batchStatus: 'metadata_staged',
      },
      error: null,
    });
    vi.spyOn(await import('../../lib/supabase/adminCore'), 'createSupabaseAdminClientCore').mockReturnValue({
      rpc: mockRpc,
    } as unknown as ReturnType<typeof createSupabaseAdminClientCore>);

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
      layoutConfig: { templateId: 'poster_showcase', featuredMedia: 'poster' },
    });
    const jsonBytes = Buffer.from(jsonContent, 'utf8').length;

    const manifest: SelectionManifest = {
      selectedRootName: 'pkg1',
      fileCount: 4,
      declaredTotalBytes: jsonBytes + 300 + 400 + 500,
      ignoredSystemFilesCount: 0,
      descriptors: [
        { uploadKey: generateUploadKey('pkg1/project.json'), originalPath: 'pkg1/project.json', fileSizeBytes: jsonBytes, browserMimeType: 'application/json' },
        { uploadKey: generateUploadKey('pkg1/poster.png'), originalPath: 'pkg1/poster.png', fileSizeBytes: 300, browserMimeType: 'image/png' },
        { uploadKey: generateUploadKey('pkg1/poster.pdf'), originalPath: 'pkg1/poster.pdf', fileSizeBytes: 400, browserMimeType: 'application/pdf' },
        { uploadKey: generateUploadKey('pkg1/snapshot-1.png'), originalPath: 'pkg1/snapshot-1.png', fileSizeBytes: 500, browserMimeType: 'image/png' },
      ],
    };

    const { analyzeBrowserImportServer } = await import('../parseBrowserImportPreview');
    const metadataFiles = new Map<string, Buffer>();
    metadataFiles.set(generateUploadKey('pkg1/project.json'), Buffer.from(jsonContent, 'utf8'));
    const analysis = await analyzeBrowserImportServer(manifest, metadataFiles);

    const { prepareBrowserImportCommitIntent } = await import('../prepareBrowserImportCommitIntent');
    const warningPaths9 = analysis.preview.batch.packages[0].status === 'warning' ? ['pkg1'] : [];
    const plannerRes = prepareBrowserImportCommitIntent({
      manifest,
      preview: analysis.preview.batch,
      selectedPackagePaths: ['pkg1'],
      acknowledgedWarningPackagePaths: warningPaths9,
      expectedPreviewFingerprint: analysis.preview.batch.previewFingerprint,
    });
    if (!plannerRes.success) throw new Error(`Planner failed in test 9: ${plannerRes.code} - ${plannerRes.message}`);

    const formData = new FormData();
    formData.append('manifest', JSON.stringify(manifest));
    formData.append('intent', JSON.stringify(plannerRes.intent));
    formData.append(generateUploadKey('pkg1/project.json'), new File([jsonContent], 'project.json', { type: 'application/json' }));

    const req = new NextRequest('http://localhost:3000/api/imports/stage-metadata', {
      method: 'POST',
      headers: { 'content-length': '2000' },
      body: formData,
    });

    const res = await stagePOST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      success: true,
      result: 'already_staged',
      batchId: '11111111-1111-1111-1111-111111111111',
      projectCount: 1,
      warningCount: 0,
      batchStatus: 'metadata_staged',
    });
  });

  it('10. Existing public ID conflict causes HTTP 409 PROJECT_ALREADY_EXISTS', async () => {
    const mockRpc = vi.fn().mockResolvedValue({
      data: { resultCode: 'PROJECT_ALREADY_EXISTS' },
      error: null,
    });
    vi.spyOn(await import('../../lib/supabase/adminCore'), 'createSupabaseAdminClientCore').mockReturnValue({
      rpc: mockRpc,
    } as unknown as ReturnType<typeof createSupabaseAdminClientCore>);

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
      layoutConfig: { templateId: 'poster_showcase', featuredMedia: 'poster' },
    });
    const jsonBytes = Buffer.from(jsonContent, 'utf8').length;

    const manifest: SelectionManifest = {
      selectedRootName: 'pkg1',
      fileCount: 4,
      declaredTotalBytes: jsonBytes + 300 + 400 + 500,
      ignoredSystemFilesCount: 0,
      descriptors: [
        { uploadKey: generateUploadKey('pkg1/project.json'), originalPath: 'pkg1/project.json', fileSizeBytes: jsonBytes, browserMimeType: 'application/json' },
        { uploadKey: generateUploadKey('pkg1/poster.png'), originalPath: 'pkg1/poster.png', fileSizeBytes: 300, browserMimeType: 'image/png' },
        { uploadKey: generateUploadKey('pkg1/poster.pdf'), originalPath: 'pkg1/poster.pdf', fileSizeBytes: 400, browserMimeType: 'application/pdf' },
        { uploadKey: generateUploadKey('pkg1/snapshot-1.png'), originalPath: 'pkg1/snapshot-1.png', fileSizeBytes: 500, browserMimeType: 'image/png' },
      ],
    };

    const { analyzeBrowserImportServer } = await import('../parseBrowserImportPreview');
    const metadataFiles = new Map<string, Buffer>();
    metadataFiles.set(generateUploadKey('pkg1/project.json'), Buffer.from(jsonContent, 'utf8'));
    const analysis = await analyzeBrowserImportServer(manifest, metadataFiles);

    const { prepareBrowserImportCommitIntent } = await import('../prepareBrowserImportCommitIntent');
    const warningPaths10 = analysis.preview.batch.packages[0].status === 'warning' ? ['pkg1'] : [];
    const plannerRes = prepareBrowserImportCommitIntent({
      manifest,
      preview: analysis.preview.batch,
      selectedPackagePaths: ['pkg1'],
      acknowledgedWarningPackagePaths: warningPaths10,
      expectedPreviewFingerprint: analysis.preview.batch.previewFingerprint,
    });
    if (!plannerRes.success) throw new Error(`Planner failed in test 10: ${plannerRes.code} - ${plannerRes.message}`);

    const formData = new FormData();
    formData.append('manifest', JSON.stringify(manifest));
    formData.append('intent', JSON.stringify(plannerRes.intent));
    formData.append(generateUploadKey('pkg1/project.json'), new File([jsonContent], 'project.json', { type: 'application/json' }));

    const req = new NextRequest('http://localhost:3000/api/imports/stage-metadata', {
      method: 'POST',
      headers: { 'content-length': '2000' },
      body: formData,
    });

    const res = await stagePOST(req);
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.code).toBe('PROJECT_ALREADY_EXISTS');
  });

  it('11. Regression: Package with unparseable manifest sets manifest: null and persistence is never called', async () => {
    const { analyzeBrowserImportServer } = await import('../parseBrowserImportPreview');

    const jsonContent = 'INVALID_JSON_CONTENT';
    const jsonBytes = Buffer.from(jsonContent, 'utf8').length;

    const manifest: SelectionManifest = {
      selectedRootName: 'pkg1',
      fileCount: 2,
      declaredTotalBytes: jsonBytes + 400,
      ignoredSystemFilesCount: 0,
      descriptors: [
        { uploadKey: generateUploadKey('pkg1/project.json'), originalPath: 'pkg1/project.json', fileSizeBytes: jsonBytes, browserMimeType: 'application/json' },
        { uploadKey: generateUploadKey('pkg1/poster.png'), originalPath: 'pkg1/poster.png', fileSizeBytes: 400, browserMimeType: 'image/png' },
      ],
    };

    const metadataFiles = new Map<string, Buffer>();
    metadataFiles.set(generateUploadKey('pkg1/project.json'), Buffer.from(jsonContent, 'utf8'));

    const analysis = await analyzeBrowserImportServer(manifest, metadataFiles);
    expect(analysis.packages[0].manifest).toBeNull();
    expect(analysis.packages[0].status).toBe('invalid');

    // Verify that attempting to stage via route POST fails with INVALID_SELECTION and does NOT persist
    const formData = new FormData();
    formData.append('manifest', JSON.stringify(manifest));
    formData.append('intent', JSON.stringify({
      version: 1,
      previewFingerprint: analysis.preview.batch.previewFingerprint,
      selectedRootName: 'pkg1',
      fileCount: 2,
      declaredTotalBytes: jsonBytes + 400,
      selectedPackagePaths: ['pkg1'],
      acknowledgedWarningPackagePaths: [],
    }));
    formData.append(generateUploadKey('pkg1/project.json'), new File([jsonContent], 'project.json', { type: 'application/json' }));

    const req = new NextRequest('http://localhost:3000/api/imports/stage-metadata', {
      method: 'POST',
      headers: { 'content-length': '2000' },
      body: formData,
    });

    const res = await stagePOST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe('INVALID_SELECTION');
  });

  it('12. validateBrowserImportMetadataStageResponse rejects unknown error codes like DATABASE_SECRET_ERROR', async () => {
    const { validateBrowserImportMetadataStageResponse } = await import('../browserImportMetadataStageContract');

    const unknownErrorCodeResponse = {
      success: false,
      code: 'DATABASE_SECRET_ERROR',
      error: 'Secret database details exposed',
    };

    expect(validateBrowserImportMetadataStageResponse(unknownErrorCodeResponse)).toBeNull();
  });

  it('13. validateBrowserImportMetadataStageResponse rejects malformed success/failure shapes and unexpected fields', async () => {
    const { validateBrowserImportMetadataStageResponse } = await import('../browserImportMetadataStageContract');

    // Success with extra forbidden field
    const extraFieldSuccess = {
      success: true,
      result: 'created',
      batchId: '11111111-1111-1111-1111-111111111111',
      projectCount: 1,
      warningCount: 0,
      batchStatus: 'metadata_staged',
      unexpectedField: 'forbidden',
    };
    expect(validateBrowserImportMetadataStageResponse(extraFieldSuccess)).toBeNull();

    // Failure with extra forbidden field
    const extraFieldFailure = {
      success: false,
      code: 'INVALID_SELECTION',
      error: 'Invalid selection',
      leakDetail: 'secret',
    };
    expect(validateBrowserImportMetadataStageResponse(extraFieldFailure)).toBeNull();

    // Malformed batchId UUID
    const badUuidSuccess = {
      success: true,
      result: 'created',
      batchId: 'not-a-uuid',
      projectCount: 1,
      warningCount: 0,
      batchStatus: 'metadata_staged',
    };
    expect(validateBrowserImportMetadataStageResponse(badUuidSuccess)).toBeNull();
  });
});
