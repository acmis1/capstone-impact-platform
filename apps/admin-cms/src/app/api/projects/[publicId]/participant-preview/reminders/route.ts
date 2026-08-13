import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '../../../../../../auth/requireAdmin';
import { canManageParticipantPreview } from '../../../../../../auth/permissions';
import { validateSameOrigin } from '../../../../../../auth/csrf';
import { validatePreviewPublicId } from '../../../../../../auth/participantPreviewInput';
import {
  parseCancelParticipantPreviewReminderInput,
  parseScheduleParticipantPreviewReminderInput,
} from '../../../../../../auth/participantPreviewReminderInput';
import { AdminAuthError } from '../../../../../../auth/authTypes';
import { getAuthErrorHttpStatus, getPublicAuthErrorMessage } from '../../../../../../auth/authHttp';
import { resolveParticipantPreviewEmailConfig } from '../../../../../../notifications/participantPreviewEmailConfig';
import { isParticipantPreviewRemindersEnabled } from '../../../../../../reminders/participantPreviewReminderConfig';
import {
  participantPreviewReminderMessage,
  type ParticipantPreviewReminderResultCode,
} from '../../../../../../reminders/participantPreviewReminder';
import { SupabaseParticipantPreviewReminderRepository } from '../../../../../../repositories/SupabaseParticipantPreviewReminderRepository';
import { ParticipantPreviewReminderRepositoryError } from '../../../../../../repositories/SupabaseParticipantPreviewReminderRepositoryCore';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

function json(code: ParticipantPreviewReminderResultCode, status: number, extra = {}) {
  return NextResponse.json(
    { success: status < 400, code, message: participantPreviewReminderMessage(code), ...extra },
    { status, headers: NO_STORE },
  );
}
function resultStatus(code: string): number {
  switch (code) {
    case 'SCHEDULED':
    case 'ALREADY_SCHEDULED':
    case 'CANCELLED':
    case 'ALREADY_CANCELLED':
      return 200;
    case 'PROJECT_NOT_FOUND':
    case 'REMINDER_NOT_FOUND':
      return 404;
    case 'PREVIEW_PERMISSION_DENIED':
      return 403;
    case 'VALIDATION_FAILED':
    case 'SCHEDULE_NOT_FUTURE':
    case 'SCHEDULE_AFTER_EXPIRY':
      return 400;
    default:
      return 409;
  }
}

function publicCode(code: string): ParticipantPreviewReminderResultCode {
  if (code === 'PREVIEW_PERMISSION_DENIED') return 'PERMISSION_DENIED';
  const allowed = new Set<ParticipantPreviewReminderResultCode>([
    'SCHEDULED', 'ALREADY_SCHEDULED', 'CANCELLED', 'ALREADY_CANCELLED',
    'REMINDER_NOT_CANCELLABLE', 'REMINDER_NOT_FOUND', 'INITIAL_NOTIFICATION_REQUIRED',
    'INITIAL_DELIVERY_NOT_CONFIRMED', 'PREVIEW_CONFIRMED', 'CORRECTION_PENDING',
    'PREVIEW_NOT_ELIGIBLE', 'CONTACT_CHANGED', 'SCHEDULE_NOT_FUTURE',
    'SCHEDULE_AFTER_EXPIRY', 'PROJECT_NOT_FOUND', 'VALIDATION_FAILED',
  ]);
  return allowed.has(code as ParticipantPreviewReminderResultCode)
    ? code as ParticipantPreviewReminderResultCode
    : 'REMINDER_FAILED';
}

async function authorizedProject(request: NextRequest, publicIdParam: string) {
  if (!validateSameOrigin(request.headers.get('origin'), request.nextUrl.origin)) {
    return { response: json('PERMISSION_DENIED', 403) } as const;
  }
  const admin = await requireAdmin();
  if (!canManageParticipantPreview(admin.permissions)) {
    return { response: json('PERMISSION_DENIED', 403) } as const;
  }
  const validation = validatePreviewPublicId(publicIdParam);
  if (!validation.valid) return { response: json('VALIDATION_FAILED', 400) } as const;
  return { admin, publicId: validation.publicId } as const;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ publicId: string }> },
) {
  try {
    const { publicId: publicIdParam } = await params;
    const authorization = await authorizedProject(request, publicIdParam);
    if ('response' in authorization) return authorization.response;

    let body: unknown;
    try { body = await request.json(); } catch { return json('VALIDATION_FAILED', 400); }
    const input = parseScheduleParticipantPreviewReminderInput(body);
    if (!input.valid) return json('VALIDATION_FAILED', 400);

    if (!isParticipantPreviewRemindersEnabled() || !resolveParticipantPreviewEmailConfig().enabled) {
      return json('REMINDERS_DISABLED', 409);
    }

    const result = await new SupabaseParticipantPreviewReminderRepository().schedule({
      publicId: authorization.publicId,
      adminId: authorization.admin.adminUserId,
      scheduledFor: input.scheduledFor,
    });
    const code = publicCode(result.resultCode);
    return json(code, resultStatus(result.resultCode), {
      reminder: result.reference ? {
        reference: result.reference,
        scheduledFor: result.scheduledFor,
        recipient: result.recipient,
        status: result.status,
        createdAt: result.createdAt,
      } : undefined,
    });
  } catch (error: unknown) {
    return handleError(error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ publicId: string }> },
) {
  try {
    const { publicId: publicIdParam } = await params;
    const authorization = await authorizedProject(request, publicIdParam);
    if ('response' in authorization) return authorization.response;

    let body: unknown;
    try { body = await request.json(); } catch { return json('VALIDATION_FAILED', 400); }
    const input = parseCancelParticipantPreviewReminderInput(body);
    if (!input.valid) return json('VALIDATION_FAILED', 400);

    const result = await new SupabaseParticipantPreviewReminderRepository().cancel({
      publicId: authorization.publicId,
      adminId: authorization.admin.adminUserId,
      reference: input.reference,
    });
    const code = publicCode(result.resultCode);
    return json(code, resultStatus(result.resultCode), {
      reminder: result.reference ? {
        reference: result.reference,
        status: result.status,
        cancelledAt: result.cancelledAt,
      } : undefined,
    });
  } catch (error: unknown) {
    return handleError(error);
  }
}

function handleError(error: unknown) {
  if (error instanceof AdminAuthError) {
    const status = getAuthErrorHttpStatus(error.type);
    return NextResponse.json(
      { success: false, code: 'PERMISSION_DENIED', message: getPublicAuthErrorMessage(error.type) },
      { status, headers: NO_STORE },
    );
  }
  if (error instanceof ParticipantPreviewReminderRepositoryError) {
    console.error('[Participant Preview Reminder API Error]:', error.code);
  } else {
    console.error('[Participant Preview Reminder API Error]: INTERNAL_FAILURE');
  }
  return json('REMINDER_FAILED', 500);
}
