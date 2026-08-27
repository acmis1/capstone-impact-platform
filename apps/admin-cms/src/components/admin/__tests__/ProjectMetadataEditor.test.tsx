/** @vitest-environment jsdom */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ProjectMetadataEditor } from '../ProjectMetadataEditor';
import {
  ProjectMetadataNavigationProvider,
  useProjectMetadataNavigation,
} from '../ProjectMetadataNavigation';
import type { ProjectMetadataView } from '../../../projects/projectMetadata';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
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
  languageOriginal = 'short',
}: {
  canEdit?: boolean;
  projectStatus?: string;
  suggestedTitle?: string;
  languageOriginal?: string;
}) {
  const {
    applyTitleSuggestion, canApplyTitleSuggestion,
    applyLanguageSuggestion, canApplyLanguageSuggestion, dirty,
  } = useProjectMetadataNavigation();
  return (
    <div>
      <div data-testid="dirty-indicator">{dirty ? 'DIRTY' : 'CLEAN'}</div>
      <div data-testid="can-apply">{canApplyTitleSuggestion ? 'CAN_APPLY' : 'CANNOT_APPLY'}</div>
      <div data-testid="can-apply-language">{canApplyLanguageSuggestion ? 'CAN_APPLY' : 'CANNOT_APPLY'}</div>
      <button
        type="button"
        data-testid="trigger-suggestion-btn"
        onClick={() => applyTitleSuggestion(suggestedTitle)}
      >
        Apply Suggestion
      </button>
      <button
        type="button"
        data-testid="trigger-language-suggestion-btn"
        onClick={() => applyLanguageSuggestion({
          field: 'summary', startOffset: 2, endOffset: 7,
          offsetUnit: 'UNICODE_CODE_POINTS', originalSourceSpan: languageOriginal,
          replacement: 'concise',
        })}
      >
        Apply language suggestion
      </button>

      <ProjectMetadataEditor
        initialMetadata={initialMetadata}
        programs={[{ id: 'prog-1', name: 'Bachelor of Software Engineering' }]}
        disciplines={[{ id: 'disc-1', name: 'Software Engineering' }]}
        industryCategories={[{ id: 'cat-1', name: 'Information Technology' }]}
        canEdit={canEdit}
        projectStatus={projectStatus}
        saveAction={vi.fn()}
      />
    </div>
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  window.confirm = vi.fn().mockReturnValue(true);
});

afterEach(cleanup);

describe('ProjectMetadataEditor Title Suggestion Integration', () => {
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
        screen.getByText(/Suggestion applied to the draft. Review it and select Save metadata/i),
      ).toBeTruthy();
    });
  });

  /**
   * Edit mode renders a failure notice as the form's error description, with an assertive alert and
   * destructive styling. Applying a suggestion is a confirmation, so it must not borrow that
   * channel: doing so tells a staff member their successful action failed, and mislabels the whole
   * form as invalid to assistive technology.
   */
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

  it('prompts with window.confirm if the title draft was already modified with unsaved changes', async () => {
    render(
      <ProjectMetadataNavigationProvider>
        <TestContainer canEdit={true} projectStatus="draft" suggestedTitle="Suggested Title 2" />
      </ProjectMetadataNavigationProvider>,
    );

    // Enter edit mode manually and change title
    const editBtn = screen.getByRole('button', { name: /Edit metadata/i });
    fireEvent.click(editBtn);

    const titleInput = screen.getByLabelText(/Project title/i) as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: 'User Typed Title' } });

    // Now trigger suggestion
    const triggerBtn = screen.getByTestId('trigger-suggestion-btn');
    fireEvent.click(triggerBtn);

    expect(window.confirm).toHaveBeenCalledWith(
      'You have unsaved changes in Project title. Replace it with the suggestion?',
    );
  });

  it('applies one code-point span to the browser draft, focuses the field, and does not auto-save', async () => {
    render(
      <ProjectMetadataNavigationProvider>
        <TestContainer />
      </ProjectMetadataNavigationProvider>,
    );
    expect(screen.getByTestId('can-apply-language').textContent).toBe('CAN_APPLY');
    fireEvent.click(screen.getByTestId('trigger-language-suggestion-btn'));
    const summary = await screen.findByLabelText(/Short summary/i) as HTMLTextAreaElement;
    expect(summary.value).toBe('A concise summary of the project.');
    expect(document.activeElement).toBe(summary);
    expect(screen.getByTestId('dirty-indicator').textContent).toBe('DIRTY');
    expect(screen.getByText(/Language suggestion applied to the draft/i).getAttribute('role')).toBe('status');
    expect(screen.getByRole('button', { name: 'Save metadata' })).toBeTruthy();
  });

  it('refuses a language suggestion when the current draft span no longer matches', async () => {
    render(
      <ProjectMetadataNavigationProvider>
        <TestContainer languageOriginal="wrong" />
      </ProjectMetadataNavigationProvider>,
    );
    fireEvent.click(screen.getByTestId('trigger-language-suggestion-btn'));
    expect(screen.getByText('Project information')).toBeTruthy();
    expect(screen.getByTestId('dirty-indicator').textContent).toBe('CLEAN');
    expect(screen.queryByLabelText(/Short summary/i)).toBeNull();
  });

  it('refuses a language suggestion when the inspected field has any unsaved edit', () => {
    render(
      <ProjectMetadataNavigationProvider>
        <TestContainer />
      </ProjectMetadataNavigationProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Edit metadata/i }));
    const summary = screen.getByLabelText(/Short summary/i) as HTMLTextAreaElement;
    const edited = `${summary.value} Staff note outside the inspected span.`;
    fireEvent.change(summary, { target: { value: edited } });

    fireEvent.click(screen.getByTestId('trigger-language-suggestion-btn'));

    expect(summary.value).toBe(edited);
    expect(screen.getByTestId('dirty-indicator').textContent).toBe('DIRTY');
    expect(screen.queryByText(/Language suggestion applied to the draft/i)).toBeNull();
  });
});
