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
import { stageBrowserImportMetadata } from '../../../../import/stageBrowserImportMetadata';
import { BrowserImportMetadataStageErrorCode } from '../../../../import/browserImportMetadataStageContract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STAGE_ERROR_MESSAGES: Record<BrowserImportMetadataStageErrorCode, string> = {
  UNAUTHENTICATED: 'Authentication required.',
  PERMISSION_DENIED: 'Access denied.',
  AUTH_SERVICE_UNAVAILABLE: 'Authentication service is temporarily unavailable. Please try again.',
  CROSS_ORIGIN_REJECTED: 'The request was not accepted.',
  MISSING_CONTENT_LENGTH: 'The request was invalid.',
  INVALID_CONTENT_LENGTH: 'The request was invalid.',
  REQUEST_TOO_LARGE: 'The request was too large.',
  INVALID_MANIFEST: 'The request manifest was invalid.',
  INVALID_INTENT: 'The request intent was invalid.',
  DUPLICATE_MANIFEST: 'The request manifest was duplicated.',
  DUPLICATE_INTENT: 'The request intent was duplicated.',
  UNEXPECTED_UPLOAD_FIELD: 'The upload form field was unexpected.',
  DUPLICATE_UPLOAD_FIELD: 'The upload form field was duplicated.',
  MISSING_METADATA_UPLOAD: 'Missing expected metadata file upload.',
  METADATA_SIZE_MISMATCH: 'Uploaded metadata size did not match declared size.',
  PREVIEW_FINGERPRINT_MISMATCH: 'Preview state has changed or fingerprint does not match.',
  INVALID_SELECTION: 'Selected packages are invalid or not allowed.',
  LOOKUP_NOT_FOUND: 'Required program, discipline, or category lookup was not found.',
  PROJECT_ALREADY_EXISTS: 'One or more selected project public IDs already exist.',
  PERSISTENCE_FAILED: 'The metadata staging operation could not be saved.',
  UNEXPECTED_INTERNAL_ERROR: 'The request could not be completed. Please try again.',
};

function stageError(code: BrowserImportMetadataStageErrorCode, status: number): NextResponse {
  return NextResponse.json(
    { success: false, code, error: STAGE_ERROR_MESSAGES[code] },
    { status, headers: { 'Cache-Control': 'no-store' } }
  );
}

