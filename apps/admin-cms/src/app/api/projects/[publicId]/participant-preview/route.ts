import { NextRequest, NextResponse } from 'next/server';
import { SupabaseParticipantPreviewRepository } from '../../../../../repositories/SupabaseParticipantPreviewRepository';
import { ParticipantPreviewExecutionError } from '../../../../../repositories/ParticipantPreviewRepository';
import { DEFAULT_PREVIEW_EXPIRES_IN_SECONDS } from '../../../../../repositories/SupabaseParticipantPreviewRepositoryCore';
import { requireAdmin } from '../../../../../auth/requireAdmin';
import { canManageParticipantPreview } from '../../../../../auth/permissions';
import { validateSameOrigin } from '../../../../../auth/csrf';
import { AdminAuthError } from '../../../../../auth/authTypes';
import { getAuthErrorHttpStatus, getPublicAuthErrorMessage } from '../../../../../auth/authHttp';
import { validatePreviewPublicId } from '../../../../../auth/participantPreviewInput';
import { generateRawPreviewToken, hashPreviewToken } from '../../../../../previews/participantPreviewToken';
import { getStagingBuckets } from '../../../../../lib/supabase/buckets';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/**
 * Route handler to generate (POST) or revoke (DELETE) a project's participant preview link.
 *
 * Rules:
 * - Validates Origin CSRF headers before any state change.
 * - Authenticates the session via requireAdmin and authorizes via the same permission
 *   (projects.review) used to complete internal review — no client-supplied actor identity.
 * - The raw token is generated server-side (Node's crypto module) and returned to the caller
 *   exactly once on success; only its SHA-256 hash ever reaches the database.
 * - Never leaks raw backend/SQL error detail to the response or logs.
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

    if (!canManageParticipantPreview(adminContext.permissions)) {
      const status = getAuthErrorHttpStatus('PERMISSION_DENIED');
      const error = getPublicAuthErrorMessage('PERMISSION_DENIED');
      return NextResponse.json({ success: false, error }, { status, headers: NO_STORE });
    }

    const rawToken = generateRawPreviewToken();
    const tokenHash = hashPreviewToken(rawToken);

    const repository = new SupabaseParticipantPreviewRepository();
    const result = await repository.generatePreview({
      publicId: validation.publicId,
      adminId: adminContext.adminUserId,
      tokenHash,
      privateBucket: getStagingBuckets().DRAFT_PRIVATE,
      expiresInSeconds: DEFAULT_PREVIEW_EXPIRES_IN_SECONDS,
    });

    // The raw token is returned exactly once, here. It is never persisted or logged.
    return NextResponse.json(
      {
        success: true,
        publicId: result.publicId,
        previewToken: rawToken,
        previewUrl: `${requestOrigin}/participant-preview/${rawToken}`,
        createdAt: result.createdAt,
        expiresAt: result.expiresAt,
      },
      { headers: NO_STORE }
    );
  } catch (error: unknown) {
    return handleParticipantPreviewError(error, 'Generate');
  }
}

export async function DELETE(
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

    if (!canManageParticipantPreview(adminContext.permissions)) {
      const status = getAuthErrorHttpStatus('PERMISSION_DENIED');
      const error = getPublicAuthErrorMessage('PERMISSION_DENIED');
      return NextResponse.json({ success: false, error }, { status, headers: NO_STORE });
    }

    const repository = new SupabaseParticipantPreviewRepository();
    const result = await repository.revokePreview({
      publicId: validation.publicId,
      adminId: adminContext.adminUserId,
    });

    return NextResponse.json(
      { success: true, publicId: result.publicId, revokedAt: result.revokedAt },
      { headers: NO_STORE }
    );
  } catch (error: unknown) {
    return handleParticipantPreviewError(error, 'Revoke');
  }
}

function handleParticipantPreviewError(error: unknown, actionLabel: 'Generate' | 'Revoke') {
  if (error instanceof AdminAuthError) {
    const status = getAuthErrorHttpStatus(error.type);
    const errMessage = getPublicAuthErrorMessage(error.type);
    return NextResponse.json({ success: false, error: errMessage }, { status, headers: NO_STORE });
  }

  if (error instanceof ParticipantPreviewExecutionError) {
    console.error(`[Participant Preview ${actionLabel} API Error]:`, error.code);

    switch (error.code) {
      case 'PROJECT_NOT_FOUND':
        return NextResponse.json({ success: false, error: 'Project not found.' }, { status: 404, headers: NO_STORE });
      case 'INVALID_PROJECT_STATE':
        return NextResponse.json(
          { success: false, error: 'Project is not eligible for a participant preview.' },
          { status: 400, headers: NO_STORE }
        );
      case 'ACTIVE_PREVIEW_EXISTS':
        return NextResponse.json(
          { success: false, error: 'An active participant preview already exists. Revoke it before generating a new one.', code: 'ACTIVE_PREVIEW_EXISTS' },
          { status: 409, headers: NO_STORE }
        );
      case 'NO_ACTIVE_PREVIEW':
        return NextResponse.json(
          { success: false, error: 'There is no active participant preview to revoke.', code: 'NO_ACTIVE_PREVIEW' },
          { status: 400, headers: NO_STORE }
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

  console.error(`[Participant Preview ${actionLabel} API Error]: INTERNAL_FAILURE`);
  const status = getAuthErrorHttpStatus('UNKNOWN');
  const errMessage = getPublicAuthErrorMessage('UNKNOWN');
  return NextResponse.json({ success: false, error: errMessage }, { status, headers: NO_STORE });
}
