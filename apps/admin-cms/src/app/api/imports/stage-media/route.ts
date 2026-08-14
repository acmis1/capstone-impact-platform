import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '../../../../auth/requireAdmin';
import { hasPermission } from '../../../../auth/permissions';
import { AdminAuthError, AuthenticatedAdminContext } from '../../../../auth/authTypes';
import { getAuthErrorHttpStatus } from '../../../../auth/authHttp';
import { validateSameOrigin } from '../../../../auth/csrf';
import {
  BROWSER_IMPORT_LIMITS,
  runBrowserImportManifestPreflight,
} from '../../../../import/browserImportPreviewContract';
import {
  browserImportCommitIntentSchema,
} from '../../../../import/browserImportCommitIntentContract';
import {
  analyzeBrowserImportServer,
  BrowserImportPreviewLimitError,
} from '../../../../import/parseBrowserImportPreview';
import { prepareBrowserImportCommitIntent } from '../../../../import/prepareBrowserImportCommitIntent';
import { computeCanonicalIntentHash } from '../../../../import/browserImportMetadataStageContract';
import { resolveExpectedBrowserImportMedia } from '../../../../import/browserImportMediaSelection';
import { stageBrowserImportMedia, MediaFileToStage } from '../../../../import/stageBrowserImportMedia';
import {
  BROWSER_IMPORT_MEDIA_LIMITS,
  BrowserImportMediaStageErrorCode,
} from '../../../../import/browserImportMediaStageContract';
import { detectMediaSignature, validateMediaAssetBytes } from '../../../../storage/mediaValidation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STAGE_ERROR_MESSAGES: Record<BrowserImportMediaStageErrorCode, string> = {
  UNAUTHENTICATED: 'Authentication required.',
  PERMISSION_DENIED: 'Access denied.',
  AUTH_SERVICE_UNAVAILABLE: 'Authentication service is temporarily unavailable. Please try again.',
  CROSS_ORIGIN_REJECTED: 'The request was not accepted.',
  MISSING_CONTENT_LENGTH: 'The request was invalid.',
  INVALID_CONTENT_LENGTH: 'The request was invalid.',
  REQUEST_TOO_LARGE: 'The request was too large.',
  MISSING_BATCH_ID: 'The request was missing a required batch identifier.',
  DUPLICATE_BATCH_ID: 'The request batch identifier was duplicated.',
  INVALID_BATCH_ID: 'The request batch identifier was invalid.',
  INVALID_MANIFEST: 'The request manifest was invalid.',
  INVALID_INTENT: 'The request intent was invalid.',
  DUPLICATE_MANIFEST: 'The request manifest was duplicated.',
  DUPLICATE_INTENT: 'The request intent was duplicated.',
  UNEXPECTED_UPLOAD_FIELD: 'The upload form field was unexpected.',
  DUPLICATE_UPLOAD_FIELD: 'The upload form field was duplicated.',
  MISSING_METADATA_UPLOAD: 'Missing expected metadata file upload.',
  METADATA_SIZE_MISMATCH: 'Uploaded metadata size did not match declared size.',
  MISSING_MEDIA_UPLOAD: 'Missing an expected media file upload.',
  MEDIA_SIZE_MISMATCH: 'Uploaded media file size did not match the expected size.',
  MEDIA_SIGNATURE_MISMATCH: 'Uploaded media file content did not match its expected type.',
  MEDIA_UNSUPPORTED_TYPE: 'Uploaded media file type is not supported.',
  PREVIEW_FINGERPRINT_MISMATCH: 'Preview state has changed or fingerprint does not match.',
  INVALID_SELECTION: 'Selected packages are invalid or not allowed.',
  BATCH_NOT_FOUND: 'The import batch could not be found.',
  BATCH_INTENT_MISMATCH: 'The import batch could not be verified for this request.',
  INVALID_BATCH_STATE: 'The import batch is not in a state that allows media staging.',
  BATCH_ALREADY_COMPLETED_MISMATCH: 'The import batch was already completed with a different media selection.',
  STORAGE_UPLOAD_FAILED: 'A media file could not be uploaded. Please try again.',
  STORAGE_CONFLICT: 'A media storage conflict was detected. Please try again.',
  PERSISTENCE_FAILED: 'The media staging operation could not be saved.',
  UNEXPECTED_INTERNAL_ERROR: 'The request could not be completed. Please try again.',
};

