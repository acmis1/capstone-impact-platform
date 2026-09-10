import { NextRequest, NextResponse } from 'next/server';
import { validateSameOrigin } from '../../../../../auth/csrf';
import { AdminAuthError } from '../../../../../auth/authTypes';
import { getAuthErrorHttpStatus, getPublicAuthErrorMessage } from '../../../../../auth/authHttp';
import { requireAdmin } from '../../../../../auth/requireAdmin';
import { canPreparePublication } from '../../../../../auth/permissions';
import { getServerEnv } from '../../../../../lib/env';
import { createSupabaseAdminClient } from '../../../../../lib/supabase/admin';
import { createPublicFeedHistoryDependencies } from '../../../../../projects/createPublicFeedHistoryDependencies';
import { isPublicFeedRollbackEnvironmentAvailable } from '../../../../../projects/publicFeedRollbackPolicy';
import { transitionPublicFeedRollbackCapability } from '../../../../../projects/publicFeedHistoryService';

const NO_STORE = { 'Cache-Control': 'no-store' };
const SHA256 = /^[0-9a-f]{64}$/;

interface CapabilityInput {
  enabled?: unknown;
  expectedVersionNumber?: unknown;
  expectedGeneration?: unknown;
  expectedFeedHash?: unknown;
  expectedRecordCount?: unknown;
  confirmation?: unknown;
}

function validPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function validNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export async function POST(request: NextRequest) {
  try {
    if (!validateSameOrigin(request.headers.get('origin'), request.nextUrl.origin)) {
      return NextResponse.json(
        { success: false, error: 'Access denied.' },
        { status: 403, headers: NO_STORE },
      );
    }

    const admin = await requireAdmin();
    if (!canPreparePublication(admin.permissions)) {
      return NextResponse.json(
        { success: false, error: 'Access denied.' },
        { status: 403, headers: NO_STORE },
      );
    }

    const input = await request.json().catch(() => null) as CapabilityInput | null;
    if (!input || typeof input.enabled !== 'boolean'
        || !validPositiveInteger(input.expectedVersionNumber)
        || !validPositiveInteger(input.expectedGeneration)
        || typeof input.expectedFeedHash !== 'string' || !SHA256.test(input.expectedFeedHash)
        || !validNonnegativeInteger(input.expectedRecordCount)
        || typeof input.confirmation !== 'string' || input.confirmation.length > 256) {
      return NextResponse.json(
        { success: false, error: 'Validation failed.' },
        { status: 400, headers: NO_STORE },
      );
    }

    const env = getServerEnv();
    if (!isPublicFeedRollbackEnvironmentAvailable(env.supabaseUrl, process.env)) {
      return NextResponse.json(
        {
          success: false,
          code: 'ROLLBACK_UNAVAILABLE',
          error: 'Public feed rollback capability is unavailable.',
        },
        { status: 404, headers: NO_STORE },
      );
    }

    const result = await transitionPublicFeedRollbackCapability(
      createPublicFeedHistoryDependencies({
        supabase: createSupabaseAdminClient(),
        supabaseUrl: env.supabaseUrl,
        adminId: admin.adminUserId,
        permissions: admin.permissions,
        feedBucket: env.SUPABASE_PUBLIC_FEEDS_BUCKET,
        feedPath: env.SUPABASE_PUBLIC_FEED_FILE,
        environment: process.env,
      }),
      input.enabled,
      {
        versionNumber: input.expectedVersionNumber,
        generation: input.expectedGeneration,
        feedHash: input.expectedFeedHash,
        recordCount: input.expectedRecordCount,
      },
      input.confirmation,
    );

    if (result.resultCode === 'CAPABILITY_UPDATED' || result.resultCode === 'NO_CHANGE') {
      return NextResponse.json({ success: true, result }, { headers: NO_STORE });
    }
    const status = result.resultCode === 'PERMISSION_DENIED' ? 403
      : result.resultCode === 'ROLLBACK_UNAVAILABLE' ? 404
        : result.resultCode === 'EXECUTION_FAILED' ? 500 : 409;
    return NextResponse.json(
      {
        success: false,
        code: result.resultCode,
        error: 'Public feed rollback capability could not be changed.',
      },
      { status, headers: NO_STORE },
    );
  } catch (error) {
    if (error instanceof AdminAuthError) {
      return NextResponse.json(
        { success: false, error: getPublicAuthErrorMessage(error.type) },
        { status: getAuthErrorHttpStatus(error.type), headers: NO_STORE },
      );
    }
    console.error('[Public feed rollback capability]: TRANSITION_UNAVAILABLE');
    return NextResponse.json(
      { success: false, error: 'Public feed rollback capability could not be changed.' },
      { status: 500, headers: NO_STORE },
    );
  }
}
