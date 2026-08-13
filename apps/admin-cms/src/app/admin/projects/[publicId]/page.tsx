import React from 'react';
import Link from 'next/link';
import { SupabaseProjectRepository } from '../../../../repositories/SupabaseProjectRepository';
import { ProjectStatusBadge } from '../../../../components/admin/ProjectStatusBadge';
import { ProjectDetailSection } from '../../../../components/admin/ProjectDetailSection';
import { ProjectMediaSummary } from '../../../../components/admin/ProjectMediaSummary';
import { ProjectValidationSummary } from '../../../../components/admin/ProjectValidationSummary';
import { StagingReviewActions } from '../../../../components/admin/StagingReviewActions';
import { getAllowedReviewActions } from '../../../../workflow/projectWorkflow';
import { createSupabaseAdminClientCore } from '../../../../lib/supabase/adminCore';
import { Project } from '../../../../domain/project';
import { requireAdmin } from '../../../../auth/requireAdmin';
import { hasPermission, canManageParticipantPreview, canPreparePublication, canResolveParticipantCorrection } from '../../../../auth/permissions';
import { ParticipantPreviewPanel } from '../../../../components/admin/ParticipantPreviewPanel';
import { SupabaseParticipantPreviewRepository } from '../../../../repositories/SupabaseParticipantPreviewRepository';
import { SupabaseParticipantPreviewNotificationRepository } from '../../../../repositories/SupabaseParticipantPreviewNotificationRepository';
import { isParticipantPreviewEmailEnabled } from '../../../../notifications/participantPreviewEmailConfig';
import { ProjectMetadataEditor } from '../../../../components/admin/ProjectMetadataEditor';
import { GuardedProjectBackLink, ProjectMetadataNavigationProvider } from '../../../../components/admin/ProjectMetadataNavigation';
import { SupabaseProjectMetadataGateway, loadProjectMetadataEditorData } from '../../../../projects/projectMetadataService';
import { saveProjectMetadataAction } from './actions';
import { ImportBatchRepository } from '../../../../repositories/ImportBatchRepository';
import { computeReadinessForImportBatchRow } from '../../../../import/importBatchReviewReadiness';
import { SubmitForReviewButton } from '../../../../components/admin/SubmitForReviewButton';
import { PublicationReadinessPanel } from '../../../../components/admin/PublicationReadinessPanel';
import { getServerEnv } from '../../../../lib/env';
import { PublicationPreparationPanel } from '../../../../components/admin/PublicationPreparationPanel';
import { isLocalPublicationExecutionAvailable } from '../../../../projects/localPublicationExecution';
import { LocalArchivePanel } from '../../../../components/admin/LocalArchivePanel';
import type { AuthenticatedAdminContext } from '../../../../auth/authTypes';
import {
  loadProjectDetailAuxiliaryData,
  ProjectDetailAuxiliaryReadError,
  projectDetailFailureCategory,
  AuditHistoryView,
  PROJECT_AUDIT_HISTORY_SELECT,
  parseAuditHistoryRow,
} from '../../../../projects/projectDetailAuxiliaryData';
import { loadProjectMediaPreviewItems } from '../../../../projects/projectMediaPreview';
import type { ProjectMediaPreviewItem } from '../../../../components/admin-media/mediaPreviewTypes';

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
  let adminContext: AuthenticatedAdminContext | null = null;
  let loadError: string | null = null;
  let auditRecords: AuditHistoryView[] | null = null;
  let metadataEditorData: Awaited<ReturnType<typeof loadProjectMetadataEditorData>> = null;
  let metadataEditorAvailable = false;
  let canEditMetadata = false;
  let submitForReview: { ready: boolean; blockingReasons: string[] } | null = null;
  let submitForReviewUnavailable = false;
  let canManagePreview = false;
  let activePreview: { createdAt: string; expiresAt: string } | null = null;
  let previewResponseState: import('../../../../domain/participantPreview').ParticipantPreviewResponseState = { type: 'unresponded' };
  let previewStateAvailable = false;
  let previewNotification: import('../../../../notifications/participantPreviewNotification').ParticipantPreviewNotificationView | null = null;
  // Server-only enablement. The browser never learns the SMTP configuration, only whether the
  // Generate + Send action is offered at all.
  const emailDeliveryEnabled = isParticipantPreviewEmailEnabled();
  let resolutionStatus: import('../../../../domain/participantPreview').ParticipantPreviewCorrectionResolutionStatus | null = null;
  let resolutionStatusAvailable = false;
  let canResolveCorrection = false;
  let publicationReadiness: import('../../../../domain/publicationReadiness').PublicationReadinessResult | null = null;
  let publicationActionsAvailable = false;
  let canPreparePublicationPlan = false;
  let localPublicationExecutionAvailable = false;
  let canExecuteLocalArchive = false;
  let mediaItems: ProjectMediaPreviewItem[] = [];
  let mediaAvailable = false;

  // Essential dependencies: without the base project or authenticated staff context there is no
  // safe project-detail page to render.
  try {
    const repository = new SupabaseProjectRepository();
    project = await repository.getProjectByPublicId(publicId);
    if (project) {
      adminContext = await requireAdmin();
    }
  } catch (error: unknown) {
    console.error('[Project detail: essential load failure]', error instanceof Error ? error.name : 'UNKNOWN_FAILURE');
    loadError = 'Project details are temporarily unavailable.';
  }

  if (project && adminContext && !loadError) {
    canEditMetadata = hasPermission(adminContext.permissions, 'projects.edit');
    canManagePreview = canManageParticipantPreview(adminContext.permissions);
    canPreparePublicationPlan = canPreparePublication(adminContext.permissions);
    canResolveCorrection = canResolveParticipantCorrection(adminContext.permissions);

    try {
      metadataEditorData = await loadProjectMetadataEditorData(
        new SupabaseProjectMetadataGateway(createSupabaseAdminClientCore()),
        publicId,
      );
      metadataEditorAvailable = metadataEditorData !== null;
      if (!metadataEditorAvailable) throw new ProjectDetailAuxiliaryReadError('INVALID_RESPONSE');
    } catch (error: unknown) {
      console.error('[Project detail: metadata editor load failure]', projectDetailFailureCategory(error));
    }

    // Submit-for-review readiness is optional and must not erase the base project when unavailable.
    if (project.importBatchId && (project.status === 'draft' || project.status === 'changes_requested')) {
      try {
        const importBatchRepository = new ImportBatchRepository();
        const [importBatch, reviewRow] = await Promise.all([
          importBatchRepository.getImportBatchById(project.importBatchId),
          importBatchRepository.getProjectReviewDataByPublicId(publicId),
        ]);
        if (importBatch && importBatch.status === 'completed' && reviewRow) {
          const readiness = computeReadinessForImportBatchRow(reviewRow);
          submitForReview = { ready: readiness.ready, blockingReasons: readiness.blockingReasons };
        }
      } catch (error: unknown) {
        submitForReviewUnavailable = true;
        console.error('[Project detail: import readiness load failure]', projectDetailFailureCategory(error));
      }
    }

    try {
      const supabase = createSupabaseAdminClientCore();
      const previewRepository = new SupabaseParticipantPreviewRepository();
      const notificationRepository = new SupabaseParticipantPreviewNotificationRepository();
      const env = getServerEnv();
      localPublicationExecutionAvailable = canPreparePublicationPlan && isLocalPublicationExecutionAvailable(env.supabaseUrl);
      canExecuteLocalArchive = hasPermission(adminContext.permissions, 'projects.archive') && isLocalPublicationExecutionAvailable(env.supabaseUrl);

      const projectDbId = (async () => {
        const { data, error } = await supabase.from('projects').select('id').eq('public_id', publicId).maybeSingle();
        if (error) throw new ProjectDetailAuxiliaryReadError('QUERY_FAILED');
        if (!data?.id) throw new ProjectDetailAuxiliaryReadError('PROJECT_ID_UNAVAILABLE');
        return data.id;
      })();

      const auxiliary = await loadProjectDetailAuxiliaryData(project, {
        loadAuditRecords: async () => {
          const dbId = await projectDbId;
          const { data, error } = await supabase
            .from('approval_records')
            .select(PROJECT_AUDIT_HISTORY_SELECT)
            .eq('project_id', dbId)
            .order('created_at', { ascending: false })
            .order('id', { ascending: false });
          if (error) throw new ProjectDetailAuxiliaryReadError('QUERY_FAILED');
          return (data ?? []).map(parseAuditHistoryRow);
        },
        loadPreviewState: async () => {
          const preview = await previewRepository.getActivePreview(await projectDbId);
          if (!preview) {
            return { activePreview: null, responseState: { type: 'unresponded' as const }, notification: null };
          }
          const [responseState, notification] = await Promise.all([
            previewRepository.getResponseState(preview.previewId),
            notificationRepository.getNotificationForPreview(preview.previewId),
          ]);
          return {
            activePreview: { createdAt: preview.createdAt, expiresAt: preview.expiresAt },
            responseState,
            notification,
          };
        },
        loadResolutionStatus: async () => previewRepository.getCorrectionResolutionStatus(await projectDbId),
        loadPublicationReadiness: async () => previewRepository.getPublicationReadiness({
            publicId,
            adminId: adminContext.adminUserId,
            privateBucket: env.SUPABASE_DRAFT_BUCKET,
          }),
      });

      auditRecords = auxiliary.auditRecords;
      activePreview = auxiliary.previewState.activePreview;
      previewResponseState = auxiliary.previewState.responseState;
      previewStateAvailable = auxiliary.previewStateAvailable;
      previewNotification = auxiliary.previewState.notification;
      resolutionStatus = auxiliary.resolutionStatus;
      resolutionStatusAvailable = auxiliary.resolutionStatusAvailable;
      publicationReadiness = auxiliary.publicationReadiness;
      publicationActionsAvailable = auxiliary.publicationActionsAvailable;
      try {
        mediaItems = await loadProjectMediaPreviewItems({
          supabase,
          projectId: await projectDbId,
          projectTitle: project.title,
          accessibilityText: project.accessibilityText,
          privateBucket: env.SUPABASE_DRAFT_BUCKET,
        });
        mediaAvailable = true;
      } catch (error: unknown) {
        console.error('[Project detail: media preview load failure]', projectDetailFailureCategory(error));
      }
    } catch (error: unknown) {
      // Configuration/client creation is shared setup for all secondary reads. Keep every
      // mutation capability disabled and retain the already loaded project metadata.
      console.error('[Project detail: auxiliary setup failure]', projectDetailFailureCategory(error));
    }
  }

  if (loadError) {
    return (
      <div style={{
        minHeight: '100vh',
        backgroundColor: '#0B0F19',
        color: '#EF4444',
        fontFamily: 'Inter, system-ui, sans-serif',
        padding: '3rem',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
      }}>
        <div style={{
          maxWidth: '600px',
          width: '100%',
          backgroundColor: '#161F30',
          borderRadius: '12px',
          padding: '2.5rem',
          border: '1px solid rgba(239, 68, 68, 0.2)',
          textAlign: 'center',
        }}>
          <h3 style={{ margin: '0 0 1rem 0' }}>Project Details Unavailable</h3>
          <p style={{ color: '#D1D5DB', fontSize: '0.95rem', lineHeight: '1.6', marginBottom: '2rem' }}>
            Project details could not be loaded. Please try again shortly.
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
            Back to Dashboard
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
        padding: '3rem',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
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
  const allowedActions = getAllowedReviewActions(project.status);

  return (
    <ProjectMetadataNavigationProvider>
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
            <GuardedProjectBackLink href="/admin" style={{
              color: '#3B82F6',
              textDecoration: 'none',
              fontSize: '0.9rem',
              fontWeight: '600',
              display: 'inline-flex',
              alignItems: 'center',
              marginBottom: '0.5rem'
            }}>
              ← Back to Staging Dashboard
            </GuardedProjectBackLink>
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
            Hosted and production public-feed operations remain disabled, and Duda stays disconnected. Explicit Local test publication and removal controls may be available only when this Admin CMS is connected to proven loopback Local Supabase.
          </p>
        </div>

        {/* Dynamic Action Trigger Panel */}
        {submitForReviewUnavailable && (
          <div style={{
            maxWidth: '1000px', margin: '0 auto 1rem', fontSize: '0.8rem', color: '#F59E0B',
            backgroundColor: 'rgba(245, 158, 11, 0.05)', border: '1px solid rgba(245, 158, 11, 0.15)',
            borderRadius: '6px', padding: '0.5rem 0.75rem',
          }}>
            Submission readiness is temporarily unavailable. Submit-for-review is disabled until readiness can be verified.
          </div>
        )}
        <ProjectDetailSection title="⚡ Staging Review Actions" borderColor="#EC4899">
          {submitForReview && canEditMetadata && (
            <div style={{ marginBottom: allowedActions.length > 0 ? '1.25rem' : 0 }}>
              {submitForReview.ready ? (
                <SubmitForReviewButton
                  batchId={project.importBatchId || ''}
                  publicId={project.publicId || ''}
                  currentStatus={project.status}
                />
              ) : (
                <div style={{
                  fontSize: '0.8rem', color: '#F59E0B', backgroundColor: 'rgba(245, 158, 11, 0.05)',
                  border: '1px solid rgba(245, 158, 11, 0.15)', borderRadius: '6px', padding: '0.5rem 0.75rem',
                }}>
                  <strong>Not ready to submit for review:</strong>
                  <ul style={{ margin: '0.25rem 0 0 0', paddingLeft: '1.1rem' }}>
                    {submitForReview.blockingReasons.map((reason) => <li key={reason}>{reason}</li>)}
                  </ul>
                </div>
              )}
            </div>
          )}
          <StagingReviewActions
            publicId={project.publicId || ''}
            currentStatus={project.status}
            allowedActions={allowedActions}
          />
          {project.status === 'published' && canExecuteLocalArchive && <LocalArchivePanel publicId={project.publicId || ''} />}
        </ProjectDetailSection>

        <ProjectDetailSection title="🚀 Publication Readiness Gate" borderColor="#10B981">
          <PublicationReadinessPanel readiness={publicationReadiness} />
          <PublicationPreparationPanel publicId={project.publicId || ''} ready={publicationActionsAvailable} canPrepare={canPreparePublicationPlan} localExecutionAvailable={localPublicationExecutionAvailable} />
        </ProjectDetailSection>

        <ProjectDetailSection title="🔗 Participant Preview" borderColor="#3B82F6">
          <ParticipantPreviewPanel
            publicId={project.publicId || ''}
            canManage={canManagePreview}
            isApprovedEligible={project.status === 'approved'}
            initialActivePreview={activePreview}
            responseState={previewResponseState}
            stateAvailable={previewStateAvailable}
            notification={previewNotification}
            participantContactEmail={project.participantContactEmail || null}
            emailDeliveryEnabled={emailDeliveryEnabled}
            resolutionStatus={resolutionStatus}
            resolutionStateAvailable={resolutionStatusAvailable}
            canResolveCorrection={canResolveCorrection}
            projectStatus={project.status}
          />
        </ProjectDetailSection>

        <ProjectDetailSection title="Project Metadata" borderColor="#3B82F6">
          {metadataEditorData && metadataEditorAvailable ? (
            <ProjectMetadataEditor
              initialMetadata={metadataEditorData.metadata}
              programs={metadataEditorData.programs}
              disciplines={metadataEditorData.disciplines}
              industryCategories={metadataEditorData.industryCategories}
              canEdit={canEditMetadata}
              projectStatus={project.status}
              saveAction={saveProjectMetadataAction}
            />
          ) : (
            <p style={{ margin: 0, fontSize: '0.85rem', color: '#9CA3AF' }}>
              Project metadata editing is temporarily unavailable. Read-only project metadata remains visible below.
            </p>
          )}
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
          <ProjectMediaSummary project={project} mediaItems={mediaItems} mediaAvailable={mediaAvailable} />
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
            {auditRecords === null ? (
              <p style={{ margin: 0, fontSize: '0.85rem', color: '#9CA3AF', fontStyle: 'italic' }}>
                Audit history is temporarily unavailable.
              </p>
            ) : auditRecords.length === 0 ? (
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
                      <tr key={rec.id} style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.05)', color: '#D1D5DB' }}>
                        <td style={{ padding: '0.5rem', fontSize: '0.8rem', color: '#9CA3AF', verticalAlign: 'top' }}>
                          {rec.timestamp ? new Date(rec.timestamp).toLocaleString() : 'N/A'}
                        </td>
                        <td style={{ padding: '0.5rem', fontWeight: 'bold', verticalAlign: 'top' }}>
                          <span style={{
                            display: 'inline-block',
                            padding: '0.15rem 0.4rem',
                            borderRadius: '4px',
                            backgroundColor: 'rgba(255, 255, 255, 0.05)',
                            fontSize: '0.75rem',
                            textTransform: 'uppercase'
                          }}>
                            {rec.action.replace('_', ' ')}
                          </span>

                          <div style={{ marginTop: '0.75rem', fontSize: '0.8rem', fontWeight: 'normal' }}>
                            <div style={{ color: '#9CA3AF' }}>Actor:</div>
                            <div style={{ color: '#D1D5DB' }}>
                              {rec.actorFullName} {rec.actorEmail ? `(${rec.actorEmail})` : ''}
                            </div>
                          </div>
                        </td>
                        <td style={{ padding: '0.5rem', verticalAlign: 'top' }}>
                          <code>{rec.fromStatus || 'N/A'}</code> → <code>{rec.toStatus || 'N/A'}</code>
                        </td>
                        <td style={{ padding: '0.5rem', color: '#F59E0B', verticalAlign: 'top' }}>
                          {rec.comments || 'N/A'}

                          {rec.action === 'update_metadata' && rec.metadataEventDetails && (
                            <div style={{ marginTop: '0.75rem', backgroundColor: 'rgba(0,0,0,0.2)', padding: '0.75rem', borderRadius: '6px' }}>
                              <div style={{ color: '#9CA3AF', fontSize: '0.8rem', marginBottom: '0.5rem' }}>
                                <strong>Changed:</strong> {rec.metadataEventDetails.changedFields.join(', ')}
                              </div>
                              <details style={{ cursor: 'pointer', fontSize: '0.8rem', color: '#60A5FA' }}>
                                <summary>View Changes</summary>
                                <div style={{ marginTop: '0.5rem', paddingLeft: '0.5rem', borderLeft: '2px solid #3B82F6', color: '#D1D5DB' }}>
                                  {rec.metadataEventDetails.changedFields.map(field => {
                                    const before = rec.metadataEventDetails!.before[field];
                                    const after = rec.metadataEventDetails!.after[field];

                                    let changeView;
                                    if (field === 'background' || field === 'solution') {
                                      changeView = (
                                        <div style={{ marginTop: '0.25rem' }}>
                                          <div style={{ color: '#9CA3AF', fontSize: '0.75rem' }}>Previous:</div>
                                          <div style={{ maxHeight: '80px', overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', opacity: 0.7, padding: '0.25rem', backgroundColor: 'rgba(0,0,0,0.1)', borderRadius: '4px', fontSize: '0.75rem' }}>
                                            {before ? String(before) : 'N/A'}
                                          </div>
                                          <div style={{ color: '#10B981', fontSize: '0.75rem', marginTop: '0.25rem' }}>New:</div>
                                          <div style={{ maxHeight: '80px', overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', padding: '0.25rem', backgroundColor: 'rgba(0,0,0,0.1)', borderRadius: '4px', fontSize: '0.75rem' }}>
                                            {after ? String(after) : 'N/A'}
                                          </div>
                                        </div>
                                      );
                                    } else if (field === 'program') {
                                      changeView = (
                                        <div style={{ marginTop: '0.25rem' }}>
                                          <span style={{ color: '#9CA3AF', textDecoration: 'line-through' }}>{(before as Record<string, unknown>)?.name as string || 'N/A'}</span>
                                          {' → '}
                                          <span style={{ color: '#10B981' }}>{(after as Record<string, unknown>)?.name as string || 'N/A'}</span>
                                        </div>
                                      );
                                    } else if (field === 'disciplines' || field === 'industryCategories') {
                                      const beforeSet = new Set(((before as Record<string, unknown>[]) || []).map(x => x.name as string));
                                      const afterSet = new Set(((after as Record<string, unknown>[]) || []).map(x => x.name as string));
                                      const added = [...afterSet].filter(x => !beforeSet.has(x));
                                      const removed = [...beforeSet].filter(x => !afterSet.has(x));
                                      changeView = (
                                        <div style={{ marginTop: '0.25rem' }}>
                                          {added.length > 0 && <div style={{ color: '#10B981' }}>Added: {added.join(', ')}</div>}
                                          {removed.length > 0 && <div style={{ color: '#EF4444' }}>Removed: {removed.join(', ')}</div>}
                                        </div>
                                      );
                                    } else {
                                      changeView = (
                                        <div style={{ marginTop: '0.25rem' }}>
                                          <span style={{ color: '#9CA3AF', textDecoration: 'line-through' }}>{String(before)}</span>
                                          {' → '}
                                          <span style={{ color: '#10B981' }}>{String(after)}</span>
                                        </div>
                                      );
                                    }

                                    return (
                                      <div key={field} style={{ marginBottom: '0.75rem' }}>
                                        <strong style={{ color: '#E5E7EB', textTransform: 'capitalize' }}>{field}</strong>
                                        {changeView}
                                      </div>
                                    );
                                  })}
                                </div>
                              </details>
                            </div>
                          )}
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
    </ProjectMetadataNavigationProvider>
  );
}
