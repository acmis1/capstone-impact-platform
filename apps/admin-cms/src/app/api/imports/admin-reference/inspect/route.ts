import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '../../../../../auth/requireAdmin';
import { hasPermission } from '../../../../../auth/permissions';
import { AdminAuthError, AuthenticatedAdminContext } from '../../../../../auth/authTypes';
import { getAuthErrorHttpStatus } from '../../../../../auth/authHttp';
import { validateSameOrigin } from '../../../../../auth/csrf';
import {
  inspectAdminReferenceWorkbook,
  ADMIN_REFERENCE_LIMITS,
} from '../../../../../import/adminReferenceReconciliation';
import { parseContentLength } from '../../preview/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const INSPECT_ERROR_MESSAGES = {
  UNAUTHENTICATED: 'Authentication required.',
  PERMISSION_DENIED: 'Access denied.',
  AUTH_SERVICE_UNAVAILABLE: 'Authentication service is temporarily unavailable. Please try again.',
  CROSS_ORIGIN_REJECTED: 'The request was not accepted.',
  MISSING_CONTENT_LENGTH: 'The inspection request was invalid.',
  INVALID_CONTENT_LENGTH: 'The inspection request was invalid.',
  REQUEST_TOO_LARGE: 'The inspection request was too large.',
  MISSING_REFERENCE_FILE: 'The reference workbook file is missing.',
  DUPLICATE_REFERENCE_FILE: 'Duplicate reference workbook file is forbidden.',
  INVALID_FILE_TYPE: 'The reference workbook must be a valid .xlsx file.',
  INVALID_WORKBOOK: 'The reference workbook is empty or malformed.',
  UNEXPECTED_UPLOAD_FIELD: 'Unexpected upload form field.',
  UNEXPECTED_INTERNAL_ERROR: 'The inspection request could not be completed. Please try again.',
} as const;

type InspectErrorCode = keyof typeof INSPECT_ERROR_MESSAGES;

function inspectError(code: InspectErrorCode, status: number): NextResponse {
  return NextResponse.json(
    { success: false, code, error: INSPECT_ERROR_MESSAGES[code] },
    { status, headers: { 'Cache-Control': 'no-store' } }
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Step 1: Same-origin CSRF check
  if (!validateSameOrigin(request.headers.get('origin'), request.nextUrl.origin)) {
    return inspectError('CROSS_ORIGIN_REJECTED', 403);
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
      return inspectError(code, getAuthErrorHttpStatus(err.type));
    }
    process.stdout.write('[Admin Reference Inspect API] unexpected_internal_error\n');
    return inspectError('UNEXPECTED_INTERNAL_ERROR', 500);
  }

  if (!hasPermission(authContext.permissions, 'projects.edit')) {
    return inspectError('PERMISSION_DENIED', 403);
  }

  // Step 3: Content-Length Enforcement
  const contentLength = parseContentLength(request.headers.get('content-length'));
  if ('code' in contentLength) {
    return inspectError(
      contentLength.code,
      contentLength.code === 'REQUEST_TOO_LARGE' ? 413 : 400
    );
  }

  try {
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return inspectError('INVALID_WORKBOOK', 400);
    }

    const fileEntries = formData.getAll('referenceFile');
    if (fileEntries.length === 0) {
      return inspectError('MISSING_REFERENCE_FILE', 400);
    }
    if (fileEntries.length > 1) {
      return inspectError('DUPLICATE_REFERENCE_FILE', 400);
    }

    // Reject any extra form fields
    for (const [key] of formData.entries()) {
      if (key !== 'referenceFile') {
        return inspectError('UNEXPECTED_UPLOAD_FIELD', 400);
      }
    }

    const fileEntry = fileEntries[0];
    if (!(fileEntry instanceof File)) {
      return inspectError('INVALID_FILE_TYPE', 400);
    }

    const file = fileEntry as File;
    const lowerName = file.name.toLowerCase();

    if (!lowerName.endsWith('.xlsx')) {
      return inspectError('INVALID_FILE_TYPE', 400);
    }

    if (file.size === 0) {
      return inspectError('INVALID_WORKBOOK', 400);
    }

    if (file.size > ADMIN_REFERENCE_LIMITS.MAX_WORKBOOK_BYTES) {
      return inspectError('REQUEST_TOO_LARGE', 413);
    }

    let arrayBuf: ArrayBuffer;
    const fileObj = file as unknown as { arrayBuffer?: () => Promise<ArrayBuffer>; buffer?: ArrayBuffer };
    if (typeof fileObj.arrayBuffer === 'function') {
      arrayBuf = await fileObj.arrayBuffer();
    } else {
      arrayBuf = fileObj.buffer || (file as unknown as ArrayBuffer);
    }

    const buffer = Buffer.from(arrayBuf);
    if (buffer.length !== file.size) {
      return inspectError('INVALID_WORKBOOK', 400);
    }

    let inspection;
    try {
      inspection = await inspectAdminReferenceWorkbook(buffer);
    } catch {
      return inspectError('INVALID_WORKBOOK', 400);
    }

    return NextResponse.json(inspection, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    process.stdout.write('[Admin Reference Inspect API] unexpected_internal_error\n');
    return inspectError('UNEXPECTED_INTERNAL_ERROR', 500);
  }
}
