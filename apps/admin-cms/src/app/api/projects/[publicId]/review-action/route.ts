import { NextRequest, NextResponse } from 'next/server';
import { SupabaseProjectRepository } from '../../../../../repositories/SupabaseProjectRepository';
import { ReviewActionExecutionError } from '../../../../../repositories/ProjectRepository';
import { requireAdmin } from '../../../../../auth/requireAdmin';
import { canPerformReviewAction } from '../../../../../auth/permissions';
import { validateSameOrigin } from '../../../../../auth/csrf';
import { AdminAuthError } from '../../../../../auth/authTypes';
import { getAuthErrorHttpStatus, getPublicAuthErrorMessage } from '../../../../../auth/authHttp';
import { validateReviewActionInput } from '../../../../../auth/reviewActionInput';

/**
 * Route handler to execute review actions (approve, request_changes, archive) on staging projects.
 * 
 * Rules:
 * - Validates Origin CSRF headers before state changes.
 * - Authenticates session using requireAdmin.
 * - Validates inputs and determines if the user has action permissions.
 * - Ensures database write calls pass the authenticated admin ID.
 * - Eradicates detailed internal stack traces from response errors.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ publicId: string }> }
) {
  try {
    // 1. Same-Origin CSRF Check
    const origin = request.headers.get('origin');
    const requestOrigin = request.nextUrl.origin;
    if (!validateSameOrigin(origin, requestOrigin)) {
      const status = getAuthErrorHttpStatus('PERMISSION_DENIED');
      const error = getPublicAuthErrorMessage('PERMISSION_DENIED');
      return NextResponse.json({ success: false, error }, { status });
    }

    // 2. Authenticate the User
    const adminContext = await requireAdmin();

    // 3. Parse Parameters and Request Body
    const { publicId } = await params;
    const body = await request.json().catch(() => null);

    // 4. Input Validation (Before any database read/write)
    const validation = validateReviewActionInput(body, publicId);
    if (!validation.valid) {
      return NextResponse.json(
        { success: false, error: 'Validation failed.' },
        { status: 400 }
      );
    }

    const { action, comments, publicId: validPublicId } = validation.data;

    // 5. Authorize Action Permission
    if (!canPerformReviewAction(adminContext.permissions, action)) {
      const status = getAuthErrorHttpStatus('PERMISSION_DENIED');
      const error = getPublicAuthErrorMessage('PERMISSION_DENIED');
      return NextResponse.json({ success: false, error }, { status });
    }

    const repository = new SupabaseProjectRepository();

    // 6. Execute Action atomically via PostgreSQL RPC using authenticated admin user ID
    const result = await repository.performReviewAction({
      publicId: validPublicId,
      action,
      comments,
      adminId: adminContext.adminUserId,
    });

    return NextResponse.json({
      success: true,
      publicId: result.publicId,
      status: result.status,
      action,
      auditRecorded: true,
    });
  } catch (error: unknown) {
    if (error instanceof AdminAuthError) {
      const status = getAuthErrorHttpStatus(error.type);
      const errMessage = getPublicAuthErrorMessage(error.type);
      return NextResponse.json(
        { success: false, error: errMessage },
        { status }
      );
    }

    if (error instanceof ReviewActionExecutionError) {
      console.error('[Workflow Action API Error]:', error.code);

      switch (error.code) {
        case 'PROJECT_NOT_FOUND':
          return NextResponse.json(
            { success: false, error: 'Project not found.' },
            { status: 404 }
          );
        case 'TRANSITION_INVALID':
          return NextResponse.json(
            { success: false, error: 'Invalid workflow transition for project state.' },
            { status: 400 }
          );
        case 'PERMISSION_DENIED': {
          const status = getAuthErrorHttpStatus('PERMISSION_DENIED');
          const errMessage = getPublicAuthErrorMessage('PERMISSION_DENIED');
          return NextResponse.json(
            { success: false, error: errMessage },
            { status }
          );
        }
        case 'INPUT_INVALID':
          return NextResponse.json(
            { success: false, error: 'Validation failed.' },
            { status: 400 }
          );
        case 'RESPONSE_INVALID':
        case 'INTERNAL_FAILURE':
        default: {
          const status = getAuthErrorHttpStatus('UNKNOWN');
          const errMessage = getPublicAuthErrorMessage('UNKNOWN');
          return NextResponse.json(
            { success: false, error: errMessage },
            { status }
          );
        }
      }
    }

    console.error('[Workflow Action API Error]: INTERNAL_FAILURE');

    const status = getAuthErrorHttpStatus('UNKNOWN');
    const errMessage = getPublicAuthErrorMessage('UNKNOWN');
    return NextResponse.json(
      { success: false, error: errMessage },
      { status }
    );
  }
}
