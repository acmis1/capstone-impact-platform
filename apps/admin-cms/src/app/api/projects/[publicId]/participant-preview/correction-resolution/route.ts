import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '../../../../../../auth/requireAdmin';
import { validateSameOrigin } from '../../../../../../auth/csrf';
import { AdminAuthError } from '../../../../../../auth/authTypes';
import { getAuthErrorHttpStatus, getPublicAuthErrorMessage } from '../../../../../../auth/authHttp';
import { validatePreviewPublicId } from '../../../../../../auth/participantPreviewInput';
import { canResolveParticipantCorrection } from '../../../../../../auth/permissions';
import { createSupabaseAdminClientCore } from '../../../../../../lib/supabase/adminCore';
import { correctionDecisionSchema, decideParticipantCorrection } from '../../../../../../previews/participantCorrectionReview';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;
const failure = (status: number, error: string) => NextResponse.json({ success: false, error }, { status, headers: NO_STORE });

export async function POST(request: NextRequest, { params }: { params: Promise<{ publicId: string }> }) {
  try {
    if (!validateSameOrigin(request.headers.get('origin'), request.nextUrl.origin)) return failure(403, 'Permission denied.');
    const admin = await requireAdmin();
    if (!canResolveParticipantCorrection(admin.permissions)) return failure(403, 'Permission denied.');
    const selection = validatePreviewPublicId((await params).publicId);
    if (!selection.valid || !request.headers.get('content-type')?.startsWith('application/json')) return failure(400, 'Validation failed.');
    const reader = request.body?.getReader();
    if (!reader) return failure(400, 'Validation failed.');
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 2048) { await reader.cancel(); return failure(413, 'Request too large.'); }
      chunks.push(part.value);
    }
    let raw: unknown;
    try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return failure(400, 'Validation failed.'); }
    const decision = correctionDecisionSchema.safeParse(raw);
    if (!decision.success) return failure(400, 'Validation failed.');
    const result = await decideParticipantCorrection(createSupabaseAdminClientCore(), selection.publicId, admin.adminUserId, decision.data);
    if (!result.success) return failure(result.code === 'PERMISSION_DENIED' ? 403 : 409,
      result.code === 'STALE_REVISION' ? 'The project changed. Reload and review the current evidence.' : 'This revision could not be accepted for that action. Reload and check the correction state.');
    return NextResponse.json({ success: true }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof AdminAuthError) return failure(getAuthErrorHttpStatus(error.type), getPublicAuthErrorMessage(error.type));
    return failure(500, 'Correction review is temporarily unavailable.');
  }
}
