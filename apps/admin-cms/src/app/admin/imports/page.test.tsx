// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImportBatchRow } from '../../../repositories/ImportBatchRepositoryCore';
import ImportBatchesPage from './page';

const repository = vi.hoisted(() => ({ listRecentImportBatches: vi.fn() }));
const permissions = vi.hoisted(() => ({ hasPermission: vi.fn() }));
const table = vi.hoisted(() => ({ render: vi.fn() }));

vi.mock('../../../repositories/ImportBatchRepository', () => ({
  ImportBatchRepository: class {
    listRecentImportBatches = repository.listRecentImportBatches;
  },
}));

vi.mock('../../../auth/requireAdmin', () => ({
  requireAdmin: vi.fn(async () => ({ permissions: ['projects.edit'] })),
}));

vi.mock('../../../auth/permissions', () => ({
  hasPermission: permissions.hasPermission,
}));

vi.mock('../../../components/admin/ImportBatchTable', () => ({
  default: ({ batches }: { batches: ImportBatchRow[] }) => {
    table.render(batches);
    return null;
  },
}));

const BATCHES: ImportBatchRow[] = [
  {
    id: 'batch-1', batch_name: 'Completed batch', source_folder: 'completed', mode: 'create', status: 'completed',
    total_projects: 2, warning_count: 2, error_count: 0, created_at: '2026-08-01T10:00:00.000Z',
  },
  {
    id: 'batch-2', batch_name: 'Failed batch', source_folder: 'failed', mode: 'create', status: 'failed',
    total_projects: 1, warning_count: 0, error_count: 3, created_at: '2026-08-02T10:00:00.000Z',
  },
  {
    id: 'batch-3', batch_name: 'Running batch', source_folder: 'running', mode: 'create', status: 'running',
    total_projects: 4, warning_count: 1, error_count: 0, created_at: '2026-08-03T10:00:00.000Z',
  },
];

function valueFor(label: string): HTMLElement {
  const summary = screen.getByRole('region', { name: 'Import batch summary' });
  const term = within(summary).getByText(label);
  const value = term.parentElement?.querySelector('dd');
  if (!value) throw new Error(`Missing value for ${label}`);
  return value as HTMLElement;
}

describe('Imports index summary', () => {
  beforeEach(() => {
    cleanup();
    repository.listRecentImportBatches.mockReset();
    permissions.hasPermission.mockReset();
    permissions.hasPermission.mockReturnValue(true);
    table.render.mockReset();
  });

  afterEach(cleanup);

  it('preserves the five exact batch metrics in one semantic operational surface', async () => {
    repository.listRecentImportBatches.mockResolvedValue(BATCHES);

    render(await ImportBatchesPage());

    const summary = screen.getByRole('region', { name: 'Import batch summary' });
    expect(summary.className).toContain('rounded-xl border border-border/80 bg-card shadow-xs');
    expect(summary.querySelectorAll('dl')).toHaveLength(1);
    expect(summary.querySelectorAll('dt')).toHaveLength(5);
    expect(valueFor('Recent imports').textContent).toBe('3');
    expect(valueFor('Completed').textContent).toBe('1');
    expect(valueFor('Failed').textContent).toBe('1');
    expect(valueFor('Total warnings').textContent).toBe('3');
    expect(valueFor('Total errors').textContent).toBe('3');
    expect(valueFor('Completed').className).toContain('text-success');
    expect(valueFor('Failed').className).toContain('text-destructive');
    expect(valueFor('Total warnings').className).toContain('text-warning-strong');
    expect(valueFor('Total errors').className).toContain('text-destructive');
    expect(summary.querySelector('dl')?.className).toContain('grid-cols-2');
    expect(summary.querySelector('dl')?.className).toContain('sm:grid-cols-3');
    expect(summary.querySelector('dl')?.className).toContain('lg:grid-cols-5');
    expect(table.render).toHaveBeenCalledWith(BATCHES);
    expect(screen.getAllByRole('link', { name: 'Import projects' }).length).toBeGreaterThan(0);
  });

  it('uses neutral value presentation for healthy zero failed, warning, and error counts', async () => {
    repository.listRecentImportBatches.mockResolvedValue([
      { ...BATCHES[0], warning_count: 0, error_count: 0 },
    ]);
    permissions.hasPermission.mockReturnValue(false);

    render(await ImportBatchesPage());

    for (const label of ['Failed', 'Total warnings', 'Total errors']) {
      expect(valueFor(label).textContent).toBe('0');
      expect(valueFor(label).className).toContain('text-foreground');
      expect(valueFor(label).className).not.toMatch(/text-(destructive|warning-strong)/);
    }
    expect(screen.queryByRole('link', { name: 'Import projects' })).toBeNull();
  });

  it('keeps the empty and bounded load-error states outside the summary/table path', async () => {
    repository.listRecentImportBatches.mockResolvedValueOnce([]);
    render(await ImportBatchesPage());
    expect(screen.getByText('No imports found')).toBeTruthy();
    expect(table.render).not.toHaveBeenCalled();

    cleanup();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    repository.listRecentImportBatches.mockRejectedValueOnce(new Error('repository unavailable'));
    render(await ImportBatchesPage());
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('Import records could not be loaded')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Import batch summary' })).toBeNull();
    expect(table.render).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
