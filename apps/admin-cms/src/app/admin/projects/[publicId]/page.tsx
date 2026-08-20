import React from 'react';
import Link from 'next/link';
import { SupabaseProjectRepository } from '../../../../repositories/SupabaseProjectRepository';
import { ProjectStatusBadge } from '../../../../components/admin/ProjectStatusBadge';
import { ProjectDetailMacroSection, ProjectReviewSection } from '../../../../components/admin/ProjectReviewSection';
import { ProjectDetailSectionNavigation } from '../../../../components/admin/ProjectDetailSectionNavigation';
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
import { ProjectAssistiveChecks } from '../../../../components/admin/ProjectAssistiveChecks';
import {
  isAssistiveExecutionAvailable,
  loadAssistiveInspection,
  SupabaseAssistiveValidationRepository,
  SupabaseAssistiveInputRepository,
  ASSISTIVE_PIPELINE_VERSION,
  type AssistiveInspectionView,
} from '../../../../assistive-validation';
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
import { loadProjectMediaReviewData } from '../../../../projects/projectMediaPreview';
import type { ApprovalMediaInput } from '../../../../validation/projectValidation';
import type { ProjectMediaPreviewItem } from '../../../../components/admin-media/mediaPreviewTypes';
import { ProjectAuditHistory } from '../../../../components/admin/ProjectAuditHistory';
import { deriveProjectWorkflowContext } from '../../../../components/admin/projectWorkflowContext';
import { getPermittedReviewActions } from '../../../../components/admin/projectReviewActions';
import { PROJECT_DETAIL_SURFACE_CLASSES } from '../../../../components/admin/projectDetailSurfaceStyles';
import { Button } from '../../../../components/ui/button';
import { ErrorState } from '../../../../components/ui/error-state';
import {
  ArrowLeft,
  FileText,
  Sparkles,
  Image as ImageIcon,
  Sliders,
  History,
  AlertTriangle,
  FolderArchive,
  ExternalLink,
  UserCheck,
  Rocket,
  Info,
} from 'lucide-react';

// Force dynamic server rendering for real-time detail load
export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{
    publicId: string;
  }>;
}

/** Read-only fact rendered in the contextual rail. Long values wrap rather than truncate. */
function RecordFact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-foreground">{children}</dd>
    </div>
  );
}

