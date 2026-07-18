import { NextRequest, NextResponse } from 'next/server';
import { SupabaseProjectRepository } from '../../../../../repositories/SupabaseProjectRepository';
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

    // Verify project exists
    const project = await repository.getProjectByPublicId(validPublicId);
    if (!project) {
      return NextResponse.json(
        { success: false, error: 'Project not found.' },
        { status: 404 }
      );
    }

    // 6. Execute Action using authenticated admin user ID
    const updatedProject = await repository.performReviewAction({
      publicId: validPublicId,
      action,
      comments,
      adminId: adminContext.adminUserId
    });

    return NextResponse.json({
      success: true,
      publicId: updatedProject.publicId,
      status: updatedProject.status,
      action,
      auditRecorded: true
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

    console.error('[Workflow Action API Error]:', error instanceof Error ? error.message : String(error));

    const status = getAuthErrorHttpStatus('UNKNOWN');
    const errMessage = getPublicAuthErrorMessage('UNKNOWN');
    return NextResponse.json(
      { success: false, error: errMessage },
      { status }
    );
  }
}
