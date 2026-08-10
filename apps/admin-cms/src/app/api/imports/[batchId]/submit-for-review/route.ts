import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '../../../../../auth/requireAdmin';
import { hasPermission } from '../../../../../auth/permissions';
import { validateSameOrigin } from '../../../../../auth/csrf';
import { AdminAuthError } from '../../../../../auth/authTypes';
import { getAuthErrorHttpStatus, getPublicAuthErrorMessage } from '../../../../../auth/authHttp';
import { validateSubmitForReviewInput } from '../../../../../auth/submitForReviewInput';
import {
  submitImportProjectsForReview,
  SubmitForReviewExecutionError,
} from '../../../../../import/submitImportProjectsForReview';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const;

/**
 * Route handler to submit one or more prepared imported projects from a completed import batch
 * into the administrative review workflow (draft/changes_requested -> submitted).
 *
 * Rules:
 * - Validates Origin CSRF headers before any state change.
 * - Authenticates the session using requireAdmin (never trusts a client-supplied admin ID).
 * - Requires projects.edit — this is a preparation/editing action, not an approval action.
 * - Delegates all eligibility, readiness, atomicity, and idempotency guarantees to the
 *   submit_import_projects_for_review RPC; never trusts browser-supplied readiness flags.
 * - Eradicates detailed internal error/database details from response errors.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ batchId: string }> }
) {
  try {
    // 1. Same-Origin CSRF Check
    const origin = request.headers.get('origin');
    const requestOrigin = request.nextUrl.origin;
    if (!validateSameOrigin(origin, requestOrigin)) {
      const status = getAuthErrorHttpStatus('PERMISSION_DENIED');
      const error = getPublicAuthErrorMessage('PERMISSION_DENIED');
      return NextResponse.json({ success: false, error }, { status, headers: NO_STORE_HEADERS });
    }

    // 2. Authenticate the User
    const adminContext = await requireAdmin();

    // 3. Parse Parameters and Request Body
    const { batchId } = await params;
    const body = await request.json().catch(() => null);

    // 4. Input Validation (Before any database read/write)
    const validation = validateSubmitForReviewInput(body, batchId);
    if (!validation.valid) {
      return NextResponse.json(
        { success: false, error: 'Validation failed.' },
        { status: 400, headers: NO_STORE_HEADERS }
      );
    }

    // 5. Authorize: submission is a preparation/editing action, never an approval action.
    if (!hasPermission(adminContext.permissions, 'projects.edit')) {
      const status = getAuthErrorHttpStatus('PERMISSION_DENIED');
      const error = getPublicAuthErrorMessage('PERMISSION_DENIED');
      return NextResponse.json({ success: false, error }, { status, headers: NO_STORE_HEADERS });
    }

    const { batchId: validBatchId, projectPublicIds, comments } = validation.data;

    // 6. Execute atomically via PostgreSQL RPC using the authenticated admin user ID
    const result = await submitImportProjectsForReview({
      batchId: validBatchId,
      projectPublicIds,
      adminId: adminContext.adminUserId,
      comments,
    });

    return NextResponse.json(
      {
        success: true,
        batchId: result.batchId,
        submittedCount: result.submittedCount,
        alreadySubmittedPublicIds: result.alreadySubmittedPublicIds,
        results: result.results,
      },
      { headers: NO_STORE_HEADERS }
    );
  } catch (error: unknown) {
    if (error instanceof AdminAuthError) {
      const status = getAuthErrorHttpStatus(error.type);
      const errMessage = getPublicAuthErrorMessage(error.type);
      return NextResponse.json({ success: false, error: errMessage }, { status, headers: NO_STORE_HEADERS });
    }

    if (error instanceof SubmitForReviewExecutionError) {
      console.error('[Submit For Review API Error]:', error.code);

      switch (error.code) {
        case 'BATCH_NOT_FOUND':
          return NextResponse.json(
            { success: false, error: 'Import batch not found.' },
            { status: 404, headers: NO_STORE_HEADERS }
          );
        case 'INVALID_BATCH_STATE':
          return NextResponse.json(
            { success: false, error: 'Import batch is not in a completed state.' },
            { status: 400, headers: NO_STORE_HEADERS }
          );
        case 'PROJECT_NOT_IN_BATCH':
          return NextResponse.json(
            { success: false, error: 'One or more selected projects do not belong to this import batch.' },
            { status: 400, headers: NO_STORE_HEADERS }
          );
        case 'INVALID_PROJECT_STATE':
          return NextResponse.json(
            {
              success: false,
              error: 'One or more selected projects are not in a submittable workflow state.',
              publicId: error.publicId,
            },
            { status: 409, headers: NO_STORE_HEADERS }
          );
        case 'READINESS_BLOCKED':
          return NextResponse.json(
            {
              success: false,
              error: 'One or more selected projects are not ready for review submission.',
              publicId: error.publicId,
              blockingReasons: error.blockingReasons,
            },
            { status: 400, headers: NO_STORE_HEADERS }
          );
        case 'INVALID_SELECTION':
          return NextResponse.json(
            { success: false, error: 'Validation failed.' },
            { status: 400, headers: NO_STORE_HEADERS }
          );
        case 'SUBMIT_PERMISSION_DENIED': {
          const status = getAuthErrorHttpStatus('PERMISSION_DENIED');
          const errMessage = getPublicAuthErrorMessage('PERMISSION_DENIED');
          return NextResponse.json({ success: false, error: errMessage }, { status, headers: NO_STORE_HEADERS });
        }
        case 'RESPONSE_INVALID':
        case 'INTERNAL_FAILURE':
        default: {
          const status = getAuthErrorHttpStatus('UNKNOWN');
          const errMessage = getPublicAuthErrorMessage('UNKNOWN');
          return NextResponse.json({ success: false, error: errMessage }, { status, headers: NO_STORE_HEADERS });
        }
      }
    }

    console.error('[Submit For Review API Error]: INTERNAL_FAILURE');

    const status = getAuthErrorHttpStatus('UNKNOWN');
    const errMessage = getPublicAuthErrorMessage('UNKNOWN');
    return NextResponse.json({ success: false, error: errMessage }, { status, headers: NO_STORE_HEADERS });
  }
}
