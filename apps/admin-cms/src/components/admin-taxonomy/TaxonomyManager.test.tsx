// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));

import { TaxonomyManager } from './TaxonomyManager';

const initialCatalogues = {
  program: [{ id: '11111111-1111-1111-8111-111111111111', name: 'IT', usageCount: 1 }],
  discipline: [{ id: '22222222-2222-2222-8222-222222222222', name: 'IT', usageCount: 0 }],
  industryCategory: [{ id: '33333333-3333-3333-8333-333333333333', name: 'Technology', usageCount: 0 }],
};

describe('TaxonomyManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      success: true,
      code: 'CREATED',
      entry: { id: '44444444-4444-4444-8444-444444444444', name: 'Aviation' },
    }), { status: 201, headers: { 'content-type': 'application/json' } })));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('adds a new program through the server route and announces the bounded result', async () => {
    render(<TaxonomyManager initialCatalogues={initialCatalogues} />);

    fireEvent.change(screen.getByLabelText('Add program'), { target: { value: 'Aviation' } });
    fireEvent.submit(screen.getByLabelText('Add program').closest('form')!);

    await waitFor(() => expect(screen.getByText('Aviation')).toBeDefined());
    expect(fetch).toHaveBeenCalledWith('/api/taxonomy/program', expect.objectContaining({ method: 'POST' }));
    expect(screen.getByText('Program added.')).toBeDefined();
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it('exposes usage counts without any removal action', () => {
    render(<TaxonomyManager initialCatalogues={initialCatalogues} />);

    expect(screen.getByText('Used by 1 project')).toBeDefined();
    expect(screen.getAllByText('Not currently used')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /remove/i })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
