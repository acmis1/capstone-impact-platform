// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LayoutRecipeVersion } from '../../layout-recipes/layoutRecipes';

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));

import { LayoutRecipeManager } from './LayoutRecipeManager';

const active: LayoutRecipeVersion = {
  id: '11111111-1111-4111-8111-111111111111',
  recipeId: '22222222-2222-4222-8222-222222222222',
  version: 2,
  name: 'Team first',
  status: 'active',
  sourceVersionId: null,
  createdAt: '2026-09-14T00:00:00.000Z',
  config: {
    templateId: 'poster_showcase', featuredMedia: 'snapshots',
    sectionOrder: ['team', 'solution', 'background', 'links', 'citations', 'accessibilityText', 'snapshots', 'video'],
    hiddenSections: ['video'],
  },
};

const retired: LayoutRecipeVersion = {
  ...active,
  id: '33333333-3333-4333-8333-333333333333',
  version: 1,
  name: 'Earlier layout',
  status: 'retired',
};

describe('LayoutRecipeManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('reloads an active recipe, reorders it with keyboard buttons, and saves a new immutable version', async () => {
    render(<LayoutRecipeManager initialRecipes={[active, retired]} />);
    expect(screen.getByText('Earlier layout · v1')).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Earlier layout/ })).toBeNull();

    fireEvent.change(screen.getByLabelText('Edit active recipe'), { target: { value: active.id } });
    fireEvent.click(screen.getByRole('button', { name: 'Move Solution up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save as new version' }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const [, options] = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(String(options?.body));
    expect(options?.method).toBe('PATCH');
    expect(body).toMatchObject({ action: 'version', sourceVersionId: active.id, expectedVersion: 2, name: 'Team first' });
    expect(body.config.sectionOrder.slice(0, 3)).toEqual(['solution', 'team', 'background']);
    expect(body).not.toHaveProperty('permissions');
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it('creates from a stock preset and keeps mandatory fields outside visibility controls', async () => {
    render(<LayoutRecipeManager initialRecipes={[]} />);
    fireEvent.change(screen.getByLabelText('Recipe name'), { target: { value: 'Media narrative' } });
    fireEvent.change(screen.getByLabelText('Maintained base preset'), { target: { value: 'media_rich' } });
    expect(screen.queryByLabelText('Hide Team and context')).toBeNull();
    expect(screen.queryByLabelText('Hide Accessibility text')).toBeNull();
    expect(screen.queryByLabelText('Hide Snapshots')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save new recipe' }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(body).toMatchObject({ action: 'create', name: 'Media narrative', config: { templateId: 'media_rich' } });
  });

  it('offers bounded duplicate and retire commands for an active version', async () => {
    render(<LayoutRecipeManager initialRecipes={[active]} />);
    fireEvent.change(screen.getByLabelText('Edit active recipe'), { target: { value: active.id } });
    fireEvent.change(screen.getByLabelText('Duplicate recipe name'), { target: { value: 'Team first alternate' } });
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual({
      action: 'duplicate', name: 'Team first alternate', sourceVersionId: active.id,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Retire' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body))).toEqual({
      action: 'retire', sourceVersionId: active.id, expectedVersion: 2,
    });
  });
});
