// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectReviewSection } from './ProjectReviewSection';
import { ProjectMediaSummary } from './ProjectMediaSummary';
import { ProjectValidationSummary } from './ProjectValidationSummary';
import { SubmitForReviewButton } from './SubmitForReviewButton';
import { StagingReviewActions } from './StagingReviewActions';
import { getReviewActionPresentation } from './reviewActionPresentation';
import { ProjectMetadataEditor } from './ProjectMetadataEditor';
import { ProjectMetadataNavigationProvider } from './ProjectMetadataNavigation';
import { Project } from '../../domain/project';
import { ProjectMetadataView } from '../../projects/projectMetadata';
import { ProjectMetadataGateway, saveProjectMetadata } from '../../projects/projectMetadataService';
import { Layers } from 'lucide-react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    refresh: vi.fn(),
  }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mockProject: Project = {
  id: 1,
  publicId: '2026-proj-01',
  title: 'Autonomous Drone Navigation',
  summary: 'A project exploring drone autonomy.',
  background: 'Problem background details.',
  solution: 'Developed solution details.',
  status: 'draft',
  year: '2026',
  program: 'Master of Computer Science',
  studyProgram: 'MC199',
  discipline: 'Software Engineering',
  disciplines: ['Software Engineering', 'Artificial Intelligence'],
  industry: 'Aviation',
  industryPartner: 'AeroTech Inc.',
  groupName: 'DroneSquad',
  participantContactEmail: 'dronesquad@example.edu',
  teamMembers: ['Alice', 'Bob'],
  academicSupervisor: 'Dr. Jane Doe',
  accessibilityText: 'Poster showing autonomous drone architecture diagram.',
  posterText: 'Full poster text content index.',
  citations: ['Ref 1', 'Ref 2'],
  externalLinks: [{ label: 'Live Demo', url: 'https://demo.example.com' }],
  videoUrl: 'https://video.example.com/watch',
  demoUrl: 'https://demo.example.com',
  repositoryUrl: 'https://github.com/example/drone',
  sourceFolder: 'drone-nav-2026',
  importBatchId: 'batch-123',
  poster: 'https://example.com/poster.png',
  posterPdf: 'https://example.com/poster.pdf',
  snapshots: ['https://example.com/snap1.png'],
  snapshotMedia: [{ url: 'https://example.com/snap1.png', altText: 'Snapshot 1', galleryPosition: 1}],
  layoutConfig: {
    templateId: 'poster_showcase',
    featuredMedia: 'poster',
    sectionOrder: ['overview', 'solution', 'media'],
  },
  validationErrors: [],
  validationWarnings: [],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
};

