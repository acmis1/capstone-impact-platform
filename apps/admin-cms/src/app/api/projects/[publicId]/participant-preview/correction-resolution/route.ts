import { NextRequest, NextResponse } from 'next/server';
import { SupabaseParticipantPreviewRepository } from '../../../../../../repositories/SupabaseParticipantPreviewRepository';
import { ParticipantPreviewExecutionError } from '../../../../../../repositories/ParticipantPreviewRepository';
import { requireAdmin } from '../../../../../../auth/requireAdmin';
import { validateSameOrigin } from '../../../../../../auth/csrf';
import { AdminAuthError } from '../../../../../../auth/authTypes';
import { getAuthErrorHttpStatus, getPublicAuthErrorMessage } from '../../../../../../auth/authHttp';
import { validatePreviewPublicId } from '../../../../../../auth/participantPreviewInput';
import { hasPermission } from '../../../../../../auth/permissions';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/**
 * Route handler to start administrative correction resolution for a project (POST).
 *
 * Rules:
 * - Same-origin CSRF validation.
 * - Authenticated admin context.
 * - Requires combined authority: projects.edit AND projects.review (admin role, or user holding both editor & reviewer roles).
 * - Accepts no internal UUIDs, status, or timestamps in request payload.
 * - Server-authoritative state resolution and advisory locking.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ publicId: string }> }
) {
  try {
    const origin = request.headers.get('origin');
    const requestOrigin = request.nextUrl.origin;
    if (!validateSameOrigin(origin, requestOrigin)) {
      const status = getAuthErrorHttpStatus('PERMISSION_DENIED');
      const error = getPublicAuthErrorMessage('PERMISSION_DENIED');
      return NextResponse.json({ success: false, error }, { status, headers: NO_STORE });
    }

    const adminContext = await requireAdmin();

    const { publicId } = await params;
    const validation = validatePreviewPublicId(publicId);
    if (!validation.valid) {
      return NextResponse.json({ success: false, error: 'Validation failed.' }, { status: 400, headers: NO_STORE });
    }

    // Require both projects.edit and projects.review permissions
    const permissions = adminContext.permissions;
    const canEdit = hasPermission(permissions, 'projects.edit');
    const canReview = hasPermission(permissions, 'projects.review');

    if (!canEdit || !canReview) {
      const status = getAuthErrorHttpStatus('PERMISSION_DENIED');
      const error = getPublicAuthErrorMessage('PERMISSION_DENIED');
      return NextResponse.json({ success: false, error }, { status, headers: NO_STORE });
    }

    const repository = new SupabaseParticipantPreviewRepository();
    const result = await repository.startCorrectionResolution({
      publicId: validation.publicId,
      adminId: adminContext.adminUserId,
    });

    return NextResponse.json(
      {
        success: true,
        correctionRequestId: result.correctionRequestId,
        resolutionStartedAt: result.resolutionStartedAt,
        alreadyInProgress: result.alreadyInProgress ?? false,
      },
      { headers: NO_STORE }
    );
  } catch (error: unknown) {
    if (error instanceof AdminAuthError) {
      const status = getAuthErrorHttpStatus(error.type);
      const errMessage = getPublicAuthErrorMessage(error.type);
      return NextResponse.json({ success: false, error: errMessage }, { status, headers: NO_STORE });
    }

    if (error instanceof ParticipantPreviewExecutionError) {
      console.error('[Start Correction Resolution API Error]:', error.code);

      switch (error.code) {
        case 'PROJECT_NOT_FOUND':
          return NextResponse.json({ success: false, error: 'Project not found.' }, { status: 404, headers: NO_STORE });
        case 'INVALID_PROJECT_STATE':
          return NextResponse.json(
            { success: false, error: 'Project is not eligible for correction resolution (must be approved).' },
            { status: 400, headers: NO_STORE }
          );
        case 'NO_OPEN_CORRECTION':
          return NextResponse.json(
            { success: false, error: 'There is no open participant correction request to resolve.' },
            { status: 400, headers: NO_STORE }
          );
        case 'AMBIGUOUS_CORRECTION_REQUEST':
          return NextResponse.json(
            { success: false, error: 'Multiple unresolved correction requests exist. Resolution cannot be started unambiguously.' },
            { status: 409, headers: NO_STORE }
          );
        case 'CONFLICTING_ACTIVE_PREVIEW':
          return NextResponse.json(
            { success: false, error: 'A conflicting active preview exists for another version of this project.' },
            { status: 409, headers: NO_STORE }
          );
        case 'PERMISSION_DENIED': {
          const status = getAuthErrorHttpStatus('PERMISSION_DENIED');
          const errMessage = getPublicAuthErrorMessage('PERMISSION_DENIED');
          return NextResponse.json({ success: false, error: errMessage }, { status, headers: NO_STORE });
        }
        case 'INPUT_INVALID':
          return NextResponse.json({ success: false, error: 'Validation failed.' }, { status: 400, headers: NO_STORE });
        case 'RESPONSE_INVALID':
        case 'INTERNAL_FAILURE':
        default: {
          const status = getAuthErrorHttpStatus('UNKNOWN');
          const errMessage = getPublicAuthErrorMessage('UNKNOWN');
          return NextResponse.json({ success: false, error: errMessage }, { status, headers: NO_STORE });
        }
      }
    }

    console.error('[Start Correction Resolution API Error]: INTERNAL_FAILURE');
    const status = getAuthErrorHttpStatus('UNKNOWN');
    const errMessage = getPublicAuthErrorMessage('UNKNOWN');
    return NextResponse.json({ success: false, error: errMessage }, { status, headers: NO_STORE });
  }
}
