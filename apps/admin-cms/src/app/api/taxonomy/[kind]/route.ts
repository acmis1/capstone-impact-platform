import { NextRequest, NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { requireAdmin } from '../../../../auth/requireAdmin';
import { canManageTaxonomy } from '../../../../auth/permissions';
import { validateSameOrigin } from '../../../../auth/csrf';
import { AdminAuthError } from '../../../../auth/authTypes';
import { getAuthErrorHttpStatus, getPublicAuthErrorMessage } from '../../../../auth/authHttp';
import { createSupabaseAdminClient } from '../../../../lib/supabase/admin';
import { SupabaseTaxonomyGateway } from '../../../../taxonomy/SupabaseTaxonomyGateway';
import {
  createTaxonomyEntry,
  parseTaxonomyKind,
  removeTaxonomyEntry,
  type TaxonomyActionResult,
} from '../../../../taxonomy/taxonomy';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const;
const MAX_REQUEST_BYTES = 2_048;

type RouteContext = { params: Promise<{ kind: string }> };

function statusFor(result: TaxonomyActionResult): number {
  if (result.ok) return result.code === 'CREATED' ? 201 : 200;
  switch (result.code) {
    case 'INVALID_INPUT': return 400;
    case 'DUPLICATE':
    case 'IN_USE': return 409;
    case 'NOT_FOUND': return 404;
    case 'PERSISTENCE_FAILED': return 500;
  }
  return 500;
}

function bodyTooLarge(request: NextRequest): boolean {
  const length = request.headers.get('content-length');
  return length !== null && /^\d+$/.test(length) && Number(length) > MAX_REQUEST_BYTES;
}

async function resolveAuthorizedKind(request: NextRequest, context: RouteContext) {
  if (!validateSameOrigin(request.headers.get('origin'), request.nextUrl.origin)) {
    return { response: NextResponse.json({ success: false, code: 'CROSS_ORIGIN_REJECTED', error: 'The request was not accepted.' }, { status: 403, headers: NO_STORE_HEADERS }) };
  }
  const kind = parseTaxonomyKind((await context.params).kind);
  if (!kind) {
    return { response: NextResponse.json({ success: false, code: 'NOT_FOUND', error: 'The requested catalogue was not found.' }, { status: 404, headers: NO_STORE_HEADERS }) };
  }
  if (bodyTooLarge(request)) {
    return { response: NextResponse.json({ success: false, code: 'INVALID_INPUT', error: 'Validation failed.' }, { status: 413, headers: NO_STORE_HEADERS }) };
  }

  const adminContext = await requireAdmin();
  if (!canManageTaxonomy(adminContext.permissions)) {
    return { response: NextResponse.json({ success: false, code: 'PERMISSION_DENIED', error: getPublicAuthErrorMessage('PERMISSION_DENIED') }, { status: 403, headers: NO_STORE_HEADERS }) };
  }
  return { kind };
}

/** Admin-only catalogue creation. The acting user's authority is derived exclusively from the session. */
export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const authorized = await resolveAuthorizedKind(request, context);
    if ('response' in authorized && authorized.response) return authorized.response;
    const body = await request.json().catch(() => null);
    const result = await createTaxonomyEntry(
      new SupabaseTaxonomyGateway(createSupabaseAdminClient()),
      authorized.kind,
      body,
    );
    if (result.ok) revalidatePath('/admin/taxonomy');
    return NextResponse.json({ success: result.ok, ...result }, { status: statusFor(result), headers: NO_STORE_HEADERS });
  } catch (error) {
    if (error instanceof AdminAuthError) {
      return NextResponse.json({ success: false, code: error.type, error: getPublicAuthErrorMessage(error.type) }, { status: getAuthErrorHttpStatus(error.type), headers: NO_STORE_HEADERS });
    }
    console.error('[Taxonomy API]: INTERNAL_FAILURE');
    return NextResponse.json({ success: false, code: 'PERSISTENCE_FAILED', error: 'The catalogue change could not be completed. Try again.' }, { status: 500, headers: NO_STORE_HEADERS });
  }
}

/** Deletes only an unused catalogue row; referenced values fail closed before DELETE is issued. */
export async function DELETE(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const authorized = await resolveAuthorizedKind(request, context);
    if ('response' in authorized && authorized.response) return authorized.response;
    const body = await request.json().catch(() => null);
    const result = await removeTaxonomyEntry(
      new SupabaseTaxonomyGateway(createSupabaseAdminClient()),
      authorized.kind,
      body,
    );
    if (result.ok) revalidatePath('/admin/taxonomy');
    return NextResponse.json({ success: result.ok, ...result }, { status: statusFor(result), headers: NO_STORE_HEADERS });
  } catch (error) {
    if (error instanceof AdminAuthError) {
      return NextResponse.json({ success: false, code: error.type, error: getPublicAuthErrorMessage(error.type) }, { status: getAuthErrorHttpStatus(error.type), headers: NO_STORE_HEADERS });
    }
    console.error('[Taxonomy API]: INTERNAL_FAILURE');
    return NextResponse.json({ success: false, code: 'PERSISTENCE_FAILED', error: 'The catalogue change could not be completed. Try again.' }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
