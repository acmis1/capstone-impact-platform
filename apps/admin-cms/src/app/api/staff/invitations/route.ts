import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '../../../../auth/requireAdmin';
import { canManageStaff } from '../../../../auth/permissions';
import { validateSameOrigin } from '../../../../auth/csrf';
import { AdminAuthError } from '../../../../auth/authTypes';
import { getAuthErrorHttpStatus, getPublicAuthErrorMessage } from '../../../../auth/authHttp';
import { createSupabaseAdminClient } from '../../../../lib/supabase/admin';
import { provisionStaffMember } from '../../../../staff/staffProvisioningService';
import {
  SupabaseStaffInvitationGateway,
  SupabaseStaffProvisioningGateway,
} from '../../../../staff/staffProvisioningRepository';
import { isStaffProvisioningEnabled } from '../../../../staff/staffProvisioningEnablement';
import {
  type StaffProvisioningResultCode,
  staffProvisioningMessage,
} from '../../../../staff/staffProvisioning';

function statusFor(code: StaffProvisioningResultCode): number {
  switch (code) {
    case 'INVITATION_PENDING':
      return 202;
    case 'VALIDATION_FAILED':
      return 400;
    case 'PERMISSION_DENIED':
      return 403;
    case 'IN_PROGRESS':
    case 'ALREADY_INVITED':
    case 'ALREADY_PROVISIONED':
      return 409;
    case 'PROVISIONING_DISABLED':
      return 503;
    default:
      return 500;
  }
}

/**
 * Creates a controlled staff provisioning invitation.
 *
 * Rules:
 * - Validates exact same-origin before anything else, reusing the centralized CSRF helper.
 * - Authenticates and authorizes independently of the browser; hiding the UI control is never
 *   the enforcement boundary.
 * - Takes ONLY the target name, email and roles from the request body. The acting administrator,
 *   their Auth identity, their authority, the target Auth identity, the provisioning status and
 *   all audit attribution are derived from the authenticated server session and the database.
 * - Returns bounded domain codes only: no raw Supabase errors, SQL, stack traces, Auth user IDs,
 *   tokens or invitation URLs.
 */
export async function POST(request: NextRequest) {
  try {
    // 1. Same-Origin CSRF Check
    const origin = request.headers.get('origin');
    if (!validateSameOrigin(origin, request.nextUrl.origin)) {
      return NextResponse.json(
        { success: false, code: 'CROSS_ORIGIN_REJECTED', error: 'The request was not accepted.' },
        { status: 403 },
      );
    }

    // 2. Authenticate the acting staff member
    const adminContext = await requireAdmin();

    // 3. Authorize the dedicated staff-management capability
    if (!canManageStaff(adminContext.permissions)) {
      const status = getAuthErrorHttpStatus('PERMISSION_DENIED');
      return NextResponse.json(
        { success: false, code: 'PERMISSION_DENIED', error: getPublicAuthErrorMessage('PERMISSION_DENIED') },
        { status },
      );
    }

    const body = await request.json().catch(() => null);
    const supabaseAdmin = createSupabaseAdminClient();

    const outcome = await provisionStaffMember(
      {
        permissions: adminContext.permissions,
        actorAdminUserId: adminContext.adminUserId,
        provisioningEnabled: isStaffProvisioningEnabled(),
        provisioning: new SupabaseStaffProvisioningGateway(supabaseAdmin),
        invitations: new SupabaseStaffInvitationGateway(supabaseAdmin),
      },
      body,
    );

    if (outcome.code !== 'INVITATION_PENDING') {
      console.error(`[Staff Provisioning API]: ${outcome.code}`);
    }

    return NextResponse.json(
      {
        success: outcome.code === 'INVITATION_PENDING',
        code: outcome.code,
        message: outcome.message,
        invitation: outcome.invitation ?? null,
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

    console.error('[Staff Provisioning API]: INTERNAL_FAILURE');
    return NextResponse.json(
      {
        success: false,
        code: 'PROVISIONING_FAILED',
        error: staffProvisioningMessage('PROVISIONING_FAILED'),
      },
      { status: 500 },
    );
  }
}
