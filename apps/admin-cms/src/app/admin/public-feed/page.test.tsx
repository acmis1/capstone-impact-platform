/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';

afterEach(cleanup);
import PublicFeedHistoryPage from './page';
import * as publicFeedRepo from '../../../projects/publicFeedHistoryRepository';
import * as requireAdminModule from '../../../auth/requireAdmin';
import * as envModule from '../../../lib/env';
import { PUBLISHING_IN_PROGRESS_STATES } from '../../../components/admin/publishingHealthPresentation';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock('../../../auth/requireAdmin');
vi.mock('../../../projects/publicFeedHistoryRepository');
vi.mock('../../../lib/env');
vi.mock('../../../lib/supabase/admin', () => ({
  createSupabaseAdminClient: () => ({}) as unknown as ReturnType<typeof import('../../../lib/supabase/admin').createSupabaseAdminClient>,
}));

const MOCK_ADMIN: Awaited<ReturnType<typeof requireAdminModule.requireAdmin>> = {
  authUserId: 'auth-1',
  adminUserId: 'admin-1',
  fullName: 'Jane Admin',
  email: 'admin@example.com',
  roles: ['admin'],
  permissions: ['projects.publish', 'projects.read', 'projects.review', 'projects.archive', 'projects.edit', 'staff.manage'],
};

const MOCK_ENV = {
  supabaseUrl: 'http://localhost:54321',
  supabaseAnonKey: 'anon',
  supabaseServiceRoleKey: 'service',
} as unknown as ReturnType<typeof envModule.getServerEnv>;

const BASE_VIEW: publicFeedRepo.PublicFeedHistoryView = {
  active: true,
  rollbackEnabled: false,
  currentVersionNumber: 10,
  generation: 10,
  page: 1,
  pageSize: 50,
  hasNewer: false,
  hasOlder: true,
  versions: [
    {
      versionNumber: 10,
      operation: 'publication',
      publicationMode: 'normal',
      createdAt: '2026-08-25T10:00:00.000Z',
      actorDisplay: 'Jane Admin',
      completionActorDisplay: 'Jane Admin',
      recordCount: 5,
      byteCount: 1024,
      feedHash: 'a'.repeat(64),
      current: true,
      affectedPublicId: 'proj-1',
      affectedTitle: 'Project One',
      previousVersionNumber: 9,
      restoredFromVersionNumber: null,
    },
  ],
  detail: null,
  deploymentStatuses: [
    { publicId: 'proj-1', title: 'Project One', lifecycleStatus: 'published', deployed: true },
    { publicId: 'proj-2', title: 'Project Two', lifecycleStatus: 'archived', deployed: false },
  ],
  blockingOperation: null,
};

function mockPage(view: publicFeedRepo.PublicFeedHistoryView) {
  vi.mocked(requireAdminModule.requireAdmin).mockResolvedValue(MOCK_ADMIN);
  vi.mocked(envModule.getServerEnv).mockReturnValue(MOCK_ENV);
  vi.mocked(publicFeedRepo.readPublicFeedHistory).mockResolvedValue(view);
}

async function renderPage(query: { version?: string; page?: string } = {}) {
  const jsx = await PublicFeedHistoryPage({ searchParams: Promise.resolve(query) });
  render(jsx);
}

function getPublishingHeader() {
  const header = screen.getByRole('heading', { name: 'Showcase publishing history' }).closest('header');
  if (!header) throw new Error('Publishing page header was not rendered.');
  return within(header);
}

function getActivityTable() {
  return within(screen.getByRole('region', { name: 'Publishing activity' }));
}

