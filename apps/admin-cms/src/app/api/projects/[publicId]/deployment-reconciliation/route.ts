import { NextRequest, NextResponse } from 'next/server';
import { validatePreviewPublicId } from '../../../../../auth/participantPreviewInput';
import { validateSameOrigin } from '../../../../../auth/csrf';
import { requireAdmin } from '../../../../../auth/requireAdmin';
import { canPreparePublication } from '../../../../../auth/permissions';
import { getServerEnv } from '../../../../../lib/env';
import { createSupabaseAdminClient } from '../../../../../lib/supabase/admin';
import { executeControlledPublication } from '../../../../../projects/controlledPublicationService';
import { createControlledPublicationDependencies } from '../../../../../projects/createControlledPublicationDependencies';
import { isLocalPublicationExecutionAvailable } from '../../../../../projects/localPublicationExecution';
import { isStagingPublicationExecutionAvailable } from '../../../../../projects/publicationExecutionPolicy';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function POST(request: NextRequest, { params }: { params: Promise<{ publicId: string }> }) {
  try {
    if (!validateSameOrigin(request.headers.get('origin'), request.nextUrl.origin)) {
      return NextResponse.json({ success: false, error: 'Access denied.' }, { status: 403, headers: NO_STORE });
    }
    const publicId = validatePreviewPublicId((await params).publicId);
    if (!publicId.valid) return NextResponse.json({ success: false, error: 'Validation failed.' }, { status: 400, headers: NO_STORE });
    const admin = await requireAdmin();
    if (!canPreparePublication(admin.permissions)) {
      return NextResponse.json({ success: false, error: 'Access denied.' }, { status: 403, headers: NO_STORE });
    }
    const env = getServerEnv();
    const executionTarget = isLocalPublicationExecutionAvailable(env.supabaseUrl)
      ? 'local' as const
      : isStagingPublicationExecutionAvailable(env.supabaseUrl) ? 'staging' as const : null;
    if (!executionTarget) {
      return NextResponse.json({ success: false, code: 'PUBLICATION_UNAVAILABLE', error: 'Deployment reconciliation is unavailable.' }, { status: 404, headers: NO_STORE });
    }
    const supabase = createSupabaseAdminClient();
    const result = await executeControlledPublication({
      permissions: admin.permissions, publicId: publicId.publicId,
      privateBucket: env.SUPABASE_DRAFT_BUCKET, publicAssetsBucket: env.SUPABASE_PUBLIC_ASSETS_BUCKET,
      publicFeedBucket: env.SUPABASE_PUBLIC_FEEDS_BUCKET, publicFeedPath: env.SUPABASE_PUBLIC_FEED_FILE,
      publicationMode: 'deployment_reconciliation',
      dependencies: createControlledPublicationDependencies({
        supabase, supabaseUrl: env.supabaseUrl, publicId: publicId.publicId,
        adminId: admin.adminUserId, privateBucket: env.SUPABASE_DRAFT_BUCKET,
        publicFeedBucket: env.SUPABASE_PUBLIC_FEEDS_BUCKET, publicFeedPath: env.SUPABASE_PUBLIC_FEED_FILE,
        executionTarget,
      }),
    });
    if (result.resultCode === 'COMPLETED' || result.resultCode === 'ALREADY_COMPLETED') {
      return NextResponse.json({ success: true, result: {
        resultCode: result.resultCode, publicId: publicId.publicId,
        recordCount: result.recordCount, feedHash: result.feedHash,
      } }, { headers: NO_STORE });
    }
    const status = result.resultCode === 'PERMISSION_DENIED' ? 403
      : ['PUBLICATION_IN_PROGRESS', 'RECOVERY_REQUIRED', 'NOT_READY'].includes(result.resultCode) ? 409 : 500;
    return NextResponse.json({ success: false, code: result.resultCode, error: 'Deployment reconciliation could not be completed.' }, { status, headers: NO_STORE });
  } catch {
    console.error('[Deployment reconciliation]: EXECUTION_UNAVAILABLE');
    return NextResponse.json({ success: false, error: 'Deployment reconciliation could not be completed.' }, { status: 500, headers: NO_STORE });
  }
}
