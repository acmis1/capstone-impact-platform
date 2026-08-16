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
  });

  describe('BrowserImportPreviewClient Presentation Hierarchy', () => {
    it('renders Admin Reference section before folder selection controls', () => {
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
    });
  });
});
