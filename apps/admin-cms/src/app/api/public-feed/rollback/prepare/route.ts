import { NextRequest, NextResponse } from 'next/server';
import { validateSameOrigin } from '../../../../../auth/csrf';
import { requireAdmin } from '../../../../../auth/requireAdmin';
import { canPreparePublication } from '../../../../../auth/permissions';
import { getServerEnv } from '../../../../../lib/env';
import { createSupabaseAdminClient } from '../../../../../lib/supabase/admin';
import { createPublicFeedHistoryDependencies } from '../../../../../projects/createPublicFeedHistoryDependencies';
import { preparePublicFeedRollback } from '../../../../../projects/publicFeedHistoryService';

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
    const input = await request.json().catch(() => null) as { versionNumber?: unknown } | null;
    if (!input || !Number.isSafeInteger(input.versionNumber) || Number(input.versionNumber) <= 0) {
      return NextResponse.json({ success: false, error: 'Validation failed.' }, { status: 400, headers: NO_STORE });
    }
    const env = getServerEnv();
    const result = await preparePublicFeedRollback(createPublicFeedHistoryDependencies({
      supabase: createSupabaseAdminClient(), supabaseUrl: env.supabaseUrl,
      adminId: admin.adminUserId, permissions: admin.permissions,
      feedBucket: env.SUPABASE_PUBLIC_FEEDS_BUCKET, feedPath: env.SUPABASE_PUBLIC_FEED_FILE,
      environment: process.env,
    }), Number(input.versionNumber));
    if (result.resultCode === 'PREPARED') {
      return NextResponse.json({ success: true, result }, { headers: NO_STORE });
    }
    const status = result.resultCode === 'PERMISSION_DENIED' ? 403
      : ['ROLLBACK_UNAVAILABLE', 'VERSION_NOT_FOUND'].includes(result.resultCode) ? 404 : 409;
    return NextResponse.json({ success: false, code: result.resultCode, error: 'Rollback preparation is unavailable.' }, { status, headers: NO_STORE });
  } catch {
    console.error('[Public feed rollback preparation]: PREPARATION_UNAVAILABLE');
    return NextResponse.json({ success: false, error: 'Rollback preparation is unavailable.' }, { status: 500, headers: NO_STORE });
  }
}
