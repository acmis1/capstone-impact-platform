import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '../../../../auth/requireAdmin';
import { AdminAuthError } from '../../../../auth/authTypes';
import { hasPermission } from '../../../../auth/permissions';
import { getAuthErrorHttpStatus, getPublicAuthErrorMessage } from '../../../../auth/authHttp';
import { createSupabaseAdminClient } from '../../../../lib/supabase/admin';
import { SupabaseDeletedProjectMaintenanceGateway } from '../../../../recovery/SupabaseDeletedProjectMaintenanceGateway';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const;

function errorResponse(error: unknown): NextResponse {
  if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: getPublicAuthErrorMessage(error.type) }, { status: getAuthErrorHttpStatus(error.type), headers: NO_STORE_HEADERS });
  console.error('[Deleted projects API]: INTERNAL_FAILURE');
  return NextResponse.json({ success: false, error: 'Deleted projects could not be loaded.' }, { status: 500, headers: NO_STORE_HEADERS });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const admin = await requireAdmin();
    if (!hasPermission(admin.permissions, 'projects.delete') || !admin.roles.includes('admin')) {
      return NextResponse.json({ success: false, error: getPublicAuthErrorMessage('PERMISSION_DENIED') }, { status: 403, headers: NO_STORE_HEADERS });
    }
    const params = request.nextUrl.searchParams;
    const rawPage = params.get('page') ?? '1';
    const rawPageSize = params.get('pageSize') ?? '20';
    const page = /^\d{1,6}$/u.test(rawPage) ? Number(rawPage) : 0;
    const pageSize = rawPageSize === '50' ? 50 : rawPageSize === '20' ? 20 : 0;
    const search = params.get('search')?.trim() ?? '';
    if (!Number.isSafeInteger(page) || page < 1 || !pageSize || search.length > 100 || /[\u0000-\u001f\u007f]/u.test(search)) {
      return NextResponse.json({ success: false, error: 'Validation failed.' }, { status: 400, headers: NO_STORE_HEADERS });
    }
    const result = await new SupabaseDeletedProjectMaintenanceGateway(createSupabaseAdminClient()).list({
      adminId: admin.adminUserId, page, pageSize: pageSize as 20 | 50, ...(search ? { search } : {}),
    });
    return NextResponse.json({ success: true, ...result }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return errorResponse(error);
  }
}
