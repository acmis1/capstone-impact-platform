import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '../../../../auth/requireAdmin';
import { hasPermission } from '../../../../auth/permissions';
import { AdminAuthError, AuthenticatedAdminContext } from '../../../../auth/authTypes';
import { getAuthErrorHttpStatus, getPublicAuthErrorMessage } from '../../../../auth/authHttp';
import {
  parseBrowserImportPreview,
  BrowserImportPreviewLimitError,
} from '../../../../import/parseBrowserImportPreview';
import {
  BROWSER_IMPORT_LIMITS,
  selectionManifestSchema,
  SelectionManifest,
} from '../../../../import/browserImportPreviewContract';
import {
  generateUploadKey,
  normalizeRelativePath,
} from '../../../../import/browserSelection';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Step 12: Correct Authentication & Authorization
  let authContext: AuthenticatedAdminContext;
  try {
    authContext = await requireAdmin();
  } catch (err: unknown) {
    const errorType = err instanceof AdminAuthError ? err.type : 'CONFIGURATION_FAILURE';
    const status = getAuthErrorHttpStatus(errorType);
    const message = getPublicAuthErrorMessage(errorType);
    return NextResponse.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } });
  }

  if (!hasPermission(authContext.permissions, 'projects.edit')) {
    return NextResponse.json(
      { error: 'Access denied: Requires "projects.edit" permission.' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  // Same-origin CSRF check
  const originHeader = request.headers.get('origin');
  if (originHeader) {
    try {
      const originUrl = new URL(originHeader);
      if (originUrl.origin !== request.nextUrl.origin) {
        return NextResponse.json(
          { error: 'Cross-origin requests are forbidden.' },
          { status: 403, headers: { 'Cache-Control': 'no-store' } }
        );
      }
    } catch {
      return NextResponse.json(
        { error: 'Invalid origin header.' },
        { status: 403, headers: { 'Cache-Control': 'no-store' } }
      );
    }
  }

  // Step 9: Request Content-Length & Body Bound Validation
  const contentLengthStr = request.headers.get('content-length');
  if (contentLengthStr) {
    const contentLength = parseInt(contentLengthStr, 10);
    if (isNaN(contentLength) || contentLength < 0) {
      return NextResponse.json(
        { error: 'Invalid Content-Length header.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }
    if (contentLength > BROWSER_IMPORT_LIMITS.MAX_MULTIPART_REQUEST_BYTES) {
      return NextResponse.json(
        { error: `Request size (${contentLength} bytes) exceeds maximum limit of 27 MB.` },
        { status: 413, headers: { 'Cache-Control': 'no-store' } }
      );
    }
  }

  try {
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return NextResponse.json(
        { error: 'Request body must be valid multipart/form-data.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    // Step 9 Phase A: Inspect Form Fields without reading file bytes
    const manifestEntries = formData.getAll('manifest');
    if (manifestEntries.length === 0) {
      return NextResponse.json(
        { error: 'Missing required "manifest" field in form data.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }
    if (manifestEntries.length > 1) {
      return NextResponse.json(
        { error: 'Duplicate "manifest" field in form data is forbidden.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const rawManifestValue = manifestEntries[0];
    if (typeof rawManifestValue !== 'string') {
      return NextResponse.json(
        { error: '"manifest" field must be a JSON string.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    if (rawManifestValue.length > BROWSER_IMPORT_LIMITS.MAX_MANIFEST_SIZE_BYTES) {
      return NextResponse.json(
        { error: 'Manifest JSON string size exceeds maximum limit of 1 MB.' },
        { status: 413, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    let parsedManifestJson: unknown;
    try {
      parsedManifestJson = JSON.parse(rawManifestValue);
    } catch {
      return NextResponse.json(
        { error: 'Manifest string is not valid JSON.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const zodResult = selectionManifestSchema.safeParse(parsedManifestJson);
    if (!zodResult.success) {
      return NextResponse.json(
        { error: 'Selection manifest is invalid or malformed.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const manifestData: SelectionManifest = zodResult.data as SelectionManifest;

    // Identify expected metadata upload keys from manifest descriptors
    const expectedMetadataKeys = new Map<string, { desc: typeof manifestData.descriptors[0]; isXlsx: boolean }>();
    for (const desc of manifestData.descriptors) {
      const norm = normalizeRelativePath(desc.originalPath);
      if (!norm) continue;
      const lowerName = norm.split('/').pop()?.toLowerCase() || '';

      if (lowerName === 'project-details.xlsx' || lowerName === 'project.json') {
        const key = generateUploadKey(norm);
        expectedMetadataKeys.set(key, { desc, isXlsx: lowerName === 'project-details.xlsx' });
      }
    }

    const seenFormKeys = new Set<string>();
    const pendingFileReads: Array<{ key: string; file: File; expectedBytes: number }> = [];

    // Phase A Validation of FormData entries
    for (const [key, value] of formData.entries()) {
      if (key === 'manifest') continue;

      if (seenFormKeys.has(key)) {
        return NextResponse.json(
          { error: `Duplicate form field key "${key}" is forbidden.` },
          { status: 400, headers: { 'Cache-Control': 'no-store' } }
        );
      }
      seenFormKeys.add(key);

      // Reject uploaded media binaries or unexpected keys
      if (!expectedMetadataKeys.has(key)) {
        return NextResponse.json(
          { error: `Form field "${key}" is not a recognized or expected metadata file upload.` },
          { status: 400, headers: { 'Cache-Control': 'no-store' } }
        );
      }

      if (!(value instanceof File)) {
        return NextResponse.json(
          { error: `Form field "${key}" must be a binary file upload.` },
          { status: 400, headers: { 'Cache-Control': 'no-store' } }
        );
      }

      const metaInfo = expectedMetadataKeys.get(key)!;
      const file = value as File;

      if (file.size === 0) {
        return NextResponse.json(
          { error: `Uploaded file "${key}" is empty (0 bytes).` },
          { status: 400, headers: { 'Cache-Control': 'no-store' } }
        );
      }

      if (file.size !== metaInfo.desc.fileSizeBytes) {
        return NextResponse.json(
          { error: `Actual uploaded file size for "${key}" (${file.size} bytes) does not match declared descriptor size (${metaInfo.desc.fileSizeBytes} bytes).` },
          { status: 400, headers: { 'Cache-Control': 'no-store' } }
        );
      }

      // Check size limits strictly based on descriptor source, not key text
      if (metaInfo.isXlsx && file.size > BROWSER_IMPORT_LIMITS.MAX_XLSX_SIZE_BYTES) {
        return NextResponse.json(
          { error: `Uploaded XLSX file "${key}" exceeds maximum limit of 5 MB.` },
          { status: 413, headers: { 'Cache-Control': 'no-store' } }
        );
      }

      if (!metaInfo.isXlsx && file.size > BROWSER_IMPORT_LIMITS.MAX_JSON_SIZE_BYTES) {
        return NextResponse.json(
          { error: `Uploaded JSON file "${key}" exceeds maximum limit of 1 MB.` },
          { status: 413, headers: { 'Cache-Control': 'no-store' } }
        );
      }

      pendingFileReads.push({ key, file, expectedBytes: file.size });
    }

    // Ensure all expected metadata files were uploaded
    for (const [expectedKey] of expectedMetadataKeys.entries()) {
      if (!seenFormKeys.has(expectedKey)) {
        return NextResponse.json(
          { error: `Missing expected metadata file upload for key "${expectedKey}".` },
          { status: 400, headers: { 'Cache-Control': 'no-store' } }
        );
      }
    }

    // Phase B: Read file bytes after all Phase A checks pass
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
          { error: `Read byte length for "${key}" did not match file size.` },
          { status: 400, headers: { 'Cache-Control': 'no-store' } }
        );
      }
      uploadedMetadataFiles.set(key, buf);
    }

    // Call server-side preview parser
    const result = await parseBrowserImportPreview(parsedManifestJson, uploadedMetadataFiles);

    return NextResponse.json(result, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err: unknown) {
    if (err instanceof BrowserImportPreviewLimitError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.httpStatus, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    // Step 10: Safe internal logging without exposing raw exceptions, stack traces, or participant names
    const errName = err instanceof Error ? err.name : 'UnknownError';
    process.stdout.write(`[Browser Import Preview API] Internal error caught: ${errName}\n`);

    return NextResponse.json(
      { error: 'The preview request could not be completed.' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
