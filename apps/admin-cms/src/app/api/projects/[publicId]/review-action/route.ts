import { NextRequest, NextResponse } from 'next/server';
import { SupabaseProjectRepository } from '../../../../../repositories/SupabaseProjectRepository';

/**
 * ⚠️ STAGING ROUTE ONLY:
 * - This endpoint updates project workflows and maps history entries inside capstone-impact-staging.
 * - Proper authentication, CSRF, and supervisor roles checks must be added before production administrative use.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ publicId: string }> }
) {
  try {
    const { publicId } = await params;
    const body = await request.json();

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

    const repository = new SupabaseProjectRepository();
    const updatedProject = await repository.performReviewAction({
      publicId,
      action,
      comments: comments || undefined,
      adminId: null // Staged without auth credentials for now
    });

    return NextResponse.json({
      success: true,
      publicId: updatedProject.publicId,
      status: updatedProject.status,
      action,
      auditRecorded: true
    });
  } catch (error: any) {
    console.error('[Staging Workflow Action API Error]:', error.message || error);

    return NextResponse.json(
      {
        success: false,
        error: 'Staging Action Rejected',
        message: error.message || 'Internal database processing failure.'
      },
      { status: 500 }
    );
  }
}
