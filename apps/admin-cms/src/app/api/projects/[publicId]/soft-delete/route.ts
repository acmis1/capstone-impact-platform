import { NextRequest, NextResponse } from 'next/server';
import { validateSameOrigin } from '../../../../../auth/csrf';
import { requireAdmin } from '../../../../../auth/requireAdmin';
import { AdminAuthError } from '../../../../../auth/authTypes';
import { getAuthErrorHttpStatus, getPublicAuthErrorMessage } from '../../../../../auth/authHttp';
import { validateSoftDeleteExecutionInput } from '../../../../../auth/projectSoftDeleteInput';
import { createSupabaseAdminClient } from '../../../../../lib/supabase/admin';
import { SupabaseProjectSoftDeleteGateway } from '../../../../../projects/SupabaseProjectSoftDeleteGateway';
import { softDeleteRequestSizeRejection } from '../../../../../projects/projectSoftDelete';
import {
  ProjectSoftDeletePermissionError,
  ProjectSoftDeleteService,
} from '../../../../../projects/projectSoftDeleteService';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const;

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ publicId: string }> },
) {
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

    const { publicId } = await params;
    const body = await request.json().catch(() => null);
    const validation = validateSoftDeleteExecutionInput(body, publicId);
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
    const result = await service.execute({
      ...validation.data,
      actor: { adminId: adminContext.adminUserId, permissions: adminContext.permissions },
    });

    if (result.resultCode === 'DELETED' || result.resultCode === 'ALREADY_DELETED') {
      return NextResponse.json({ success: true, result }, { headers: NO_STORE_HEADERS });
    }
    if (result.resultCode === 'PROJECT_NOT_FOUND') {
      return NextResponse.json(
        { success: false, code: result.resultCode, error: 'Project not found.' },
        { status: 404, headers: NO_STORE_HEADERS },
      );
    }
    return NextResponse.json(
      {
        success: false,
        code: result.resultCode,
        error: result.reason || (
          result.resultCode === 'STALE_VERSION'
            ? 'The project changed after eligibility was checked.'
            : 'The project is not eligible for soft delete.'
        ),
      },
      { status: 409, headers: NO_STORE_HEADERS },
    );
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
    console.error('[Project Soft Delete Execution Error]: INTERNAL_FAILURE');
    return NextResponse.json(
      { success: false, error: 'Project deletion could not be completed.' },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
