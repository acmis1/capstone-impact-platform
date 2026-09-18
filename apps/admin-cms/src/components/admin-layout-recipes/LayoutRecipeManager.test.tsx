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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, recipeVersionId: active.id }),
    }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Move Solution & impact up' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Reset layout choices' }));
    expect(screen.queryByLabelText('Hide Team and context')).toBeNull();
    expect(screen.queryByLabelText('Hide Accessibility text')).toBeNull();
    expect(screen.queryByLabelText('Hide Snapshots')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save new recipe' }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(body).toMatchObject({ action: 'create', name: 'Media narrative', config: { templateId: 'media_rich' } });
  });

  it('offers bounded duplicate and retire commands for an active version', async () => {
    const duplicate = { ...active, id: '55555555-5555-4555-8555-555555555555', recipeId: '66666666-6666-4666-8666-666666666666', version: 1, name: 'Team first alternate' };
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ success: true, recipeVersionId: duplicate.id }) } as Response);
    const { rerender } = render(<LayoutRecipeManager initialRecipes={[active]} />);
    fireEvent.change(screen.getByLabelText('Edit active recipe'), { target: { value: active.id } });
    fireEvent.change(screen.getByLabelText('Duplicate saved recipe name'), { target: { value: 'Team first alternate' } });
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate saved version' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual({
      action: 'duplicate', name: 'Team first alternate', sourceVersionId: active.id,
    });

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    rerender(<LayoutRecipeManager initialRecipes={[active, duplicate]} />);
    await waitFor(() => expect((screen.getByLabelText('Edit active recipe') as HTMLSelectElement).value).toBe(duplicate.id));
    fireEvent.click(screen.getByRole('button', { name: 'Retire recipe version' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retire recipe version' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body))).toEqual({
      action: 'retire', sourceVersionId: duplicate.id, expectedVersion: 1,
    });
  });

  it('guards dirty reset, preserves focus on cancellation, and clears unload protection after discard', async () => {
    const nativeConfirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<LayoutRecipeManager initialRecipes={[]} />);
    const nameInput = screen.getByLabelText('Recipe name');
    fireEvent.change(nameInput, { target: { value: 'Draft recipe' } });

    const beforeUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(beforeUnload);
    expect(beforeUnload.defaultPrevented).toBe(true);

    const startNew = screen.getByRole('button', { name: 'Start new' });
    startNew.focus();
    fireEvent.click(startNew);
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(document.activeElement).toBe(startNew));
    expect((screen.getByLabelText('Recipe name') as HTMLInputElement).value).toBe('Draft recipe');

    fireEvent.click(startNew);
    fireEvent.click(screen.getByRole('button', { name: 'Start new recipe' }));
    await waitFor(() => expect((screen.getByLabelText('Recipe name') as HTMLInputElement).value).toBe(''));
    const cleanBeforeUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(cleanBeforeUnload);
    expect(cleanBeforeUnload.defaultPrevented).toBe(false);
    expect(nativeConfirm).not.toHaveBeenCalled();
  });

  it('keeps order and hidden choices when featured media changes, while previewing the effective feature', () => {
    render(<LayoutRecipeManager initialRecipes={[active]} />);
    fireEvent.change(screen.getByLabelText('Edit active recipe'), { target: { value: active.id } });
    const orderBefore = screen.getByText('1. Team & group');
    expect(orderBefore).toBeTruthy();
    expect((screen.getByLabelText('Hide Project video') as HTMLInputElement).checked).toBe(true);

    fireEvent.change(screen.getByLabelText('Featured media'), { target: { value: 'snapshots' } });
    expect(screen.getByText('1. Team & group')).toBeTruthy();
    expect((screen.getByLabelText('Hide Project video') as HTMLInputElement).checked).toBe(true);
    expect(document.querySelector('[data-layout-region="featured"][data-featured-media="snapshots"]')).toBeTruthy();
  });

  it('selects the returned immutable version after the refreshed library arrives', async () => {
    const nextVersion: LayoutRecipeVersion = {
      ...active,
      id: '44444444-4444-4444-8444-444444444444',
      version: 3,
      sourceVersionId: active.id,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, recipeVersionId: nextVersion.id }),
    }));
    const { rerender } = render(<LayoutRecipeManager initialRecipes={[active]} />);
    fireEvent.change(screen.getByLabelText('Edit active recipe'), { target: { value: active.id } });
    fireEvent.click(screen.getByRole('button', { name: 'Save as new version' }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());

    rerender(<LayoutRecipeManager initialRecipes={[active, nextVersion]} />);
    await waitFor(() => expect((screen.getByLabelText('Edit active recipe') as HTMLSelectElement).value).toBe(nextVersion.id));
    expect(screen.getByRole('button', { name: 'Save as new version' })).toBeTruthy();
  });

  it('shows the exact saved recipe version in the retire confirmation', () => {
    render(<LayoutRecipeManager initialRecipes={[active]} />);
    fireEvent.change(screen.getByLabelText('Edit active recipe'), { target: { value: active.id } });
    fireEvent.click(screen.getByRole('button', { name: 'Retire recipe version' }));
    expect(screen.getByText('Retire “Team first” v2?')).toBeTruthy();
    expect(screen.getByText(/version history is retained/i)).toBeTruthy();
  });

  it('stops after an unknown write outcome until the library is reloaded', async () => {
    const refresh = mocks.refresh;
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    render(<LayoutRecipeManager initialRecipes={[]} />);
    fireEvent.change(screen.getByLabelText('Recipe name'), { target: { value: 'Uncertain recipe' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save new recipe' }));
    await waitFor(() => expect(screen.getAllByText(/write outcome is unknown/i).length).toBeGreaterThan(0));
    expect(refresh).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Save new recipe' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('recipe composer correction regressions', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  it('keeps the original recipe lineage when changing its base preset', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true, recipeVersionId: active.id }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<LayoutRecipeManager initialRecipes={[active]} />);
    fireEvent.change(screen.getByLabelText('Edit active recipe'), { target: { value: active.id } });
    fireEvent.change(screen.getByLabelText('Maintained base preset'), { target: { value: 'technical_detail' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset layout choices' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save as new version' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ action: 'version', sourceVersionId: active.id, config: { templateId: 'technical_detail' } });
  });
  it.each([null, {}, { success: false }, { success: true }])('freezes further writes after a malformed successful response (%j)', async payload => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => payload });
    vi.stubGlobal('fetch', fetchMock);
    render(<LayoutRecipeManager initialRecipes={[]} />);
    fireEvent.change(screen.getByLabelText('Recipe name'), { target: { value: 'Synthetic uncertain write' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save new recipe' }));
    await waitFor(() => expect(screen.getAllByText(/write outcome is unknown/i).length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: 'Save new recipe' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
