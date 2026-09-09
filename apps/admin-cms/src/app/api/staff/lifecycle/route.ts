import { NextRequest, NextResponse } from 'next/server';
import { AdminAuthError } from '../../../../auth/authTypes';
import { validateSameOrigin } from '../../../../auth/csrf';
import { getAuthErrorHttpStatus, getPublicAuthErrorMessage } from '../../../../auth/authHttp';
import { canManageStaff } from '../../../../auth/permissions';
import { requireAdmin } from '../../../../auth/requireAdmin';
import { createSupabaseAdminClient } from '../../../../lib/supabase/admin';
import type { StaffLifecycleResultCode } from '../../../../staff/staffLifecycle';
import {
  SupabaseStaffAccessProviderGateway,
  SupabaseStaffLifecycleDatabaseGateway,
} from '../../../../staff/staffLifecycleRepository';
import { manageStaffLifecycle } from '../../../../staff/staffLifecycleService';

function statusFor(code: StaffLifecycleResultCode): number {
  switch (code) {
    case 'UPDATED':
    case 'NO_CHANGE':
    case 'ALREADY_ACTIVE':
    case 'ALREADY_DEACTIVATED':
    case 'PROVIDER_SYNCHRONIZED':
    case 'ALREADY_SYNCHRONIZED':
      return 200;
    case 'UPDATED_PROVIDER_PENDING':
    case 'UPDATED_PROVIDER_ATTENTION':
    case 'PROVIDER_PENDING':
      return 202;
    case 'VALIDATION_FAILED':
      return 400;
    case 'PERMISSION_DENIED':
      return 403;
    case 'TARGET_NOT_FOUND':
      return 404;
    case 'PROVIDER_ATTENTION':
      return 502;
    case 'IN_PROGRESS':
    case 'SELF_MODIFICATION_DENIED':
    case 'LAST_ADMIN_PROTECTED':
    case 'STALE_VERSION':
    case 'INVALID_STATE':
    case 'PROVIDER_RECONCILIATION_REQUIRED':
    case 'NOTHING_TO_RECONCILE':
      return 409;
    case 'LIFECYCLE_FAILED':
    default:
      return 500;
  }
}

const ACCEPTED_CODES = new Set<StaffLifecycleResultCode>([
  'UPDATED',
  'NO_CHANGE',
  'ALREADY_ACTIVE',
  'ALREADY_DEACTIVATED',
  'PROVIDER_SYNCHRONIZED',
  'ALREADY_SYNCHRONIZED',
  'UPDATED_PROVIDER_PENDING',
  'UPDATED_PROVIDER_ATTENTION',
]);

/** Same-origin, independently authenticated staff lifecycle mutation boundary. */
export async function POST(request: NextRequest) {
  try {
    if (!validateSameOrigin(request.headers.get('origin'), request.nextUrl.origin)) {
      return NextResponse.json(
        { success: false, code: 'CROSS_ORIGIN_REJECTED', error: 'The request was not accepted.' },
        { status: 403 },
      );
    }

    const adminContext = await requireAdmin();
    if (!canManageStaff(adminContext.permissions)) {
      return NextResponse.json(
        {
          success: false,
          code: 'PERMISSION_DENIED',
          error: getPublicAuthErrorMessage('PERMISSION_DENIED'),
        },
        { status: getAuthErrorHttpStatus('PERMISSION_DENIED') },
      );
    }

    const body = await request.json().catch(() => null);
    const supabaseAdmin = createSupabaseAdminClient();
    const outcome = await manageStaffLifecycle(
      {
        permissions: adminContext.permissions,
        actorAdminUserId: adminContext.adminUserId,
        database: new SupabaseStaffLifecycleDatabaseGateway(supabaseAdmin),
        provider: new SupabaseStaffAccessProviderGateway(supabaseAdmin),
      },
      body,
    );

    if (!ACCEPTED_CODES.has(outcome.code)) {
      console.error(`[Staff Lifecycle API]: ${outcome.code}`);
    }
    return NextResponse.json(
      {
        success: ACCEPTED_CODES.has(outcome.code),
        code: outcome.code,
        message: outcome.message,
        staff: outcome.staff,
      },
      { status: statusFor(outcome.code) },
    );
  } catch (error: unknown) {
    if (error instanceof AdminAuthError) {
      return NextResponse.json(
        { success: false, code: error.type, error: getPublicAuthErrorMessage(error.type) },
        { status: getAuthErrorHttpStatus(error.type) },
      );
    }

    console.error('[Staff Lifecycle API]: INTERNAL_FAILURE');
    return NextResponse.json(
      {
        success: false,
        code: 'LIFECYCLE_FAILED',
        message: 'Staff access could not be updated. Refresh before trying again.',
        staff: null,
      },
      { status: 500 },
    );
  }
}
