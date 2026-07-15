import { NextResponse } from 'next/server';
import { SupabaseProjectRepository } from '../../../repositories/SupabaseProjectRepository';
import { requireAdmin } from '../../../auth/requireAdmin';
import { AdminAuthError } from '../../../auth/authTypes';
import { hasPermission } from '../../../auth/permissions';
import { getAuthErrorHttpStatus, getPublicAuthErrorMessage } from '../../../auth/authHttp';

/**
 * Endpoint to fetch project records from the staging database.
 * 
 * Rules:
 * - Requires 'projects.read' permission.
 * - Returns 401 for unauthenticated sessions.
 * - Returns 403 for unauthorized or unprovisioned requests.
 * - Performs repository query only after authentication & authorization checks succeed.
 */
export async function GET() {
  try {
    // 1. Authenticate and Authorize
    const adminContext = await requireAdmin();
    
    if (!hasPermission(adminContext.permissions, 'projects.read')) {
      const status = getAuthErrorHttpStatus('PERMISSION_DENIED');
      const error = getPublicAuthErrorMessage('PERMISSION_DENIED');
      return NextResponse.json({ success: false, error }, { status });
    }

    // 2. Query repository after authorization success
    const repository = new SupabaseProjectRepository();
    const projects = await repository.listProjects();
    
    return NextResponse.json({
      success: true,
      count: projects.length,
      data: projects
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
    
    // Log the actual error internally for developer auditing
    console.error('[Projects API Error]:', error instanceof Error ? error.message : String(error));
    
    const status = getAuthErrorHttpStatus('UNKNOWN');
    const errMessage = getPublicAuthErrorMessage('UNKNOWN');
    return NextResponse.json(
      { success: false, error: errMessage },
      { status }
    );
  }
}