/** Long-form public showcase content block with a readable measure. */
function ContentBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-border pt-4 first:border-t-0 first:pt-0">
      <h4 className="text-sm font-semibold text-foreground">{title}</h4>
      <div className="mt-1.5 max-w-[75ch] text-sm leading-relaxed text-foreground-subtle">{children}</div>
    </div>
  );
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
  let approvalMedia: ApprovalMediaInput | null = null;
  let canReview = false;
  let initialAssistiveInspection: AssistiveInspectionView | null = null;
  let initialAssistiveInspectionReadFailed = false;
  const canExecuteAssistiveChecks = isAssistiveExecutionAvailable();

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
    canReview = hasPermission(adminContext.permissions, 'projects.review');
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
        const mediaReview = await loadProjectMediaReviewData({
          supabase,
          projectId: await projectDbId,
          projectPublicId: publicId,
          projectTitle: project.title,
          accessibilityText: project.accessibilityText,
          privateBucket: env.SUPABASE_DRAFT_BUCKET,
        });
        mediaItems = mediaReview.items;
        approvalMedia = mediaReview.approvalMedia;
        mediaAvailable = true;
      } catch (error: unknown) {
        console.error('[Project detail: media preview load failure]', projectDetailFailureCategory(error));
      }

      try {
        const inspectionResult = await loadAssistiveInspection(
          new SupabaseAssistiveValidationRepository(supabase),
          new SupabaseAssistiveInputRepository(supabase),
          {
            projectId: await projectDbId,
            pipelineVersion: ASSISTIVE_PIPELINE_VERSION,
            privateBucket: env.SUPABASE_DRAFT_BUCKET,
          },
        );
        if (inspectionResult.ok) {
          if (inspectionResult.found) {
            initialAssistiveInspection = inspectionResult.inspection;
          }
        } else {
          initialAssistiveInspectionReadFailed = true;
        }
      } catch (error: unknown) {
        initialAssistiveInspectionReadFailed = true;
        console.error('[Project detail: assistive inspection load failure]', projectDetailFailureCategory(error));
      }
    } catch (error: unknown) {
      // Configuration/client creation is shared setup for all secondary reads. Keep every
      // mutation capability disabled and retain the already loaded project metadata.
      console.error('[Project detail: auxiliary setup failure]', projectDetailFailureCategory(error));
    }
  }

  if (loadError) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-lg flex-col items-center justify-center p-6 text-center">
        <ErrorState
          headingLevel="h1"
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
      <div className="mx-auto flex min-h-[50vh] max-w-lg flex-col items-center justify-center p-6 text-center">
        <ErrorState
          headingLevel="h1"
          title="Project not found"
          description={`No project record was found matching the identifier ${publicId}.`}
          action={
            <Button asChild>
              <Link href="/admin">Return to projects</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const isEligible = project.status === 'approved' || project.status === 'published';
  const statusAllowedActions = getAllowedReviewActions(project.status);
  const permittedReviewActions = getPermittedReviewActions(statusAllowedActions, adminContext?.permissions ?? []);

  // Orientation prose derived from the state this page already loaded. It never decides what a
  // transition does; `getAllowedReviewActions`, import readiness, and publication readiness
  // remain the only authorities, and the canonical controls below are unchanged.
  const workflowContext = deriveProjectWorkflowContext({
    status: project.status,
    allowedActions: permittedReviewActions,
    submitForReview,
    submitForReviewUnavailable,
    canEditMetadata,
    canManageParticipantPreview: canManagePreview,
    canResolveParticipantCorrection: canResolveCorrection,
    canPreparePublication: canPreparePublicationPlan,
    canExecuteLocalArchive,
    participantResponse: previewStateAvailable ? previewResponseState.type : null,
    hasActivePreview: activePreview !== null,
    publicationReadiness,
    pendingRemovalFromPublic: Boolean(project.pendingRemovalFromPublic),
  });

  const canSubmitForReview = submitForReview !== null && canEditMetadata;
  const showSubmitButton = canSubmitForReview && submitForReview!.ready;
  const showSubmitBlockers = canSubmitForReview && !submitForReview!.ready;
  const hasCanonicalAction = showSubmitButton || permittedReviewActions.length > 0;
  // Participant confirmation and publication only become operational after approval. Before
  // that they stay present and reachable, but collapsed so they do not compete with editing.
  const laterStagesActive = project.status === 'approved' || project.status === 'published';

  return (
    <ProjectMetadataNavigationProvider>
      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-6 pb-16 xl:gap-8">
        {/* Orientation: identity, workflow status, and the way back */}
        <header className="flex flex-col gap-4">
          <GuardedProjectBackLink
            href="/admin"
            className="inline-flex min-h-[40px] w-fit items-center gap-1.5 rounded-md text-sm font-medium text-foreground-subtle transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>Back to projects</span>
          </GuardedProjectBackLink>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
            <div className="flex min-w-0 flex-col gap-2">
              <h1 className="max-w-[24ch] break-words text-2xl font-bold tracking-tight text-foreground">
                {project.title}
              </h1>
              <dl className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5 text-sm">
                <div className="flex min-w-0 items-baseline gap-1.5">
                  <dt className="text-muted-foreground">Public ID</dt>
                  <dd className="min-w-0 break-all rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                    {project.publicId}
                  </dd>
                </div>
                {project.year && (
                  <div className="flex items-baseline gap-1.5">
                    <dt className="text-muted-foreground">Year</dt>
                    <dd className="text-foreground">{project.year}</dd>
                  </div>
                )}
                {project.program && (
                  <div className="flex min-w-0 items-baseline gap-1.5">
                    <dt className="text-muted-foreground">Program</dt>
                    <dd className="break-words text-foreground">{project.program}</dd>
                  </div>
                )}
                {project.discipline && (
                  <div className="flex min-w-0 items-baseline gap-1.5">
                    <dt className="text-muted-foreground">Discipline</dt>
                    <dd className="break-words text-foreground">{project.discipline}</dd>
                  </div>
                )}
              </dl>
            </div>

            <div className="shrink-0">
              <ProjectStatusBadge status={project.status} />
            </div>
          </div>
        </header>

        <ProjectDetailSectionNavigation />

        <div className="grid items-start gap-10 xl:grid-cols-[minmax(0,1fr)_340px] xl:gap-8">
          <div className="flex min-w-0 flex-col gap-14">
            <ProjectDetailMacroSection
              id="review-and-edit"
              title="Review and edit"
              description="Understand the current workflow decision, resolve blockers, take the permitted action, and update project information."
            >
              {/* Operationally important even though it is repeated in the technical record below */}
              {project.pendingRemovalFromPublic && (
                <div className={`flex items-start gap-2.5 p-4 ${PROJECT_DETAIL_SURFACE_CLASSES.blocker}`} role="status">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
                  <div className="text-sm leading-relaxed">
                    <strong className="font-semibold">Showcase removal pending.</strong> This project is marked for
                    removal from the public showcase. Check the lifecycle and technical sections before making
                    further changes.
                  </div>
                </div>
              )}

              {/* The one emphasised area: where the project is, what is blocking it, and what can be done */}
              <ProjectReviewSection
          id="workflow-status"
          tone="emphasis"
          title={`Review status: ${workflowContext.stageLabel}`}
          description={workflowContext.summary}
        >
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <p className="max-w-[80ch] text-sm font-medium leading-relaxed text-foreground">
                {workflowContext.decision}
              </p>
              {/*
                An in-page anchor, never a second Edit control: the metadata editor stays the one
                place project information can be changed, and this only moves focus to it so the
                editor is one step away from the decision area on a tall review state.
              */}
              {metadataEditorAvailable && (
                <a
                  href="#project-information"
                  className="inline-flex min-h-[32px] w-fit items-center gap-1.5 text-sm font-medium text-foreground-subtle underline decoration-border-strong underline-offset-4 hover:text-foreground hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  Go to project information
                </a>
              )}
            </div>

            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(260px,340px)] lg:gap-8">
              {/* Why an action may be unavailable, next to the action itself */}
              <div className="flex min-w-0 flex-col gap-4">
                {submitForReviewUnavailable && (
                  <div className={`flex items-start gap-2.5 p-3.5 ${PROJECT_DETAIL_SURFACE_CLASSES.caution}`}>
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
                    <p className="text-sm leading-relaxed">
                      Submission readiness is temporarily unavailable, so submit for review stays disabled
                      until readiness can be verified.
                    </p>
                  </div>
                )}

                {showSubmitBlockers && (
                  <div className={`p-3.5 ${PROJECT_DETAIL_SURFACE_CLASSES.blocker}`}>
                    <div className="flex items-start gap-2.5">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
                      <div className="min-w-0">
                        <strong className="text-sm font-semibold">Not ready to submit for review</strong>
                        <ul className="mt-1.5 list-disc space-y-1 pl-4 text-sm leading-relaxed">
                          {submitForReview!.blockingReasons.map((reason) => (
                            <li key={reason}>{reason}</li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </div>
                )}

                <ProjectValidationSummary project={project} approvalMedia={approvalMedia} />
              </div>

              {/*
                Canonical workflow controls — rendered exactly once on this page. The column
                only appears when an action actually exists, so a draft is never told both
                "Submit for review" and "no review transition is available"; when nothing is
                available the status summary above states that on its own.
              */}
              {hasCanonicalAction && (
                <div className="flex min-w-0 flex-col gap-4 lg:border-l lg:border-border lg:pl-8">
                  <h4 className="text-sm font-semibold text-foreground">Available actions</h4>
                  {showSubmitButton && (
                    <SubmitForReviewButton
                      batchId={project.importBatchId || ''}
                      publicId={project.publicId || ''}
                      currentStatus={project.status}
                    />
                  )}
                  {permittedReviewActions.length > 0 && (
                    <StagingReviewActions
                      publicId={project.publicId || ''}
                      currentStatus={project.status}
                      allowedActions={permittedReviewActions}
                    />
                  )}
                </div>
              )}
            </div>
          </div>
              </ProjectReviewSection>

              <ProjectAssistiveChecks
                publicId={publicId}
                canEditMetadata={canEditMetadata}
                canReview={canReview}
                canExecute={canExecuteAssistiveChecks}
                initialInspection={initialAssistiveInspection}
                initialReadFailed={initialAssistiveInspectionReadFailed}
                headingLevel="h3"
              />

            {/* Editing is the highest-frequency task, so it opens the workspace */}
            {metadataEditorData && metadataEditorAvailable ? (
              <div id="project-information" className="scroll-mt-44 rounded-xl border border-border bg-card p-4 sm:p-6 xl:scroll-mt-40">
                <ProjectMetadataEditor
                  initialMetadata={metadataEditorData.metadata}
                  programs={metadataEditorData.programs}
                  disciplines={metadataEditorData.disciplines}
                  industryCategories={metadataEditorData.industryCategories}
                  canEdit={canEditMetadata}
                  projectStatus={project.status}
                  saveAction={saveProjectMetadataAction}
                  headingLevel="h3"
                />
              </div>
            ) : (
              <ProjectReviewSection
                id="project-information"
                title="Project information"
                description="Core public project information including program, disciplines, categories, and accessibility text."
                icon={FileText}
              >
                <p role="status" className="text-sm text-muted-foreground">
                  Project metadata editing is temporarily unavailable. The read-only project content below
                  remains visible.
                </p>
              </ProjectReviewSection>
            )}

            </ProjectDetailMacroSection>

            <ProjectDetailMacroSection
              id="content-and-media"
              title="Content and media"
              description="Inspect the public-facing narrative, supporting links, poster and document assets, and their accessibility evidence."
            >

            <ProjectReviewSection
              id="showcase-content"
              title="Public showcase content"
              description="The written content that appears on the public project card and detail view."
              icon={Sparkles}
            >
              <div className="flex flex-col gap-4">
                <ContentBlock title="Short summary">
                  <p className="whitespace-pre-wrap break-words">{project.summary || 'Not provided'}</p>
                </ContentBlock>

                <ContentBlock title="Problem background">
                  <p className="whitespace-pre-wrap break-words">{project.background || 'Not provided'}</p>
                </ContentBlock>

                <ContentBlock title="Developed solution">
                  <p className="whitespace-pre-wrap break-words">{project.solution || 'Not provided'}</p>
                </ContentBlock>

                <ContentBlock title="Accessibility description">
                  <p className="whitespace-pre-wrap break-words">{project.accessibilityText || 'Not provided'}</p>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    Screen-reader description of the poster image, read from accessibility.txt.
                  </p>
                </ContentBlock>

                {/* Poster full text can run to many hundreds of words, so it opens on request */}
                <div className="border-t border-border pt-4">
                  <details className="group">
                    <summary className="inline-flex min-h-[40px] cursor-pointer list-none items-center gap-2 rounded-md text-sm font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                      <ExternalLink className="h-4 w-4 shrink-0 rotate-90 text-foreground-subtle transition-transform group-open:rotate-180" aria-hidden="true" />
                      <span>Poster full text</span>
                      <span className="font-normal text-muted-foreground">
                        {project.posterText ? `(${project.posterText.length.toLocaleString()} characters)` : '(not provided)'}
                      </span>
                    </summary>
                    <p className="mt-2 max-w-[75ch] whitespace-pre-wrap break-words rounded-lg border border-border bg-surface-inset p-3 text-sm leading-relaxed text-foreground-subtle">
                      {project.posterText || 'Not provided'}
                    </p>
                  </details>
                </div>

                <div className="grid gap-5 border-t border-border pt-4 sm:grid-cols-2">
                  <div>
                    <h4 className="text-sm font-semibold text-foreground">External citations</h4>
                    {project.citations && project.citations.length > 0 ? (
                      <ul className="mt-1.5 list-disc space-y-1 pl-4 text-sm leading-relaxed text-foreground-subtle">
                        {project.citations.map((c: string, i: number) => (
                          <li key={i} className="break-words">{c}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-1.5 text-sm text-muted-foreground">None</p>
                    )}
                  </div>

                  <div>
                    <h4 className="text-sm font-semibold text-foreground">External web links</h4>
                    {project.externalLinks && project.externalLinks.length > 0 ? (
                      <ul className="mt-1.5 space-y-1.5 text-sm">
                        {project.externalLinks.map((link: { label?: string; url: string }, i: number) => (
                          <li key={i}>
                            <a
                              href={link.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex min-h-[32px] items-center gap-1.5 font-medium text-foreground underline decoration-border-strong underline-offset-4 wrap-anywhere hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                            >
                              <span>{link.label || link.url}</span>
                              <ExternalLink className="h-3.5 w-3.5 shrink-0 text-foreground-subtle" aria-hidden="true" />
                            </a>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-1.5 text-sm text-muted-foreground">None</p>
                    )}
                  </div>
                </div>
              </div>
            </ProjectReviewSection>

            <ProjectReviewSection
              id="media-accessibility"
              title="Media and accessibility"
              description="Uploaded poster, document, and snapshot files, their text alternatives, and external showcase links."
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

            </ProjectDetailMacroSection>

            <ProjectDetailMacroSection
              id="participant-and-publication"
              title="Participant and publication"
              description="Follow the later confirmation and publication stages while each panel reports its own authoritative availability and readiness."
            >

            <ProjectReviewSection
              id="participant-confirmation"
              title="Participant confirmation"
              description={
                laterStagesActive
                  ? 'Share the approved project with participants, track their response, and resolve requested corrections before publication.'
                  : 'Becomes available after internal review approves the project. Participants confirm their project before publication.'
              }
              icon={UserCheck}
              collapsible={!laterStagesActive}
              collapsedHint={laterStagesActive ? undefined : 'After approval'}
            >
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
            </ProjectReviewSection>

            <ProjectReviewSection
              id="publication-lifecycle"
              title="Publication and lifecycle"
              description={
                laterStagesActive
                  ? 'Publication readiness, preparation evidence, and the local showcase lifecycle. Approval alone does not publish a project, and this interface never performs live Duda publication.'
                  : 'Becomes relevant after approval and participant confirmation. Approval alone does not publish a project.'
              }
              icon={Rocket}
              collapsible={!laterStagesActive}
              collapsedHint={laterStagesActive ? undefined : 'After confirmation'}
            >
              <div className="flex flex-col gap-4">
                <PublicationReadinessPanel readiness={publicationReadiness} />
                <PublicationPreparationPanel
                  publicId={project.publicId || ''}
                  ready={publicationActionsAvailable}
                  canPrepare={canPreparePublicationPlan}
                  localExecutionAvailable={localPublicationExecutionAvailable}
                />
                {project.status === 'published' && canExecuteLocalArchive && (
                  <LocalArchivePanel publicId={project.publicId || ''} />
                )}
              </div>
            </ProjectReviewSection>

            </ProjectDetailMacroSection>

            <ProjectDetailMacroSection
              id="technical-and-history"
              title="Technical details and history"
              description="Review secondary configuration, record evidence, and the ordered administrative history without letting it dominate routine decisions."
            >
              {/* Secondary technical evidence: available on request, never competing with review */}
              <ProjectReviewSection
                id="technical-details"
                title="Technical configuration and record details"
                description="Showcase template configuration, cached validation counts, and record timestamps."
                icon={Sliders}
                collapsible
                defaultOpen={project.status === 'archived'}
                collapsedHint="Advanced"
              >
                <div className="grid gap-6 md:grid-cols-2">
                  <div>
                    <h4 className="text-sm font-semibold text-foreground">Layout settings</h4>
                    <dl className="mt-3 flex flex-col gap-2.5 text-sm">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b border-border pb-2">
                        <dt className="text-muted-foreground">Active template ID</dt>
                        <dd className="break-all font-mono text-xs text-foreground">
                          {project.layoutConfig?.templateId || 'default'}
                        </dd>
                      </div>
                      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b border-border pb-2">
                        <dt className="text-muted-foreground">Featured media focus</dt>
                        <dd className="capitalize text-foreground">{project.layoutConfig?.featuredMedia || 'None'}</dd>
                      </div>
                      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b border-border pb-2">
                        <dt className="text-muted-foreground">Section ordering</dt>
                        <dd className="break-words text-right text-foreground">
                          {project.layoutConfig?.sectionOrder
                            ? project.layoutConfig.sectionOrder.join(', ')
                            : 'Default order'}
                        </dd>
                      </div>
                      {project.layoutConfig?.hiddenSections && (
                        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
                          <dt className="text-muted-foreground">Hidden sections</dt>
                          <dd className="break-words text-right font-medium text-foreground">
                            {project.layoutConfig.hiddenSections.join(', ')}
                          </dd>
                        </div>
                      )}
                    </dl>
                  </div>

                  <div>
                    <h4 className="text-sm font-semibold text-foreground">System details</h4>
                    <dl className="mt-3 flex flex-col gap-2.5 text-sm">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b border-border pb-2">
                        <dt className="text-muted-foreground">Cached validation errors</dt>
                        <dd className="font-medium text-foreground">{project.validationErrors?.length || 0}</dd>
                      </div>
                      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b border-border pb-2">
                        <dt className="text-muted-foreground">Cached validation warnings</dt>
                        <dd className="font-medium text-foreground">{project.validationWarnings?.length || 0}</dd>
                      </div>
                      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b border-border pb-2">
                        <dt className="text-muted-foreground">Pending showcase removal</dt>
                        <dd className="font-semibold text-foreground">
                          {project.pendingRemovalFromPublic ? 'Yes' : 'No'}
                        </dd>
                      </div>
                      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b border-border pb-2">
                        <dt className="text-muted-foreground">Created</dt>
                        <dd className="break-all text-right text-foreground-subtle">{project.created_at || 'Not recorded'}</dd>
                      </div>
                      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
                        <dt className="text-muted-foreground">Updated</dt>
                        <dd className="break-all text-right text-foreground-subtle">{project.updated_at || 'Not recorded'}</dd>
                      </div>
                    </dl>

                    {project.status === 'archived' && (
                      <div className="mt-3 rounded-lg border border-border bg-surface-inset p-3 text-sm text-foreground-subtle">
                        <p><strong className="font-semibold text-foreground">Archived:</strong> {project.archivedAt || 'Not recorded'}</p>
                        <p className="mt-1 break-words"><strong className="font-semibold text-foreground">Reason:</strong> {project.archiveReason || 'Not recorded'}</p>
                      </div>
                    )}
                  </div>
                </div>
              </ProjectReviewSection>

              <ProjectReviewSection
                id="change-history"
                tone="plain"
                title="Change history"
                description="Recorded administrative transitions, project information updates, and review notes."
                icon={History}
              >
                <ProjectAuditHistory auditRecords={auditRecords} />
              </ProjectReviewSection>
            </ProjectDetailMacroSection>
          </div>

          {/* Contextual rail: read-only record evidence that supports, but does not drive, review */}
          <aside aria-label="Project record context" className="flex min-w-0 flex-col gap-4">
            <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
              <h3 className="text-base font-semibold tracking-tight text-foreground">Project record</h3>
              <dl className="mt-4 flex flex-col gap-3.5">
                <RecordFact label="Study program code">{project.studyProgram || 'Not provided'}</RecordFact>
                <RecordFact label="Showcase disciplines">
                  {project.disciplines && project.disciplines.length > 0 ? project.disciplines.join(', ') : 'None'}
                </RecordFact>
                <RecordFact label="Industry partner">
                  {project.industryPartner ? `${project.industryPartner} (${project.industry || 'area not provided'})` : 'Not provided'}
                </RecordFact>
                <RecordFact label="Group name">{project.groupName || 'Not provided'}</RecordFact>
                <RecordFact label="Team roster">
                  {project.teamMembers && project.teamMembers.length > 0 ? (
                    <ul className="flex flex-col gap-0.5">
                      {project.teamMembers.map((member: string, index: number) => (
                        <li key={index}>{member}</li>
                      ))}
                    </ul>
                  ) : (
                    'None'
                  )}
                </RecordFact>
                <RecordFact label="Academic supervisor">{project.academicSupervisor || 'Not provided'}</RecordFact>
                <RecordFact label="Public feed eligibility">
                  {isEligible ? 'Eligible by status' : 'Not eligible at this status'}
                </RecordFact>
              </dl>
            </div>

            {project.importBatchId && (
              <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
                <h3 className="flex items-center gap-2 text-base font-semibold tracking-tight text-foreground">
                  <FolderArchive className="h-4 w-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
                  Import origin
                </h3>
                <p className="mt-2 break-all font-mono text-xs text-foreground-subtle">{project.sourceFolder}</p>
                <Button asChild variant="outline" size="sm" className="mt-3 w-full">
                  <Link href={`/admin/imports/${project.importBatchId}`}>View import batch</Link>
                </Button>
              </div>
            )}

            <div className={`flex items-start gap-2.5 p-4 ${PROJECT_DETAIL_SURFACE_CLASSES.context}`}>
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
              <p className="text-sm leading-relaxed">
                <strong className="font-semibold text-foreground">Review staging sandbox.</strong> Hosted and
                production public-feed operations are disabled and external integrations stay disconnected.
                Local test publication controls appear only on loopback Local Supabase.
              </p>
            </div>
          </aside>
        </div>

      </div>
    </ProjectMetadataNavigationProvider>
  );
}