describe('PublicFeedHistoryPage', () => {
  it('renders top summary cards truthfully and does not leak raw publication modes', async () => {
    mockPage(BASE_VIEW);
    await renderPage();

    expect(screen.getByText('Showcase publishing history')).toBeTruthy();
    expect(screen.getByText('Ready')).toBeTruthy();
    expect(screen.getAllByText('Projects published').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('1')).toBeTruthy(); // 1 project in the published deployment state
    expect(screen.getAllByText('Published').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('Showcase connected')).toBeNull();
    expect(screen.queryByText('Connected')).toBeNull();
    expect(screen.queryByText(/Published · normal/i)).toBeNull();
    expect(getPublishingHeader().getByText('Publishing ready')).toBeTruthy();
  });

  it('names the summary card Publishing health and reports no issues when nothing is wrong', async () => {
    mockPage(BASE_VIEW);
    await renderPage();

    expect(screen.getByText('Publishing health')).toBeTruthy();
    expect(screen.getByText('No issues')).toBeTruthy();
    expect(screen.queryByText('Status alignment')).toBeNull();
    expect(screen.queryByText('All projects in sync')).toBeNull();
  });

  it('offers a task-first route back to the project list at /admin', async () => {
    mockPage(BASE_VIEW);
    await renderPage();

    const cta = getPublishingHeader().getByRole('link', { name: /Choose a project to publish/i });
    expect(cta.getAttribute('href')).toBe('/admin');
  });

  it('shows setup required in the header when publishing is inactive and no operation is blocking', async () => {
    mockPage({ ...BASE_VIEW, active: false });
    await renderPage();

    const header = getPublishingHeader();
    expect(header.getByText('Setup required')).toBeTruthy();
    expect(header.queryByText('Publishing ready')).toBeNull();
  });

  it('renders truthful status metrics when on page 2+ without mislabeling page-relative timestamps', async () => {
    mockPage({
      ...BASE_VIEW,
      page: 2,
      hasNewer: true,
      hasOlder: false,
      versions: [
        {
          versionNumber: 5,
          operation: 'publication',
          publicationMode: 'deployment_reconciliation',
          createdAt: '2026-08-20T10:00:00.000Z',
          actorDisplay: 'Jane Admin',
          completionActorDisplay: 'Jane Admin',
          recordCount: 4,
          byteCount: 900,
          feedHash: 'b'.repeat(64),
          current: false,
          affectedPublicId: 'proj-2',
          affectedTitle: 'Project Two',
          previousVersionNumber: 4,
          restoredFromVersionNumber: null,
        },
      ],
    });
    await renderPage({ page: '2' });

    // Publishing health stays a global, truthful fact rather than a page-relative one.
    expect(screen.getByText('No issues')).toBeTruthy();
    // Verifies operation translation for deployment_reconciliation
    expect(screen.getByText('Showcase status repaired')).toBeTruthy();
    expect(screen.queryByText(/deployment reconciliation/i)).toBeNull();
  });

  it('alerts when published projects diverge from showcase deployment status', async () => {
    mockPage({
      ...BASE_VIEW,
      deploymentStatuses: [
        { publicId: 'proj-1', title: 'Project One', lifecycleStatus: 'published', deployed: true },
        { publicId: 'proj-2', title: 'Project Two', lifecycleStatus: 'published', deployed: false },
      ],
    });
    await renderPage();

    expect(screen.getByText('1 project needs repair')).toBeTruthy();
    expect(screen.getByText(/Publishing status needs attention:/i)).toBeTruthy();
  });

  it('uses reconciliation semantics consistently in activity and selected details', async () => {
    const reconciliationItem: publicFeedRepo.PublicFeedHistoryDetail = {
      ...BASE_VIEW.versions[0],
      publicationMode: 'deployment_reconciliation',
      affectedPublicId: 'proj-2',
      affectedTitle: 'Project Two',
      members: [{
        ordinal: 1,
        publicId: 'proj-2',
        title: 'Project Two',
        lifecycleStatus: 'published',
        currentlyDeployed: true,
      }],
    };
    mockPage({ ...BASE_VIEW, versions: [reconciliationItem], detail: reconciliationItem });
    await renderPage({ version: '10' });

    expect(screen.getByText('Showcase status repaired')).toBeTruthy();
    expect(screen.getByText('Repaired showcase status for Project Two')).toBeTruthy();
    expect(screen.queryByText('Published project Project Two')).toBeNull();
  });

  describe('in-progress versus recovery semantics', () => {
    it('presents RECOVERY_REQUIRED as recovery required and pauses publishing', async () => {
      mockPage({
        ...BASE_VIEW,
        blockingOperation: {
          kind: 'PUBLICATION',
          state: 'RECOVERY_REQUIRED',
          failureCode: 'STORAGE_TIMEOUT',
          updatedAt: '2026-08-25T12:00:00.000Z',
        },
      });
      await renderPage();

      const header = getPublishingHeader();
      expect(header.getByText('Needs attention')).toBeTruthy();
      expect(header.queryByText('Publishing ready')).toBeNull();
      // Header badge, publishing status card and publishing health card all agree.
      expect(screen.getAllByText('Needs attention')).toHaveLength(3);
      expect(screen.getByText('Publishing needs attention')).toBeTruthy();
      expect(screen.getAllByText(/did not finish cleanly/i).length).toBeGreaterThanOrEqual(1);
      expect(screen.getByRole('button', { name: /Recover publishing status/i })).toBeTruthy();
      expect(screen.queryByText('Publishing in progress')).toBeNull();
    });

    it.each(PUBLISHING_IN_PROGRESS_STATES)(
      'presents %s as an ordinary publishing action still running, never as recovery',
      async (state) => {
        mockPage({
          ...BASE_VIEW,
          blockingOperation: { kind: 'PUBLICATION', state, failureCode: null, updatedAt: '2026-08-25T12:00:00.000Z' },
        });
        await renderPage();

        const header = getPublishingHeader();
        expect(header.getByText('Publishing in progress')).toBeTruthy();
        expect(header.queryByText('Needs attention')).toBeNull();
        expect(screen.getByText(/Another publishing action is currently running/i)).toBeTruthy();

        // No recovery wording and no recovery control merely because an operation is in flight.
        expect(screen.queryByText('Publishing needs attention')).toBeNull();
        expect(screen.queryByText('Publishing recovery required')).toBeNull();
        expect(screen.queryByText(/did not finish cleanly/i)).toBeNull();
        expect(screen.queryByRole('button', { name: /Recover publishing status/i })).toBeNull();
      },
    );

    it('keeps the publishing health card in agreement while an action is running', async () => {
      mockPage({
        ...BASE_VIEW,
        blockingOperation: { kind: 'PUBLICATION', state: 'WRITE_STARTED', failureCode: null, updatedAt: '2026-08-25T12:00:00.000Z' },
      });
      await renderPage();

      // Header badge, publishing status card, publishing health card and the alert heading agree.
      expect(screen.getAllByText('Publishing in progress')).toHaveLength(4);
      expect(screen.queryByText('No issues')).toBeNull();
    });

    it('keeps the raw operation state available under technical details only', async () => {
      mockPage({
        ...BASE_VIEW,
        blockingOperation: { kind: 'PUBLICATION', state: 'CANDIDATE_OBSERVED', failureCode: null, updatedAt: '2026-08-25T12:00:00.000Z' },
      });
      await renderPage();

      const disclosure = screen.getByText('Publishing in progress', { selector: 'h2' }).closest('section');
      expect(disclosure).toBeTruthy();
      const technical = within(disclosure as HTMLElement);
      expect(technical.getByText('Technical details')).toBeTruthy();
      expect(technical.getByText(/candidate observed/i)).toBeTruthy();
    });
  });

  describe('activity information priority', () => {
    it('does not repeat the baseline concept in the project column', async () => {
      const baselineItem = {
        ...BASE_VIEW.versions[0],
        versionNumber: 1,
        operation: 'baseline' as const,
        publicationMode: null,
        affectedPublicId: null,
        affectedTitle: null,
        previousVersionNumber: null,
        recordCount: 0,
        current: true,
      };
      mockPage({ ...BASE_VIEW, currentVersionNumber: 1, versions: [baselineItem] });
      await renderPage();

      const cells = getActivityTable().getAllByRole('cell');
      expect(cells[0].textContent).toBe('Initial setup');
      expect(cells[1].textContent).toBe('—');
      expect(getActivityTable().queryAllByText('Initial setup')).toHaveLength(1);
    });

    it('labels the record-count column as the resulting published total, not the action volume', async () => {
      const removalItem = {
        ...BASE_VIEW.versions[0],
        operation: 'removal' as const,
        publicationMode: null,
        recordCount: 4,
      };
      mockPage({ ...BASE_VIEW, versions: [removalItem] });
      await renderPage();

      const table = getActivityTable();
      expect(table.getByRole('columnheader', { name: 'Published after activity' })).toBeTruthy();
      expect(table.queryByRole('columnheader', { name: 'Projects published' })).toBeNull();
      expect(table.getByText('Removed')).toBeTruthy();
    });

    it('exposes the timezone on every publishing timestamp', async () => {
      mockPage(BASE_VIEW);
      await renderPage();

      const cells = getActivityTable().getAllByRole('cell');
      expect(cells[2].textContent).toContain('UTC');
      expect(cells[2].querySelector('time')?.getAttribute('dateTime')).toBe('2026-08-25T10:00:00.000Z');
    });

    it('keeps version selection working while de-emphasizing version mechanics', async () => {
      mockPage(BASE_VIEW);
      await renderPage();

      const versionLink = getActivityTable().getByRole('link', { name: 'v10' });
      expect(versionLink.getAttribute('href')).toBe('/admin/public-feed?page=1&version=10');
    });
  });

  describe('selected activity details', () => {
    const historicalDetail: publicFeedRepo.PublicFeedHistoryDetail = {
      ...BASE_VIEW.versions[0],
      versionNumber: 7,
      current: false,
      recordCount: 2,
      members: [
        { ordinal: 1, publicId: 'proj-1', title: 'Project One', lifecycleStatus: 'published', currentlyDeployed: true },
        { ordinal: 2, publicId: 'proj-9', title: 'Project Nine', lifecycleStatus: 'archived', currentlyDeployed: false },
      ],
    };

    it('describes member badges as current publication state, not historical membership', async () => {
      mockPage({ ...BASE_VIEW, detail: historicalDetail });
      await renderPage({ version: '7' });

      expect(screen.getByText('Currently published')).toBeTruthy();
      expect(screen.getByText('Not currently published')).toBeTruthy();
      const memberList = screen.getByRole('list');
      expect(within(memberList).queryByText('Published')).toBeNull();
      expect(within(memberList).queryByText('Not published')).toBeNull();
    });

    it('uses a plain heading and keeps the version number under technical details', async () => {
      mockPage({ ...BASE_VIEW, detail: historicalDetail });
      await renderPage({ version: '7' });

      expect(screen.getByText('Activity details')).toBeTruthy();
      expect(screen.queryByText('Activity details (Version 7)')).toBeNull();
      const technical = screen.getByText('Version', { selector: 'dt' }).closest('div');
      expect(within(technical as HTMLElement).getByText('v7')).toBeTruthy();
    });

    it('states the resulting published total rather than implying the change published them', async () => {
      mockPage({ ...BASE_VIEW, detail: { ...historicalDetail, operation: 'removal', publicationMode: null } });
      await renderPage({ version: '7' });

      expect(screen.getByText(/2 projects were published after this change/i)).toBeTruthy();
    });

    it('collapses the audit evidence until a version is deliberately selected', async () => {
      mockPage({ ...BASE_VIEW, detail: historicalDetail });
      await renderPage();
      expect(screen.getByText('Activity details').closest('details')?.hasAttribute('open')).toBe(false);

      cleanup();
      mockPage({ ...BASE_VIEW, detail: historicalDetail });
      await renderPage({ version: '7' });
      expect(screen.getByText('Activity details').closest('details')?.hasAttribute('open')).toBe(true);
    });

    it('retains full technical evidence behind progressive disclosure', async () => {
      mockPage({ ...BASE_VIEW, detail: historicalDetail });
      await renderPage({ version: '7' });

      expect(screen.getByText('SHA-256 integrity hash')).toBeTruthy();
      expect(screen.getByText('a'.repeat(64))).toBeTruthy();
      expect(screen.getByText('Exact byte count')).toBeTruthy();
      expect(screen.getByText('Advanced publishing details')).toBeTruthy();
      expect(screen.getByText('Head generation')).toBeTruthy();
    });
  });

  describe('project publishing status table', () => {
    it('uses Project ID and human workflow-status labels', async () => {
      mockPage({
        ...BASE_VIEW,
        deploymentStatuses: [
          { publicId: 'proj-3', title: 'Project Three', lifecycleStatus: 'changes_requested', deployed: false },
        ],
      });
      await renderPage();

      const table = within(screen.getByRole('region', { name: 'Project publishing status' }));
      expect(table.getByRole('columnheader', { name: 'Project ID' })).toBeTruthy();
      expect(table.getByText('Changes requested')).toBeTruthy();
      expect(table.queryByText('changes requested')).toBeNull();
    });
  });
});
