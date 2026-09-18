import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  repositoryConstructed: vi.fn(),
  getProjectByPublicId: vi.fn(),
  events: [] as string[],
  hasPermission: vi.fn(),
  canManageParticipantPreview: vi.fn(),
  canPreparePublication: vi.fn(),
  canResolveParticipantCorrection: vi.fn(),
  createSupabaseAdminClientCore: vi.fn(),
  loadProjectMetadataEditorData: vi.fn(),
  loadProjectDetailAuxiliaryData: vi.fn(),
  loadProjectMediaReviewData: vi.fn(),
  getServerEnv: vi.fn(),
  resolvePublicationExecutionTarget: vi.fn(),
  resolveAssistiveExecutionAvailability: vi.fn(),
  loadAssistiveInspection: vi.fn(),
  getAllowedReviewActions: vi.fn(),
  deriveProjectWorkflowContext: vi.fn(),
  getPermittedReviewActions: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('../../../../auth/requireAdmin', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('../../../../auth/permissions', () => ({
  hasPermission: mocks.hasPermission,
  canManageParticipantPreview: mocks.canManageParticipantPreview,
  canPreparePublication: mocks.canPreparePublication,
  canResolveParticipantCorrection: mocks.canResolveParticipantCorrection,
}));
vi.mock('../../../../repositories/SupabaseProjectRepository', () => ({
  SupabaseProjectRepository: class {
    constructor() {
      mocks.events.push('construct');
      mocks.repositoryConstructed();
    }
    getProjectByPublicId = (...args: unknown[]) => {
      mocks.events.push('getProjectByPublicId');
      return mocks.getProjectByPublicId(...args);
    };
  },
}));
vi.mock('../../../../lib/supabase/adminCore', () => ({
  createSupabaseAdminClientCore: mocks.createSupabaseAdminClientCore,
}));
vi.mock('../../../../lib/env', () => ({ getServerEnv: mocks.getServerEnv }));
vi.mock('../../../../projects/projectMetadataService', () => ({
  SupabaseProjectMetadataGateway: class {},
  loadProjectMetadataEditorData: mocks.loadProjectMetadataEditorData,
}));
vi.mock('../../../../projects/projectDetailAuxiliaryData', () => ({
  loadProjectDetailAuxiliaryData: mocks.loadProjectDetailAuxiliaryData,
  ProjectDetailAuxiliaryReadError: class extends Error {},
  projectDetailFailureCategory: () => 'AUXILIARY_FAILURE',
  PROJECT_AUDIT_HISTORY_SELECT: 'id',
  parseAuditHistoryRow: vi.fn(),
}));
vi.mock('../../../../projects/projectMediaPreview', () => ({ loadProjectMediaReviewData: mocks.loadProjectMediaReviewData }));
vi.mock('../../../../assistive-validation', () => ({
  resolveAssistiveExecutionAvailability: mocks.resolveAssistiveExecutionAvailability,
  loadAssistiveInspection: mocks.loadAssistiveInspection,
  SupabaseAssistiveValidationRepository: class {},
  SupabaseAssistiveInputRepository: class {},
  SupabaseAssistiveWorkerHeartbeatRepository: class {},
  resolveAssistiveWorkerRuntimeIdentity: vi.fn(),
  SupabaseAssistiveExecutionControlRepository: class {},
  ASSISTIVE_PIPELINE_VERSION: 'test-pipeline',
}));
vi.mock('../../../../notifications/participantPreviewEmailConfig', () => ({ isParticipantPreviewEmailEnabled: () => false }));
vi.mock('../../../../reminders/participantPreviewReminderConfig', () => ({ isParticipantPreviewRemindersEnabled: () => false }));
vi.mock('../../../../repositories/SupabaseParticipantPreviewRepository', () => ({ SupabaseParticipantPreviewRepository: class {} }));
vi.mock('../../../../repositories/SupabaseParticipantPreviewNotificationRepository', () => ({ SupabaseParticipantPreviewNotificationRepository: class {} }));
vi.mock('../../../../repositories/SupabaseParticipantPreviewReminderRepository', () => ({ SupabaseParticipantPreviewReminderRepository: class {} }));
vi.mock('../../../../workflow/projectWorkflow', () => ({ getAllowedReviewActions: mocks.getAllowedReviewActions }));
vi.mock('../../../../projects/publicationExecutionPolicy', () => ({ resolvePublicationExecutionTarget: mocks.resolvePublicationExecutionTarget }));
vi.mock('../../../../security/stagingRuntimeIdentity', () => ({
  isProductionRuntimeEnvironment: () => false,
  isStagingRuntimeEnvironment: () => false,
}));
vi.mock('../../../../previews/participantCorrectionReview', () => ({ loadCorrectionReviewView: vi.fn() }));
vi.mock('../../../../components/admin/ProjectStatusBadge', () => ({ ProjectStatusBadge: () => null }));
vi.mock('../../../../components/admin/ProjectReviewSection', () => ({ ProjectDetailMacroSection: () => null, ProjectReviewSection: () => null }));
vi.mock('../../../../components/admin/ProjectDetailSectionNavigation', () => ({ ProjectDetailSectionNavigation: () => null }));
vi.mock('../../../../components/admin/ProjectMediaSummary', () => ({ ProjectMediaSummary: () => null }));
vi.mock('../../../../components/admin/ProjectValidationSummary', () => ({ ProjectValidationSummary: () => null }));
vi.mock('../../../../components/admin/StagingReviewActions', () => ({ StagingReviewActions: () => null }));
vi.mock('../../../../components/admin/ProjectSoftDeleteAction', () => ({ ProjectSoftDeleteAction: () => null }));
vi.mock('../../../../components/admin/ParticipantCorrectionReview', () => ({ ParticipantCorrectionReview: () => null }));
vi.mock('../../../../components/admin/PrePreviewPackageReplacement', () => ({ PrePreviewPackageReplacement: () => null }));
vi.mock('../../../../components/admin/ParticipantPreviewPanel', () => ({ ParticipantPreviewPanel: () => null }));
vi.mock('../../../../components/admin/ParticipantPreviewAccessEvidence', () => ({ ParticipantPreviewAccessEvidence: () => null }));
vi.mock('../../../../components/admin/ProjectMetadataEditor', () => ({ ProjectMetadataEditor: () => null }));
vi.mock('../../../../components/admin/ProjectMetadataNavigation', () => ({ GuardedProjectBackLink: () => null, ProjectMetadataNavigationProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('../../../../components/admin/ProjectAssistiveChecks', () => ({ ProjectAssistiveChecks: () => null }));
vi.mock('../../../../components/admin/SubmitForReviewButton', () => ({ SubmitForReviewButton: () => null }));
vi.mock('../../../../components/admin/PublicationReadinessPanel', () => ({ PublicationReadinessPanel: () => null }));
vi.mock('../../../../components/admin/LocalArchivePanel', () => ({ LocalArchivePanel: () => null }));
vi.mock('../../../../components/admin/ProjectAuditHistory', () => ({ ProjectAuditHistory: () => null }));
vi.mock('../../../../components/admin/projectWorkflowContext', () => ({ deriveProjectWorkflowContext: mocks.deriveProjectWorkflowContext }));
vi.mock('../../../../components/admin/projectReviewActions', () => ({ getPermittedReviewActions: mocks.getPermittedReviewActions }));
vi.mock('../../../../components/admin/projectDetailSurfaceStyles', () => ({ PROJECT_DETAIL_SURFACE_CLASSES: {} }));
vi.mock('../../../../app/admin/projects/[publicId]/actions', () => ({
  saveProjectMetadataAction: vi.fn(),
  saveSnapshotAltTextAction: vi.fn(),
}));
vi.mock('../../../../repositories/ImportBatchRepository', () => ({ ImportBatchRepository: class {} }));
vi.mock('../../../../import/importBatchReviewReadiness', () => ({ computeReadinessForImportBatchRow: vi.fn() }));

import ProjectDetailPage from './page';

const PROJECT = {
  id: 1, publicId: 'project-1', title: 'Project one', summary: 'Summary', background: 'Background', solution: 'Solution',
  year: '2026', program: 'Program', studyProgram: 'Study program', discipline: 'Discipline', disciplines: ['Discipline'],
  industry: 'Technology', industryPartner: 'Partner', academicSupervisor: 'Supervisor', groupName: 'Team',
  participantContactEmail: 'participant@example.invalid', teamMembers: ['Participant'], poster: '', posterPdf: '',
  posterText: 'Poster text', accessibilityText: 'Accessible text', snapshots: [], snapshotMedia: [], videoUrl: '',
  demoUrl: '', repositoryUrl: '', externalLinks: [], citations: [], layoutConfig: { templateId: 'poster_showcase', featuredMedia: 'poster', sectionOrder: [], hiddenSections: [] },
  status: 'published',
} as never;

function renderPage(publicId = 'project-1') {
  return ProjectDetailPage({ params: Promise.resolve({ publicId }) });
}

describe('Project detail authorization boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.events.length = 0;
    mocks.requireAdmin.mockImplementation(async () => {
      mocks.events.push('auth');
      return { permissions: ['projects.read'], roles: ['reviewer'], adminUserId: 'admin-1' };
    });
    mocks.hasPermission.mockReturnValue(false);
    mocks.canManageParticipantPreview.mockReturnValue(false);
    mocks.canPreparePublication.mockReturnValue(false);
    mocks.canResolveParticipantCorrection.mockReturnValue(false);
    mocks.getProjectByPublicId.mockResolvedValue(PROJECT);
    mocks.createSupabaseAdminClientCore.mockReturnValue({
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: { id: 'db-project-1' }, error: null }) }),
        }),
      }),
    });
    mocks.loadProjectMetadataEditorData.mockResolvedValue(null);
    mocks.loadProjectDetailAuxiliaryData.mockRejectedValue(new Error('optional auxiliary unavailable'));
    mocks.getServerEnv.mockReturnValue({ supabaseUrl: 'http://127.0.0.1:54321', SUPABASE_DRAFT_BUCKET: 'drafts' });
    mocks.resolveAssistiveExecutionAvailability.mockResolvedValue({ canEnqueue: false, message: null });
    mocks.getAllowedReviewActions.mockReturnValue([]);
    mocks.deriveProjectWorkflowContext.mockReturnValue({});
    mocks.getPermittedReviewActions.mockReturnValue([]);
  });

  it('fails closed before constructing or reading the service-role project repository', async () => {
    mocks.requireAdmin.mockRejectedValueOnce(new Error('session revoked'));

    const markup = renderToStaticMarkup(await renderPage());

    expect(mocks.repositoryConstructed).not.toHaveBeenCalled();
    expect(mocks.getProjectByPublicId).not.toHaveBeenCalled();
    expect(markup).toContain('Project Details Unavailable');
  });

  it('authenticates before the missing-project lookup and preserves the not-found state', async () => {
    mocks.getProjectByPublicId.mockResolvedValueOnce(null);

    const markup = renderToStaticMarkup(await renderPage('missing-project'));

    expect(mocks.events).toEqual(['auth', 'construct', 'getProjectByPublicId']);
    expect(markup).toContain('Project not found');
  });

  it('loads an authorized project before optional auxiliary data', async () => {
    const element = await renderPage();

    expect(mocks.events).toEqual(['auth', 'construct', 'getProjectByPublicId']);
    expect(element).toBeTruthy();
    expect(mocks.getProjectByPublicId).toHaveBeenCalledWith('project-1');
  });
});