function parseContentLength(header: string | null): { code: 'MISSING_CONTENT_LENGTH' | 'INVALID_CONTENT_LENGTH' | 'REQUEST_TOO_LARGE' } | { bytes: number } {
  if (header === null || header === '') return { code: 'MISSING_CONTENT_LENGTH' };
  if (!/^(0|[1-9][0-9]*)$/.test(header)) return { code: 'INVALID_CONTENT_LENGTH' };
  const bytes = Number(header);
  if (!Number.isSafeInteger(bytes)) return { code: 'INVALID_CONTENT_LENGTH' };
  if (bytes > BROWSER_IMPORT_LIMITS.MAX_MULTIPART_REQUEST_BYTES) return { code: 'REQUEST_TOO_LARGE' };
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
      const code = err.type === 'UNAUTHENTICATED'
        ? 'UNAUTHENTICATED'
        : err.type === 'CONFIGURATION_FAILURE'
          ? 'AUTH_SERVICE_UNAVAILABLE'
          : 'PERMISSION_DENIED';
      return stageError(code, getAuthErrorHttpStatus(err.type));
    }
    process.stdout.write('[Browser Import Metadata Stage API] unexpected_internal_error\n');
    return stageError('UNEXPECTED_INTERNAL_ERROR', 500);
  }

  if (!hasPermission(authContext.permissions, 'projects.edit')) {
    return stageError('PERMISSION_DENIED', 403);
  }

  // Step 3: Strict Content-Length Enforcement
  const contentLength = parseContentLength(request.headers.get('content-length'));
  if ('code' in contentLength) return stageError(contentLength.code, contentLength.code === 'REQUEST_TOO_LARGE' ? 413 : 400);

  try {
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return stageError('INVALID_MANIFEST', 400);
    }

    // Step 4: Validate manifest field
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
      return stageError('INVALID_MANIFEST', preflight.httpStatus);
    }

    // Step 5: Validate intent field
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

    // Step 6: Validate multipart file uploads against preflight expected metadata keys
    const seenFormKeys = new Set<string>();
    const pendingFileReads: Array<{ key: string; file: File; expectedBytes: number }> = [];
    let actualMetadataBytes = 0;

    for (const [key, value] of formData.entries()) {
      if (key === 'manifest' || key === 'intent') continue;

      if (seenFormKeys.has(key)) return stageError('DUPLICATE_UPLOAD_FIELD', 400);
      seenFormKeys.add(key);

      if (!preflight.expectedMetadataKeys.has(key)) return stageError('UNEXPECTED_UPLOAD_FIELD', 400);
      if (!(value instanceof File)) return stageError('UNEXPECTED_UPLOAD_FIELD', 400);

      const metaInfo = preflight.expectedMetadataKeys.get(key)!;
      const file = value as File;

      if (file.size === 0 || file.size !== metaInfo.desc.fileSizeBytes) {
        return stageError('METADATA_SIZE_MISMATCH', 400);
      }

      if (file.size > (metaInfo.isXlsx ? BROWSER_IMPORT_LIMITS.MAX_XLSX_SIZE_BYTES : BROWSER_IMPORT_LIMITS.MAX_JSON_SIZE_BYTES)) {
        return stageError('REQUEST_TOO_LARGE', 413);
      }

      actualMetadataBytes += file.size;
      if (actualMetadataBytes > BROWSER_IMPORT_LIMITS.MAX_TOTAL_METADATA_BYTES || pendingFileReads.length + 1 > BROWSER_IMPORT_LIMITS.MAX_METADATA_FILES) {
        return stageError('REQUEST_TOO_LARGE', 413);
      }

      pendingFileReads.push({ key, file, expectedBytes: file.size });
    }

    for (const expectedKey of preflight.expectedMetadataKeys.keys()) {
      if (!seenFormKeys.has(expectedKey)) return stageError('MISSING_METADATA_UPLOAD', 400);
    }

    // Step 7: Read file bytes ONLY after all structural checks pass
    const uploadedMetadataFiles = new Map<string, Buffer>();
    for (const { key, file, expectedBytes } of pendingFileReads) {
      let arrayBuf: ArrayBuffer;
      const fileObj = file as unknown as { arrayBuffer?: () => Promise<ArrayBuffer>; buffer?: ArrayBuffer };
      if (typeof fileObj.arrayBuffer === 'function') {
        arrayBuf = await fileObj.arrayBuffer();
      } else {
        arrayBuf = fileObj.buffer || (file as unknown as ArrayBuffer);
      }
      const buf = Buffer.from(arrayBuf);
      if (buf.length !== expectedBytes) return stageError('METADATA_SIZE_MISMATCH', 400);
      uploadedMetadataFiles.set(key, buf);
    }

    // Step 8: Re-run authoritative server parsing and preview generation
    const serverAnalysis = await analyzeBrowserImportServer(preflight, uploadedMetadataFiles);

    // Step 9: Re-run server-side commit intent planning to get canonical server intent
    const serverPlannerResult = prepareBrowserImportCommitIntent({
      manifest: preflight.manifest,
      preview: serverAnalysis.preview.batch,
      selectedPackagePaths: submittedIntent.selectedPackagePaths,
      acknowledgedWarningPackagePaths: submittedIntent.acknowledgedWarningPackagePaths,
      expectedPreviewFingerprint: submittedIntent.previewFingerprint,
    });

    if (!serverPlannerResult.success) {
      const mapPlannerError = (code: string): BrowserImportMetadataStageErrorCode => {
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

    // Step 10: Call atomic persistence service
    const stageResult = await stageBrowserImportMetadata({
      authContext,
      serverAnalysis,
      intent: canonicalServerIntent,
    });

    if (!stageResult.success) {
      const httpStatus = stageResult.code === 'PROJECT_ALREADY_EXISTS' ? 409 : 400;
      return stageError(stageResult.code, httpStatus);
    }

    return NextResponse.json(stageResult, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err: unknown) {
    if (err instanceof BrowserImportPreviewLimitError) {
      return stageError('INVALID_MANIFEST', err.httpStatus);
    }

    process.stdout.write('[Browser Import Metadata Stage API] unexpected_internal_error\n');
    return stageError('UNEXPECTED_INTERNAL_ERROR', 500);
  }
}
