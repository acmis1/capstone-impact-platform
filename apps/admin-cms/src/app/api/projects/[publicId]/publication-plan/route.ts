import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '../../../../../auth/requireAdmin';
import { AdminAuthError } from '../../../../../auth/authTypes';
import { getAuthErrorHttpStatus, getPublicAuthErrorMessage } from '../../../../../auth/authHttp';
import { validateSameOrigin } from '../../../../../auth/csrf';
import { getServerEnv } from '../../../../../lib/env';
import { SupabaseProjectRepository } from '../../../../../repositories/SupabaseProjectRepository';
import { SupabaseParticipantPreviewRepository } from '../../../../../repositories/SupabaseParticipantPreviewRepository';
import { SupabasePublicationExecutionRepository } from '../../../../../repositories/SupabasePublicationExecutionRepository';
import { preparePublicationPlan } from '../../../../../projects/publicationPlanService';
import { validatePreviewPublicId } from '../../../../../auth/participantPreviewInput';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function POST(request: NextRequest, { params }: { params: Promise<{ publicId: string }> }) {
  try {
    if (!validateSameOrigin(request.headers.get('origin'), request.nextUrl.origin)) {
      return NextResponse.json({ success: false, error: getPublicAuthErrorMessage('PERMISSION_DENIED') }, { status: 403, headers: NO_STORE });
    }
    const admin = await requireAdmin();
    const { publicId } = await params;
    const validation = validatePreviewPublicId(publicId);
    if (!validation.valid) {
      return NextResponse.json({ success: false, error: 'Validation failed.' }, { status: 400, headers: NO_STORE });
    }
    const projectRepository = new SupabaseProjectRepository();
    const previewRepository = new SupabaseParticipantPreviewRepository();
    const publicationRepository = new SupabasePublicationExecutionRepository();
    const env = getServerEnv();
    const privateBucket = env.SUPABASE_DRAFT_BUCKET;
    const plan = await preparePublicationPlan(admin.permissions, validation.publicId, {
      getReadiness: () => previewRepository.getPublicationReadiness({ publicId: validation.publicId, adminId: admin.adminUserId, privateBucket }),
      listProjects: () => projectRepository.listProjects(),
      listProjectMedia: () => publicationRepository.listProjectMedia(validation.publicId),
      privateBucket,
      publicBucket: env.SUPABASE_PUBLIC_ASSETS_BUCKET,
      getPublicUrl: (bucket, path) => publicationRepository.getPublicUrl(bucket, path),
    });
    if (plan.resultCode === 'PERMISSION_DENIED') {
      return NextResponse.json({ success: false, error: getPublicAuthErrorMessage('PERMISSION_DENIED') }, { status: 403, headers: NO_STORE });
    }
    if (plan.resultCode !== 'READY_TO_STAGE') {
      return NextResponse.json({ success: false, result: plan, error: 'Publication plan is unavailable.' }, { status: 409, headers: NO_STORE });
    }
    return NextResponse.json({ success: true, result: plan }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof AdminAuthError) {
      return NextResponse.json({ success: false, error: getPublicAuthErrorMessage(error.type) }, { status: getAuthErrorHttpStatus(error.type), headers: NO_STORE });
    }
    console.error('[Publication plan API Error]: unavailable');
    return NextResponse.json({ success: false, error: 'Publication plan is unavailable.' }, { status: 500, headers: NO_STORE });
  }
}
