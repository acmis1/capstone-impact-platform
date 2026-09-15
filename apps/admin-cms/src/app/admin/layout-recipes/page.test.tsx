// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  canManageTaxonomy: vi.fn(),
  createSupabaseAdminClient: vi.fn(() => ({ serviceRole: true })),
  list: vi.fn(),
}));

vi.mock('../../../auth/requireAdmin', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('../../../auth/permissions', () => ({ canManageTaxonomy: mocks.canManageTaxonomy }));
vi.mock('../../../lib/supabase/admin', () => ({ createSupabaseAdminClient: mocks.createSupabaseAdminClient }));
vi.mock('../../../layout-recipes/SupabaseLayoutRecipeGateway', () => ({
  SupabaseLayoutRecipeGateway: class { list = mocks.list; },
}));
vi.mock('../../../components/admin-layout-recipes/LayoutRecipeManager', () => ({
  LayoutRecipeManager: ({ initialRecipes }: { initialRecipes: unknown[] }) => <div>Recipe manager: {initialRecipes.length}</div>,
}));

import LayoutRecipesPage from './page';

describe('LayoutRecipesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ permissions: ['taxonomy.manage'] });
    mocks.canManageTaxonomy.mockReturnValue(true);
    mocks.list.mockResolvedValue([{ id: 'recipe' }]);
  });
  afterEach(cleanup);

  it('loads the shared library only after server-side administrative authorization', async () => {
    render(await LayoutRecipesPage());
    expect(screen.getByRole('heading', { name: 'Layout recipes' })).toBeTruthy();
    expect(screen.getByText('Recipe manager: 1')).toBeTruthy();
    expect(mocks.canManageTaxonomy).toHaveBeenCalledWith(['taxonomy.manage']);
  });

  it('denies direct navigation without opening the service-role client', async () => {
    mocks.canManageTaxonomy.mockReturnValue(false);
    render(await LayoutRecipesPage());
    expect(screen.getByRole('heading', { name: 'Access denied' })).toBeTruthy();
    expect(mocks.createSupabaseAdminClient).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('fails closed when the persistent library cannot be read', async () => {
    mocks.list.mockRejectedValue(new Error('unavailable'));
    render(await LayoutRecipesPage());
    expect(screen.getByRole('heading', { name: 'Layout recipes unavailable' })).toBeTruthy();
  });
});
