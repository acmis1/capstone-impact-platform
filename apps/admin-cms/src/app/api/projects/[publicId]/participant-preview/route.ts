import { NextRequest, NextResponse } from 'next/server';
import { SupabaseParticipantPreviewRepository } from '../../../../../repositories/SupabaseParticipantPreviewRepository';
import { ParticipantPreviewExecutionError } from '../../../../../repositories/ParticipantPreviewRepository';
import { DEFAULT_PREVIEW_EXPIRES_IN_SECONDS } from '../../../../../repositories/SupabaseParticipantPreviewRepositoryCore';
import { requireAdmin } from '../../../../../auth/requireAdmin';
import { canManageParticipantPreview, hasPermission } from '../../../../../auth/permissions';
import { validateSameOrigin } from '../../../../../auth/csrf';
import { AdminAuthError } from '../../../../../auth/authTypes';
import { getAuthErrorHttpStatus, getPublicAuthErrorMessage } from '../../../../../auth/authHttp';
import { validatePreviewPublicId } from '../../../../../auth/participantPreviewInput';
import { generateRawPreviewToken, hashPreviewToken } from '../../../../../previews/participantPreviewToken';
import { getStagingBuckets } from '../../../../../lib/supabase/buckets';
import { SupabaseParticipantPreviewNotificationRepository } from '../../../../../repositories/SupabaseParticipantPreviewNotificationRepository';
import { resolveParticipantPreviewEmailConfig } from '../../../../../notifications/participantPreviewEmailConfig';
import { SmtpParticipantPreviewEmailTransport } from '../../../../../notifications/smtpParticipantPreviewEmailTransport';
import { executeParticipantPreviewNotification } from '../../../../../notifications/participantPreviewNotificationService';
import { participantPreviewNotificationMessage } from '../../../../../notifications/participantPreviewNotification';
import { parseParticipantPreviewRequestBody } from '../../../../../auth/participantPreviewInput';

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

    let parsedBody: ReturnType<typeof parseParticipantPreviewRequestBody> = {
      valid: true,
      isCorrectionReissue: false,
      sendEmail: false,
    };
    try {
      const contentType = request.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        parsedBody = parseParticipantPreviewRequestBody(await request.json());
      }
    } catch {
      // A malformed or absent body is the ordinary bodyless POST; the defaults above apply.
    }

    if (!parsedBody.valid) {
      return NextResponse.json({ success: false, error: 'Validation failed.' }, { status: 400, headers: NO_STORE });
    }

    const { isCorrectionReissue, sendEmail } = parsedBody;

    if (isCorrectionReissue) {
      const canEdit = hasPermission(adminContext.permissions, 'projects.edit');
      const canReview = hasPermission(adminContext.permissions, 'projects.review');
      if (!canEdit || !canReview) {
        const status = getAuthErrorHttpStatus('PERMISSION_DENIED');
        const error = getPublicAuthErrorMessage('PERMISSION_DENIED');
        return NextResponse.json({ success: false, error }, { status, headers: NO_STORE });
      }
    } else {
      if (!canManageParticipantPreview(adminContext.permissions)) {
        const status = getAuthErrorHttpStatus('PERMISSION_DENIED');
        const error = getPublicAuthErrorMessage('PERMISSION_DENIED');
        return NextResponse.json({ success: false, error }, { status, headers: NO_STORE });
      }
    }

    // Enablement is checked before anything is generated. Discovering that delivery is switched off
    // only after creating a preview would burn its one-time credential for nothing.
    const emailConfig = sendEmail
      ? resolveParticipantPreviewEmailConfig()
      : ({ enabled: false } as const);

    if (sendEmail && !emailConfig.enabled) {
      return NextResponse.json(
        {
          success: false,
          code: 'EMAIL_DELIVERY_DISABLED',
          error: participantPreviewNotificationMessage('EMAIL_DELIVERY_DISABLED'),
        },
        { status: 409, headers: NO_STORE }
      );
    }

    const rawToken = generateRawPreviewToken();
    const tokenHash = hashPreviewToken(rawToken);
    const privateBucket = getStagingBuckets().DRAFT_PRIVATE;

    if (sendEmail && emailConfig.enabled) {
      const notificationRepository = new SupabaseParticipantPreviewNotificationRepository();
      const generated = await notificationRepository.generatePreviewWithNotification({
        publicId: validation.publicId,
        adminId: adminContext.adminUserId,
        tokenHash,
        privateBucket,
        expiresInSeconds: DEFAULT_PREVIEW_EXPIRES_IN_SECONDS,
        isCorrectionReissue,
      });

      if (generated.resultCode !== 'SUCCESS') {
        // Nothing was created: the atomic RPC validates the authoritative contact first.
        return NextResponse.json(
          {
            success: false,
            code: generated.resultCode,
            error: participantPreviewNotificationMessage(generated.resultCode),
          },
          { status: 409, headers: NO_STORE }
        );
      }

      const preview = generated.value;
      // The secure URL is assembled here, in server memory, and handed only to the transport. It is
      // never persisted, never logged, and leaves this process only in the outgoing message and in
      // the existing one-time response below.
      const previewUrl = `${requestOrigin}/participant-preview/${rawToken}`;

      const notification = await executeParticipantPreviewNotification(
        {
          notifications: notificationRepository,
          transport: new SmtpParticipantPreviewEmailTransport(emailConfig.smtp),
        },
        {
          notificationId: preview.notificationId,
          executionToken: preview.executionToken,
          recipient: preview.recipient,
          projectTitle: preview.projectTitle,
          previewUrl,
          expiresAt: preview.expiresAt,
          fromAddress: emailConfig.smtp.from,
        }
      );

      // The preview itself exists regardless of the delivery outcome, so the one-time credential is
      // still returned exactly once — otherwise an ambiguous delivery would strand a valid preview
      // that no one could reach.
      return NextResponse.json(
        {
          success: true,
          publicId: preview.publicId,
          previewToken: rawToken,
          previewUrl,
          createdAt: preview.createdAt,
          expiresAt: preview.expiresAt,
          notification: {
            status: notification.code,
            message: notification.message,
            recipient: preview.recipient,
            requestedAt: preview.requestedAt,
            failureCode: notification.failureCode,
          },
        },
        { headers: NO_STORE }
      );
    }

    const repository = new SupabaseParticipantPreviewRepository();
    const result = await repository.generatePreview({
      publicId: validation.publicId,
      adminId: adminContext.adminUserId,
      tokenHash,
      privateBucket,
      expiresInSeconds: DEFAULT_PREVIEW_EXPIRES_IN_SECONDS,
      isCorrectionReissue,
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
      case 'CORRECTION_RESOLUTION_REQUIRED':
        return NextResponse.json(
          { success: false, error: 'An unresolved participant correction request requires resolution before generating a new preview.', code: 'CORRECTION_RESOLUTION_REQUIRED' },
          { status: 409, headers: NO_STORE }
        );
      case 'NO_CORRECTION_IN_PROGRESS':
        return NextResponse.json(
          { success: false, error: 'There is no correction resolution currently in progress for this project.', code: 'NO_CORRECTION_IN_PROGRESS' },
          { status: 400, headers: NO_STORE }
        );
      case 'AMBIGUOUS_CORRECTION_REQUEST':
        return NextResponse.json(
          { success: false, error: 'Multiple unresolved correction requests exist. Action cannot be completed unambiguously.', code: 'AMBIGUOUS_CORRECTION_REQUEST' },
          { status: 409, headers: NO_STORE }
        );
      case 'MEDIA_ACCESSIBILITY_REQUIRED':
        return NextResponse.json(
          { success: false, error: 'The snapshot image needs alt text before a participant preview can be generated. Request changes, add it in the project media section, then approve again.', code: 'MEDIA_ACCESSIBILITY_REQUIRED' },
          { status: 409, headers: NO_STORE }
        );
      case 'PUBLICATION_IN_PROGRESS':
        return NextResponse.json(
          { success: false, error: 'Publication is currently in progress for this project.', code: 'PUBLICATION_IN_PROGRESS' },
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
