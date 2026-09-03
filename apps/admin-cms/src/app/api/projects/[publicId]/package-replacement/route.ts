import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '../../../../../auth/requireAdmin';
import { validateSameOrigin } from '../../../../../auth/csrf';
import { AdminAuthError } from '../../../../../auth/authTypes';
import { getAuthErrorHttpStatus, getPublicAuthErrorMessage } from '../../../../../auth/authHttp';
import { validatePreviewPublicId } from '../../../../../auth/participantPreviewInput';
import { canResolveParticipantCorrection } from '../../../../../auth/permissions';
import { createSupabaseAdminClientCore } from '../../../../../lib/supabase/adminCore';
import { CorrectionPackageError, parseParticipantCorrectionPackage, readCorrectionBody } from '../../../../../previews/participantCorrectionPackage';
import { stagePrePreviewReplacement } from '../../../../../previews/participantCorrectionService';
import { acquireCorrectionUpload } from '../../../../../previews/correctionUploadGuard';

const headers = { 'Cache-Control': 'no-store' };
const failure = (status: number, error: string) => NextResponse.json({ success: false, error }, { status, headers });

export async function POST(request: NextRequest, { params }: { params: Promise<{ publicId: string }> }) {
  try {
    if (!validateSameOrigin(request.headers.get('origin'), request.nextUrl.origin)) return failure(403, 'Permission denied.');
    const admin = await requireAdmin();
    if (!canResolveParticipantCorrection(admin.permissions)) return failure(403, 'Permission denied.');
    const selection = validatePreviewPublicId((await params).publicId);
    if (!selection.valid) return failure(400, 'Invalid project selection.');
    const client = createSupabaseAdminClientCore();
    const context = await client.rpc('pre_preview_package_context', { p_public_id: selection.publicId, p_admin_id: admin.adminUserId });
    if (context.error || context.data?.resultCode !== 'SUCCESS') return failure(409, 'Package replacement is unavailable. Reload to check the project and package review state.');
    // The reservation boundary enforces freeze/quota and recognizes exact retries,
    // including a third completed upload whose response was lost in transport.
    const release = acquireCorrectionUpload();
    if (!release) return failure(429, 'Another package is being processed. Try again shortly.');
    try {
      const candidate = await parseParticipantCorrectionPackage(await readCorrectionBody(request), selection.publicId);
      const result = await stagePrePreviewReplacement(client, selection.publicId, admin.adminUserId, candidate);
      if (result === 'lookup') return failure(400, 'The workbook must use supported program, discipline and industry names.');
      if (result === 'limit') return failure(409, 'This project revision has reached its three-package allowance.');
      if (result !== 'submitted') return failure(409, 'The package could not be submitted. Retry the same files or reload to check the review state.');
      return NextResponse.json({ success: true }, { headers });
    } finally { release(); }
  } catch (error) {
    if (error instanceof AdminAuthError) return failure(getAuthErrorHttpStatus(error.type), getPublicAuthErrorMessage(error.type));
    if (error instanceof CorrectionPackageError) return failure(400, error.message);
    return failure(500, 'Package replacement is temporarily unavailable.');
  }
}
