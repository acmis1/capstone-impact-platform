const AUTHORITY_FIELDS = new Set([
  'participantPreviewId', 'previewId', 'projectId', 'initialNotificationId', 'notificationId',
  'recipient', 'recipientEmail', 'participantContactEmail', 'to', 'cc', 'bcc',
  'adminId', 'actorId', 'scheduledBy', 'status', 'executionToken', 'previewToken', 'previewUrl',
]);

export type ScheduleParticipantPreviewReminderInput =
  | { valid: true; scheduledFor: string }
  | { valid: false };

const ABSOLUTE_ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export function parseScheduleParticipantPreviewReminderInput(
  body: unknown,
): ScheduleParticipantPreviewReminderInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { valid: false };
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => AUTHORITY_FIELDS.has(key) || key !== 'scheduledFor')) {
    return { valid: false };
  }
  if (
    typeof record.scheduledFor !== 'string' ||
    record.scheduledFor.length > 64 ||
    !ABSOLUTE_ISO_INSTANT.test(record.scheduledFor)
  ) {
    return { valid: false };
  }
  const instant = Date.parse(record.scheduledFor);
  if (!Number.isFinite(instant)) return { valid: false };
  return { valid: true, scheduledFor: new Date(instant).toISOString() };
}

export type CancelParticipantPreviewReminderInput =
  | { valid: true; reference: string }
  | { valid: false };

export function parseCancelParticipantPreviewReminderInput(
  body: unknown,
): CancelParticipantPreviewReminderInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { valid: false };
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => AUTHORITY_FIELDS.has(key) || key !== 'reference')) {
    return { valid: false };
  }
  if (
    typeof record.reference !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.reference)
  ) {
    return { valid: false };
  }
  return { valid: true, reference: record.reference.toLowerCase() };
}
