import { NextRequest, NextResponse } from 'next/server';
import { getAuthErrorHttpStatus, getPublicAuthErrorMessage } from '../../../../../auth/authHttp';
import { validatePreviewPublicId } from '../../../../../auth/participantPreviewInput';
import { requireAdmin } from '../../../../../auth/requireAdmin';
import { validateSameOrigin } from '../../../../../auth/csrf';
import { AdminAuthError } from '../../../../../auth/authTypes';
import { canPreparePublication } from '../../../../../auth/permissions';
import { getServerEnv } from '../../../../../lib/env';
import { createSupabaseAdminClientForServerEnv } from '../../../../../lib/supabase/admin';
import { executeControlledPublication } from '../../../../../projects/controlledPublicationService';
import { createControlledPublicationDependencies } from '../../../../../projects/createControlledPublicationDependencies';
import { isProductionPublicationExecutionAvailable } from '../../../../../projects/publicationExecutionPolicy';

const NO_STORE = { 'Cache-Control': 'no-store' };
const json = (body: object, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

function unavailable() {
  return json({
    success: false,
    code: 'PRODUCTION_PUBLICATION_UNAVAILABLE',
    error: 'Live showcase publication is unavailable.',
  }, 404);
}

function productionEnvironmentSnapshot(supabaseUrl: string) {
  return Object.freeze({
    CAPSTONE_RUNTIME_ENV: process.env.CAPSTONE_RUNTIME_ENV,
    CAPSTONE_EXPECTED_SUPABASE_HOST: process.env.CAPSTONE_EXPECTED_SUPABASE_HOST,
    CAPSTONE_PRODUCTION_PUBLICATION_ENABLED: process.env.CAPSTONE_PRODUCTION_PUBLICATION_ENABLED,
    NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
  });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ publicId: string }> }) {
  try {
    if (!validateSameOrigin(request.headers.get('origin'), request.nextUrl.origin)) {
      return json({ success: false, error: getPublicAuthErrorMessage('PERMISSION_DENIED') }, 403);
    }
    const publicId = validatePreviewPublicId((await params).publicId);
    if (!publicId.valid) return json({ success: false, error: 'Validation failed.' }, 400);
    const admin = await requireAdmin();
    if (!canPreparePublication(admin.permissions)) {
      return json({ success: false, error: getPublicAuthErrorMessage('PERMISSION_DENIED') }, 403);
    }

    const env = Object.freeze(getServerEnv());
    const executionEnvironment = productionEnvironmentSnapshot(env.supabaseUrl);
    if (!isProductionPublicationExecutionAvailable(env.supabaseUrl, executionEnvironment)) {
      return unavailable();
    }
    const dependencies = createControlledPublicationDependencies({
      supabase: createSupabaseAdminClientForServerEnv(env),
      supabaseUrl: env.supabaseUrl,
      publicId: publicId.publicId,
      adminId: admin.adminUserId,
      privateBucket: env.SUPABASE_DRAFT_BUCKET,
      publicFeedBucket: env.SUPABASE_PUBLIC_FEEDS_BUCKET,
      publicFeedPath: env.SUPABASE_PUBLIC_FEED_FILE,
      executionTarget: 'production',
      executionEnvironment,
    });
    const result = await executeControlledPublication({
      permissions: admin.permissions,
      publicId: publicId.publicId,
      privateBucket: env.SUPABASE_DRAFT_BUCKET,
      publicAssetsBucket: env.SUPABASE_PUBLIC_ASSETS_BUCKET,
      publicFeedBucket: env.SUPABASE_PUBLIC_FEEDS_BUCKET,
      publicFeedPath: env.SUPABASE_PUBLIC_FEED_FILE,
      dependencies,
    });

    if (result.resultCode === 'COMPLETED' || result.resultCode === 'ALREADY_COMPLETED') {
      return json({ success: true, result: {
        resultCode: result.resultCode,
        publicId: publicId.publicId,
        snapshotId: result.snapshotId,
        recordCount: result.recordCount,
        feedHash: result.feedHash,
        feedPublicUrl: result.feedPublicUrl,
      } });
    }
    if (result.resultCode === 'NOT_READY') {
      return json({
        success: false,
        result: {
          resultCode: result.resultCode,
          readinessCode: result.readinessCode,
          blockers: result.blockers,
        },
        error: 'Readiness changed. Generate a new publication plan.',
      }, 409);
    }
    if (result.resultCode === 'PUBLICATION_IN_PROGRESS') {
      return json({ success: false, code: result.resultCode, error: 'Another publication is already in progress.' }, 409);
    }
    if (result.resultCode === 'RECOVERY_REQUIRED') {
      return json({ success: false, code: result.resultCode, error: 'Publication recovery is incomplete and requires attention.' }, 409);
    }
    if (result.resultCode === 'PERMISSION_DENIED') {
      return json({ success: false, error: getPublicAuthErrorMessage('PERMISSION_DENIED') }, 403);
    }
    if (result.resultCode === 'EXECUTION_FAILED' && result.failureCode === 'EXECUTION_POLICY_DENIED') {
      return unavailable();
    }
    return json({ success: false, error: 'Live showcase publication could not be completed.' }, 500);
  } catch (error) {
    if (error instanceof AdminAuthError) {
      return json(
        { success: false, error: getPublicAuthErrorMessage(error.type) },
        getAuthErrorHttpStatus(error.type),
      );
    }
    console.error('[Production publication API Error]: unavailable');
    return json({ success: false, error: 'Live showcase publication could not be completed.' }, 500);
  }
}
