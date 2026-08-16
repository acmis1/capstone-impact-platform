import { NextRequest, NextResponse } from 'next/server';
import { AdminAuthError } from '../../../../auth/authTypes';
import { validateSameOrigin } from '../../../../auth/csrf';
import { getAuthErrorHttpStatus, getPublicAuthErrorMessage } from '../../../../auth/authHttp';
import { canManageStaff } from '../../../../auth/permissions';
import { requireAdmin } from '../../../../auth/requireAdmin';
import { createSupabaseAdminClient } from '../../../../lib/supabase/admin';
import { isVerifiedStagingRuntime } from '../../../../security/stagingRuntimeIdentity';
import { isStaffProvisioningEnabled } from '../../../../staff/staffProvisioningEnablement';
import {
  SupabaseStaffPasswordIdentityGateway,
  SupabaseStaffProvisioningGateway,
} from '../../../../staff/staffProvisioningRepository';
import {
  staffTestAccountMessage,
  type StaffTestAccountResultCode,
  validateStaffTestAccountInput,
} from '../../../../staff/staffTestAccount';
import { provisionStaffTestAccount } from '../../../../staff/staffTestAccountService';

function statusFor(code: StaffTestAccountResultCode): number {
  switch (code) {
    case 'ACCOUNT_READY':
      return 201;
    case 'VALIDATION_FAILED':
      return 400;
    case 'PERMISSION_DENIED':
    case 'STAGING_ONLY':
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

/** Creates a ready-to-use, non-admin test account only on a verified staging runtime. */
export async function POST(request: NextRequest) {
  try {
    const origin = request.headers.get('origin');
    if (!validateSameOrigin(origin, request.nextUrl.origin)) {
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

    if (!isVerifiedStagingRuntime()) {
      return NextResponse.json(
        { success: false, code: 'STAGING_ONLY', message: staffTestAccountMessage('STAGING_ONLY') },
        { status: statusFor('STAGING_ONLY') },
      );
    }

    if (!isStaffProvisioningEnabled()) {
      return NextResponse.json(
        {
          success: false,
          code: 'PROVISIONING_DISABLED',
          message: staffTestAccountMessage('PROVISIONING_DISABLED'),
        },
        { status: statusFor('PROVISIONING_DISABLED') },
      );
    }

    const body = await request.json().catch(() => null);
    if (!validateStaffTestAccountInput(body).valid) {
      return NextResponse.json(
        {
          success: false,
          code: 'VALIDATION_FAILED',
          message: staffTestAccountMessage('VALIDATION_FAILED'),
        },
        { status: statusFor('VALIDATION_FAILED') },
      );
    }

    const supabaseAdmin = createSupabaseAdminClient();
    const outcome = await provisionStaffTestAccount(
      {
        permissions: adminContext.permissions,
        actorAdminUserId: adminContext.adminUserId,
        provisioningEnabled: true,
        stagingRuntimeVerified: true,
        provisioning: new SupabaseStaffProvisioningGateway(supabaseAdmin),
        identities: new SupabaseStaffPasswordIdentityGateway(supabaseAdmin),
      },
      body,
    );

    if (outcome.code !== 'ACCOUNT_READY') {
      console.error(`[Staff Test Account API]: ${outcome.code}`);
    }

    return NextResponse.json(
      { success: outcome.code === 'ACCOUNT_READY', code: outcome.code, message: outcome.message },
      { status: statusFor(outcome.code) },
    );
  } catch (error: unknown) {
    if (error instanceof AdminAuthError) {
      return NextResponse.json(
        { success: false, code: error.type, error: getPublicAuthErrorMessage(error.type) },
        { status: getAuthErrorHttpStatus(error.type) },
      );
    }

    console.error('[Staff Test Account API]: INTERNAL_FAILURE');
    return NextResponse.json(
      {
        success: false,
        code: 'PROVISIONING_FAILED',
        message: staffTestAccountMessage('PROVISIONING_FAILED'),
      },
      { status: 500 },
    );
  }
}
