import { NextRequest, NextResponse } from 'next/server';
import { validateSameOrigin } from '../../../../../auth/csrf';
import { requireAdmin } from '../../../../../auth/requireAdmin';
import { AdminAuthError } from '../../../../../auth/authTypes';
import { getAuthErrorHttpStatus, getPublicAuthErrorMessage } from '../../../../../auth/authHttp';
import { validateBulkReviewPreflightInput } from '../../../../../auth/bulkProjectReviewInput';
import { createSupabaseAdminClient } from '../../../../../lib/supabase/admin';
import { SupabaseBulkProjectReviewGateway } from '../../../../../projects/SupabaseBulkProjectReviewGateway';
import { BulkReviewPermissionError, BulkReviewService } from '../../../../../projects/bulkProjectReviewService';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const;

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    if (!validateSameOrigin(request.headers.get('origin'), request.nextUrl.origin)) {
      const error = getPublicAuthErrorMessage('PERMISSION_DENIED');
      return NextResponse.json({ success: false, error }, { status: 403, headers: NO_STORE_HEADERS });
    }

    const body = await request.json().catch(() => null);
    const validation = validateBulkReviewPreflightInput(body);
    if (!validation.valid) {
      return NextResponse.json({ success: false, error: 'Validation failed.' }, { status: 400, headers: NO_STORE_HEADERS });
    }

    const adminContext = await requireAdmin();
    const service = new BulkReviewService(new SupabaseBulkProjectReviewGateway(createSupabaseAdminClient()));
    const result = await service.preflight({
      ...validation.data,
      actor: { adminId: adminContext.adminUserId, permissions: adminContext.permissions },
    });
    return NextResponse.json(result, { headers: NO_STORE_HEADERS });
  } catch (error: unknown) {
    if (error instanceof AdminAuthError) {
      return NextResponse.json(
        { success: false, error: getPublicAuthErrorMessage(error.type) },
        { status: getAuthErrorHttpStatus(error.type), headers: NO_STORE_HEADERS },
      );
    }
    if (error instanceof BulkReviewPermissionError) {
      return NextResponse.json(
        { success: false, error: getPublicAuthErrorMessage('PERMISSION_DENIED') },
        { status: 403, headers: NO_STORE_HEADERS },
      );
    }
    console.error('[Bulk Review Preflight Error]: INTERNAL_FAILURE');
    return NextResponse.json(
      { success: false, error: 'The bulk review preflight could not be completed.' },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
