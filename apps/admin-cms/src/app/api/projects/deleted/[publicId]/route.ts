import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '../../../../../auth/requireAdmin';
import { AdminAuthError } from '../../../../../auth/authTypes';
import { hasPermission } from '../../../../../auth/permissions';
import { getAuthErrorHttpStatus, getPublicAuthErrorMessage } from '../../../../../auth/authHttp';
import { validateSameOrigin } from '../../../../../auth/csrf';
import { createSupabaseAdminClient } from '../../../../../lib/supabase/admin';
import { SupabaseDeletedProjectMaintenanceGateway } from '../../../../../recovery/SupabaseDeletedProjectMaintenanceGateway';
import { recoverDeletedProjectInputSchema } from '../../../../../recovery/deletedProjectMaintenance';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const;
const MAX_REQUEST_BYTES = 2_048;

async function readBoundedBody(request: NextRequest): Promise<unknown | NextResponse> {
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    if (!part.value) continue;
    size += part.value.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      await reader.cancel().catch(() => undefined);
      return NextResponse.json({ success: false, error: 'Request too large.' }, { status: 413, headers: NO_STORE_HEADERS });
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; } catch { return {}; }
}

function authDenied(admin: Awaited<ReturnType<typeof requireAdmin>>) {
  return !hasPermission(admin.permissions, 'projects.delete') || !admin.roles.includes('admin');
}

function failure(error: unknown, fallback: string): NextResponse {
  if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: getPublicAuthErrorMessage(error.type) }, { status: getAuthErrorHttpStatus(error.type), headers: NO_STORE_HEADERS });
  console.error('[Deleted project API]: INTERNAL_FAILURE');
  return NextResponse.json({ success: false, error: fallback }, { status: 500, headers: NO_STORE_HEADERS });
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ publicId: string }> }): Promise<NextResponse> {
  try {
    const admin = await requireAdmin();
    if (authDenied(admin)) return NextResponse.json({ success: false, error: getPublicAuthErrorMessage('PERMISSION_DENIED') }, { status: 403, headers: NO_STORE_HEADERS });
    const { publicId } = await params;
    if (!/^[A-Za-z0-9_-]{1,100}$/u.test(publicId)) return NextResponse.json({ success: false, error: 'Validation failed.' }, { status: 400, headers: NO_STORE_HEADERS });
    const detail = await new SupabaseDeletedProjectMaintenanceGateway(createSupabaseAdminClient()).detail(publicId, admin.adminUserId);
    if (!detail) return NextResponse.json({ success: false, error: 'Deleted project not found.' }, { status: 404, headers: NO_STORE_HEADERS });
    return NextResponse.json({ success: true, detail }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return failure(error, 'Deleted project details could not be loaded.');
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ publicId: string }> }): Promise<NextResponse> {
  try {
    if (!validateSameOrigin(request.headers.get('origin'), request.nextUrl.origin)) return NextResponse.json({ success: false, error: 'The request was not accepted.' }, { status: 403, headers: NO_STORE_HEADERS });
    const length = request.headers.get('content-length');
    if (length !== null && (!/^\d+$/u.test(length) || Number(length) > MAX_REQUEST_BYTES)) return NextResponse.json({ success: false, error: 'Validation failed.' }, { status: 413, headers: NO_STORE_HEADERS });
    const admin = await requireAdmin();
    if (authDenied(admin)) return NextResponse.json({ success: false, error: getPublicAuthErrorMessage('PERMISSION_DENIED') }, { status: 403, headers: NO_STORE_HEADERS });
    const { publicId } = await params;
    const body = await readBoundedBody(request);
    if (body instanceof NextResponse) return body;
    const parsed = recoverDeletedProjectInputSchema.safeParse({ ...(typeof body === 'object' && body !== null ? body : {}), publicId });
    if (!parsed.success) return NextResponse.json({ success: false, error: 'Validation failed.' }, { status: 400, headers: NO_STORE_HEADERS });
    const result = await new SupabaseDeletedProjectMaintenanceGateway(createSupabaseAdminClient()).recover({ ...parsed.data, adminId: admin.adminUserId });
    if (result.resultCode === 'RECOVERED' || result.resultCode === 'ALREADY_RECOVERED') return NextResponse.json({ success: true, result }, { headers: NO_STORE_HEADERS });
    return NextResponse.json({ success: false, code: result.resultCode, error: typeof result.reason === 'string' ? result.reason : 'Recovery was not completed.' }, { status: 409, headers: NO_STORE_HEADERS });
  } catch (error) {
    return failure(error, 'Deleted project recovery could not be completed.');
  }
}
