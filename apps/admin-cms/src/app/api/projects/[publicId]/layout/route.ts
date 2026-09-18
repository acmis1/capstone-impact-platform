import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '../../../../../auth/requireAdmin';
import { AdminAuthError } from '../../../../../auth/authTypes';
import { getAuthErrorHttpStatus, getPublicAuthErrorMessage } from '../../../../../auth/authHttp';
import { validateSameOrigin } from '../../../../../auth/csrf';
import { createSupabaseAdminClient } from '../../../../../lib/supabase/admin';
import { SupabaseProjectLayoutMaintenanceGateway } from '../../../../../projects/SupabaseProjectLayoutMaintenanceGateway';
import { ProjectLayoutMaintenancePermissionError, updateProjectLayout } from '../../../../../projects/projectLayoutMaintenance';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const;
const MAX_REQUEST_BYTES = 16_384;

async function readBody(request: NextRequest): Promise<unknown | NextResponse> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_REQUEST_BYTES)) return NextResponse.json({ success: false, error: 'Validation failed.' }, { status: 413, headers: NO_STORE_HEADERS });
  const reader = request.body?.getReader();
  if (!reader) return NextResponse.json({ success: false, error: 'Validation failed.' }, { status: 400, headers: NO_STORE_HEADERS });
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) { const part = await reader.read(); if (part.done) break; if (!part.value) continue; size += part.value.byteLength; if (size > MAX_REQUEST_BYTES) { await reader.cancel().catch(() => undefined); return NextResponse.json({ success: false, error: 'Request too large.' }, { status: 413, headers: NO_STORE_HEADERS }); } chunks.push(part.value); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; } catch { return NextResponse.json({ success: false, error: 'Validation failed.' }, { status: 400, headers: NO_STORE_HEADERS }); }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ publicId: string }> }): Promise<NextResponse> {
  try {
    if (!validateSameOrigin(request.headers.get('origin'), request.nextUrl.origin)) return NextResponse.json({ success: false, error: 'The request was not accepted.' }, { status: 403, headers: NO_STORE_HEADERS });
    const body = await readBody(request); if (body instanceof NextResponse) return body;
    const admin = await requireAdmin();
    const { publicId } = await params;
    const input = typeof body === 'object' && body !== null ? { ...body as Record<string, unknown>, publicId } : { publicId };
    const result = await updateProjectLayout({ actor: { adminId: admin.adminUserId, permissions: admin.permissions, roles: admin.roles }, gateway: new SupabaseProjectLayoutMaintenanceGateway(createSupabaseAdminClient()), input });
    return NextResponse.json({ success: result.resultCode === 'UPDATED' || result.resultCode === 'UNCHANGED', ...result }, { status: result.resultCode === 'UPDATED' || result.resultCode === 'UNCHANGED' ? 200 : result.resultCode === 'PERMISSION_DENIED' ? 403 : result.resultCode === 'STALE_VERSION' ? 409 : 400, headers: NO_STORE_HEADERS });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: getPublicAuthErrorMessage(error.type) }, { status: getAuthErrorHttpStatus(error.type), headers: NO_STORE_HEADERS });
    if (error instanceof ProjectLayoutMaintenancePermissionError) return NextResponse.json({ success: false, error: getPublicAuthErrorMessage('PERMISSION_DENIED') }, { status: 403, headers: NO_STORE_HEADERS });
    console.error('[Project layout API]: INTERNAL_FAILURE');
    return NextResponse.json({ success: false, error: 'The layout change could not be completed.' }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
