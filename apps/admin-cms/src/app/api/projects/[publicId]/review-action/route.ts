import { NextRequest, NextResponse } from 'next/server';
import { SupabaseProjectRepository } from '../../../../../repositories/SupabaseProjectRepository';
import { requireAdmin } from '../../../../../auth/requireAdmin';
import { canPerformReviewAction } from '../../../../../auth/permissions';
import { validateSameOrigin } from '../../../../../auth/csrf';
import { AdminAuthError } from '../../../../../auth/authTypes';

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
    const host = request.headers.get('host');
    if (!validateSameOrigin(origin, host)) {
      return NextResponse.json(
        { success: false, error: 'CSRF Blocked: cross-origin requests are not allowed.' },
        { status: 403 }
      );
    }

    // 2. Authenticate the User
    const adminContext = await requireAdmin();

    // 3. Parse Parameters and Request Body
    const { publicId } = await params;
    const body = await request.json().catch(() => null);

    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { success: false, error: 'Invalid input', message: 'Body must be a valid JSON object.' },
        { status: 400 }
      );
    }

    const { action, comments } = body;

    if (!action || !['request_changes', 'approve', 'archive'].includes(action)) {
      return NextResponse.json(
        {
          success: false,
          error: 'Invalid action parameter',
          message: 'Action must be "request_changes", "approve", or "archive".'
        },
        { status: 400 }
      );
    }

    // 4. Authorize Action Permission
    if (!canPerformReviewAction(adminContext.permissions, action)) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized: lacking review permission for this action.' },
        { status: 403 }
      );
    }

    const repository = new SupabaseProjectRepository();

    // Verify project exists (Distinguishable check)
    const project = await repository.getProjectByPublicId(publicId);
    if (!project) {
      return NextResponse.json(
        { success: false, error: 'Project not found', message: `No project with ID ${publicId} exists.` },
        { status: 404 }
      );
    }

    // 5. Execute Action using authenticated admin user ID
    const updatedProject = await repository.performReviewAction({
      publicId,
      action,
      comments: comments || undefined,
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
      const status = error.type === 'UNAUTHENTICATED' ? 401 : 403;
      return NextResponse.json(
        { success: false, error: error.message },
        { status }
      );
    }

    const errMessage = error instanceof Error ? error.message : String(error);
    console.error('[Workflow Action API Error]:', errMessage);

    const isAuditFailure = errMessage.includes('audit logging failed');
    if (isAuditFailure) {
      return NextResponse.json(
        {
          success: false,
          error: 'Audit logging failed',
          message: 'Project status update completed but audit logging failed; staging data may require manual reset.'
        },
        { status: 500 }
      );
    }

    return NextResponse.json(
      {
        success: false,
        error: 'Staging Action Rejected',
        message: 'Internal database processing failure.'
      },
      { status: 500 }
    );
  }
}
