/** @vitest-environment jsdom */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ProjectMetadataEditor } from '../ProjectMetadataEditor';
import { ProjectMetadataNavigationProvider, useProjectMetadataNavigation } from '../ProjectMetadataNavigation';
import type { ProjectMetadataView } from '../../../projects/projectMetadata';
afterEach(cleanup);
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


function NavigationProbe() {
  const navigation = useProjectMetadataNavigation();
  return <p>{navigation?.canApplyTitleSuggestion ? 'Title apply registered' : 'No title apply handler'}</p>;
}
describe('ProjectMetadataEditor participant ownership policy', () => {
  it.each(['draft', 'in_review', 'changes_requested', 'approved', 'published'])('offers only read-only ownership guidance in %s', (projectStatus) => {
    const saveAction = vi.fn();
    const { container } = render(<ProjectMetadataNavigationProvider><ProjectMetadataEditor initialMetadata={initialMetadata} programs={[]} disciplines={[]} industryCategories={[]} canEdit projectStatus={projectStatus} saveAction={saveAction} /><NavigationProbe /></ProjectMetadataNavigationProvider>);
    expect(screen.getByText(/owned by the project team/i)).toBeTruthy();
    expect(screen.getByText('No title apply handler')).toBeTruthy();
    expect(container.querySelector('input, textarea, select, form')).toBeNull();
    expect(screen.queryByRole('button', { name: /edit|save|apply/i })).toBeNull();
    expect(saveAction).not.toHaveBeenCalled();
  });
});