const STATUS_BY_CODE: Partial<Record<BrowserImportMediaStageErrorCode, number>> = {
  BATCH_NOT_FOUND: 404,
  BATCH_INTENT_MISMATCH: 409,
  INVALID_BATCH_STATE: 409,
  BATCH_ALREADY_COMPLETED_MISMATCH: 409,
  STORAGE_UPLOAD_FAILED: 502,
  STORAGE_CONFLICT: 409,
  PERSISTENCE_FAILED: 500,
  UNEXPECTED_INTERNAL_ERROR: 500,
};

function stageError(code: BrowserImportMediaStageErrorCode, status?: number): NextResponse {
  return NextResponse.json(
    { success: false, code, error: STAGE_ERROR_MESSAGES[code] },
    { status: status ?? STATUS_BY_CODE[code] ?? 400, headers: { 'Cache-Control': 'no-store' } }
  );
}

function parseContentLength(
  header: string | null
): { code: 'MISSING_CONTENT_LENGTH' | 'INVALID_CONTENT_LENGTH' | 'REQUEST_TOO_LARGE' } | { bytes: number } {
  if (header === null || header === '') return { code: 'MISSING_CONTENT_LENGTH' };
  if (!/^(0|[1-9][0-9]*)$/.test(header)) return { code: 'INVALID_CONTENT_LENGTH' };
  const bytes = Number(header);
  if (!Number.isSafeInteger(bytes)) return { code: 'INVALID_CONTENT_LENGTH' };
  if (bytes > BROWSER_IMPORT_MEDIA_LIMITS.MAX_MEDIA_MULTIPART_REQUEST_BYTES) return { code: 'REQUEST_TOO_LARGE' };
  return { bytes };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Step 1: Same-origin CSRF check
  if (!validateSameOrigin(request.headers.get('origin'), request.nextUrl.origin)) {
    return stageError('CROSS_ORIGIN_REJECTED', 403);
  }

  // Step 2: Auth check
  let authContext: AuthenticatedAdminContext;
  try {
    authContext = await requireAdmin();
  } catch (err: unknown) {
    if (err instanceof AdminAuthError) {
      const code =
        err.type === 'UNAUTHENTICATED'
          ? 'UNAUTHENTICATED'
          : err.type === 'CONFIGURATION_FAILURE'
            ? 'AUTH_SERVICE_UNAVAILABLE'
            : 'PERMISSION_DENIED';
      return stageError(code, getAuthErrorHttpStatus(err.type));
    }
    process.stdout.write('[Browser Import Media Stage API] unexpected_internal_error\n');
    return stageError('UNEXPECTED_INTERNAL_ERROR', 500);
  }

  if (!hasPermission(authContext.permissions, 'projects.edit')) {
    return stageError('PERMISSION_DENIED', 403);
  }

  // Step 3: Strict Content-Length enforcement
  const contentLength = parseContentLength(request.headers.get('content-length'));
  if ('code' in contentLength) {
    return stageError(contentLength.code, contentLength.code === 'REQUEST_TOO_LARGE' ? 413 : 400);
  }

  try {
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return stageError('INVALID_MANIFEST', 400);
    }

    // Step 4: Validate batchId field
    const batchIdEntries = formData.getAll('batchId');
    if (batchIdEntries.length === 0) return stageError('MISSING_BATCH_ID', 400);
    if (batchIdEntries.length > 1) return stageError('DUPLICATE_BATCH_ID', 400);
    const rawBatchId = batchIdEntries[0];
    if (typeof rawBatchId !== 'string' || !UUID_REGEX.test(rawBatchId)) {
      return stageError('INVALID_BATCH_ID', 400);
    }
    const batchId = rawBatchId;

    // Step 5: Validate manifest field
    const manifestEntries = formData.getAll('manifest');
    if (manifestEntries.length === 0) return stageError('INVALID_MANIFEST', 400);
    if (manifestEntries.length > 1) return stageError('DUPLICATE_MANIFEST', 400);

    const rawManifestValue = manifestEntries[0];
    if (typeof rawManifestValue !== 'string' || rawManifestValue.length > BROWSER_IMPORT_LIMITS.MAX_MANIFEST_SIZE_BYTES) {
      return stageError('INVALID_MANIFEST', 400);
    }

    let parsedManifestJson: unknown;
    try {
      parsedManifestJson = JSON.parse(rawManifestValue);
    } catch {
      return stageError('INVALID_MANIFEST', 400);
    }

    const preflight = runBrowserImportManifestPreflight(parsedManifestJson);
    if (!preflight.success) {
      return stageError('INVALID_MANIFEST', 400);
    }

    // Step 6: Validate intent field
    const intentEntries = formData.getAll('intent');
    if (intentEntries.length === 0) return stageError('INVALID_INTENT', 400);
    if (intentEntries.length > 1) return stageError('DUPLICATE_INTENT', 400);

    const rawIntentValue = intentEntries[0];
    if (typeof rawIntentValue !== 'string' || rawIntentValue.length > BROWSER_IMPORT_LIMITS.MAX_MANIFEST_SIZE_BYTES) {
      return stageError('INVALID_INTENT', 400);
    }

    let parsedIntentJson: unknown;
    try {
      parsedIntentJson = JSON.parse(rawIntentValue);
    } catch {
      return stageError('INVALID_INTENT', 400);
    }

    const intentValidation = browserImportCommitIntentSchema.safeParse(parsedIntentJson);
    if (!intentValidation.success) {
      return stageError('INVALID_INTENT', 400);
    }
    const submittedIntent = intentValidation.data;

    // Step 7: Structural validation of ALL non-reserved upload fields (duplicate rejection)
    const seenFormKeys = new Set<string>();
    const metadataFileEntries: Array<{ key: string; file: File; expectedBytes: number }> = [];
    const candidateMediaEntries: Array<{ key: string; file: File }> = [];
    let actualMetadataBytes = 0;

    for (const [key, value] of formData.entries()) {
      if (key === 'manifest' || key === 'intent' || key === 'batchId') continue;

      if (seenFormKeys.has(key)) return stageError('DUPLICATE_UPLOAD_FIELD', 400);
      seenFormKeys.add(key);

      if (!(value instanceof File)) return stageError('UNEXPECTED_UPLOAD_FIELD', 400);
      const file = value as File;

      if (preflight.expectedMetadataKeys.has(key)) {
        const metaInfo = preflight.expectedMetadataKeys.get(key)!;

        if (file.size === 0 || file.size !== metaInfo.desc.fileSizeBytes) {
          return stageError('METADATA_SIZE_MISMATCH', 400);
        }
        if (file.size > (metaInfo.isXlsx ? BROWSER_IMPORT_LIMITS.MAX_XLSX_SIZE_BYTES : BROWSER_IMPORT_LIMITS.MAX_JSON_SIZE_BYTES)) {
          return stageError('REQUEST_TOO_LARGE', 413);
        }

        actualMetadataBytes += file.size;
        if (
          actualMetadataBytes > BROWSER_IMPORT_LIMITS.MAX_TOTAL_METADATA_BYTES ||
          metadataFileEntries.length + 1 > BROWSER_IMPORT_LIMITS.MAX_METADATA_FILES
        ) {
          return stageError('REQUEST_TOO_LARGE', 413);
        }

        metadataFileEntries.push({ key, file, expectedBytes: file.size });
      } else {
        if (candidateMediaEntries.length + 1 > BROWSER_IMPORT_MEDIA_LIMITS.MAX_MEDIA_FILES) {
          return stageError('REQUEST_TOO_LARGE', 413);
        }
        candidateMediaEntries.push({ key, file });
      }
    }

    for (const expectedKey of preflight.expectedMetadataKeys.keys()) {
      if (!seenFormKeys.has(expectedKey)) return stageError('MISSING_METADATA_UPLOAD', 400);
    }

    // Step 8: Read metadata bytes only after structural checks pass
    const uploadedMetadataFiles = new Map<string, Buffer>();
    for (const { key, file, expectedBytes } of metadataFileEntries) {
      const arrayBuf = await file.arrayBuffer();
      const buf = Buffer.from(arrayBuf);
      if (buf.length !== expectedBytes) return stageError('METADATA_SIZE_MISMATCH', 400);
      uploadedMetadataFiles.set(key, buf);
    }

    // Step 9: Re-run authoritative server parsing and preview generation
    const serverAnalysis = await analyzeBrowserImportServer(preflight, uploadedMetadataFiles);

    // Step 10: Re-run server-side commit intent planning to get canonical server intent
    const serverPlannerResult = prepareBrowserImportCommitIntent({
      manifest: preflight.manifest,
      preview: serverAnalysis.preview.batch,
      selectedPackagePaths: submittedIntent.selectedPackagePaths,
      acknowledgedWarningPackagePaths: submittedIntent.acknowledgedWarningPackagePaths,
      expectedPreviewFingerprint: submittedIntent.previewFingerprint,
    });

    if (!serverPlannerResult.success) {
      const mapPlannerError = (code: string): BrowserImportMediaStageErrorCode => {
        if (code === 'PREVIEW_FINGERPRINT_MISMATCH') return 'PREVIEW_FINGERPRINT_MISMATCH';
        if (code === 'INVALID_MANIFEST') return 'INVALID_MANIFEST';
        return 'INVALID_SELECTION';
      };
      return stageError(mapPlannerError(serverPlannerResult.code), 400);
    }

    const canonicalServerIntent = serverPlannerResult.intent;

    // Strict equality check between submitted intent and canonical server intent
    if (JSON.stringify(submittedIntent) !== JSON.stringify(canonicalServerIntent)) {
      return stageError('PREVIEW_FINGERPRINT_MISMATCH', 400);
    }

    const metadataIntentHash = computeCanonicalIntentHash(canonicalServerIntent);

    // Step 11: Derive the authoritative expected media file set for the selected packages
    const expectedMediaResult = resolveExpectedBrowserImportMedia({
      preflight,
      packages: serverAnalysis.packages,
      selectedPackagePaths: canonicalServerIntent.selectedPackagePaths,
    });

    if (!expectedMediaResult.success) {
      return stageError('INVALID_SELECTION', 400);
    }

    const expectedFiles = expectedMediaResult.files;
    if (expectedFiles.length === 0) {
      return stageError('INVALID_SELECTION', 400);
    }

    const expectedByKey = new Map(expectedFiles.map((f) => [f.uploadKey, f]));

    // Step 12: Validate candidate media entries strictly against the expected set
    const candidateByKey = new Map(candidateMediaEntries.map((c) => [c.key, c.file]));

    for (const key of candidateByKey.keys()) {
      if (!expectedByKey.has(key)) return stageError('UNEXPECTED_UPLOAD_FIELD', 400);
    }

    for (const expected of expectedFiles) {
      if (!candidateByKey.has(expected.uploadKey)) return stageError('MISSING_MEDIA_UPLOAD', 400);
    }

    let totalMediaBytes = 0;
    const pendingMediaReads: Array<{ file: File; expected: (typeof expectedFiles)[number] }> = [];

    for (const expected of expectedFiles) {
      const file = candidateByKey.get(expected.uploadKey)!;

      if (file.size !== expected.fileSizeBytes) return stageError('MEDIA_SIZE_MISMATCH', 400);

      const maxAllowed =
        expected.assetType === 'poster_pdf' ? BROWSER_IMPORT_LIMITS.MAX_PDF_SIZE_BYTES : BROWSER_IMPORT_LIMITS.MAX_IMAGE_SIZE_BYTES;
      if (file.size > maxAllowed) return stageError('REQUEST_TOO_LARGE', 413);

      totalMediaBytes += file.size;
      if (totalMediaBytes > BROWSER_IMPORT_MEDIA_LIMITS.MAX_MEDIA_MULTIPART_REQUEST_BYTES) {
        return stageError('REQUEST_TOO_LARGE', 413);
      }

      pendingMediaReads.push({ file, expected });
    }

    // Step 13: Read actual media bytes and validate exact length + real file signature
    const filesToStage: MediaFileToStage[] = [];
    for (const { file, expected } of pendingMediaReads) {
      const arrayBuf = await file.arrayBuffer();
      const buf = Buffer.from(arrayBuf);

      if (buf.length !== expected.fileSizeBytes) return stageError('MEDIA_SIZE_MISMATCH', 400);

      const detected = detectMediaSignature(buf);
      if (!detected) return stageError('MEDIA_UNSUPPORTED_TYPE', 400);

      const bytesValidation = validateMediaAssetBytes({
        fileName: expected.fileName,
        content: buf,
        expectedMimeType: expected.canonicalMimeType,
        expectedFileSizeBytes: expected.fileSizeBytes,
      });
      if (!bytesValidation.valid) {
        return stageError('MEDIA_SIGNATURE_MISMATCH', 400);
      }

      filesToStage.push({
        packagePath: expected.packagePath,
        projectPublicId: expected.projectPublicId,
        assetType: expected.assetType,
        fileName: expected.fileName,
        fileSizeBytes: expected.fileSizeBytes,
        canonicalMimeType: expected.canonicalMimeType,
        // Taken from the server-reparsed package, never from the multipart request. The browser has
        // no field through which it could supply or override this value.
        snapshotAltText: expected.snapshotAltText,
        content: buf,
      });
    }

    // Step 14: Upload + atomic database finalization
    const stageResult = await stageBrowserImportMedia({
      authContext,
      batchId,
      metadataIntentHash,
      files: filesToStage,
    });

    if (!stageResult.success) {
      return stageError(stageResult.code);
    }

    return NextResponse.json(stageResult, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err: unknown) {
    if (err instanceof BrowserImportPreviewLimitError) {
      return stageError('INVALID_MANIFEST', 400);
    }

    process.stdout.write('[Browser Import Media Stage API] unexpected_internal_error\n');
    return stageError('UNEXPECTED_INTERNAL_ERROR', 500);
  }
}
