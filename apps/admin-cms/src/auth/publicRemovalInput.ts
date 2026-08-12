import { validatePreviewPublicId } from './participantPreviewInput';

export type PublicRemovalInputResult =
  | { valid: true; publicId: string; archiveReason: string }
  | { valid: false };

export function validatePublicRemovalInput(body: unknown, publicIdValue: unknown): PublicRemovalInputResult {
  const publicId = validatePreviewPublicId(publicIdValue);
  if (!publicId.valid || body === null || typeof body !== 'object' || Array.isArray(body)) return { valid: false };
  const reason = (body as Record<string, unknown>).archiveReason;
  if (typeof reason !== 'string') return { valid: false };
  const archiveReason = reason.trim();
  if (archiveReason.length === 0 || archiveReason.length > 4000) return { valid: false };
  return { valid: true, publicId: publicId.publicId, archiveReason };
}
