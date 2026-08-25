import { NextRequest, NextResponse } from 'next/server';
import { validateSameOrigin } from '../../../../auth/csrf';
import { requireAdmin } from '../../../../auth/requireAdmin';
import { canPreparePublication } from '../../../../auth/permissions';
import { AdminAuthError } from '../../../../auth/authTypes';
import { getAuthErrorHttpStatus, getPublicAuthErrorMessage } from '../../../../auth/authHttp';
import { getServerEnv } from '../../../../lib/env';
import { createSupabaseAdminClient } from '../../../../lib/supabase/admin';
import { createPublicFeedHistoryDependencies } from '../../../../projects/createPublicFeedHistoryDependencies';
import { activatePublicFeedHistory } from '../../../../projects/publicFeedHistoryService';

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
    const env = getServerEnv();
    const result = await activatePublicFeedHistory(createPublicFeedHistoryDependencies({
      supabase: createSupabaseAdminClient(), supabaseUrl: env.supabaseUrl,
      adminId: admin.adminUserId, permissions: admin.permissions,
      feedBucket: env.SUPABASE_PUBLIC_FEEDS_BUCKET, feedPath: env.SUPABASE_PUBLIC_FEED_FILE,
      environment: process.env,
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
