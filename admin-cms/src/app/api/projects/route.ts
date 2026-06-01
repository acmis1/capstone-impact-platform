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
    // ⚠️ CRITICAL: DO NOT expose database secrets or detailed connection URIs in the client response
    console.error('[Staging Projects API Error]:', error.message || error);
    
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
