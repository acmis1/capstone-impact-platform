import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImportBatchRow } from '../../../../repositories/ImportBatchRepositoryCore';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  hasPermission: vi.fn(),
  constructed: vi.fn(),
  getImportBatchById: vi.fn(),
  getImportBatchReviewData: vi.fn(),
  events: [] as string[],
}));

vi.mock('server-only', () => ({}));
vi.mock('../../../../auth/requireAdmin', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('../../../../auth/permissions', () => ({ hasPermission: mocks.hasPermission }));
vi.mock('../../../../repositories/ImportBatchRepository', () => ({
  ImportBatchRepository: class {
    constructor() {
      mocks.events.push('construct');
      mocks.constructed();
    }
    getImportBatchById = (...args: unknown[]) => {
      mocks.events.push('getImportBatchById');
      return mocks.getImportBatchById(...args);
    };
    getImportBatchReviewData = (...args: unknown[]) => {
      mocks.events.push('getImportBatchReviewData');
      return mocks.getImportBatchReviewData(...args);
    };
  },
}));
vi.mock('../../../../components/admin/ImportBatchStatusBadge', () => ({
  default: () => <span>Batch status</span>,
}));
vi.mock('../../../../components/admin/ImportBatchReviewPanel', () => ({
  ImportBatchReviewPanel: () => <div>Review panel</div>,
}));

import ImportBatchDetailPage from './page';

const BATCH = {
  id: 'batch-1', batch_name: 'Completed batch', source_folder: 'completed', mode: 'create', status: 'completed',
  total_projects: 0, warning_count: 0, error_count: 0, created_at: '2026-08-01T10:00:00.000Z',
} as ImportBatchRow;

function renderPage(batchId = 'batch-1') {
  return ImportBatchDetailPage({ params: Promise.resolve({ batchId }) });
}

describe('Import batch detail authorization boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.events.length = 0;
    mocks.requireAdmin.mockResolvedValue({ permissions: ['projects.read', 'projects.edit'] });
    mocks.hasPermission.mockReturnValue(true);
    mocks.getImportBatchById.mockResolvedValue(BATCH);
    mocks.getImportBatchReviewData.mockResolvedValue([]);
  });

  it('authenticates before constructing or reading the repository', async () => {
    mocks.requireAdmin.mockRejectedValueOnce(new Error('session revoked'));

    const markup = renderToStaticMarkup(await renderPage());

    expect(mocks.constructed).not.toHaveBeenCalled();
    expect(mocks.getImportBatchById).not.toHaveBeenCalled();
    expect(mocks.getImportBatchReviewData).not.toHaveBeenCalled();
    expect(markup).toContain('Import details unavailable');
  });

  it('preserves the authorized batch and review-data happy path after auth', async () => {
    await renderPage();

    expect(mocks.events).toEqual(['construct', 'getImportBatchById', 'getImportBatchReviewData']);
    expect(mocks.getImportBatchById).toHaveBeenCalledWith('batch-1');
    expect(mocks.getImportBatchReviewData).toHaveBeenCalledWith('batch-1');
  });

  it('preserves the safe missing-batch state without a review-data read', async () => {
    mocks.getImportBatchById.mockResolvedValueOnce(null);

    const markup = renderToStaticMarkup(await renderPage());

    expect(markup).toContain('Import not found');
    expect(mocks.getImportBatchReviewData).not.toHaveBeenCalled();
  });
});
