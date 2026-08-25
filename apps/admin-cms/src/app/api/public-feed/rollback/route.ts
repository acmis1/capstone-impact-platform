import { NextRequest, NextResponse } from 'next/server';
import { validateSameOrigin } from '../../../../auth/csrf';
import { requireAdmin } from '../../../../auth/requireAdmin';
import { canPreparePublication } from '../../../../auth/permissions';
import { getServerEnv } from '../../../../lib/env';
import { createSupabaseAdminClient } from '../../../../lib/supabase/admin';
import { createPublicFeedHistoryDependencies } from '../../../../projects/createPublicFeedHistoryDependencies';
import { executePublicFeedRollback } from '../../../../projects/publicFeedHistoryService';

const NO_STORE = { 'Cache-Control': 'no-store' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest) {
  try {
    if (!validateSameOrigin(request.headers.get('origin'), request.nextUrl.origin)) {
      return NextResponse.json({ success: false, error: 'Access denied.' }, { status: 403, headers: NO_STORE });
    }
    const admin = await requireAdmin();
    if (!canPreparePublication(admin.permissions)) {
      return NextResponse.json({ success: false, error: 'Access denied.' }, { status: 403, headers: NO_STORE });
    }
    const input = await request.json().catch(() => null) as { preparationHandle?: unknown; acknowledgement?: unknown } | null;
    if (!input || typeof input.preparationHandle !== 'string' || !UUID.test(input.preparationHandle)
        || typeof input.acknowledgement !== 'string' || input.acknowledgement.length > 200) {
      return NextResponse.json({ success: false, error: 'Validation failed.' }, { status: 400, headers: NO_STORE });
    }
    const env = getServerEnv();
    const result = await executePublicFeedRollback(createPublicFeedHistoryDependencies({
      supabase: createSupabaseAdminClient(), supabaseUrl: env.supabaseUrl,
      adminId: admin.adminUserId, permissions: admin.permissions,
      feedBucket: env.SUPABASE_PUBLIC_FEEDS_BUCKET, feedPath: env.SUPABASE_PUBLIC_FEED_FILE,
      environment: process.env,
    }), input.preparationHandle, input.acknowledgement);
    if (result.resultCode === 'COMPLETED') {
      return NextResponse.json({ success: true, result }, { headers: NO_STORE });
    }
    const status = result.resultCode === 'PERMISSION_DENIED' ? 403
      : result.resultCode === 'ROLLBACK_UNAVAILABLE' ? 404 : 409;
    return NextResponse.json({ success: false, code: result.resultCode, error: 'Rollback could not be completed.' }, { status, headers: NO_STORE });
  } catch {
    console.error('[Public feed rollback]: ROLLBACK_UNAVAILABLE');
    return NextResponse.json({ success: false, error: 'Rollback could not be completed.' }, { status: 500, headers: NO_STORE });
  }
}
