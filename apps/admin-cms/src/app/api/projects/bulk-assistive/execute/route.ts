import { NextRequest, NextResponse } from 'next/server';

import { validateSameOrigin } from '../../../../../auth/csrf';
import { AdminAuthError } from '../../../../../auth/authTypes';
import { getAuthErrorHttpStatus, getPublicAuthErrorMessage } from '../../../../../auth/authHttp';
import { hasPermission } from '../../../../../auth/permissions';
import { requireAdmin } from '../../../../../auth/requireAdmin';
import { validateBulkAssistiveExecuteInput } from '../../../../../auth/bulkAssistiveInput';
import {
  BulkAssistivePermissionError,
  BulkAssistiveExecutionService,
  SupabaseBulkAssistiveExecutionGateway,
  resolveAssistiveExecutionAvailability,
  SupabaseAssistiveWorkerHeartbeatRepository,
  resolveAssistiveWorkerRuntimeIdentity,
  SupabaseAssistiveExecutionControlRepository,
} from '../../../../../assistive-validation';
import { getServerEnv } from '../../../../../lib/env';
import { createSupabaseAdminClient } from '../../../../../lib/supabase/admin';
import { bulkAssistiveRequestSizeRejection } from '../../../../../assistive-validation/domain/bulkExecutionContract';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const;

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    if (!validateSameOrigin(request.headers.get('origin'), request.nextUrl.origin)) {
      return NextResponse.json(
        { success: false, error: getPublicAuthErrorMessage('PERMISSION_DENIED') },
        { status: 403, headers: NO_STORE_HEADERS },
      );
    }
    if (bulkAssistiveRequestSizeRejection(request.headers.get('content-length')) !== null) {
      return NextResponse.json(
        { success: false, error: 'Validation failed.' },
        { status: 413, headers: NO_STORE_HEADERS },
      );
    }

    const body = await request.json().catch(() => null);
    const validation = validateBulkAssistiveExecuteInput(body);
    if (!validation.valid) {
      return NextResponse.json(
        { success: false, error: 'Validation failed.' },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }

    const adminContext = await requireAdmin();
    if (!hasPermission(adminContext.permissions, 'projects.edit')) {
      return NextResponse.json(
        { success: false, error: getPublicAuthErrorMessage('PERMISSION_DENIED') },
        { status: 403, headers: NO_STORE_HEADERS },
      );
    }

    const env = getServerEnv();
    const supabase = createSupabaseAdminClient();
    const availability = await resolveAssistiveExecutionAvailability(
      env.supabaseUrl,
      new SupabaseAssistiveWorkerHeartbeatRepository(
        supabase,
        resolveAssistiveWorkerRuntimeIdentity(process.env),
      ),
      new SupabaseAssistiveExecutionControlRepository(supabase),
    );
    const service = new BulkAssistiveExecutionService(
      new SupabaseBulkAssistiveExecutionGateway(supabase, env.SUPABASE_DRAFT_BUCKET),
    );
    const result = await service.execute({
      ...validation.data,
      actor: { adminId: adminContext.adminUserId, permissions: adminContext.permissions },
      availability,
    });
    return NextResponse.json(result, { headers: NO_STORE_HEADERS });
  } catch (error: unknown) {
    if (error instanceof AdminAuthError) {
      return NextResponse.json(
        { success: false, error: getPublicAuthErrorMessage(error.type) },
        { status: getAuthErrorHttpStatus(error.type), headers: NO_STORE_HEADERS },
      );
    }
    if (error instanceof BulkAssistivePermissionError) {
      return NextResponse.json(
        { success: false, error: getPublicAuthErrorMessage('PERMISSION_DENIED') },
        { status: 403, headers: NO_STORE_HEADERS },
      );
    }
    console.error('[Bulk Assistive Execution Error]: INTERNAL_FAILURE');
    return NextResponse.json(
      { success: false, error: 'The bulk assistive operation could not be completed.' },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
