import React from 'react';
import Link from 'next/link';
import { SupabaseProjectRepository } from '../../../../repositories/SupabaseProjectRepository';
import { ProjectStatusBadge } from '../../../../components/admin/ProjectStatusBadge';
import { ProjectDetailSection } from '../../../../components/admin/ProjectDetailSection';
import { ProjectMediaSummary } from '../../../../components/admin/ProjectMediaSummary';
import { ProjectValidationSummary } from '../../../../components/admin/ProjectValidationSummary';
import { StagingReviewActions } from '../../../../components/admin/StagingReviewActions';
import { getAllowedReviewActions, ProjectStatus } from '../../../../workflow/projectWorkflow';
import { createSupabaseAdminClientCore } from '../../../../lib/supabase/adminCore';
import { Project } from '../../../../domain/project';

// Force dynamic server rendering for real-time detail load
export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{
    publicId: string;
  }>;
}

export default async function ProjectDetailPage({ params }: PageProps) {
  const { publicId } = await params;
  let project: Project | null = null;
  let loadError: string | null = null;
  let auditRecords: Array<Record<string, unknown>> = [];

  try {
    const repository = new SupabaseProjectRepository();
    project = await repository.getProjectByPublicId(publicId);

    if (project) {
      // Fetch recent approval_records for this project
      const supabase = createSupabaseAdminClientCore();
      
      // Resolve UUID for project
      const { data: dbProj } = await supabase
        .from('projects')
        .select('id')
        .eq('public_id', publicId)
        .maybeSingle();

      if (dbProj) {
        const { data: records, error: recordsError } = await supabase
          .from('approval_records')
          .select('*')
          .eq('project_id', dbProj.id)
          .order('created_at', { ascending: false });

        if (!recordsError && records) {
          auditRecords = records;
        }
      }
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown staging error';
    console.error(`[Staging Project Detail Failure]:`, message);
    loadError = message;
  }

  if (loadError) {
    return (
      <div style={{
        minHeight: '100vh',
        backgroundColor: '#0B0F19',
        color: '#F3F4F6',
        fontFamily: 'Inter, system-ui, sans-serif',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
      }}>
        <div style={{
          maxWidth: '500px',
          width: '100%',
          backgroundColor: '#161F30',
          borderRadius: '12px',
          padding: '2rem',
          textAlign: 'center',
          border: '1px solid rgba(239, 68, 68, 0.2)',
        }}>
          <h2 style={{ color: '#EF4444', margin: '0 0 1rem 0' }}>⚠️ Staging Load Failure</h2>
          <p style={{ color: '#9CA3AF', fontSize: '0.95rem', lineHeight: '1.6', marginBottom: '2rem' }}>
            Failed to query staging database project details: {loadError}
          </p>
          <Link href="/admin" style={{
            color: '#FFFFFF',
            backgroundColor: '#3B82F6',
            padding: '0.6rem 1.5rem',
            borderRadius: '6px',
            textDecoration: 'none',
            fontWeight: '600',
            fontSize: '0.9rem'
          }}>
            Return to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  if (!project) {
    return (
      <div style={{
        minHeight: '100vh',
        backgroundColor: '#0B0F19',
        color: '#F3F4F6',
        fontFamily: 'Inter, system-ui, sans-serif',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
      }}>
        <div style={{
          maxWidth: '500px',
          width: '100%',
          backgroundColor: '#161F30',
          borderRadius: '12px',
          padding: '2.5rem',
          border: '1px dashed rgba(255, 255, 255, 0.1)',
          textAlign: 'center',
        }}>
          <h2 style={{ margin: '0 0 0.5rem 0', color: '#F59E0B' }}>🔍 Project Not Found</h2>
          <p style={{ color: '#9CA3AF', fontSize: '0.95rem', lineHeight: '1.6', marginBottom: '2rem' }}>
            Staging project public ID <code>&quot;{publicId}&quot;</code> was not found. Seed records or check search key formats.
          </p>
          <Link href="/admin" style={{
            color: '#FFFFFF',
            backgroundColor: '#3B82F6',
            padding: '0.6rem 1.5rem',
            borderRadius: '6px',
            textDecoration: 'none',
            fontWeight: '600',
            fontSize: '0.9rem'
          }}>
            Return to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  const isEligible = project.status === 'approved' || project.status === 'published';
  const allowedActions = getAllowedReviewActions(project.status as ProjectStatus);

  return (
    <div style={{
      minHeight: '100vh',
      backgroundColor: '#0B0F19',
      color: '#F3F4F6',
      fontFamily: 'Inter, system-ui, sans-serif',
      padding: '2rem',
    }}>
      <div style={{
        maxWidth: '1000px',
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
            <Link href="/admin" style={{
              color: '#3B82F6',
              textDecoration: 'none',
              fontSize: '0.9rem',
              fontWeight: '600',
              display: 'inline-flex',
              alignItems: 'center',
              marginBottom: '0.5rem'
            }}>
              ← Back to Staging Dashboard
            </Link>
            <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 800 }}>Project Ingestion Review</h1>
          </div>
          <div style={{ textAlign: 'right' }}>
            <span style={{ fontSize: '0.8rem', color: '#9CA3AF', display: 'block', marginBottom: '0.25rem' }}>Workflow State:</span>
            <ProjectStatusBadge status={project.status} />
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
            ⚠️ ADMINISTRATIVE REVIEW STAGING SANDBOX
          </h4>
          <p style={{ margin: 0, fontSize: '0.85rem', lineHeight: '1.5', color: '#D1D5DB' }}>
            This detail review operates purely on <strong>Staging Data</strong>. No active coordinator or student personal folders are parsed. Live public feed showcase mirrors (Duda presentation layers) remain disconnected. Editing, publishing, and archiving actions are locked during this summer semester development.
          </p>
        </div>

        {/* Dynamic Action Trigger Panel */}
        <ProjectDetailSection title="⚡ Staging Review Actions" borderColor="#EC4899">
          <StagingReviewActions
            publicId={project.publicId || ''}
            currentStatus={project.status}
            allowedActions={allowedActions}
          />
        </ProjectDetailSection>

        {/* B. Project Overview */}
        <ProjectDetailSection title="Project Overview" borderColor="#3B82F6">
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: '1.5rem',
            fontSize: '0.9rem',
            lineHeight: '1.6'
          }}>
            <div>
              <div style={{ color: '#9CA3AF' }}><strong>Project Title:</strong></div>
              <div style={{ fontSize: '1.1rem', fontWeight: 'bold', color: '#FFFFFF' }}>{project.title}</div>
              
              <div style={{ color: '#9CA3AF', marginTop: '1rem' }}><strong>Public Showcase ID:</strong></div>
              <div><code style={{ backgroundColor: '#1E293B', padding: '0.15rem 0.35rem', borderRadius: '4px', color: '#F59E0B' }}>{project.publicId}</code></div>

              <div style={{ color: '#9CA3AF', marginTop: '1rem' }}><strong>Academic Term (Year):</strong></div>
              <div>{project.year || 'N/A'}</div>

              <div style={{ color: '#9CA3AF', marginTop: '1rem' }}><strong>Study Program & Code:</strong></div>
              <div>{project.program ? `${project.program} (${project.studyProgram || 'N/A'})` : 'N/A'}</div>
            </div>

            <div>
              <div style={{ color: '#9CA3AF' }}><strong>Primary Discipline:</strong></div>
              <div>{project.discipline || 'N/A'}</div>

              <div style={{ color: '#9CA3AF', marginTop: '1rem' }}><strong>Mapped Showcase Disciplines:</strong></div>
              <div>{project.disciplines && project.disciplines.length > 0 ? project.disciplines.join(', ') : 'None'}</div>

              <div style={{ color: '#9CA3AF', marginTop: '1rem' }}><strong>Industry Partner / Area:</strong></div>
              <div>{project.industryPartner ? `${project.industryPartner} (${project.industry || 'N/A'})` : 'N/A'}</div>

              <div style={{ color: '#9CA3AF', marginTop: '1rem' }}><strong>Public Showcase Eligibility:</strong></div>
              <div>
                {isEligible ? (
                  <span style={{ color: '#10B981', fontWeight: 'bold' }}>YES (Eligible for Approved Feed)</span>
                ) : (
                  <span style={{ color: '#EF4444', fontWeight: 'bold' }}>NO (Draft/Reviewing/Archived)</span>
                )}
              </div>
            </div>
          </div>

          <div style={{ marginTop: '1.5rem', borderTop: '1px solid rgba(255, 255, 255, 0.05)', paddingTop: '1rem' }}>
            <div style={{ color: '#9CA3AF', fontSize: '0.85rem' }}><strong>Group Name:</strong> {project.groupName || 'N/A'}</div>
            <div style={{ color: '#9CA3AF', fontSize: '0.85rem', marginTop: '0.25rem' }}>
              <strong>Team Roster:</strong> {project.teamMembers && project.teamMembers.length > 0 ? project.teamMembers.join(', ') : 'None'}
            </div>
            <div style={{ color: '#9CA3AF', fontSize: '0.85rem', marginTop: '0.25rem' }}>
              <strong>Academic Supervisor:</strong> {project.academicSupervisor || 'N/A'}
            </div>
            {project.importBatchId && (
              <div style={{
                marginTop: '1rem',
                backgroundColor: 'rgba(59, 130, 246, 0.05)',
                border: '1px solid rgba(59, 130, 246, 0.1)',
                borderRadius: '8px',
                padding: '0.75rem 1rem',
                fontSize: '0.85rem',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center'
              }}>
                <div>
                  <strong style={{ color: '#60A5FA', display: 'block', fontSize: '0.75rem', textTransform: 'uppercase', marginBottom: '0.15rem' }}>📦 Ingestion Import Source</strong>
                  <span style={{ color: '#D1D5DB' }}>Imported via folder <code>{project.sourceFolder}</code></span>
                </div>
                <div>
                  <Link href={`/admin/imports/${project.importBatchId}`} style={{
                    color: '#3B82F6',
                    textDecoration: 'none',
                    fontWeight: 600,
                    fontSize: '0.8rem',
                    backgroundColor: 'rgba(59, 130, 246, 0.1)',
                    padding: '0.3rem 0.6rem',
                    borderRadius: '4px',
                    border: '1px solid rgba(59, 130, 246, 0.2)'
                  }}>
                    View Import Batch →
                  </Link>
                </div>
              </div>
            )}
          </div>
        </ProjectDetailSection>

        {/* C. Public Showcase Content */}
        <ProjectDetailSection title="Public Showcase Content" borderColor="#8B5CF6">
          <div style={{ fontSize: '0.9rem', lineHeight: '1.6' }}>
            <div style={{ marginBottom: '1rem' }}>
              <div style={{ color: '#9CA3AF', fontWeight: 'bold' }}>Short Summary:</div>
              <p style={{ margin: '0.25rem 0 0 0', color: '#D1D5DB' }}>{project.summary || 'N/A'}</p>
            </div>

            <div style={{ marginBottom: '1rem' }}>
              <div style={{ color: '#9CA3AF', fontWeight: 'bold' }}>Problem Background:</div>
              <p style={{ margin: '0.25rem 0 0 0', color: '#D1D5DB', whiteSpace: 'pre-wrap' }}>{project.background || 'N/A'}</p>
            </div>

            <div style={{ marginBottom: '1rem' }}>
              <div style={{ color: '#9CA3AF', fontWeight: 'bold' }}>Developed Solution:</div>
              <p style={{ margin: '0.25rem 0 0 0', color: '#D1D5DB', whiteSpace: 'pre-wrap' }}>{project.solution || 'N/A'}</p>
            </div>

            <div style={{ marginBottom: '1rem' }}>
              <div style={{ color: '#9CA3AF', fontWeight: 'bold' }}>Accessibility Description (accessibility.txt):</div>
              <p style={{ margin: '0.25rem 0 0 0', color: '#D1D5DB' }}>{project.accessibilityText || 'N/A'}</p>
            </div>

            <div style={{ marginBottom: '1rem' }}>
              <div style={{ color: '#9CA3AF', fontWeight: 'bold' }}>Poster Text Index (OCR / Full Text):</div>
              <p style={{ margin: '0.25rem 0 0 0', color: '#9CA3AF', fontSize: '0.85rem', fontStyle: 'italic' }}>
                {project.posterText || 'N/A'}
              </p>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.5rem', marginTop: '1rem' }}>
              <div>
                <div style={{ color: '#9CA3AF', fontWeight: 'bold' }}>External Citations:</div>
                <ul style={{ margin: '0.25rem 0 0 0', paddingLeft: '1.25rem', color: '#D1D5DB' }}>
                  {project.citations && project.citations.length > 0 ? (
                    project.citations.map((c: string, i: number) => <li key={i}>{c}</li>)
                  ) : (
                    <li>None</li>
                  )}
                </ul>
              </div>

              <div>
                <div style={{ color: '#9CA3AF', fontWeight: 'bold' }}>External Web Links:</div>
                <ul style={{ margin: '0.25rem 0 0 0', paddingLeft: '1.25rem', color: '#D1D5DB' }}>
                  {project.externalLinks && project.externalLinks.length > 0 ? (
                    project.externalLinks.map((link: { label?: string; url: string }, i: number) => (
                      <li key={i}>
                        <a href={link.url} target="_blank" rel="noopener noreferrer" style={{ color: '#3B82F6', textDecoration: 'none' }}>
                          {link.label || link.url}
                        </a>
                      </li>
                    ))
                  ) : (
                    <li>None</li>
                  )}
                </ul>
              </div>
            </div>
          </div>
        </ProjectDetailSection>

        {/* D. Media Review */}
        <ProjectDetailSection title="Staging Media Review" borderColor="#10B981">
          <ProjectMediaSummary project={project} />
        </ProjectDetailSection>

        {/* E. Layout Review */}
        <ProjectDetailSection title="Showcase Grid Layout & Config" borderColor="#F59E0B">
          <div style={{ fontSize: '0.9rem', lineHeight: '1.6' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
              <tbody>
                <tr style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.05)' }}>
                  <th style={{ padding: '0.5rem 0', color: '#9CA3AF', fontWeight: 'normal', width: '200px' }}>Active Template ID</th>
                  <td style={{ padding: '0.5rem 0' }}>
                    <code style={{ backgroundColor: '#1E293B', padding: '0.15rem 0.35rem', borderRadius: '4px', color: '#3B82F6' }}>
                      {project.layoutConfig?.templateId || 'default'}
                    </code>
                  </td>
                </tr>

                <tr style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.05)' }}>
                  <th style={{ padding: '0.5rem 0', color: '#9CA3AF', fontWeight: 'normal' }}>Featured Media Focus</th>
                  <td style={{ padding: '0.5rem 0' }}>
                    <span style={{ textTransform: 'capitalize' }}>
                      {project.layoutConfig?.featuredMedia || 'None'}
                    </span>
                  </td>
                </tr>

                <tr style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.05)' }}>
                  <th style={{ padding: '0.5rem 0', color: '#9CA3AF', fontWeight: 'normal' }}>Section Ordering</th>
                  <td style={{ padding: '0.5rem 0' }}>
                    {project.layoutConfig?.sectionOrder ? (
                      project.layoutConfig.sectionOrder.join(' → ')
                    ) : (
                      <span style={{ color: '#9CA3AF' }}>Default order</span>
                    )}
                  </td>
                </tr>

                {project.layoutConfig?.hiddenSections && (
                  <tr>
                    <th style={{ padding: '0.5rem 0', color: '#9CA3AF', fontWeight: 'normal' }}>Hidden Sections</th>
                    <td style={{ padding: '0.5rem 0', color: '#EF4444' }}>
                      {project.layoutConfig.hiddenSections.join(', ')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </ProjectDetailSection>

        {/* F. Internal/Staging Diagnostics & Compliance */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(450px, 1fr))',
          gap: '1.5rem'
        }}>
          {/* Validation card */}
          <ProjectDetailSection title="Staging Compliance & Validation Summary" borderColor="#EC4899">
            <ProjectValidationSummary project={project} />
          </ProjectDetailSection>

          {/* System Audit card */}
          <ProjectDetailSection title="Staging Internal System Audit" borderColor="#6B7280">
            <div style={{ fontSize: '0.85rem', lineHeight: '1.6', color: '#D1D5DB' }}>
              <div><strong>Validation Errors (Cached):</strong> {project.validationErrors?.length || 0}</div>
              <div><strong>Validation Warnings (Cached):</strong> {project.validationWarnings?.length || 0}</div>
              
              <div style={{ marginTop: '0.75rem' }}>
                <strong>Pending Showcase Removal:</strong>{' '}
                <span style={{ color: project.pendingRemovalFromPublic ? '#EF4444' : '#10B981', fontWeight: 'bold' }}>
                  {project.pendingRemovalFromPublic ? '⚠️ YES' : 'NO'}
                </span>
              </div>

              {project.status === 'archived' && (
                <div style={{
                  marginTop: '0.75rem',
                  backgroundColor: 'rgba(255, 255, 255, 0.02)',
                  borderRadius: '6px',
                  padding: '0.5rem 0.75rem',
                  border: '1px solid rgba(255, 255, 255, 0.05)'
                }}>
                  <div><strong>Archived Timestamp:</strong> {project.archivedAt || 'N/A'}</div>
                  <div style={{ marginTop: '0.25rem' }}><strong>Archival Reason:</strong> {project.archiveReason || 'N/A'}</div>
                </div>
              )}

              <div style={{
                marginTop: '1rem',
                borderTop: '1px solid rgba(255, 255, 255, 0.05)',
                paddingTop: '0.75rem',
                fontSize: '0.8rem',
                color: '#9CA3AF'
              }}>
                <div><strong>System Created At:</strong> {project.created_at || 'N/A'}</div>
                <div><strong>System Updated At:</strong> {project.updated_at || 'N/A'}</div>
              </div>
            </div>
          </ProjectDetailSection>
        </div>

        {/* Audit Log / Change History */}
        <div style={{ marginTop: '1.5rem' }}>
          <ProjectDetailSection title="📜 Staging Change & Audit Logs" borderColor="#6B7280">
            {auditRecords.length === 0 ? (
              <p style={{ margin: 0, fontSize: '0.85rem', color: '#9CA3AF', fontStyle: 'italic' }}>
                No review action logs recorded for this staging project.
              </p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.1)', color: '#9CA3AF' }}>
                      <th style={{ padding: '0.5rem', fontWeight: '600' }}>Timestamp</th>
                      <th style={{ padding: '0.5rem', fontWeight: '600' }}>Action Taken</th>
                      <th style={{ padding: '0.5rem', fontWeight: '600' }}>Transition</th>
                      <th style={{ padding: '0.5rem', fontWeight: '600' }}>Comments/Audit Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditRecords.map((rec) => (
                      <tr key={String(rec.id || '')} style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.05)', color: '#D1D5DB' }}>
                        <td style={{ padding: '0.5rem', fontSize: '0.8rem', color: '#9CA3AF' }}>
                          {rec.created_at ? new Date(String(rec.created_at)).toLocaleString() : 'N/A'}
                        </td>
                        <td style={{ padding: '0.5rem', fontWeight: 'bold' }}>
                          <span style={{
                            display: 'inline-block',
                            padding: '0.15rem 0.4rem',
                            borderRadius: '4px',
                            backgroundColor: 'rgba(255, 255, 255, 0.05)',
                            fontSize: '0.75rem',
                            textTransform: 'uppercase'
                          }}>
                            {String(rec.action_taken || '').replace('_', ' ')}
                          </span>
                        </td>
                        <td style={{ padding: '0.5rem' }}>
                          <code>{String(rec.from_status || '')}</code> → <code>{String(rec.to_status || '')}</code>
                        </td>
                        <td style={{ padding: '0.5rem', color: '#F59E0B' }}>
                          {String(rec.comments || 'N/A')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </ProjectDetailSection>
        </div>

      </div>
    </div>
  );
}
