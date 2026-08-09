import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '../../../../auth/requireAdmin';
import { hasPermission } from '../../../../auth/permissions';
import { AdminAuthError } from '../../../../auth/authTypes';
import {
  parseBrowserImportPreview,
  BrowserImportPreviewLimitError,
} from '../../../../import/parseBrowserImportPreview';
import { SelectionManifest } from '../../../../import/browserSelection';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  // 1. Authorization Boundary
  let authContext;
  try {
    authContext = await requireAdmin();
  } catch (err: unknown) {
    if (err instanceof AdminAuthError && err.type === 'PERMISSION_DENIED') {
      return NextResponse.json(
        { error: 'Access denied.' },
        { status: 403, headers: { 'Cache-Control': 'no-store' } }
      );
    }
    return NextResponse.json(
      { error: 'Unauthenticated.' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  if (!hasPermission(authContext.permissions, 'projects.edit')) {
    return NextResponse.json(
      { error: 'Permission denied.' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  // 2. Cross-Origin Protection Boundary
  const originHeader = request.headers.get('origin');
  if (originHeader) {
    const requestOrigin = request.nextUrl.origin;
    if (originHeader.toLowerCase() !== requestOrigin.toLowerCase()) {
      return NextResponse.json(
        { error: 'Cross-origin requests are forbidden.' },
        { status: 403, headers: { 'Cache-Control': 'no-store' } }
      );
    }
  }

  // 3. Pre-parse Content-Length Limit Check (Max 25 MB)
  const contentLength = request.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > 25 * 1024 * 1024) {
    return NextResponse.json(
      { error: 'Uploaded content size exceeds maximum limit of 25 MB.', code: 'TOTAL_METADATA_SIZE_LIMIT_EXCEEDED' },
      { status: 413, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  // 4. Multipart Body Parsing
  try {
    const formData = await request.formData();
    const manifestJson = formData.get('manifest');

    if (!manifestJson || typeof manifestJson !== 'string') {
      return NextResponse.json(
        { error: 'Selection manifest is missing or invalid.', code: 'MANIFEST_INVALID' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    if (manifestJson.length > 1 * 1024 * 1024) {
      return NextResponse.json(
        { error: 'Selection manifest exceeds maximum size limit of 1 MB.', code: 'MANIFEST_SIZE_LIMIT_EXCEEDED' },
        { status: 413, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    let manifestObj: SelectionManifest;
    try {
      manifestObj = JSON.parse(manifestJson);
    } catch {
      return NextResponse.json(
        { error: 'Selection manifest is not valid JSON.', code: 'MANIFEST_INVALID' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const uploadedMetadataFiles = new Map<string, Buffer>();

    for (const [key, value] of formData.entries()) {
      if (key === 'manifest') continue;
      if (value && typeof value === 'object' && 'arrayBuffer' in value) {
        const fileObj = value as File;
        const arrayBuf = await fileObj.arrayBuffer();
        uploadedMetadataFiles.set(key, Buffer.from(arrayBuf));
      }
    }

    const previewResponse = await parseBrowserImportPreview(manifestObj, uploadedMetadataFiles);

    return NextResponse.json(previewResponse, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err: unknown) {
    if (err instanceof BrowserImportPreviewLimitError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.httpStatus, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    console.error('[Browser Import Preview Error]:', err);
    return NextResponse.json(
      { error: 'An unexpected error occurred during preview generation.' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
