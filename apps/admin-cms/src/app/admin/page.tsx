import React from 'react';
import Link from 'next/link';
import { SupabaseProjectRepository } from '../../repositories/SupabaseProjectRepository';
import { ProjectTable } from '../../components/admin/ProjectTable';
import { Project } from '../../domain/project';

// Force dynamic server rendering for real-time staging status check
export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  let projects: Project[] = [];
  let databaseError: string | null = null;

  try {
    const repository = new SupabaseProjectRepository();
    projects = await repository.listProjects();
  } catch (error: any) {
    console.error('[Staging Dashboard Load Failure]:', error.message || error);
    databaseError = error.message || 'Unknown database connection error';
  }

  // Aggregate metrics
  const totalProjects = projects.length;
  const publicEligibleCount = projects.filter(
    (p) => p.status === 'approved' || p.status === 'published'
  ).length;
  const inReviewCount = projects.filter((p) => p.status === 'in_review').length;
  const archivedCount = projects.filter((p) => p.status === 'archived').length;

  return (
    <div style={{
      minHeight: '100vh',
      backgroundColor: '#0B0F19',
      color: '#F3F4F6',
      fontFamily: 'Inter, system-ui, sans-serif',
      padding: '2rem',
    }}>
      <div style={{
        maxWidth: '1200px',
        margin: '0 auto',
      }}>
        {/* Navigation header */}
        <header style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '2rem',
          borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
          paddingBottom: '1rem',
        }}>
          <div>
            <h1 style={{ margin: 0, fontSize: '1.75rem', fontWeight: 800 }}>Admin/CMS Staging Console</h1>
            <p style={{ margin: '0.25rem 0 0 0', fontSize: '0.9rem', color: '#9CA3AF' }}>Operational Workspace — Security & Feed Validation Staged</p>
          </div>
          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <Link href="/admin/imports" style={{
              color: '#10B981',
              textDecoration: 'none',
              fontSize: '0.95rem',
              fontWeight: 600,
              backgroundColor: 'rgba(16, 185, 129, 0.1)',
              padding: '0.5rem 1rem',
              borderRadius: '6px',
              border: '1px solid rgba(16, 185, 129, 0.2)',
              transition: 'background-color 0.2s',
            }}>
              View Import Batches
            </Link>
            <Link href="/" style={{
              color: '#3B82F6',
              textDecoration: 'none',
              fontSize: '0.95rem',
              fontWeight: 600,
              backgroundColor: 'rgba(59, 130, 246, 0.1)',
              padding: '0.5rem 1rem',
              borderRadius: '6px',
              border: '1px solid rgba(59, 130, 246, 0.2)',
              transition: 'background-color 0.2s',
            }}>
              Back to Home
            </Link>
          </div>
        </header>

        {/* ⚠️ Staging Warning Banner */}
        <div style={{
          backgroundColor: 'rgba(245, 158, 11, 0.1)',
          border: '1px solid rgba(245, 158, 11, 0.2)',
          borderRadius: '12px',
          padding: '1.25rem 1.5rem',
          marginBottom: '2rem',
          color: '#F59E0B',
        }}>
          <h4 style={{ margin: '0 0 0.5rem 0', display: 'flex', alignItems: 'center', fontSize: '1rem', fontWeight: 'bold' }}>
            ⚠️ ADMINISTRATIVE STAGING BASELINE WARNING
          </h4>
          <p style={{ margin: 0, fontSize: '0.85rem', lineHeight: '1.5', color: '#D1D5DB' }}>
            This interface runs strictly in <strong>Staging Mode</strong>. No real stakeholder, student personal records, or staff directories are loaded. All workflows, data inputs, and storage mirrors operate on synthesized mock datasets. The live <strong>Duda Presentation Showcase is disconnected</strong> during this semester break development window to prevent visual disruptions on production links. Editing and approval action buttons are locked/not implemented yet.
          </p>
        </div>

        {databaseError ? (
          /* Safe DB Connection Error Display */
          <div style={{
            backgroundColor: 'rgba(239, 68, 68, 0.1)',
            border: '1px solid rgba(239, 68, 68, 0.2)',
            borderRadius: '12px',
            padding: '2rem',
            textAlign: 'center',
            color: '#EF4444',
            marginBottom: '2rem',
          }}>
            <h3 style={{ margin: '0 0 0.75rem 0' }}>Staging Database Connection Offline</h3>
            <p style={{ margin: '0 0 1.5rem 0', color: '#D1D5DB', fontSize: '0.95rem', lineHeight: '1.6' }}>
              The Next.js Admin app is operational, but it failed to establish a secure database connection. Please ensure that you have configured your local <code>.env.local</code> credentials, and applied the necessary database migrations in your Supabase SQL editor.
            </p>
            <div style={{
              backgroundColor: '#0F172A',
              padding: '1rem',
              borderRadius: '8px',
              fontFamily: 'Courier New, monospace',
              fontSize: '0.85rem',
              color: '#F87171',
              display: 'inline-block',
              textAlign: 'left',
              maxWidth: '600px',
              width: '100%',
              overflowX: 'auto',
            }}>
              <strong>Error Trace:</strong> {databaseError}
            </div>
          </div>
        ) : (
          <>
            {/* Summary Cards */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: '1.5rem',
              marginBottom: '2rem',
            }}>
              {/* Card 1: Total Projects */}
              <div style={{
                backgroundColor: '#161F30',
                borderRadius: '12px',
                padding: '1.5rem',
                border: '1px solid rgba(255, 255, 255, 0.05)',
              }}>
                <div style={{ fontSize: '0.85rem', fontWeight: '600', color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Total Projects
                </div>
                <div style={{ fontSize: '2.5rem', fontWeight: '800', color: '#FFFFFF', marginTop: '0.5rem' }}>
                  {totalProjects}
                </div>
              </div>

              {/* Card 2: Approved / Public Eligible */}
              <div style={{
                backgroundColor: '#161F30',
                borderRadius: '12px',
                padding: '1.5rem',
                border: '1px solid rgba(255, 255, 255, 0.05)',
                borderLeft: '4px solid #10B981',
              }}>
                <div style={{ fontSize: '0.85rem', fontWeight: '600', color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Public Showcase Eligible
                </div>
                <div style={{ fontSize: '2.5rem', fontWeight: '800', color: '#10B981', marginTop: '0.5rem' }}>
                  {publicEligibleCount}
                </div>
              </div>

              {/* Card 3: In Review */}
              <div style={{
                backgroundColor: '#161F30',
                borderRadius: '12px',
                padding: '1.5rem',
                border: '1px solid rgba(255, 255, 255, 0.05)',
                borderLeft: '4px solid #F59E0B',
              }}>
                <div style={{ fontSize: '0.85rem', fontWeight: '600', color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Under Review
                </div>
                <div style={{ fontSize: '2.5rem', fontWeight: '800', color: '#F59E0B', marginTop: '0.5rem' }}>
                  {inReviewCount}
                </div>
              </div>

              {/* Card 4: Archived */}
              <div style={{
                backgroundColor: '#161F30',
                borderRadius: '12px',
                padding: '1.5rem',
                border: '1px solid rgba(255, 255, 255, 0.05)',
                borderLeft: '4px solid #9CA3AF',
              }}>
                <div style={{ fontSize: '0.85rem', fontWeight: '600', color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Archived Projects
                </div>
                <div style={{ fontSize: '2.5rem', fontWeight: '800', color: '#9CA3AF', marginTop: '0.5rem' }}>
                  {archivedCount}
                </div>
              </div>
            </div>

            {/* Projects Table Section */}
            <div style={{
              backgroundColor: '#161F30',
              borderRadius: '12px',
              padding: '2rem',
              border: '1px solid rgba(255, 255, 255, 0.05)',
            }}>
              <h2 style={{ fontSize: '1.25rem', margin: 0, color: '#3B82F6', borderBottom: '1px solid rgba(255, 255, 255, 0.05)', paddingBottom: '0.75rem' }}>
                Capstone Projects Repository
              </h2>
              <ProjectTable projects={projects} />
            </div>
          </>
        )}
      </div>
      
      {/* Dynamic CSS Styling overrides for table elements */}
      <style dangerouslySetInnerHTML={{__html: `
        .project-row:hover {
          background-color: #1E293B !important;
        }
      `}} />
    </div>
  );
}
