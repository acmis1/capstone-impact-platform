import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '../../../../auth/requireAdmin';
import { hasPermission } from '../../../../auth/permissions';
import { AdminAuthError, AuthenticatedAdminContext } from '../../../../auth/authTypes';
import { getAuthErrorHttpStatus } from '../../../../auth/authHttp';
import {
  parseBrowserImportPreview,
  BrowserImportPreviewLimitError,
} from '../../../../import/parseBrowserImportPreview';
import {
  BROWSER_IMPORT_LIMITS,
  runBrowserImportManifestPreflight,
} from '../../../../import/browserImportPreviewContract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ERROR_MESSAGES: Record<string, string> = {
  UNAUTHENTICATED: 'Authentication required.',
  PERMISSION_DENIED: 'Access denied.',
  CROSS_ORIGIN_REJECTED: 'The preview request was not accepted.',
  MISSING_CONTENT_LENGTH: 'The preview request was invalid.',
  INVALID_CONTENT_LENGTH: 'The preview request was invalid.',
  REQUEST_TOO_LARGE: 'The preview request was too large.',
  INVALID_MANIFEST: 'The preview request was invalid.',
  DUPLICATE_MANIFEST: 'The preview request was invalid.',
  UNEXPECTED_UPLOAD_FIELD: 'The preview request was invalid.',
  DUPLICATE_UPLOAD_FIELD: 'The preview request was invalid.',
  MISSING_METADATA_UPLOAD: 'The preview request was invalid.',
  METADATA_SIZE_MISMATCH: 'The preview request was invalid.',
  METADATA_LIMIT_EXCEEDED: 'The preview request was too large.',
  UNEXPECTED_INTERNAL_ERROR: 'The preview request could not be completed. Please try again.',
};

