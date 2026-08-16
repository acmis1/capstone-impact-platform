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
    it('renders all 5 sequential steps', () => {
      render(<ImportWorkflowGuide currentStep={1} />);

      expect(screen.getByText('Prepare files')).toBeTruthy();
      expect(screen.getByText('Add reference file')).toBeTruthy();
      expect(screen.getByText('Choose folder')).toBeTruthy();
      expect(screen.getByText('Check results')).toBeTruthy();
      expect(screen.getByText('Import')).toBeTruthy();
    });

    it('expands and collapses the folder and file preparation guide', () => {
      render(<ImportWorkflowGuide currentStep={1} />);

      // Initially guide is collapsed
      expect(screen.queryByText(/Expected Files per Project/i)).toBeNull();

      // Click guide header to expand
      const guideToggle = screen.getByRole('heading', {
        name: /Before you start: Folder and file preparation guide/i,
      });
      fireEvent.click(guideToggle);

      expect(screen.getByText(/Expected Files per Project/i)).toBeTruthy();
      expect(screen.getByText('project-details.xlsx')).toBeTruthy();
      expect(screen.getByText('poster.png')).toBeTruthy();
      expect(screen.getByText('poster.pdf')).toBeTruthy();

      // Click again to collapse
      fireEvent.click(guideToggle);
      expect(screen.queryByText(/Expected Files per Project/i)).toBeNull();
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
  });

  describe('BrowserImportPreviewClient', () => {
    it('renders folder selection card, guide, and buttons without errors', () => {
      render(<BrowserImportPreviewClient />);

      expect(screen.getByRole('heading', { name: 'Choose project folder' })).toBeTruthy();
      expect(screen.getByRole('button', { name: /Choose project folder/i })).toBeTruthy();
    });
  });
});