describe('PR2B1 Core Project Review Experience Components', () => {
  describe('ProjectReviewSection', () => {
    it('renders section title, description, icon and children', () => {
      render(
        <ProjectReviewSection
          title="Project Overview"
          description="Detailed academic and industry identification"
          icon={Layers}
        >
          <div data-testid="child-content">Section child body</div>
        </ProjectReviewSection>
      );

      expect(screen.getByText('Project Overview')).toBeTruthy();
      expect(screen.getByText('Detailed academic and industry identification')).toBeTruthy();
      expect(screen.getByTestId('child-content')).toBeTruthy();
    });
  });

  describe('ProjectMediaSummary', () => {
    it('renders external showcase links with secure attributes', () => {
      render(
        <ProjectMediaSummary
          project={mockProject}
          mediaItems={[]}
          mediaAvailable={true}
        />
      );

      expect(screen.getByText('Video Showcase')).toBeTruthy();
      expect(screen.getByText('Interactive Demo')).toBeTruthy();
      expect(screen.getByText('Git Repository')).toBeTruthy();

      const videoLink = screen.getByRole('link', { name: /video showcase link/i });
      expect(videoLink.getAttribute('href')).toBe('https://video.example.com/watch');
      expect(videoLink.getAttribute('target')).toBe('_blank');
      expect(videoLink.getAttribute('rel')).toBe('noopener noreferrer');

      const demoLink = screen.getByRole('link', { name: /external demo/i });
      expect(demoLink.getAttribute('href')).toBe('https://demo.example.com');
      expect(demoLink.getAttribute('target')).toBe('_blank');
      expect(demoLink.getAttribute('rel')).toBe('noopener noreferrer');

      const repoLink = screen.getByRole('link', { name: /git repository/i });
      expect(repoLink.getAttribute('href')).toBe('https://github.com/example/drone');
      expect(repoLink.getAttribute('target')).toBe('_blank');
      expect(repoLink.getAttribute('rel')).toBe('noopener noreferrer');
    });

    it('renders fallback when media preview is unavailable', () => {
      render(
        <ProjectMediaSummary
          project={mockProject}
          mediaItems={[]}
          mediaAvailable={false}
        />
      );

      expect(screen.getByRole('status').textContent).toContain('Media preview temporarily unavailable.');
    });
  });

  describe('ProjectValidationSummary', () => {
    const invalidPrivateApprovalMedia = {
      posterImage: { rowCount: 1, validPrivateCount: 0 },
      posterPdf: { rowCount: 1, validPrivateCount: 0 },
      snapshotMedia: [{ galleryPosition: 1, validPrivate: false, altText: 'Snapshot 1' }],
    };

    it('renders blocking errors and compliance warnings without emoji', () => {
      const invalidProject: Project = {
        ...mockProject,
        posterText: '', // Missing poster text causes validation error
        layoutConfig: {
          templateId: 'unsupported_template',
          featuredMedia: 'poster',
          sectionOrder: ['overview'],
        },
      };

      render(<ProjectValidationSummary project={invalidProject} approvalMedia={{
        posterImage: { rowCount: 1, validPrivateCount: 1 },
        posterPdf: { rowCount: 1, validPrivateCount: 1 },
        snapshotMedia: [],
      }} />);

      expect(screen.getByText(/Blocking issues/i)).toBeTruthy();
      expect(screen.queryByText(/✅/)).toBeNull();
      expect(screen.queryByText(/❌/)).toBeNull();
    });

    it('renders validation passed indicator when approved with no blocking errors', () => {
      const readyProject: Project = {
        ...mockProject,
        status: 'approved',
      };

      render(<ProjectValidationSummary project={readyProject} approvalMedia={{
        posterImage: { rowCount: 1, validPrivateCount: 1 },
        posterPdf: { rowCount: 1, validPrivateCount: 1 },
        snapshotMedia: [],
      }} />);

      expect(screen.getByText(/Validation passed/i)).toBeTruthy();
      expect(screen.getByText(/This project has no blocking validation issues/i)).toBeTruthy();
      expect(screen.queryByText(/Ready for publication/i)).toBeNull();
      expect(screen.queryByText(/Publication ready/i)).toBeNull();
    });

    it.each(['submitted', 'in_review'] as const)('keeps private staged-media approval blockers for %s projects', (status) => {
      render(<ProjectValidationSummary project={{ ...mockProject, status }} approvalMedia={invalidPrivateApprovalMedia} />);

      expect(screen.getByText(/Poster image in staged project media is invalid\. Approval blocked\./i)).toBeTruthy();
      expect(screen.getByText(/Poster PDF in staged project media is invalid\. Approval blocked\./i)).toBeTruthy();
      expect(screen.getByText(/Snapshot gallery in staged project media is invalid\. Approval blocked\./i)).toBeTruthy();
    });

    it('does not render pre-approval media blockers for published projects', () => {
      render(<ProjectValidationSummary project={{ ...mockProject, status: 'published' }} approvalMedia={invalidPrivateApprovalMedia} />);

      expect(screen.getByText(/Approval validation was completed before publication/i)).toBeTruthy();
      expect(screen.queryByText(/Approval blocked/i)).toBeNull();
      expect(screen.queryByText(/Poster image in staged project media is invalid/i)).toBeNull();
      expect(screen.queryByText(/Poster PDF in staged project media is invalid/i)).toBeNull();
      expect(screen.queryByText(/Snapshot gallery in staged project media is invalid/i)).toBeNull();
      expect(screen.queryByText(/Validation needs attention/i)).toBeNull();
    });

    it('does not render pre-approval media blockers for archived projects', () => {
      render(<ProjectValidationSummary project={{ ...mockProject, status: 'archived' }} approvalMedia={invalidPrivateApprovalMedia} />);

      expect(screen.getByText(/Approval validation is not applicable in the archived state/i)).toBeTruthy();
      expect(screen.queryByText(/Approval blocked/i)).toBeNull();
      expect(screen.queryByText(/Poster image in staged project media is invalid/i)).toBeNull();
      expect(screen.queryByText(/Poster PDF in staged project media is invalid/i)).toBeNull();
      expect(screen.queryByText(/Snapshot gallery in staged project media is invalid/i)).toBeNull();
      expect(screen.queryByText(/Validation needs attention/i)).toBeNull();
    });

    it('keeps layout validation active after publication', () => {
      render(<ProjectValidationSummary
        project={{
          ...mockProject,
          status: 'published',
          layoutConfig: { ...mockProject.layoutConfig, templateId: 'unsupported_template' },
        }}
        approvalMedia={invalidPrivateApprovalMedia}
      />);

      expect(screen.getByText(/Invalid layout templateId "unsupported_template"/i)).toBeTruthy();
      expect(screen.queryByText(/Approval blocked/i)).toBeNull();
    });
  });

  describe('SubmitForReviewButton', () => {
    it('dispatches submit-for-review API request and renders success', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, submittedCount: 1 }),
      });
      vi.stubGlobal('fetch', mockFetch);

      render(
        <ProjectMetadataNavigationProvider>
          <SubmitForReviewButton
            batchId="batch-123"
            publicId="2026-proj-01"
            currentStatus="draft"
          />
        </ProjectMetadataNavigationProvider>
      );

      const button = screen.getByRole('button', { name: /Submit for review/i });
      fireEvent.click(button);

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          '/api/imports/batch-123/submit-for-review',
          expect.objectContaining({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectPublicIds: ['2026-proj-01'] }),
          })
        );
      });

      expect(await screen.findByText(/Submitted for review successfully\./i)).toBeTruthy();
    });

    it('renders safe generic error message when submit fails', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ success: false, error: 'Internal database query failure details' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      render(
        <ProjectMetadataNavigationProvider>
          <SubmitForReviewButton
            batchId="batch-123"
            publicId="2026-proj-01"
            currentStatus="draft"
          />
        </ProjectMetadataNavigationProvider>
      );

      const button = screen.getByRole('button', { name: /Submit for review/i });
      fireEvent.click(button);

      expect(await screen.findByText(/Project could not be submitted for review\. Please try again\./i)).toBeTruthy();
    });
  });

  describe('StagingReviewActions', () => {
    it('keeps the allowed action order and assigns accurate visual semantics', () => {
      const actions = ['approve', 'request_changes', 'archive'];
      render(
        <StagingReviewActions
          publicId="2026-proj-01"
          currentStatus="in_review"
          allowedActions={actions}
        />
      );

      expect(
        screen.getAllByRole('button').filter((button) => actions.some((action) =>
          button.textContent === getReviewActionPresentation(action).label,
        )).map((button) => button.textContent),
      ).toEqual(actions.map((action) => getReviewActionPresentation(action).label));

      expect(getReviewActionPresentation('approve').variant).toBe('default');
      expect(getReviewActionPresentation('request_changes').variant).toBe('outline');
      expect(getReviewActionPresentation('request_changes').className).not.toContain('destructive');
      expect(getReviewActionPresentation('archive').variant).toBe('destructive');
    });

    it('does not render denied review controls that could be keyboard reached', () => {
      render(
        <StagingReviewActions
          publicId="2026-proj-01"
          currentStatus="in_review"
          allowedActions={[]}
        />
      );

      expect(screen.queryByRole('button', { name: /Approve project/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /Request changes/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /Archive project/i })).toBeNull();
    });

    it('requires accessible confirmation and safely cancels archive by button or Escape', async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);

      render(
        <StagingReviewActions
          publicId="2026-proj-01"
          currentStatus="in_review"
          allowedActions={['archive']}
        />
      );

      const archiveButton = screen.getByRole('button', { name: 'Archive project' });
      archiveButton.focus();
      fireEvent.click(archiveButton);

      const dialog = screen.getByRole('alertdialog', { name: 'Archive project?' });
      expect(mockFetch).not.toHaveBeenCalled();
      const descriptionId = dialog.getAttribute('aria-describedby');
      expect(descriptionId).toBeTruthy();
      expect(document.getElementById(descriptionId!)?.textContent).toMatch(/moves this project to Archived/i);
      expect(within(dialog).getByText(/moves this project to Archived/i)).toBeTruthy();
      expect(within(dialog).getByText(/does not delete project data/i)).toBeTruthy();
      expect(within(dialog).getByText(/not the controlled public-removal workflow/i)).toBeTruthy();
      expect(within(dialog).getByRole('button', { name: 'Archive project' })).toBeTruthy();

      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect(mockFetch).not.toHaveBeenCalled();
      await waitFor(() => expect(document.activeElement).toBe(archiveButton));

      fireEvent.click(archiveButton);
      expect(screen.getByRole('alertdialog', { name: 'Archive project?' })).toBeTruthy();
      fireEvent.keyDown(document, { key: 'Escape' });

      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect(mockFetch).not.toHaveBeenCalled();
      await waitFor(() => expect(document.activeElement).toBe(archiveButton));
    });

    it('dispatches exactly one canonical archive request only after confirmation', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      });
      vi.stubGlobal('fetch', mockFetch);

      render(
        <StagingReviewActions
          publicId="2026-proj-01"
          currentStatus="in_review"
          allowedActions={['archive']}
        />
      );

      fireEvent.change(screen.getByLabelText(/Review comments/i), {
        target: { value: 'Archive after final review.' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Archive project' }));
      expect(mockFetch).not.toHaveBeenCalled();

      const confirmButton = within(screen.getByRole('alertdialog')).getByRole('button', {
        name: 'Archive project',
      });
      fireEvent.click(confirmButton);
      fireEvent.click(confirmButton);

      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/projects/2026-proj-01/review-action',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'archive', comments: 'Archive after final review.' }),
        }),
      );
    });

    it('dispatches approve directly without archive confirmation', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      });
      vi.stubGlobal('fetch', mockFetch);

      render(
        <StagingReviewActions
          publicId="2026-proj-01"
          currentStatus="in_review"
          allowedActions={['approve', 'request_changes']}
        />
      );

      const textarea = screen.getByLabelText(/Review comments/i);
      fireEvent.change(textarea, { target: { value: 'Looks great!' } });

      const approveButton = screen.getByRole('button', { name: /Approve project/i });
      expect(approveButton).toBeTruthy();

      const requestChangesButton = screen.getByRole('button', { name: /Request changes/i });
      expect(requestChangesButton).toBeTruthy();

      fireEvent.click(approveButton);

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          '/api/projects/2026-proj-01/review-action',
          expect.objectContaining({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'approve', comments: 'Looks great!' }),
          })
        );
      });

      expect(await screen.findByText(/Status transition successful\./i)).toBeTruthy();
    });

    it('dispatches request changes directly without archive confirmation', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      });
      vi.stubGlobal('fetch', mockFetch);

      render(
        <StagingReviewActions
          publicId="2026-proj-01"
          currentStatus="in_review"
          allowedActions={['request_changes']}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: /Request changes/i }));

      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/projects/2026-proj-01/review-action',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ action: 'request_changes', comments: undefined }),
        }),
      );
    });

    it('renders safe generic error message when review transition fails', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ success: false, error: 'Detailed RPC exception trace' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      render(
        <StagingReviewActions
          publicId="2026-proj-01"
          currentStatus="in_review"
          allowedActions={['approve']}
        />
      );

      const approveButton = screen.getByRole('button', { name: /Approve project/i });
      fireEvent.click(approveButton);

      expect(await screen.findByText(/Status transition could not be completed\. Please try again\./i)).toBeTruthy();
    });
  });

  describe('ProjectMetadataEditor heading level', () => {
    const mockMetadataView: ProjectMetadataView = {
      publicId: '2026-proj-01',
      title: 'Autonomous Drone Navigation',
      summary: 'A project exploring drone autonomy.',
      background: 'Problem background details.',
      solution: 'Developed solution details.',
      posterText: 'Full poster text content index.',
      accessibilityText: 'Poster showing autonomous drone architecture diagram.',
      year: '2026',
      programId: 'a0000000-0000-4000-8000-000000000001',
      disciplineIds: ['b0000000-0000-4000-8000-000000000001'],
      industryCategoryIds: ['c0000000-0000-4000-8000-000000000001'],
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
    };

    it('renders heading level 2 by default when headingLevel prop is omitted', () => {
      render(
        <ProjectMetadataNavigationProvider>
          <ProjectMetadataEditor
            initialMetadata={mockMetadataView}
            programs={[]}
            disciplines={[]}
            industryCategories={[]}
            canEdit={true}
            projectStatus="draft"
            saveAction={vi.fn()}
          />
        </ProjectMetadataNavigationProvider>
      );

      expect(screen.getByRole('heading', { name: /project information/i, level: 2 })).toBeTruthy();
    });

    it('renders heading level 4 when explicit headingLevel="h4" is provided', () => {
      render(
        <ProjectMetadataNavigationProvider>
          <ProjectMetadataEditor
            initialMetadata={mockMetadataView}
            programs={[]}
            disciplines={[]}
            industryCategories={[]}
            canEdit={true}
            projectStatus="draft"
            saveAction={vi.fn()}
            headingLevel="h4"
          />
        </ProjectMetadataNavigationProvider>
      );

      expect(screen.getByRole('heading', { name: /project information/i, level: 4 })).toBeTruthy();
    });
  });

  describe('ProjectMetadataEditor save acknowledgement (regression for #128)', () => {
    const initialMetadata: ProjectMetadataView = {
      publicId: '2026-proj-01',
      title: 'Autonomous Drone Navigation',
      summary: 'A project exploring drone autonomy.',
      background: 'Problem background details.',
      solution: 'Developed solution details.',
      posterText: 'Full poster text content index.',
      accessibilityText: 'Poster showing autonomous drone architecture diagram.',
      year: '2026',
      programId: 'a0000000-0000-4000-8000-000000000001',
      disciplineIds: ['b0000000-0000-4000-8000-000000000001'],
      industryCategoryIds: ['c0000000-0000-4000-8000-000000000001'],
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
    };
    const options = {
      programs: [{ id: initialMetadata.programId, name: 'Program' }],
      disciplines: [{ id: initialMetadata.disciplineIds[0], name: 'Discipline' }],
      industryCategories: [{ id: initialMetadata.industryCategoryIds[0], name: 'Industry' }],
    };

    const renderEditor = (rpcResponse: unknown) => {
      const gateway: ProjectMetadataGateway = {
        loadProject: async () => { throw new Error('Persistence must not be reached'); },
        loadOptions: async () => options,
        updateMetadataAtomically: async () => rpcResponse,
      };
      const saveAction = (input: unknown) => saveProjectMetadata(gateway, input, 'test-admin-user');
      return render(
        <ProjectMetadataNavigationProvider>
          <ProjectMetadataEditor
            initialMetadata={initialMetadata}
            programs={options.programs}
            disciplines={options.disciplines}
            industryCategories={options.industryCategories}
            canEdit={true}
            projectStatus="changes_requested"
            saveAction={saveAction}
          />
        </ProjectMetadataNavigationProvider>,
      );
    };

    const enterEditAndChangeTitle = (title: string) => {
      fireEvent.click(screen.getByRole('button', { name: /edit project information/i }));
      fireEvent.change(screen.getByLabelText(/project title/i), { target: { value: title } });
    };

    it('exits edit mode and shows the saved confirmation for a committed save matching the authoritative audited RPC contract', async () => {
      const revisedMetadata = { ...initialMetadata, title: 'Revised title' };
      renderEditor({ resultCode: 'SUCCESS', metadata: revisedMetadata, auditRecordId: 'e0000000-0000-4000-8000-000000000001' });

      enterEditAndChangeTitle('Revised title');
      fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

      expect(await screen.findByText('Project information saved.')).toBeTruthy();
      expect(screen.queryByRole('button', { name: /save changes/i })).toBeNull();
      expect(screen.getByRole('button', { name: /edit project information/i })).toBeTruthy();
    });

    it('stays in edit mode when the RPC response omits the audit record the authoritative contract always returns', async () => {
      const revisedMetadata = { ...initialMetadata, title: 'Revised title' };
      renderEditor({ resultCode: 'SUCCESS', metadata: revisedMetadata });

      enterEditAndChangeTitle('Revised title');
      fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

      expect(await screen.findByText('We could not save your changes. Please try again.')).toBeTruthy();
      expect(screen.getByRole('button', { name: /save changes/i })).toBeTruthy();
    });
  });
});
