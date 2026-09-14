import { NextRequest, NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { requireAdmin } from '../../../auth/requireAdmin';
import { validateSameOrigin } from '../../../auth/csrf';
import { AdminAuthError } from '../../../auth/authTypes';
import { getAuthErrorHttpStatus, getPublicAuthErrorMessage } from '../../../auth/authHttp';
import { createSupabaseAdminClient } from '../../../lib/supabase/admin';
import { SupabaseLayoutRecipeGateway } from '../../../layout-recipes/SupabaseLayoutRecipeGateway';
import {
  manageLayoutRecipe,
  type LayoutRecipeCommandResult,
} from '../../../layout-recipes/layoutRecipes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const;
const MAX_REQUEST_BYTES = 8_192;

function responseStatus(result: LayoutRecipeCommandResult): number {
  if (result.ok) return result.code === 'CREATED' || result.code === 'DUPLICATED' ? 201 : 200;
  switch (result.code) {
    case 'VALIDATION_FAILED': return 400;
    case 'PERMISSION_DENIED': return 403;
    case 'NOT_FOUND': return 404;
    case 'DUPLICATE_NAME':
    case 'VERSION_CONFLICT': return 409;
    case 'PERSISTENCE_FAILED': return 500;
  }
}

function jsonError(status: number, code: string, error: string): NextResponse {
  return NextResponse.json({ success: false, code, error }, { status, headers: NO_STORE_HEADERS });
}

async function readBoundedJson(request: NextRequest): Promise<{ body: unknown } | { response: NextResponse }> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(declaredLength) || !Number.isSafeInteger(Number(declaredLength))) {
      return { response: jsonError(400, 'VALIDATION_FAILED', 'Validation failed.') };
    }
    if (Number(declaredLength) > MAX_REQUEST_BYTES) {
      return { response: jsonError(413, 'VALIDATION_FAILED', 'Request too large.') };
    }
  }

  const reader = request.body?.getReader();
  if (!reader) return { response: jsonError(400, 'VALIDATION_FAILED', 'Validation failed.') };
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    if (!part.value || part.value.byteLength === 0) continue;
    size += part.value.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      await reader.cancel().catch(() => undefined);
      return { response: jsonError(413, 'VALIDATION_FAILED', 'Request too large.') };
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { body: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
  } catch {
    return { response: jsonError(400, 'VALIDATION_FAILED', 'Validation failed.') };
  }
}

async function authenticatedResponse(error: unknown): Promise<NextResponse> {
  if (error instanceof AdminAuthError) {
    return jsonError(getAuthErrorHttpStatus(error.type), error.type, getPublicAuthErrorMessage(error.type));
  }
  console.error('[Layout recipe API]: INTERNAL_FAILURE');
  return jsonError(500, 'PERSISTENCE_FAILED', 'The layout recipe request could not be completed.');
}

/** All authenticated project staff may read active choices; only administrators may mutate. */
export async function GET(): Promise<NextResponse> {
  try {
    await requireAdmin();
    const recipes = await new SupabaseLayoutRecipeGateway(createSupabaseAdminClient()).list();
    return NextResponse.json(
      { success: true, recipes: recipes.filter((recipe) => recipe.status === 'active') },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    return authenticatedResponse(error);
  }
}

async function mutate(request: NextRequest, allowedActions: readonly string[]): Promise<NextResponse> {
  try {
    if (!validateSameOrigin(request.headers.get('origin'), request.nextUrl.origin)) {
      return jsonError(403, 'CROSS_ORIGIN_REJECTED', 'The request was not accepted.');
    }
    const parsedBody = await readBoundedJson(request);
    if ('response' in parsedBody) return parsedBody.response;
    const action = typeof parsedBody.body === 'object' && parsedBody.body !== null && 'action' in parsedBody.body
      ? (parsedBody.body as { action?: unknown }).action
      : null;
    if (typeof action !== 'string' || !allowedActions.includes(action)) {
      return jsonError(400, 'VALIDATION_FAILED', 'Validation failed.');
    }

    const adminContext = await requireAdmin();
    const result = await manageLayoutRecipe({
      permissions: adminContext.permissions,
      actorAdminId: adminContext.adminUserId,
      gateway: new SupabaseLayoutRecipeGateway(createSupabaseAdminClient()),
      input: parsedBody.body,
    });
    if (result.ok) {
      revalidatePath('/admin/layout-recipes');
      revalidatePath('/admin/imports/new');
    }
    return NextResponse.json(
      { success: result.ok, ...result, ...(!result.ok ? { error: result.message } : {}) },
      { status: responseStatus(result), headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    return authenticatedResponse(error);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return mutate(request, ['create', 'duplicate']);
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  return mutate(request, ['version', 'retire']);
}
