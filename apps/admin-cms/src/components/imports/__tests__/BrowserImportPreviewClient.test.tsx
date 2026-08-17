// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BrowserImportPreviewClient from '../BrowserImportPreviewClient';
import { ImportWorkflowGuide } from '../ImportWorkflowGuide';
import { AdminReferenceDatasetSection } from '../AdminReferenceDatasetSection';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PR2A Guided Import Workflow Components', () => {
  describe('ImportWorkflowGuide', () => {
    it('renders all 5 sequential steps and distinguishes completed, current, and upcoming', () => {
      render(<ImportWorkflowGuide currentStep={3} />);

      expect(screen.getByText('Reference file')).toBeTruthy();
      expect(screen.getByText('Project folder')).toBeTruthy();
      expect(screen.getByText('Check results')).toBeTruthy();
      expect(screen.getByText('Confirm & save')).toBeTruthy();
      expect(screen.getByText('Import media')).toBeTruthy();

      // Step 3 is current
      const currentItem = screen.getByText('Check results').closest('li');
      expect(currentItem?.getAttribute('aria-current')).toBe('step');
      expect(currentItem?.textContent).toContain('current step');

      // Steps 1 and 2 are completed (no aria-current, marked completed for assistive tech)
      const step1Item = screen.getByText('Reference file').closest('li');
      expect(step1Item?.getAttribute('aria-current')).toBeNull();
      expect(step1Item?.textContent).toContain('completed');
      const step2Item = screen.getByText('Project folder').closest('li');
      expect(step2Item?.getAttribute('aria-current')).toBeNull();
      expect(step2Item?.textContent).toContain('completed');

      // Upcoming steps show their plain step number and no aria-current
      expect(screen.getByText('4')).toBeTruthy();
      expect(screen.getByText('5')).toBeTruthy();
      const step5Item = screen.getByText('Import media').closest('li');
      expect(step5Item?.getAttribute('aria-current')).toBeNull();
      expect(step5Item?.textContent).not.toContain('completed');
    });

    it('expands and collapses via semantic button and aria-expanded', () => {
      render(<ImportWorkflowGuide currentStep={1} />);

      // Initially guide is collapsed
      expect(screen.queryByText(/Expected Files per Project/i)).toBeNull();

      // Click semantic toggle button to expand
      const toggleButton = screen.getByRole('button', {
        name: /show.*guide/i,
      });
      expect(toggleButton.getAttribute('aria-expanded')).toBe('false');

      fireEvent.click(toggleButton);

      expect(toggleButton.getAttribute('aria-expanded')).toBe('true');
      expect(screen.getByText(/Expected Files per Project/i)).toBeTruthy();
      expect(screen.getByText('project-details.xlsx')).toBeTruthy();
      expect(screen.getByText('poster.png')).toBeTruthy();
      expect(screen.getByText('poster.pdf')).toBeTruthy();

      // Click again to collapse
      fireEvent.click(toggleButton);
      expect(toggleButton.getAttribute('aria-expanded')).toBe('false');
      expect(screen.queryByText(/Expected Files per Project/i)).toBeNull();
    });

    it('advertises poster.png as PNG only (max 5 MB) without advertising JPEG or WEBP', () => {
      render(<ImportWorkflowGuide currentStep={1} />);

      // Expand guide
      const toggleButton = screen.getByRole('button', {
        name: /show.*guide/i,
      });
      fireEvent.click(toggleButton);

      // Verify exact PNG description
      expect(screen.getByText(/Required poster image \(PNG; maximum 5 MB\)\./i)).toBeTruthy();

      // Verify JPEG and WEBP are not advertised for poster.png or anywhere in the guide
      const guideContainer = screen.getByText(/Expected Files per Project/i).closest('div');
      expect(guideContainer?.textContent).not.toContain('JPEG');
      expect(guideContainer?.textContent).not.toContain('WEBP');
    });
  });

  describe('AdminReferenceDatasetSection', () => {
    it('renders file selection and initial helper copy', () => {
      const onConfigured = vi.fn();
      render(<AdminReferenceDatasetSection onMappingConfigured={onConfigured} />);

      expect(screen.getByText('Admin Reference file')).toBeTruthy();
      expect(
        screen.getByText(/Use the School's reference spreadsheet to match and cross-check/i)
      ).toBeTruthy();
    });

    it('humanizes all canonical field option labels', async () => {
      // Mock successful inspection to render mapping selects
      const fakeInspection = {
        success: true,
        worksheets: [
          {
            name: 'Sheet1',
            rowCount: 10,
            columnCount: 5,
            headers: ['ColA', 'ColB', 'ColC', 'ColD', 'ColE'],
          },
        ],
      };

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => fakeInspection,
        })
      );

      const onConfigured = vi.fn();
      render(<AdminReferenceDatasetSection onMappingConfigured={onConfigured} />);

      // Upload file and click inspect
      const input = screen.getByLabelText(/Choose Admin Reference spreadsheet/i);
      const file = new File(['test'], 'reference.xlsx', {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      fireEvent.change(input, { target: { files: [file] } });

      const inspectButton = screen.getByRole('button', { name: /Inspect reference file/i });
      fireEvent.click(inspectButton);

      // Wait for mappings to render
      expect(await screen.findByText('1. Match projects using:')).toBeTruthy();

      // Verify humanized field labels exist in options and raw camelCase is not displayed as option text
      expect(screen.getAllByRole('option', { name: 'Public ID' }).length).toBeGreaterThan(0);
      expect(screen.getAllByRole('option', { name: 'Project title' }).length).toBeGreaterThan(0);
      expect(screen.getAllByRole('option', { name: 'Group name' }).length).toBeGreaterThan(0);
      expect(screen.getAllByRole('option', { name: 'Academic year' }).length).toBeGreaterThan(0);
      expect(screen.getAllByRole('option', { name: 'Program' }).length).toBeGreaterThan(0);
      expect(screen.getAllByRole('option', { name: 'Study program' }).length).toBeGreaterThan(0);
      expect(screen.getAllByRole('option', { name: 'Academic supervisor' }).length).toBeGreaterThan(0);
      expect(screen.getAllByRole('option', { name: 'Industry partner' }).length).toBeGreaterThan(0);
      expect(screen.getAllByRole('option', { name: 'Participant contact email' }).length).toBeGreaterThan(0);
      expect(screen.getAllByRole('option', { name: 'Team members' }).length).toBeGreaterThan(0);

      // Verify representative raw camelCase identifiers are NOT displayed as option labels
      expect(screen.queryByRole('option', { name: 'studyProgram' })).toBeNull();
      expect(screen.queryByRole('option', { name: 'academicSupervisor' })).toBeNull();
      expect(screen.queryByRole('option', { name: 'industryPartner' })).toBeNull();
      expect(screen.queryByRole('option', { name: 'participantContactEmail' })).toBeNull();
      expect(screen.queryByRole('option', { name: 'teamMembers' })).toBeNull();

      // Verify accurate unconfirmed text
      expect(
        screen.getByText(/Mapping not confirmed — confirm the mapping before preparing projects for import\./i)
      ).toBeTruthy();
    });
  });

  describe('BrowserImportPreviewClient Presentation Hierarchy & Copy', () => {
    it('renders Admin Reference section before folder selection controls and sets initial step to Step 1', () => {
      render(<BrowserImportPreviewClient />);

      // Admin Reference heading exists before folder selection
      const refHeading = screen.getByRole('heading', { name: 'Admin Reference file' });
      expect(refHeading).toBeTruthy();

      // Folder selection heading and button exist
      const folderHeading = screen.getByRole('heading', { name: 'Choose project folder' });
      expect(folderHeading).toBeTruthy();
      expect(screen.getByRole('button', { name: /Choose project folder/i })).toBeTruthy();

      // Verify DOM document order: refHeading precedes folderHeading
      const position = refHeading.compareDocumentPosition(folderHeading);
      expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      // Step 1 (Reference file) is initially active, since it is optional and not yet configured
      const step1 = screen.getByText('Reference file').closest('li');
      expect(step1?.getAttribute('aria-current')).toBe('step');
    });

    it('does not contain developer jargon like (Idempotent) or private draft storage in rendered strings', () => {
      const { container } = render(<BrowserImportPreviewClient />);
      expect(container.textContent).not.toContain('(Idempotent)');
      expect(container.textContent).not.toContain('private draft storage');
    });
  });
});
