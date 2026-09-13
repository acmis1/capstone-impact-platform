import { NextRequest, NextResponse } from 'next/server';
import { validateSameOrigin } from '../../../../auth/csrf';
import { requireAdmin } from '../../../../auth/requireAdmin';
import { canPreparePublication } from '../../../../auth/permissions';
import { AdminAuthError } from '../../../../auth/authTypes';
import { getAuthErrorHttpStatus, getPublicAuthErrorMessage } from '../../../../auth/authHttp';
import { getServerEnv } from '../../../../lib/env';
import { createSupabaseAdminClientForServerEnv } from '../../../../lib/supabase/admin';
import { createPublicFeedHistoryDependencies } from '../../../../projects/createPublicFeedHistoryDependencies';
import { activatePublicFeedHistory } from '../../../../projects/publicFeedHistoryService';
import { resolvePublicationExecutionTarget } from '../../../../projects/publicationExecutionPolicy';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function POST(request: NextRequest) {
  try {
    if (!validateSameOrigin(request.headers.get('origin'), request.nextUrl.origin)) {
      return NextResponse.json({ success: false, error: 'Access denied.' }, { status: 403, headers: NO_STORE });
    }
    const admin = await requireAdmin();
    if (!canPreparePublication(admin.permissions)) {
      return NextResponse.json({ success: false, error: 'Access denied.' }, { status: 403, headers: NO_STORE });
    }
    const env = Object.freeze(getServerEnv());
    const environment = Object.freeze({
      CAPSTONE_RUNTIME_ENV: process.env.CAPSTONE_RUNTIME_ENV,
      CAPSTONE_EXPECTED_SUPABASE_HOST: process.env.CAPSTONE_EXPECTED_SUPABASE_HOST,
      CAPSTONE_STAGING_PUBLICATION_ENABLED: process.env.CAPSTONE_STAGING_PUBLICATION_ENABLED,
      CAPSTONE_PRODUCTION_PUBLICATION_ENABLED: process.env.CAPSTONE_PRODUCTION_PUBLICATION_ENABLED,
      CAPSTONE_LOCAL_PUBLIC_FEED_ROLLBACK_ENABLED: process.env.CAPSTONE_LOCAL_PUBLIC_FEED_ROLLBACK_ENABLED,
      CAPSTONE_STAGING_PUBLIC_FEED_ROLLBACK_ENABLED: process.env.CAPSTONE_STAGING_PUBLIC_FEED_ROLLBACK_ENABLED,
      NEXT_PUBLIC_SUPABASE_URL: env.supabaseUrl,
    });
    const executionTarget = resolvePublicationExecutionTarget(env.supabaseUrl, environment);
    if (!executionTarget) {
      return NextResponse.json(
        { success: false, code: 'EXECUTION_FAILED', error: 'Public feed activation could not be completed.' },
        { status: 500, headers: NO_STORE },
      );
    }
    const result = await activatePublicFeedHistory(createPublicFeedHistoryDependencies({
      supabase: createSupabaseAdminClientForServerEnv(env), supabaseUrl: env.supabaseUrl,
      adminId: admin.adminUserId, permissions: admin.permissions,
      feedBucket: env.SUPABASE_PUBLIC_FEEDS_BUCKET, feedPath: env.SUPABASE_PUBLIC_FEED_FILE,
      executionTarget, environment,
    }));
    if (result.resultCode === 'COMPLETED' || result.resultCode === 'ALREADY_ACTIVE') {
      return NextResponse.json({ success: true, result }, { headers: NO_STORE });
    }
    const status = result.resultCode === 'PUBLICATION_IN_PROGRESS' || result.resultCode === 'RECOVERY_REQUIRED' ? 409 : 500;
    return NextResponse.json({ success: false, code: result.resultCode, error: 'Public feed activation could not be completed.' }, { status, headers: NO_STORE });
  } catch (error) {
    if (error instanceof AdminAuthError) {
      return NextResponse.json(
        { success: false, error: getPublicAuthErrorMessage(error.type) },
        { status: getAuthErrorHttpStatus(error.type), headers: NO_STORE },
      );
    }
    console.error('[Public feed activation]: ACTIVATION_UNAVAILABLE');
    return NextResponse.json({ success: false, error: 'Public feed activation could not be completed.' }, { status: 500, headers: NO_STORE });
  }
}
