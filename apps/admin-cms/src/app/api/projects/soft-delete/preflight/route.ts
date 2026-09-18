import { NextRequest, NextResponse } from 'next/server';
import { validateSameOrigin } from '../../../../../auth/csrf';
import { requireAdmin } from '../../../../../auth/requireAdmin';
import { AdminAuthError } from '../../../../../auth/authTypes';
import { getAuthErrorHttpStatus, getPublicAuthErrorMessage } from '../../../../../auth/authHttp';
import { validateSoftDeletePreflightInput } from '../../../../../auth/projectSoftDeleteInput';
import { createSupabaseAdminClient } from '../../../../../lib/supabase/admin';
import { SupabaseProjectSoftDeleteGateway } from '../../../../../projects/SupabaseProjectSoftDeleteGateway';
import { softDeleteRequestSizeRejection } from '../../../../../projects/projectSoftDelete';
import {
  ProjectSoftDeletePermissionError,
  ProjectSoftDeleteService,
} from '../../../../../projects/projectSoftDeleteService';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const;

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    if (!validateSameOrigin(request.headers.get('origin'), request.nextUrl.origin)) {
      return NextResponse.json(
        { success: false, error: getPublicAuthErrorMessage('PERMISSION_DENIED') },
        { status: 403, headers: NO_STORE_HEADERS },
      );
    }
    if (softDeleteRequestSizeRejection(request.headers.get('content-length')) !== null) {
      return NextResponse.json(
        { success: false, error: 'Validation failed.' },
        { status: 413, headers: NO_STORE_HEADERS },
      );
    }

    const body = await request.json().catch(() => null);
    const validation = validateSoftDeletePreflightInput(body);
    if (!validation.valid) {
      return NextResponse.json(
        { success: false, error: 'Validation failed.' },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }

    const adminContext = await requireAdmin();
    const service = new ProjectSoftDeleteService(
      new SupabaseProjectSoftDeleteGateway(createSupabaseAdminClient()),
    );
    const result = await service.preflight({
      publicIds: validation.data.publicIds,
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
    if (error instanceof ProjectSoftDeletePermissionError) {
      return NextResponse.json(
        { success: false, error: getPublicAuthErrorMessage('PERMISSION_DENIED') },
        { status: 403, headers: NO_STORE_HEADERS },
      );
    }
    console.error('[Project Soft Delete Preflight Error]: INTERNAL_FAILURE');
    return NextResponse.json(
      { success: false, error: 'Project deletion eligibility could not be checked.' },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
