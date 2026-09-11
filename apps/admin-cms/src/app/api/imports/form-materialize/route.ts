import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '../../../../auth/requireAdmin';
import { hasPermission } from '../../../../auth/permissions';
import { AdminAuthError, AuthenticatedAdminContext } from '../../../../auth/authTypes';
import { getAuthErrorHttpStatus } from '../../../../auth/authHttp';
import { validateSameOrigin } from '../../../../auth/csrf';
import { BROWSER_IMPORT_LIMITS } from '../../../../import/browserImportPreviewContract';
import { formIntakeMetadataSchema } from '../../../../import/formIntakeContract';
import { materializeFormIntakeWorkbook } from '../../../../import/formIntakeWorkbookMaterializer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseContentLength(
  header: string | null
): { code: 'MISSING_CONTENT_LENGTH' | 'INVALID_CONTENT_LENGTH' | 'REQUEST_TOO_LARGE' } | { bytes: number } {
  if (header === null || header === '') return { code: 'MISSING_CONTENT_LENGTH' };
  if (!/^(0|[1-9][0-9]*)$/.test(header)) return { code: 'INVALID_CONTENT_LENGTH' };
  const bytes = Number(header);
  if (!Number.isSafeInteger(bytes)) return { code: 'INVALID_CONTENT_LENGTH' };
  if (bytes > BROWSER_IMPORT_LIMITS.MAX_MULTIPART_REQUEST_BYTES) return { code: 'REQUEST_TOO_LARGE' };
  return { bytes };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1. Same-origin CSRF check
  if (!validateSameOrigin(request.headers.get('origin'), request.nextUrl.origin)) {
    return NextResponse.json(
      { success: false, code: 'CROSS_ORIGIN_REJECTED', error: 'Cross-origin requests are forbidden.' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  // 2. Authentication check
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
      return NextResponse.json(
        { success: false, code, error: 'Authentication failed.' },
        { status: getAuthErrorHttpStatus(err.type), headers: { 'Cache-Control': 'no-store' } }
      );
    }
    return NextResponse.json(
      { success: false, code: 'UNEXPECTED_INTERNAL_ERROR', error: 'An internal error occurred.' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  // 3. Permission check
  if (!hasPermission(authContext.permissions, 'projects.edit')) {
    return NextResponse.json(
      { success: false, code: 'PERMISSION_DENIED', error: 'Permission denied.' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  // 4. Strict Content-Length Enforcement
  const contentLength = parseContentLength(request.headers.get('content-length'));
  if ('code' in contentLength) {
    return NextResponse.json(
      { success: false, code: contentLength.code, error: 'Invalid content length.' },
      { status: contentLength.code === 'REQUEST_TOO_LARGE' ? 413 : 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  // 5. Parse and validate JSON payload
  let rawJson: unknown;
  try {
    rawJson = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, code: 'INVALID_JSON', error: 'Request body must be valid JSON.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const parsed = formIntakeMetadataSchema.safeParse(rawJson);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, code: 'VALIDATION_ERROR', error: 'Invalid form intake metadata.', details: parsed.error.issues },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  // 6. Materialize canonical workbook
  try {
    const buffer = await materializeFormIntakeWorkbook(parsed.data);
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="project-details.xlsx"',
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    return NextResponse.json(
      { success: false, code: 'MATERIALIZATION_FAILED', error: 'Failed to materialize workbook.' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
