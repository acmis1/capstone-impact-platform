import { NextRequest, NextResponse } from 'next/server';
import { getAuthErrorHttpStatus, getPublicAuthErrorMessage } from '../../../../../auth/authHttp';
import { validatePreviewPublicId } from '../../../../../auth/participantPreviewInput';
import { requireAdmin } from '../../../../../auth/requireAdmin';
import { validateSameOrigin } from '../../../../../auth/csrf';
import { AdminAuthError } from '../../../../../auth/authTypes';
import { canPreparePublication } from '../../../../../auth/permissions';
import { getServerEnv } from '../../../../../lib/env';
import { createSupabaseAdminClient } from '../../../../../lib/supabase/admin';
import { executeControlledPublication } from '../../../../../projects/controlledPublicationService';
import { createControlledPublicationDependencies } from '../../../../../projects/createControlledPublicationDependencies';
import { isStagingPublicationExecutionAvailable } from '../../../../../projects/publicationExecutionPolicy';

const NO_STORE = { 'Cache-Control': 'no-store' };

function unavailable() {
  return NextResponse.json(
    {
      success: false,
      code: 'STAGING_PUBLICATION_UNAVAILABLE',
      error: 'Staging showcase publication is unavailable.',
    },
    { status: 404, headers: NO_STORE },
  );
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ publicId: string }> }) {
  try {
    if (!validateSameOrigin(request.headers.get('origin'), request.nextUrl.origin)) {
      return NextResponse.json(
        { success: false, error: getPublicAuthErrorMessage('PERMISSION_DENIED') },
        { status: 403, headers: NO_STORE },
      );
    }

    const validation = validatePreviewPublicId((await params).publicId);
    if (!validation.valid) {
      return NextResponse.json(
        { success: false, error: 'Validation failed.' },
        { status: 400, headers: NO_STORE },
      );
    }

    const admin = await requireAdmin();
    if (!canPreparePublication(admin.permissions)) {
      return NextResponse.json(
        { success: false, error: getPublicAuthErrorMessage('PERMISSION_DENIED') },
        { status: 403, headers: NO_STORE },
      );
    }

    const env = getServerEnv();
    if (!isStagingPublicationExecutionAvailable(env.supabaseUrl)) return unavailable();

    const dependencies = createControlledPublicationDependencies({
      supabase: createSupabaseAdminClient(),
      supabaseUrl: env.supabaseUrl,
      publicId: validation.publicId,
      adminId: admin.adminUserId,
      privateBucket: env.SUPABASE_DRAFT_BUCKET,
      publicFeedBucket: env.SUPABASE_PUBLIC_FEEDS_BUCKET,
      publicFeedPath: env.SUPABASE_PUBLIC_FEED_FILE,
      executionTarget: 'staging',
    });
    const result = await executeControlledPublication({
      permissions: admin.permissions,
      publicId: validation.publicId,
      privateBucket: env.SUPABASE_DRAFT_BUCKET,
      publicAssetsBucket: env.SUPABASE_PUBLIC_ASSETS_BUCKET,
      publicFeedBucket: env.SUPABASE_PUBLIC_FEEDS_BUCKET,
      publicFeedPath: env.SUPABASE_PUBLIC_FEED_FILE,
      dependencies,
    });

    if (result.resultCode === 'COMPLETED' || result.resultCode === 'ALREADY_COMPLETED') {
      return NextResponse.json({
        success: true,
        result: {
          resultCode: result.resultCode,
          publicId: validation.publicId,
          snapshotId: result.snapshotId,
          recordCount: result.recordCount,
          feedHash: result.feedHash,
          feedPublicUrl: result.feedPublicUrl,
        },
      }, { headers: NO_STORE });
    }
    if (result.resultCode === 'NOT_READY') {
      return NextResponse.json({
        success: false,
        result: {
          resultCode: result.resultCode,
          readinessCode: result.readinessCode,
          blockers: result.blockers,
        },
        error: 'Readiness changed. Generate a new publication plan.',
      }, { status: 409, headers: NO_STORE });
    }
    if (result.resultCode === 'PUBLICATION_IN_PROGRESS') {
      return NextResponse.json(
        { success: false, code: result.resultCode, error: 'Another publication is already in progress.' },
        { status: 409, headers: NO_STORE },
      );
    }
    if (result.resultCode === 'RECOVERY_REQUIRED') {
      return NextResponse.json(
        { success: false, code: result.resultCode, error: 'Publication recovery is incomplete and requires attention.' },
        { status: 409, headers: NO_STORE },
      );
    }
    if (result.resultCode === 'PERMISSION_DENIED') {
      return NextResponse.json(
        { success: false, error: getPublicAuthErrorMessage('PERMISSION_DENIED') },
        { status: 403, headers: NO_STORE },
      );
    }
    if (result.resultCode === 'EXECUTION_FAILED' && result.failureCode === 'EXECUTION_POLICY_DENIED') {
      return unavailable();
    }
    return NextResponse.json(
      { success: false, error: 'Staging showcase publication could not be completed.' },
      { status: 500, headers: NO_STORE },
    );
  } catch (error) {
    if (error instanceof AdminAuthError) {
      return NextResponse.json(
        { success: false, error: getPublicAuthErrorMessage(error.type) },
        { status: getAuthErrorHttpStatus(error.type), headers: NO_STORE },
      );
    }
    console.error('[Staging publication API Error]: unavailable');
    return NextResponse.json(
      { success: false, error: 'Staging showcase publication could not be completed.' },
      { status: 500, headers: NO_STORE },
    );
  }
}
