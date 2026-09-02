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

// Persistable ids for the one test that asserts the exact id arrays reaching the save action:
// the metadata input schema requires real UUIDs, so a save can only be exercised with them.
const persistableMetadata: ProjectMetadataView = {
  ...initialMetadata,
  programId: '10000000-0000-4000-8000-000000000001',
  disciplineIds: ['20000000-0000-4000-8000-000000000001'],
  industryCategoryIds: ['30000000-0000-4000-8000-000000000001'],
};

const persistableDisciplines = [
  { id: '20000000-0000-4000-8000-000000000001', name: 'Software Engineering' },
  { id: '20000000-0000-4000-8000-000000000002', name: 'Computer Science' },
];

const persistableIndustryCategories = [
  { id: '30000000-0000-4000-8000-000000000001', name: 'Information Technology' },
  { id: '30000000-0000-4000-8000-000000000002', name: 'Healthcare' },
];

function TestContainer({
  canEdit = true,
  projectStatus = 'draft',
  suggestedTitle = 'Suggested New Title',
  languageOriginal = 'short',
  metadata = initialMetadata,
  disciplines = [
    { id: 'disc-1', name: 'Software Engineering' },
    { id: 'disc-2', name: 'Computer Science' },
  ],
  industryCategories = [
    { id: 'cat-1', name: 'Information Technology' },
    { id: 'cat-2', name: 'Healthcare' },
  ],
  saveAction = vi.fn().mockResolvedValue({ ok: true, metadata: initialMetadata } as ProjectMetadataActionResult),
}: {
  canEdit?: boolean;
  projectStatus?: string;
  suggestedTitle?: string;
  languageOriginal?: string;
  metadata?: ProjectMetadataView;
  disciplines?: { id: string; name: string }[];
  industryCategories?: { id: string; name: string }[];
  saveAction?: (input: unknown) => Promise<ProjectMetadataActionResult>;
}) {
  const {
    applyTitleSuggestion, canApplyTitleSuggestion,
    applyLanguageSuggestion, canApplyLanguageSuggestion, dirty,
  } = useProjectMetadataNavigation();
  const [outcome, setOutcome] = React.useState('IDLE');
  return (
    <div>
      <div data-testid="dirty-indicator">{dirty ? 'DIRTY' : 'CLEAN'}</div>
      <div data-testid="can-apply">{canApplyTitleSuggestion ? 'CAN_APPLY' : 'CANNOT_APPLY'}</div>
      <div data-testid="can-apply-language">{canApplyLanguageSuggestion ? 'CAN_APPLY' : 'CANNOT_APPLY'}</div>
      <div data-testid="suggestion-outcome">{outcome}</div>
      <button
        type="button"
        data-testid="trigger-suggestion-btn"
        onClick={() => {
          setOutcome('PENDING');
          void applyTitleSuggestion(suggestedTitle).then((result) => setOutcome(result));
        }}
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
        initialMetadata={metadata}
        programs={[{ id: metadata.programId, name: 'Bachelor of Software Engineering' }]}
        disciplines={disciplines}
        industryCategories={industryCategories}
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

  it('A: resolves applied immediately when the title carries no unsaved conflict', async () => {
    render(
      <ProjectMetadataNavigationProvider>
        <TestContainer canEdit={true} projectStatus="draft" suggestedTitle="Clean Suggested Title" />
      </ProjectMetadataNavigationProvider>,
    );

    fireEvent.click(screen.getByTestId('trigger-suggestion-btn'));

    await waitFor(() => expect(screen.getByTestId('suggestion-outcome').textContent).toBe('applied'));
    expect(screen.queryByText('Replace unsaved title?')).toBeNull();
    expect((screen.getByLabelText(/Project title/i) as HTMLInputElement).value).toBe('Clean Suggested Title');
  });

  it('B: keeps the outcome pending while the replacement confirmation is still open', async () => {
    render(
      <ProjectMetadataNavigationProvider>
        <TestContainer canEdit={true} projectStatus="draft" suggestedTitle="Suggested Replacement" />
      </ProjectMetadataNavigationProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Edit project information/i }));
    fireEvent.change(screen.getByLabelText(/Project title/i), { target: { value: 'User Typed Title' } });
    fireEvent.click(screen.getByTestId('trigger-suggestion-btn'));

    expect(screen.getByText('Replace unsaved title?')).toBeTruthy();

    // Nothing has been decided yet, so the caller must not be told the suggestion was applied.
    await waitFor(() => expect(screen.getByTestId('suggestion-outcome').textContent).toBe('PENDING'));
    expect((screen.getByLabelText(/Project title/i) as HTMLInputElement).value).toBe('User Typed Title');
  });

  it('C: resolves cancelled and leaves the draft untouched when the current title is kept', async () => {
    render(
      <ProjectMetadataNavigationProvider>
        <TestContainer canEdit={true} projectStatus="draft" suggestedTitle="Suggested Replacement" />
      </ProjectMetadataNavigationProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Edit project information/i }));
    fireEvent.change(screen.getByLabelText(/Project title/i), { target: { value: 'User Typed Title' } });
    fireEvent.click(screen.getByTestId('trigger-suggestion-btn'));
    fireEvent.click(screen.getByRole('button', { name: 'Keep current title' }));

    await waitFor(() => expect(screen.getByTestId('suggestion-outcome').textContent).toBe('cancelled'));
    expect((screen.getByLabelText(/Project title/i) as HTMLInputElement).value).toBe('User Typed Title');
    expect(screen.queryByText(/Suggestion applied to the draft/i)).toBeNull();
  });

  it('C2: resolves cancelled when the replacement dialog is dismissed with Escape', async () => {
    render(
      <ProjectMetadataNavigationProvider>
        <TestContainer canEdit={true} projectStatus="draft" suggestedTitle="Suggested Replacement" />
      </ProjectMetadataNavigationProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Edit project information/i }));
    fireEvent.change(screen.getByLabelText(/Project title/i), { target: { value: 'User Typed Title' } });
    fireEvent.click(screen.getByTestId('trigger-suggestion-btn'));
    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(screen.getByTestId('suggestion-outcome').textContent).toBe('cancelled'));
    expect((screen.getByLabelText(/Project title/i) as HTMLInputElement).value).toBe('User Typed Title');
  });

  it('D: resolves applied only after the replacement actually changes the draft', async () => {
    render(
      <ProjectMetadataNavigationProvider>
        <TestContainer canEdit={true} projectStatus="draft" suggestedTitle="Suggested Replacement" />
      </ProjectMetadataNavigationProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Edit project information/i }));
    fireEvent.change(screen.getByLabelText(/Project title/i), { target: { value: 'User Typed Title' } });
    fireEvent.click(screen.getByTestId('trigger-suggestion-btn'));
    expect(screen.getByTestId('suggestion-outcome').textContent).toBe('PENDING');

    fireEvent.click(screen.getByRole('button', { name: 'Replace title' }));

    await waitFor(() => expect(screen.getByTestId('suggestion-outcome').textContent).toBe('applied'));
    expect((screen.getByLabelText(/Project title/i) as HTMLInputElement).value).toBe('Suggested Replacement');
  });

  it('E: resolves unavailable and reports no success when no editable editor is mounted', async () => {
    render(
      <ProjectMetadataNavigationProvider>
        <TestContainer canEdit={false} projectStatus="draft" suggestedTitle="Suggested Replacement" />
      </ProjectMetadataNavigationProvider>,
    );

    expect(screen.getByTestId('can-apply').textContent).toBe('CANNOT_APPLY');
    fireEvent.click(screen.getByTestId('trigger-suggestion-btn'));

    await waitFor(() => expect(screen.getByTestId('suggestion-outcome').textContent).toBe('unavailable'));
    expect(screen.queryByText(/Suggestion applied to the draft/i)).toBeNull();
  });

  it('E2: resolves unavailable for an approved project whose information is locked', async () => {
    render(
      <ProjectMetadataNavigationProvider>
        <TestContainer canEdit={true} projectStatus="approved" suggestedTitle="Suggested Replacement" />
      </ProjectMetadataNavigationProvider>,
    );

    expect(screen.getByTestId('can-apply').textContent).toBe('CANNOT_APPLY');
    fireEvent.click(screen.getByTestId('trigger-suggestion-btn'));

    await waitFor(() => expect(screen.getByTestId('suggestion-outcome').textContent).toBe('unavailable'));
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
    const trigger = screen.getByRole('button', { name: 'Disciplines: 1 selected' });
    fireEvent.click(trigger);

    // Select "Computer Science" from the checkbox group - no modifier key, single activation
    fireEvent.click(screen.getByRole('checkbox', { name: 'Computer Science' }));

    // Verify both are selected
    expect(screen.getByTestId('dirty-indicator').textContent).toBe('DIRTY');
    expect(screen.getByRole('button', { name: 'Disciplines: 2 selected' })).toBeTruthy();
    expect(screen.getAllByText('Computer Science').length).toBeGreaterThan(0);

    // Remove Software Engineering via chip
    const removeBtn = screen.getByRole('button', { name: 'Remove Software Engineering' });
    fireEvent.click(removeBtn);

    expect(screen.queryByRole('button', { name: 'Remove Software Engineering' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Disciplines: 1 selected' })).toBeTruthy();
  });

  it('submits the exact discipline and industry category id arrays the multi-select produced', async () => {
    const saveAction = vi
      .fn()
      .mockResolvedValue({ ok: true, metadata: persistableMetadata } as ProjectMetadataActionResult);
    render(
      <ProjectMetadataNavigationProvider>
        <TestContainer
          canEdit={true}
          projectStatus="draft"
          saveAction={saveAction}
          metadata={persistableMetadata}
          disciplines={persistableDisciplines}
          industryCategories={persistableIndustryCategories}
        />
      </ProjectMetadataNavigationProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Edit project information/i }));

    fireEvent.click(screen.getByRole('button', { name: 'Disciplines: 1 selected' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Computer Science' }));
    fireEvent.keyDown(document, { key: 'Escape' });

    fireEvent.click(screen.getByRole('button', { name: 'Industry categories: 1 selected' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Healthcare' }));
    fireEvent.keyDown(document, { key: 'Escape' });

    const saveBtn = screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);
    fireEvent.submit(saveBtn.closest('form') as HTMLFormElement);

    await waitFor(() => expect(saveAction).toHaveBeenCalledTimes(1));
    expect(saveAction.mock.calls[0][0]).toMatchObject({
      disciplineIds: [
        '20000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000002',
      ],
      industryCategoryIds: [
        '30000000-0000-4000-8000-000000000001',
        '30000000-0000-4000-8000-000000000002',
      ],
    });
  });

  it('restores focus to Cancel when dirty changes are kept with the dialog button', async () => {
    render(
      <ProjectMetadataNavigationProvider>
        <TestContainer canEdit={true} projectStatus="draft" />
      </ProjectMetadataNavigationProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Edit project information/i }));
    const titleInput = screen.getByLabelText(/Project title/i) as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: 'Modified Title Before Keep Editing' } });

    const cancelBtn = screen.getByRole('button', { name: 'Cancel' });
    cancelBtn.focus();
    fireEvent.click(cancelBtn);
    expect(screen.getByRole('alertdialog')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByText('Editing project information')).toBeTruthy();
    expect((screen.getByLabelText(/Project title/i) as HTMLInputElement).value).toBe(
      'Modified Title Before Keep Editing',
    );
    await waitFor(() => expect(document.activeElement).toBe(cancelBtn));
  });

  it('restores focus to Cancel when dirty changes are kept with Escape', async () => {
    render(
      <ProjectMetadataNavigationProvider>
        <TestContainer canEdit={true} projectStatus="draft" />
      </ProjectMetadataNavigationProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Edit project information/i }));
    const titleInput = screen.getByLabelText(/Project title/i) as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: 'Modified Title Before Escape' } });

    const cancelBtn = screen.getByRole('button', { name: 'Cancel' });
    cancelBtn.focus();
    fireEvent.click(cancelBtn);
    expect(screen.getByRole('alertdialog')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByText('Editing project information')).toBeTruthy();
    expect((screen.getByLabelText(/Project title/i) as HTMLInputElement).value).toBe(
      'Modified Title Before Escape',
    );
    await waitFor(() => expect(document.activeElement).toBe(cancelBtn));
  });

  it('prompts with AlertDialog when canceling dirty changes, and discards changes on confirmation', async () => {
    const saveAction = vi.fn().mockResolvedValue({ ok: true, metadata: initialMetadata } as ProjectMetadataActionResult);
    render(
      <ProjectMetadataNavigationProvider>
        <TestContainer canEdit={true} projectStatus="draft" saveAction={saveAction} />
      </ProjectMetadataNavigationProvider>,
    );

    const editBtn = screen.getByRole('button', { name: /Edit project information/i });
    fireEvent.click(editBtn);

    const titleInput = screen.getByLabelText(/Project title/i) as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: 'Modified Title Before Discard' } });

    expect(screen.getByTestId('dirty-indicator').textContent).toBe('DIRTY');

    const cancelBtn = screen.getByRole('button', { name: 'Cancel' });
    cancelBtn.focus();
    fireEvent.click(cancelBtn);
    expect(screen.getByRole('alertdialog')).toBeTruthy();

    const discardBtn = screen.getByRole('button', { name: 'Discard changes' });
    fireEvent.click(discardBtn);

    await waitFor(() => {
      expect(screen.getByText('Project information')).toBeTruthy();
      expect(screen.getByTestId('dirty-indicator').textContent).toBe('CLEAN');
      expect(screen.queryByLabelText(/Project title/i)).toBeNull();
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(saveAction).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: /Edit project information/i }),
      );
    });
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
    await waitFor(() => expect(document.activeElement).toBe(summary));
    expect(screen.getByTestId('dirty-indicator').textContent).toBe('DIRTY');
    expect(screen.getByText(/Language suggestion applied to the draft/i).getAttribute('role')).toBe('status');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy();
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
    fireEvent.click(screen.getByRole('button', { name: /Edit project information/i }));
    const summary = screen.getByLabelText(/Short summary/i) as HTMLTextAreaElement;
    const edited = `${summary.value} Staff note outside the inspected span.`;
    fireEvent.change(summary, { target: { value: edited } });

    fireEvent.click(screen.getByTestId('trigger-language-suggestion-btn'));

    expect(summary.value).toBe(edited);
    expect(screen.getByTestId('dirty-indicator').textContent).toBe('DIRTY');
    expect(screen.queryByText(/Language suggestion applied to the draft/i)).toBeNull();
  });
});
