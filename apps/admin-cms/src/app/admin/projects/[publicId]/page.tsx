import React from 'react';
import Link from 'next/link';
import { SupabaseProjectRepository } from '../../../../repositories/SupabaseProjectRepository';
import { ProjectStatusBadge } from '../../../../components/admin/ProjectStatusBadge';
import { ProjectDetailSection } from '../../../../components/admin/ProjectDetailSection';
import { ProjectReviewSection } from '../../../../components/admin/ProjectReviewSection';
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
import { isParticipantPreviewRemindersEnabled } from '../../../../reminders/participantPreviewReminderConfig';
import { SupabaseParticipantPreviewReminderRepository } from '../../../../repositories/SupabaseParticipantPreviewReminderRepository';
import { ProjectMetadataEditor } from '../../../../components/admin/ProjectMetadataEditor';
import { GuardedProjectBackLink, ProjectMetadataNavigationProvider } from '../../../../components/admin/ProjectMetadataNavigation';
import { SupabaseProjectMetadataGateway, loadProjectMetadataEditorData } from '../../../../projects/projectMetadataService';
import { saveProjectMetadataAction, saveSnapshotAltTextAction } from './actions';
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
import { Button } from '../../../../components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../../../../components/ui/card';
import { ErrorState } from '../../../../components/ui/error-state';
import {
  ArrowLeft,
  FileText,
  Layers,
  Sparkles,
  Image as ImageIcon,
  ShieldCheck,
  CheckSquare,
  Sliders,
  Info,
  History,
  AlertTriangle,
  FolderArchive,
  ExternalLink,
} from 'lucide-react';

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
  let previewReminders: import('../../../../reminders/participantPreviewReminder').ParticipantPreviewReminderView[] = [];
  // Server-only enablement. The browser never learns the SMTP configuration, only whether the
  // Generate + Send action is offered at all.
  const emailDeliveryEnabled = isParticipantPreviewEmailEnabled();
  const reminderSchedulingEnabled = emailDeliveryEnabled && isParticipantPreviewRemindersEnabled();
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
      const reminderRepository = new SupabaseParticipantPreviewReminderRepository();
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
          const dbId = await projectDbId;
          const preview = await previewRepository.getActivePreview(dbId);
          const reminders = await reminderRepository.getReminderHistoryForProject(
            dbId,
            preview?.previewId ?? null,
          );
          if (!preview) {
            return {
              activePreview: null,
              responseState: { type: 'unresponded' as const },
              notification: null,
              reminders,
            };
          }
          const [responseState, notification] = await Promise.all([
            previewRepository.getResponseState(preview.previewId),
            notificationRepository.getNotificationForPreview(preview.previewId),
          ]);
          return {
            activePreview: { createdAt: preview.createdAt, expiresAt: preview.expiresAt },
            responseState,
            notification,
            reminders,
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
      previewReminders = auxiliary.previewState.reminders;
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
      <div className="flex flex-col items-center justify-center min-h-[50vh] p-6 text-center max-w-lg mx-auto">
        <ErrorState
          title="Project Details Unavailable"
          description="Project details could not be loaded. Please try again shortly."
          action={
            <Button asChild variant="outline">
              <Link href="/admin">Return to projects</Link>
            </Button>
          }
        />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] p-6 text-center max-w-lg mx-auto">
        <Card className="bg-card border-border shadow-xs p-6 text-center w-full">
          <CardHeader className="p-0 pb-3">
            <CardTitle className="text-base sm:text-lg font-bold text-foreground">Project Not Found</CardTitle>
            <CardDescription className="text-xs text-muted-foreground mt-1">
              No project record was found matching the identifier <code className="bg-muted px-1.5 py-0.5 rounded font-mono text-foreground">{publicId}</code>.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0 pt-4">
            <Button asChild>
              <Link href="/admin">Return to projects</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const isEligible = project.status === 'approved' || project.status === 'published';
  const allowedActions = getAllowedReviewActions(project.status);

  return (
    <ProjectMetadataNavigationProvider>
      <div className="flex flex-col gap-6 max-w-5xl mx-auto w-full pb-12">
        {/* Top Navigation & Project Header */}
        <div className="flex flex-col gap-3">
          <div>
            <GuardedProjectBackLink
              href="/admin"
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Back to projects</span>
            </GuardedProjectBackLink>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-4 sm:p-5 rounded-lg bg-card border border-border shadow-xs">
            <div className="flex flex-col gap-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <h2 className="text-lg sm:text-xl font-bold text-foreground tracking-tight break-words">
                  {project.title}
                </h2>
                <ProjectStatusBadge status={project.status} />
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>
                  <strong className="text-foreground">Public ID:</strong>{' '}
                  <code className="font-mono bg-muted px-1.5 py-0.5 rounded text-foreground">{project.publicId}</code>
                </span>
                {project.year && (
                  <span>
                    <strong className="text-foreground">Year:</strong> {project.year}
                  </span>
                )}
                {project.program && (
                  <span>
                    <strong className="text-foreground">Program:</strong> {project.program}
                  </span>
                )}
                {project.discipline && (
                  <span>
                    <strong className="text-foreground">Discipline:</strong> {project.discipline}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Sandbox Safety Notice Banner */}
        <div className="p-3.5 rounded-lg bg-warning/10 border border-warning/30 text-warning text-xs leading-relaxed flex items-start gap-2.5">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
          <div>
            <strong>Administrative review staging sandbox:</strong> Hosted and production public-feed operations remain disabled, and external integrations stay disconnected. Local test publication controls are available only when connected to loopback Local Supabase.
          </div>
        </div>

        {/* B. REVIEW AND EDIT PROJECT INFORMATION */}
        <ProjectReviewSection
          title="Project Metadata"
          description="Core public project information including program, disciplines, categories, and accessibility text."
          icon={FileText}
        >
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
            <p className="text-xs text-muted-foreground">
              Project metadata editing is temporarily unavailable. Read-only project metadata remains visible below.
            </p>
          )}
        </ProjectReviewSection>

        {/* Project Overview */}
        <ProjectReviewSection
          title="Project Overview"
          description="Detailed academic and industry identification for this project record."
          icon={Layers}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs sm:text-sm">
            <dl className="flex flex-col gap-3">
              <div>
                <dt className="text-xs font-semibold text-muted-foreground">Project Title</dt>
                <dd className="font-semibold text-foreground text-sm mt-0.5">{project.title}</dd>
              </div>

              <div>
                <dt className="text-xs font-semibold text-muted-foreground">Public Showcase ID</dt>
                <dd className="mt-0.5">
                  <code className="bg-muted px-1.5 py-0.5 rounded font-mono text-xs text-foreground">
                    {project.publicId}
                  </code>
                </dd>
              </div>

              <div>
                <dt className="text-xs font-semibold text-muted-foreground">Academic Term (Year)</dt>
                <dd className="text-foreground mt-0.5">{project.year || 'Not provided'}</dd>
              </div>

              <div>
                <dt className="text-xs font-semibold text-muted-foreground">Study Program & Code</dt>
                <dd className="text-foreground mt-0.5">
                  {project.program ? `${project.program} (${project.studyProgram || 'Not provided'})` : 'Not provided'}
                </dd>
              </div>

              <div>
                <dt className="text-xs font-semibold text-muted-foreground">Primary Discipline</dt>
                <dd className="text-foreground mt-0.5">{project.discipline || 'Not provided'}</dd>
              </div>
            </dl>

            <dl className="flex flex-col gap-3">
              <div>
                <dt className="text-xs font-semibold text-muted-foreground">Mapped Showcase Disciplines</dt>
                <dd className="text-foreground mt-0.5">
                  {project.disciplines && project.disciplines.length > 0 ? project.disciplines.join(', ') : 'None'}
                </dd>
              </div>

              <div>
                <dt className="text-xs font-semibold text-muted-foreground">Industry Partner / Area</dt>
                <dd className="text-foreground mt-0.5">
                  {project.industryPartner ? `${project.industryPartner} (${project.industry || 'Not provided'})` : 'Not provided'}
                </dd>
              </div>

              <div>
                <dt className="text-xs font-semibold text-muted-foreground">Group Name</dt>
                <dd className="text-foreground mt-0.5">{project.groupName || 'Not provided'}</dd>
              </div>

              <div>
                <dt className="text-xs font-semibold text-muted-foreground">Team Roster</dt>
                <dd className="text-foreground mt-0.5">
                  {project.teamMembers && project.teamMembers.length > 0 ? project.teamMembers.join(', ') : 'None'}
                </dd>
              </div>

              <div>
                <dt className="text-xs font-semibold text-muted-foreground">Academic Supervisor</dt>
                <dd className="text-foreground mt-0.5">{project.academicSupervisor || 'Not provided'}</dd>
              </div>

              <div>
                <dt className="text-xs font-semibold text-muted-foreground">Public Showcase Eligibility</dt>
                <dd className="mt-0.5">
                  {isEligible ? (
                    <span className="text-success font-semibold text-xs inline-flex items-center gap-1">
                      Eligible for Approved Feed
                    </span>
                  ) : (
                    <span className="text-muted-foreground text-xs">
                      Draft / In Review (Not eligible for public feed)
                    </span>
                  )}
                </dd>
              </div>
            </dl>
          </div>

          {project.importBatchId && (
            <div className="mt-4 pt-3 border-t border-border flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 p-3 rounded-md bg-muted/40 text-xs">
              <div className="flex items-center gap-2">
                <FolderArchive className="h-4 w-4 text-primary shrink-0" aria-hidden="true" />
                <span className="text-muted-foreground">
                  Imported via folder: <code className="font-mono text-foreground font-semibold">{project.sourceFolder}</code>
                </span>
              </div>
              <Button asChild variant="outline" size="sm" className="h-7 text-xs font-medium shrink-0">
                <Link href={`/admin/imports/${project.importBatchId}`}>
                  View Import Batch
                  <ExternalLink className="h-3 w-3 ml-1" aria-hidden="true" />
                </Link>
              </Button>
            </div>
          )}
        </ProjectReviewSection>

        {/* Public Showcase Content */}
        <ProjectReviewSection
          title="Public Showcase Content"
          description="Content displayed on the public project card and detail views."
          icon={Sparkles}
        >
          <div className="flex flex-col gap-4 text-xs sm:text-sm">
            <div>
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">
                Short Summary
              </h4>
              <p className="text-foreground leading-relaxed">
                {project.summary || 'Not provided'}
              </p>
            </div>

            <div className="pt-3 border-t border-border">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">
                Problem Background
              </h4>
              <p className="text-foreground leading-relaxed whitespace-pre-wrap">
                {project.background || 'Not provided'}
              </p>
            </div>

            <div className="pt-3 border-t border-border">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">
                Developed Solution
              </h4>
              <p className="text-foreground leading-relaxed whitespace-pre-wrap">
                {project.solution || 'Not provided'}
              </p>
            </div>

            <div className="pt-3 border-t border-border">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">
                Accessibility Description (accessibility.txt)
              </h4>
              <p className="text-foreground leading-relaxed">
                {project.accessibilityText || 'Not provided'}
              </p>
            </div>

            <div className="pt-3 border-t border-border">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">
                Poster Full Text Index
              </h4>
              <p className="text-xs text-muted-foreground italic leading-relaxed whitespace-pre-wrap bg-muted/30 p-3 rounded-md border border-border">
                {project.posterText || 'Not provided'}
              </p>
            </div>

            <div className="pt-3 border-t border-border grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
                  External Citations
                </h4>
                {project.citations && project.citations.length > 0 ? (
                  <ul className="list-disc pl-4 space-y-1 text-xs text-foreground">
                    {project.citations.map((c: string, i: number) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted-foreground">None</p>
                )}
              </div>

              <div>
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
                  External Web Links
                </h4>
                {project.externalLinks && project.externalLinks.length > 0 ? (
                  <ul className="space-y-1.5 text-xs">
                    {project.externalLinks.map((link: { label?: string; url: string }, i: number) => (
                      <li key={i}>
                        <a
                          href={link.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-primary hover:underline font-medium break-all"
                        >
                          <span>{link.label || link.url}</span>
                          <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted-foreground">None</p>
                )}
              </div>
            </div>
          </div>
        </ProjectReviewSection>

        {/* C. REVIEW MEDIA AND ACCESSIBILITY */}
        <ProjectReviewSection
          title="Media & Accessibility Review"
          description="Uploaded project images and documents, plus snapshot image alt text."
          icon={ImageIcon}
        >
          <ProjectMediaSummary
            project={project}
            mediaItems={mediaItems}
            mediaAvailable={mediaAvailable}
            snapshotAltText={metadataEditorData ? {
              canEdit: canEditMetadata,
              // The same project version the metadata editor holds, so whichever surface saves
              // second is told the view is stale instead of silently overwriting the other.
              expectedUpdatedAt: metadataEditorData.metadata.expectedUpdatedAt,
              saveAction: saveSnapshotAltTextAction,
            } : undefined}
          />
        </ProjectReviewSection>

        {/* D. CHECK VALIDATION */}
        <ProjectReviewSection
          title="Compliance & Validation"
          description="Approval readiness gates, blocking issues, and compliance warnings."
          icon={ShieldCheck}
        >
          <ProjectValidationSummary project={project} />
        </ProjectReviewSection>

        {/* E. REVIEW / SUBMISSION ACTIONS */}
        <ProjectReviewSection
          title="Review & Submission Actions"
          description="Submit project for review or execute administrative workflow transitions."
          icon={CheckSquare}
        >
          {submitForReviewUnavailable && (
            <div className="mb-3 p-2.5 rounded-md bg-warning/10 border border-warning/30 text-xs text-warning">
              Submission readiness is temporarily unavailable. Submit-for-review is disabled until readiness can be verified.
            </div>
          )}

          {submitForReview && canEditMetadata && (
            <div className="mb-4 pb-4 border-b border-border">
              {submitForReview.ready ? (
                <SubmitForReviewButton
                  batchId={project.importBatchId || ''}
                  publicId={project.publicId || ''}
                  currentStatus={project.status}
                />
              ) : (
                <div className="p-3 rounded-md bg-warning/10 border border-warning/30 text-xs text-warning flex flex-col gap-1">
                  <strong className="text-foreground">Not ready to submit for review:</strong>
                  <ul className="list-disc pl-4 space-y-0.5 text-warning">
                    {submitForReview.blockingReasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
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
        </ProjectReviewSection>

        {/* F. PARTICIPANT CONFIRMATION (Untouched Component Wrapped in ProjectDetailSection) */}
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
            reminderSchedulingEnabled={reminderSchedulingEnabled}
            reminders={previewReminders}
            resolutionStatus={resolutionStatus}
            resolutionStateAvailable={resolutionStatusAvailable}
            canResolveCorrection={canResolveCorrection}
            projectStatus={project.status}
          />
        </ProjectDetailSection>

        {/* G. PUBLICATION / ARCHIVE (Untouched Components Wrapped in ProjectDetailSection) */}
        <ProjectDetailSection title="🚀 Publication Readiness Gate" borderColor="#10B981">
          <PublicationReadinessPanel readiness={publicationReadiness} />
          <PublicationPreparationPanel
            publicId={project.publicId || ''}
            ready={publicationActionsAvailable}
            canPrepare={canPreparePublicationPlan}
            localExecutionAvailable={localPublicationExecutionAvailable}
          />
          {project.status === 'published' && canExecuteLocalArchive && (
            <div className="mt-4 pt-4 border-t border-border/20">
              <LocalArchivePanel publicId={project.publicId || ''} />
            </div>
          )}
        </ProjectDetailSection>

        {/* H. TECHNICAL / AUDIT DETAILS */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Layout Settings */}
          <ProjectReviewSection
            title="Layout Settings"
            description="Active showcase template configuration."
            icon={Sliders}
          >
            <dl className="flex flex-col gap-2.5 text-xs">
              <div className="flex items-center justify-between py-1 border-b border-border">
                <dt className="text-muted-foreground">Active Template ID</dt>
                <dd>
                  <code className="bg-muted px-1.5 py-0.5 rounded font-mono text-primary font-semibold">
                    {project.layoutConfig?.templateId || 'default'}
                  </code>
                </dd>
              </div>

              <div className="flex items-center justify-between py-1 border-b border-border">
                <dt className="text-muted-foreground">Featured Media Focus</dt>
                <dd className="font-medium text-foreground capitalize">
                  {project.layoutConfig?.featuredMedia || 'None'}
                </dd>
              </div>

              <div className="flex items-center justify-between py-1 border-b border-border">
                <dt className="text-muted-foreground">Section Ordering</dt>
                <dd className="font-medium text-foreground">
                  {project.layoutConfig?.sectionOrder ? (
                    project.layoutConfig.sectionOrder.join(' → ')
                  ) : (
                    <span className="text-muted-foreground">Default order</span>
                  )}
                </dd>
              </div>

              {project.layoutConfig?.hiddenSections && (
                <div className="flex items-center justify-between py-1">
                  <dt className="text-muted-foreground">Hidden Sections</dt>
                  <dd className="font-medium text-destructive">
                    {project.layoutConfig.hiddenSections.join(', ')}
                  </dd>
                </div>
              )}
            </dl>
          </ProjectReviewSection>

          {/* System Details */}
          <ProjectReviewSection
            title="System Details"
            description="Staging diagnostics and record timestamps."
            icon={Info}
          >
            <dl className="flex flex-col gap-2.5 text-xs">
              <div className="flex items-center justify-between py-1 border-b border-border">
                <dt className="text-muted-foreground">Validation Errors (Cached)</dt>
                <dd className="font-semibold text-foreground">
                  {project.validationErrors?.length || 0}
                </dd>
              </div>

              <div className="flex items-center justify-between py-1 border-b border-border">
                <dt className="text-muted-foreground">Validation Warnings (Cached)</dt>
                <dd className="font-semibold text-foreground">
                  {project.validationWarnings?.length || 0}
                </dd>
              </div>

              <div className="flex items-center justify-between py-1 border-b border-border">
                <dt className="text-muted-foreground">Pending Showcase Removal</dt>
                <dd className="font-semibold">
                  {project.pendingRemovalFromPublic ? (
                    <span className="text-destructive font-bold">Yes</span>
                  ) : (
                    <span className="text-success font-semibold">No</span>
                  )}
                </dd>
              </div>

              {project.status === 'archived' && (
                <div className="p-2 rounded bg-muted/40 border border-border text-xs">
                  <div><strong>Archived:</strong> {project.archivedAt || 'Not recorded'}</div>
                  <div className="mt-0.5"><strong>Reason:</strong> {project.archiveReason || 'Not recorded'}</div>
                </div>
              )}

              <div className="pt-2 border-t border-border text-[11px] text-muted-foreground flex flex-col gap-1">
                <div>Created: {project.created_at || 'Not recorded'}</div>
                <div>Updated: {project.updated_at || 'Not recorded'}</div>
              </div>
            </dl>
          </ProjectReviewSection>
        </div>

        {/* Change History & Audit Logs */}
        <ProjectReviewSection
          title="Change History & Audit Logs"
          description="Recorded administrative transitions, metadata updates, and audit notes."
          icon={History}
        >
          {auditRecords === null ? (
            <p className="text-xs text-muted-foreground italic">
              Audit history is temporarily unavailable.
            </p>
          ) : auditRecords.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">
              No review action logs recorded for this project.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-border text-muted-foreground">
                    <th className="py-2 px-2 font-semibold">Timestamp</th>
                    <th className="py-2 px-2 font-semibold">Action Taken</th>
                    <th className="py-2 px-2 font-semibold">Transition</th>
                    <th className="py-2 px-2 font-semibold">Comments / Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {auditRecords.map((rec) => (
                    <tr key={rec.id} className="text-foreground align-top">
                      <td className="py-2.5 px-2 text-muted-foreground text-[11px] whitespace-nowrap">
                        {rec.timestamp ? new Date(rec.timestamp).toLocaleString() : 'Not recorded'}
                      </td>
                      <td className="py-2.5 px-2">
                        <span className="inline-block px-1.5 py-0.5 rounded bg-muted font-semibold text-[11px] uppercase tracking-wider text-foreground">
                          {rec.action.replace('_', ' ')}
                        </span>
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          Actor: <strong className="text-foreground">{rec.actorFullName}</strong>
                          {rec.actorEmail && <span> ({rec.actorEmail})</span>}
                        </div>
                      </td>
                      <td className="py-2.5 px-2 whitespace-nowrap">
                        <code className="text-xs font-mono">{rec.fromStatus || 'None'}</code>
                        {' → '}
                        <code className="text-xs font-mono font-semibold text-primary">{rec.toStatus || 'None'}</code>
                      </td>
                      <td className="py-2.5 px-2 text-xs">
                        {rec.comments && (
                          <div className="text-foreground font-medium mb-1">
                            {rec.comments}
                          </div>
                        )}

                        {rec.action === 'update_metadata' && rec.metadataEventDetails && (
                          <div className="mt-1.5 p-2 rounded bg-muted/40 border border-border text-[11px]">
                            <div className="text-muted-foreground mb-1">
                              <strong>Changed fields:</strong> {rec.metadataEventDetails.changedFields.join(', ')}
                            </div>
                            <details className="cursor-pointer text-primary">
                              <summary className="font-medium hover:underline">View details</summary>
                              <div className="mt-2 pl-2 border-l-2 border-primary space-y-2 text-foreground">
                                {rec.metadataEventDetails.changedFields.map((field) => {
                                  const before = rec.metadataEventDetails!.before[field];
                                  const after = rec.metadataEventDetails!.after[field];

                                  let changeView;
                                  if (field === 'background' || field === 'solution' || field === 'posterText' || field === 'accessibilityText') {
                                    changeView = (
                                      <div className="mt-1">
                                        <div className="text-muted-foreground text-[10px]">Previous:</div>
                                        <div className="max-h-20 overflow-y-auto whitespace-pre-wrap break-words opacity-70 p-1.5 bg-muted rounded text-[11px]">
                                          {before ? String(before) : 'Not provided'}
                                        </div>
                                        <div className="text-success text-[10px] mt-1">New:</div>
                                        <div className="max-h-20 overflow-y-auto whitespace-pre-wrap break-words p-1.5 bg-muted rounded text-[11px]">
                                          {after ? String(after) : 'Not provided'}
                                        </div>
                                      </div>
                                    );
                                  } else if (field === 'program') {
                                    changeView = (
                                      <div className="mt-0.5">
                                        <span className="text-muted-foreground line-through">
                                          {(before as Record<string, unknown>)?.name as string || 'Not provided'}
                                        </span>
                                        {' → '}
                                        <span className="text-success font-medium">
                                          {(after as Record<string, unknown>)?.name as string || 'Not provided'}
                                        </span>
                                      </div>
                                    );
                                  } else if (field === 'disciplines' || field === 'industryCategories') {
                                    const beforeSet = new Set(((before as Record<string, unknown>[]) || []).map((x) => x.name as string));
                                    const afterSet = new Set(((after as Record<string, unknown>[]) || []).map((x) => x.name as string));
                                    const added = [...afterSet].filter((x) => !beforeSet.has(x));
                                    const removed = [...beforeSet].filter((x) => !afterSet.has(x));
                                    changeView = (
                                      <div className="mt-0.5 space-y-0.5">
                                        {added.length > 0 && <div className="text-success">Added: {added.join(', ')}</div>}
                                        {removed.length > 0 && <div className="text-destructive">Removed: {removed.join(', ')}</div>}
                                      </div>
                                    );
                                  } else {
                                    changeView = (
                                      <div className="mt-0.5">
                                        <span className="text-muted-foreground line-through">{String(before)}</span>
                                        {' → '}
                                        <span className="text-success font-medium">{String(after)}</span>
                                      </div>
                                    );
                                  }

                                  return (
                                    <div key={field}>
                                      <strong className="capitalize text-muted-foreground">{field}:</strong>
                                      {changeView}
                                    </div>
                                  );
                                })}
                              </div>
                            </details>
                          </div>
                        )}

                        {rec.action === 'update_metadata' && rec.mediaAccessibilityEventDetails && (
                          <div className="mt-1.5 p-2 rounded bg-muted/40 border border-border text-[11px]">
                            <div className="text-muted-foreground mb-1">
                              <strong>Changed:</strong> Snapshot image alt text
                            </div>
                            <details className="cursor-pointer text-primary">
                              <summary className="font-medium hover:underline">View details</summary>
                              <div className="mt-2 pl-2 border-l-2 border-primary text-foreground">
                                <div className="text-muted-foreground text-[10px]">Previous:</div>
                                <div className="max-h-20 overflow-y-auto whitespace-pre-wrap break-words opacity-70 p-1.5 bg-muted rounded text-[11px]">
                                  {rec.mediaAccessibilityEventDetails.before.snapshotAltText ?? 'Not previously provided'}
                                </div>
                                <div className="text-success text-[10px] mt-1">New:</div>
                                <div className="max-h-20 overflow-y-auto whitespace-pre-wrap break-words p-1.5 bg-muted rounded text-[11px]">
                                  {rec.mediaAccessibilityEventDetails.after.snapshotAltText}
                                </div>
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
        </ProjectReviewSection>
      </div>
    </ProjectMetadataNavigationProvider>
  );
}
