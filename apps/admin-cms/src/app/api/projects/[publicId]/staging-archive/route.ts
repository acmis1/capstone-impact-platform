import { NextRequest, NextResponse } from 'next/server';
import { getAuthErrorHttpStatus, getPublicAuthErrorMessage } from '../../../../../auth/authHttp';
import { validateSameOrigin } from '../../../../../auth/csrf';
import { validatePreviewPublicId } from '../../../../../auth/participantPreviewInput';
import { hasPermission } from '../../../../../auth/permissions';
import { validatePublicRemovalInput } from '../../../../../auth/publicRemovalInput';
import { requireAdmin } from '../../../../../auth/requireAdmin';
import { AdminAuthError } from '../../../../../auth/authTypes';
import { getServerEnv } from '../../../../../lib/env';
import { createSupabaseAdminClientForServerEnv } from '../../../../../lib/supabase/admin';
import { executeControlledPublicRemoval } from '../../../../../projects/controlledPublicRemovalService';
import { createControlledPublicRemovalDependencies } from '../../../../../projects/createControlledPublicRemovalDependencies';
import { isStagingPublicationExecutionAvailable } from '../../../../../projects/publicationExecutionPolicy';

const NO_STORE = { 'Cache-Control': 'no-store' };
const json = (body: object, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

function unavailable() {
  return json({
    success: false,
    code: 'STAGING_ARCHIVE_UNAVAILABLE',
    error: 'Staging showcase archive is unavailable.',
  }, 404);
}

function stagingEnvironmentSnapshot(supabaseUrl: string) {
  return Object.freeze({
    CAPSTONE_RUNTIME_ENV: process.env.CAPSTONE_RUNTIME_ENV,
    CAPSTONE_EXPECTED_SUPABASE_HOST: process.env.CAPSTONE_EXPECTED_SUPABASE_HOST,
    CAPSTONE_STAGING_PUBLICATION_ENABLED: process.env.CAPSTONE_STAGING_PUBLICATION_ENABLED,
    NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
  });
}

function failed() {
  return json({
    success: false,
    code: 'STAGING_ARCHIVE_FAILED',
    error: 'Staging showcase archive could not be completed.',
  }, 500);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ publicId: string }> }) {
  try {
    if (!validateSameOrigin(request.headers.get('origin'), request.nextUrl.origin)) {
      return json({ success: false, error: getPublicAuthErrorMessage('PERMISSION_DENIED') }, 403);
    }
    const publicId = validatePreviewPublicId((await params).publicId);
    if (!publicId.valid) return json({ success: false, error: 'Validation failed.' }, 400);
    const admin = await requireAdmin();
    if (!hasPermission(admin.permissions, 'projects.archive')) {
      return json({ success: false, error: getPublicAuthErrorMessage('PERMISSION_DENIED') }, 403);
    }
    const body = await request.json().catch(() => null);
    const input = validatePublicRemovalInput(body, publicId.publicId);
    if (!input.valid) return json({ success: false, error: 'Validation failed.' }, 400);

    const env = Object.freeze(getServerEnv());
    const executionEnvironment = stagingEnvironmentSnapshot(env.supabaseUrl);
    if (!isStagingPublicationExecutionAvailable(env.supabaseUrl, executionEnvironment)) {
      return unavailable();
    }
    const dependencies = createControlledPublicRemovalDependencies({
      supabase: createSupabaseAdminClientForServerEnv(env),
      supabaseUrl: env.supabaseUrl,
      publicId: input.publicId,
      adminId: admin.adminUserId,
      feedBucket: env.SUPABASE_PUBLIC_FEEDS_BUCKET,
      feedPath: env.SUPABASE_PUBLIC_FEED_FILE,
      executionTarget: 'staging',
      executionEnvironment,
    });
    const result = await executeControlledPublicRemoval({
      permissions: admin.permissions,
      publicId: input.publicId,
      archiveReason: input.archiveReason,
      dependencies,
    });

    if (result.resultCode === 'COMPLETED' || result.resultCode === 'ALREADY_COMPLETED') {
      return json({
        success: true,
        result: {
          resultCode: result.resultCode,
          publicId: input.publicId,
          recordCount: result.recordCount,
          feedHash: result.feedHash,
        },
      });
    }
    if (result.resultCode === 'PERMISSION_DENIED') {
      return json({ success: false, error: getPublicAuthErrorMessage('PERMISSION_DENIED') }, 403);
    }
    if (result.resultCode === 'PUBLICATION_IN_PROGRESS') {
      return json({ success: false, code: result.resultCode, error: 'Another public-feed operation is already in progress.' }, 409);
    }
    if (result.resultCode === 'RECOVERY_REQUIRED') {
      return json({ success: false, code: result.resultCode, error: 'Public-feed recovery is incomplete and requires attention.' }, 409);
    }
    if (result.resultCode === 'NOT_PUBLISHED') {
      return json({ success: false, code: result.resultCode, error: 'The project is not currently published.' }, 409);
    }
    if (result.resultCode === 'EXECUTION_FAILED' && result.failureCode === 'NON_LOCAL_ENVIRONMENT') {
      return unavailable();
    }
    if (result.resultCode === 'EXECUTION_FAILED' && result.failureCode === 'CURRENT_FEED_DIVERGED') {
      return json({
        success: false,
        code: result.failureCode,
        error: 'The canonical staging feed no longer matches the authoritative database. Archive was not performed.',
      }, 409);
    }
    return failed();
  } catch (error) {
    if (error instanceof AdminAuthError) {
      return json({ success: false, error: getPublicAuthErrorMessage(error.type) }, getAuthErrorHttpStatus(error.type));
    }
    console.error('[Staging archive API Error]: unavailable');
    return failed();
  }
}
