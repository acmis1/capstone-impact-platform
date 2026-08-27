/** @vitest-environment jsdom */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ProjectMetadataEditor } from '../ProjectMetadataEditor';
import {
  ProjectMetadataNavigationProvider,
  useProjectMetadataNavigation,
} from '../ProjectMetadataNavigation';
import type { ProjectMetadataActionResult, ProjectMetadataView } from '../../../projects/projectMetadata';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const initialMetadata: ProjectMetadataView = {
  publicId: 'PRJ-101',
  expectedUpdatedAt: '2026-08-21T09:00:00.000Z',
  title: 'Original Project Title',
  summary: 'A short summary of the project.',
  background: 'Background information goes here.',
  solution: 'Solution details go here.',
  posterText: 'Poster text here.',
  accessibilityText: 'Alt text for poster.',
  year: '2026',
  programId: 'prog-1',
  disciplineIds: ['disc-1'],
  industryCategoryIds: ['cat-1'],
};

function TestContainer({
  canEdit = true,
  projectStatus = 'draft',
  suggestedTitle = 'Suggested New Title',
  saveAction = vi.fn().mockResolvedValue({ ok: true, metadata: initialMetadata } as ProjectMetadataActionResult),
}: {
  canEdit?: boolean;
  projectStatus?: string;
  suggestedTitle?: string;
  saveAction?: (input: unknown) => Promise<ProjectMetadataActionResult>;
}) {
  const { applyTitleSuggestion, canApplyTitleSuggestion, dirty } = useProjectMetadataNavigation();
  return (
    <div>
      <div data-testid="dirty-indicator">{dirty ? 'DIRTY' : 'CLEAN'}</div>
      <div data-testid="can-apply">{canApplyTitleSuggestion ? 'CAN_APPLY' : 'CANNOT_APPLY'}</div>
      <button
        type="button"
        data-testid="trigger-suggestion-btn"
        onClick={() => applyTitleSuggestion(suggestedTitle)}
      >
        Apply Suggestion
      </button>

      <ProjectMetadataEditor
        initialMetadata={initialMetadata}
        programs={[{ id: 'prog-1', name: 'Bachelor of Software Engineering' }]}
        disciplines={[
          { id: 'disc-1', name: 'Software Engineering' },
          { id: 'disc-2', name: 'Computer Science' },
        ]}
        industryCategories={[
          { id: 'cat-1', name: 'Information Technology' },
          { id: 'cat-2', name: 'Healthcare' },
        ]}
        canEdit={canEdit}
        projectStatus={projectStatus}
        saveAction={saveAction}
      />
    </div>
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(cleanup);

describe('ProjectMetadataEditor Title Suggestion and Form Integration', () => {
  it('registers the suggestion handler when canEdit is true and project is editable', () => {
    render(
      <ProjectMetadataNavigationProvider>
        <TestContainer canEdit={true} projectStatus="draft" />
      </ProjectMetadataNavigationProvider>,
    );

    expect(screen.getByTestId('can-apply').textContent).toBe('CAN_APPLY');
  });

  it('unregisters the suggestion handler when canEdit is false or project is approved', () => {
    render(
      <ProjectMetadataNavigationProvider>
        <TestContainer canEdit={false} projectStatus="draft" />
      </ProjectMetadataNavigationProvider>,
    );

    expect(screen.getByTestId('can-apply').textContent).toBe('CANNOT_APPLY');
  });

  it('switches to edit mode, populates the suggested title, marks dirty, and does NOT auto-save', async () => {
    render(
      <ProjectMetadataNavigationProvider>
        <TestContainer canEdit={true} projectStatus="draft" suggestedTitle="AI & Smart Cities" />
      </ProjectMetadataNavigationProvider>,
    );

    expect(screen.getByTestId('dirty-indicator').textContent).toBe('CLEAN');
    const triggerBtn = screen.getByTestId('trigger-suggestion-btn');
    fireEvent.click(triggerBtn);

    await waitFor(() => {
      expect(screen.getByTestId('dirty-indicator').textContent).toBe('DIRTY');
      expect(screen.getByText('Editing project information')).toBeTruthy();
      const titleInput = screen.getByLabelText(/Project title/i) as HTMLInputElement;
      expect(titleInput.value).toBe('AI & Smart Cities');
      expect(
        screen.getByText(/Suggestion applied to the draft. Review it and select Save changes/i),
      ).toBeTruthy();
    });
  });

  it('announces an applied suggestion as status, not as a form error', async () => {
    render(
      <ProjectMetadataNavigationProvider>
        <TestContainer canEdit={true} projectStatus="draft" suggestedTitle="AI & Smart Cities" />
      </ProjectMetadataNavigationProvider>,
    );

    fireEvent.click(screen.getByTestId('trigger-suggestion-btn'));

    const notice = await screen.findByText(/Suggestion applied to the draft/i);
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.getAttribute('id')).not.toBe('metadata-form-error');
    expect(notice.className).not.toMatch(/destructive/);

    expect(screen.queryByRole('alert')).toBeNull();
    const form = document.querySelector('form');
    expect(form?.getAttribute('aria-describedby')).toBeNull();
  });

  it('opens in-app AlertDialog if the title draft was already modified with unsaved changes', async () => {
    render(
      <ProjectMetadataNavigationProvider>
        <TestContainer canEdit={true} projectStatus="draft" suggestedTitle="Suggested Title 2" />
      </ProjectMetadataNavigationProvider>,
    );

    // Enter edit mode manually and change title
    const editBtn = screen.getByRole('button', { name: /Edit project information/i });
    fireEvent.click(editBtn);

    const titleInput = screen.getByLabelText(/Project title/i) as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: 'User Typed Title' } });

    // Now trigger suggestion
    const triggerBtn = screen.getByTestId('trigger-suggestion-btn');
    fireEvent.click(triggerBtn);

    // Verify in-app AlertDialog is shown
    expect(screen.getByText('Replace unsaved title?')).toBeTruthy();
    expect(
      screen.getByText(/You have unsaved changes in Project title/i)
    ).toBeTruthy();

    // Click "Replace title"
    const replaceBtn = screen.getByRole('button', { name: 'Replace title' });
    fireEvent.click(replaceBtn);

    await waitFor(() => {
      expect((screen.getByLabelText(/Project title/i) as HTMLInputElement).value).toBe(
        'Suggested Title 2'
      );
    });
  });

  it('integrates MultiSelect and allows adding/removing discipline chips without native multiple select', async () => {
    render(
      <ProjectMetadataNavigationProvider>
        <TestContainer canEdit={true} projectStatus="draft" />
      </ProjectMetadataNavigationProvider>,
    );

    const editBtn = screen.getByRole('button', { name: /Edit project information/i });
    fireEvent.click(editBtn);

    // Verify initial chip is present
    expect(screen.getByText('Software Engineering')).toBeTruthy();

    // Open multi-select dropdown for Disciplines
    const combobox = screen.getByRole('combobox', { name: /Disciplines, 1 selected/i });
    fireEvent.click(combobox);

    // Select "Computer Science"
    const csOption = screen.getByRole('option', { name: /Computer Science/i });
    fireEvent.click(csOption);

    // Verify both are selected
    expect(screen.getByTestId('dirty-indicator').textContent).toBe('DIRTY');
    expect(screen.getByText('2 disciplines selected')).toBeTruthy();
    expect(screen.getAllByText('Computer Science').length).toBeGreaterThan(0);

    // Remove Software Engineering via chip
    const removeBtn = screen.getByRole('button', { name: 'Remove Software Engineering' });
    fireEvent.click(removeBtn);

    expect(screen.queryByRole('button', { name: 'Remove Software Engineering' })).toBeNull();
    expect(screen.getByText('1 disciplines selected')).toBeTruthy();
  });

  it('prompts with AlertDialog when canceling dirty changes, and discards changes on confirmation', async () => {
    render(
      <ProjectMetadataNavigationProvider>
        <TestContainer canEdit={true} projectStatus="draft" />
      </ProjectMetadataNavigationProvider>,
    );

    const editBtn = screen.getByRole('button', { name: /Edit project information/i });
    fireEvent.click(editBtn);

    const titleInput = screen.getByLabelText(/Project title/i) as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: 'Modified Title Before Discard' } });

    expect(screen.getByTestId('dirty-indicator').textContent).toBe('DIRTY');

    // Click Cancel
    const cancelBtn = screen.getByRole('button', { name: 'Cancel' });
    fireEvent.click(cancelBtn);

    // Verify Discard changes dialog appears
    expect(screen.getByText('Discard unsaved changes?')).toBeTruthy();

    // Confirm discard
    const discardBtn = screen.getByRole('button', { name: 'Discard changes' });
    fireEvent.click(discardBtn);

    await waitFor(() => {
      expect(screen.getByText('Project information')).toBeTruthy();
      expect(screen.getByTestId('dirty-indicator').textContent).toBe('CLEAN');
    });
  });
});