function previewError(code: keyof typeof ERROR_MESSAGES, status: number): NextResponse {
  return NextResponse.json(
    { success: false, code, error: ERROR_MESSAGES[code] },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}

export function parseContentLength(header: string | null): { code: 'MISSING_CONTENT_LENGTH' | 'INVALID_CONTENT_LENGTH' | 'REQUEST_TOO_LARGE' } | { bytes: number } {
  if (header === null || header === '') return { code: 'MISSING_CONTENT_LENGTH' };
  if (!/^(0|[1-9][0-9]*)$/.test(header)) return { code: 'INVALID_CONTENT_LENGTH' };
  const bytes = Number(header);
  if (!Number.isSafeInteger(bytes)) return { code: 'INVALID_CONTENT_LENGTH' };
  if (bytes > BROWSER_IMPORT_LIMITS.MAX_MULTIPART_REQUEST_BYTES) return { code: 'REQUEST_TOO_LARGE' };
  return { bytes };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Step 1: Authentication & Authorization
  let authContext: AuthenticatedAdminContext;
  try {
    authContext = await requireAdmin();
  } catch (err: unknown) {
    if (err instanceof AdminAuthError) {
      const code = err.type === 'PERMISSION_DENIED' || err.type === 'ADMIN_NOT_PROVISIONED'
        ? 'PERMISSION_DENIED'
        : 'UNAUTHENTICATED';
      return previewError(code, getAuthErrorHttpStatus(err.type));
    }
    process.stdout.write('[Browser Import Preview API] unexpected_internal_error\n');
    return previewError('UNEXPECTED_INTERNAL_ERROR', 500);
  }

  if (!hasPermission(authContext.permissions, 'projects.edit')) {
    return previewError('PERMISSION_DENIED', 403);
  }

  // Step 2: Same-origin CSRF check
  const originHeader = request.headers.get('origin');
  if (originHeader) {
    try {
      const originUrl = new URL(originHeader);
      if (originUrl.origin !== request.nextUrl.origin) {
        return previewError('CROSS_ORIGIN_REJECTED', 403);
      }
    } catch {
      return previewError('CROSS_ORIGIN_REJECTED', 403);
    }
  }

  // Step 3: Strict Content-Length Enforcement (must satisfy /^(0|[1-9][0-9]*)$/)
  const contentLength = parseContentLength(request.headers.get('content-length'));
  if ('code' in contentLength) return previewError(contentLength.code, contentLength.code === 'REQUEST_TOO_LARGE' ? 413 : 400);

  try {
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return NextResponse.json(
        { success: false, code: 'INVALID_MANIFEST', error: 'Request body must be valid multipart/form-data.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    // Step 4: Phase A Inspection - Manifest validation & preflight check
    const manifestEntries = formData.getAll('manifest');
    if (manifestEntries.length === 0) {
      return NextResponse.json(
        { success: false, code: 'INVALID_MANIFEST', error: 'Missing required manifest field.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }
    if (manifestEntries.length > 1) {
      return NextResponse.json(
        { success: false, code: 'DUPLICATE_MANIFEST', error: 'Duplicate manifest field is forbidden.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const rawManifestValue = manifestEntries[0];
    if (typeof rawManifestValue !== 'string') {
      return NextResponse.json(
        { success: false, code: 'INVALID_MANIFEST', error: 'Manifest field must be a JSON string.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    if (rawManifestValue.length > BROWSER_IMPORT_LIMITS.MAX_MANIFEST_SIZE_BYTES) {
      return NextResponse.json(
        { success: false, code: 'REQUEST_TOO_LARGE', error: 'Manifest JSON string size exceeds limit.' },
        { status: 413, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    let parsedManifestJson: unknown;
    try {
      parsedManifestJson = JSON.parse(rawManifestValue);
    } catch {
      return NextResponse.json(
        { success: false, code: 'INVALID_MANIFEST', error: 'Manifest string is not valid JSON.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const preflight = runBrowserImportManifestPreflight(parsedManifestJson);
    if (!preflight.success) {
      return NextResponse.json(
        { success: false, code: preflight.code, error: preflight.code === 'METADATA_LIMIT_EXCEEDED' ? ERROR_MESSAGES.METADATA_LIMIT_EXCEEDED : ERROR_MESSAGES.INVALID_MANIFEST },
        { status: preflight.httpStatus, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const seenFormKeys = new Set<string>();
    const pendingFileReads: Array<{ key: string; file: File; expectedBytes: number }> = [];
    let actualMetadataBytes = 0;

    // Phase A Validation of FormData entries against preflight expected metadata keys
    for (const [key, value] of formData.entries()) {
      if (key === 'manifest') continue;

      if (seenFormKeys.has(key)) {
        return NextResponse.json(
          { success: false, code: 'DUPLICATE_UPLOAD_FIELD', error: 'Duplicate upload field in form data is forbidden.' },
          { status: 400, headers: { 'Cache-Control': 'no-store' } }
        );
      }
      seenFormKeys.add(key);

      if (!preflight.expectedMetadataKeys.has(key)) {
        return NextResponse.json(
          { success: false, code: 'UNEXPECTED_UPLOAD_FIELD', error: 'Form field is not an expected metadata file upload.' },
          { status: 400, headers: { 'Cache-Control': 'no-store' } }
        );
      }

      if (!(value instanceof File)) {
        return NextResponse.json(
          { success: false, code: 'UNEXPECTED_UPLOAD_FIELD', error: 'Form field must be a file upload.' },
          { status: 400, headers: { 'Cache-Control': 'no-store' } }
        );
      }

      const metaInfo = preflight.expectedMetadataKeys.get(key)!;
      const file = value as File;

      if (file.size === 0) {
        return NextResponse.json(
          { success: false, code: 'METADATA_SIZE_MISMATCH', error: 'Uploaded metadata file is empty.' },
          { status: 400, headers: { 'Cache-Control': 'no-store' } }
        );
      }

      if (file.size !== metaInfo.desc.fileSizeBytes) {
        return NextResponse.json(
          { success: false, code: 'METADATA_SIZE_MISMATCH', error: 'Uploaded file size does not match declared descriptor size.' },
          { status: 400, headers: { 'Cache-Control': 'no-store' } }
        );
      }

      if (file.size > (metaInfo.isXlsx ? BROWSER_IMPORT_LIMITS.MAX_XLSX_SIZE_BYTES : BROWSER_IMPORT_LIMITS.MAX_JSON_SIZE_BYTES)) {
        return previewError('METADATA_LIMIT_EXCEEDED', 413);
      }
      actualMetadataBytes += file.size;
      if (actualMetadataBytes > BROWSER_IMPORT_LIMITS.MAX_TOTAL_METADATA_BYTES || pendingFileReads.length + 1 > BROWSER_IMPORT_LIMITS.MAX_METADATA_FILES) {
        return previewError('METADATA_LIMIT_EXCEEDED', 413);
      }

      pendingFileReads.push({ key, file, expectedBytes: file.size });
    }

    // Ensure all expected metadata files were uploaded
    for (const expectedKey of preflight.expectedMetadataKeys.keys()) {
      if (!seenFormKeys.has(expectedKey)) {
        return NextResponse.json(
          { success: false, code: 'MISSING_METADATA_UPLOAD', error: 'Missing expected metadata file upload.' },
          { status: 400, headers: { 'Cache-Control': 'no-store' } }
        );
      }
    }

    // Phase B: Read file bytes ONLY after all Phase A checks pass
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
      if (buf.length !== expectedBytes) {
        return NextResponse.json(
          { success: false, code: 'METADATA_SIZE_MISMATCH', error: 'Read byte length did not match file size.' },
          { status: 400, headers: { 'Cache-Control': 'no-store' } }
        );
      }
      uploadedMetadataFiles.set(key, buf);
    }

    // Call server-side preview parser passing preflight result and metadata buffers
    const result = await parseBrowserImportPreview(preflight, uploadedMetadataFiles);

    return NextResponse.json(result, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err: unknown) {
    if (err instanceof BrowserImportPreviewLimitError) {
      return NextResponse.json(
        { success: false, code: err.code, error: 'Request validation failed.' },
        { status: err.httpStatus, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    // Controlled internal logging (never log raw input, stack traces, or participant names)
    process.stdout.write('[Browser Import Preview API] unexpected_internal_error\n');

    return NextResponse.json(
      { success: false, code: 'UNEXPECTED_INTERNAL_ERROR', error: 'The preview request could not be completed.' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
