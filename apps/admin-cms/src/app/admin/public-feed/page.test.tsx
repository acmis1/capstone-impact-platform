/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';

afterEach(cleanup);
import PublicFeedHistoryPage from './page';
import * as publicFeedRepo from '../../../projects/publicFeedHistoryRepository';
import * as requireAdminModule from '../../../auth/requireAdmin';
import * as envModule from '../../../lib/env';

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

function getPublishingHeader() {
  const header = screen.getByRole('heading', { name: 'Showcase publishing history' }).closest('header');
  if (!header) throw new Error('Publishing page header was not rendered.');
  return within(header);
}

describe('PublicFeedHistoryPage', () => {
  it('renders top summary cards truthfully and does not leak raw publication modes', async () => {
    vi.mocked(requireAdminModule.requireAdmin).mockResolvedValue(MOCK_ADMIN);
    vi.mocked(envModule.getServerEnv).mockReturnValue(MOCK_ENV);
    vi.mocked(publicFeedRepo.readPublicFeedHistory).mockResolvedValue(BASE_VIEW);

    const jsx = await PublicFeedHistoryPage({ searchParams: Promise.resolve({}) });
    render(jsx);

    expect(screen.getByText('Showcase publishing history')).toBeTruthy();
    expect(screen.getByText('Ready')).toBeTruthy();
    expect(screen.getAllByText('Projects published').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('1')).toBeTruthy(); // 1 project in the published deployment state
    expect(screen.getByText('All projects in sync')).toBeTruthy();
    expect(screen.getAllByText('Published').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('Showcase connected')).toBeNull();
    expect(screen.queryByText('Connected')).toBeNull();
    expect(screen.queryByText(/Published · normal/i)).toBeNull();
    expect(getPublishingHeader().getByText('Publishing ready')).toBeTruthy();
  });

  it('shows setup required in the header when publishing is inactive and no operation is blocking', async () => {
    vi.mocked(requireAdminModule.requireAdmin).mockResolvedValue(MOCK_ADMIN);
    vi.mocked(envModule.getServerEnv).mockReturnValue(MOCK_ENV);
    vi.mocked(publicFeedRepo.readPublicFeedHistory).mockResolvedValue({ ...BASE_VIEW, active: false });

    const jsx = await PublicFeedHistoryPage({ searchParams: Promise.resolve({}) });
    render(jsx);

    const header = getPublishingHeader();
    expect(header.getByText('Setup required')).toBeTruthy();
    expect(header.queryByText('Publishing ready')).toBeNull();
  });

  it('renders truthful status metrics when on page 2+ without mislabeling page-relative timestamps', async () => {
    const page2View: publicFeedRepo.PublicFeedHistoryView = {
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
    };

    vi.mocked(requireAdminModule.requireAdmin).mockResolvedValue(MOCK_ADMIN);
    vi.mocked(envModule.getServerEnv).mockReturnValue(MOCK_ENV);
    vi.mocked(publicFeedRepo.readPublicFeedHistory).mockResolvedValue(page2View);

    const jsx = await PublicFeedHistoryPage({ searchParams: Promise.resolve({ page: '2' }) });
    render(jsx);

    // Verifies status alignment metric is global and truthful
    expect(screen.getByText('All projects in sync')).toBeTruthy();
    // Verifies operation translation for deployment_reconciliation
    expect(screen.getByText('Showcase status repaired')).toBeTruthy();
    expect(screen.queryByText(/deployment reconciliation/i)).toBeNull();
  });

  it('alerts when published projects diverge from showcase deployment status', async () => {
    const divergedView: publicFeedRepo.PublicFeedHistoryView = {
      ...BASE_VIEW,
      deploymentStatuses: [
        { publicId: 'proj-1', title: 'Project One', lifecycleStatus: 'published', deployed: true },
        { publicId: 'proj-2', title: 'Project Two', lifecycleStatus: 'published', deployed: false },
      ],
    };

    vi.mocked(requireAdminModule.requireAdmin).mockResolvedValue(MOCK_ADMIN);
    vi.mocked(envModule.getServerEnv).mockReturnValue(MOCK_ENV);
    vi.mocked(publicFeedRepo.readPublicFeedHistory).mockResolvedValue(divergedView);

    const jsx = await PublicFeedHistoryPage({ searchParams: Promise.resolve({}) });
    render(jsx);

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
    vi.mocked(requireAdminModule.requireAdmin).mockResolvedValue(MOCK_ADMIN);
    vi.mocked(envModule.getServerEnv).mockReturnValue(MOCK_ENV);
    vi.mocked(publicFeedRepo.readPublicFeedHistory).mockResolvedValue({
      ...BASE_VIEW,
      versions: [reconciliationItem],
      detail: reconciliationItem,
    });

    const jsx = await PublicFeedHistoryPage({ searchParams: Promise.resolve({ version: '10' }) });
    render(jsx);

    expect(screen.getByText('Showcase status repaired')).toBeTruthy();
    expect(screen.getByText('Repaired showcase status for Project Two')).toBeTruthy();
    expect(screen.queryByText('Published project Project Two')).toBeNull();
  });

  it('alerts when a blocking recovery operation is active', async () => {
    const recoveryView: publicFeedRepo.PublicFeedHistoryView = {
      ...BASE_VIEW,
      blockingOperation: {
        kind: 'PUBLICATION',
        state: 'RECOVERY_REQUIRED',
        failureCode: 'STORAGE_TIMEOUT',
        updatedAt: '2026-08-25T12:00:00.000Z',
      },
    };

    vi.mocked(requireAdminModule.requireAdmin).mockResolvedValue(MOCK_ADMIN);
    vi.mocked(envModule.getServerEnv).mockReturnValue(MOCK_ENV);
    vi.mocked(publicFeedRepo.readPublicFeedHistory).mockResolvedValue(recoveryView);

    const jsx = await PublicFeedHistoryPage({ searchParams: Promise.resolve({}) });
    render(jsx);

    const header = getPublishingHeader();
    expect(header.getByText('Needs attention')).toBeTruthy();
    expect(header.queryByText('Publishing ready')).toBeNull();
    expect(screen.getAllByText('Needs attention')).toHaveLength(2);
    expect(screen.getByText('Recovery required')).toBeTruthy();
    expect(screen.getByText('Publishing needs attention')).toBeTruthy();
  });
});
