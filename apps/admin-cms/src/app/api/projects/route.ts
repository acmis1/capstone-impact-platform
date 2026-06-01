import { NextResponse } from 'next/server';
import { SupabaseProjectRepository } from '../../../repositories/SupabaseProjectRepository';

/**
 * ⚠️ STAGING ROUTE ONLY:
 * - This endpoint fetches project records from the capstone-impact-staging database.
 * - Proper authentication and authorization checks must be added before production or real administrative use.
 */
export async function GET() {
  try {
    const repository = new SupabaseProjectRepository();
    const projects = await repository.listProjects();
    
    return NextResponse.json({
      success: true,
      count: projects.length,
      data: projects
    });
  } catch (error: any) {
    // Log the actual error internally for developer auditing
    console.error('[Staging Projects API Error]:', error.message || error);
    
    // Check if the error is related to permission denied / RLS
    const isPermissionError = error.message && (
      error.message.includes('permission denied') || 
      error.message.includes('42501')
    );

    if (isPermissionError) {
      return NextResponse.json(
        {
          success: false,
          error: 'Database permission denied',
          message: 'The staging database is reachable, but the server key is not being treated as elevated access. Check whether SUPABASE_SECRET_KEY is supported by the current client path or use SUPABASE_SERVICE_ROLE_KEY as temporary staging fallback.'
        },
        { status: 403 }
      );
    }
    
    return NextResponse.json(
      {
        success: false,
        error: 'Database connection failed or tables are not scaffolded.',
        message: 'Ensure the migrations have been applied manually and local .env.local file is configured.'
      },
      { status: 500 }
    );
  }
}
