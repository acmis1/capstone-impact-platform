// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BrowserImportPreviewClient from '../BrowserImportPreviewClient';
import * as clientMaterializer from '../../../import/formIntakeMaterializerClient';

describe('BrowserImportFormIntakeFlow - Form Intake in BrowserImportPreviewClient', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('toggles between Upload project package and Enter project using form tabs', () => {
    render(<BrowserImportPreviewClient />);

    const packageTab = screen.getByRole('tab', { name: /Upload project package/i });
    const formTab = screen.getByRole('tab', { name: /Enter project using form/i });

    expect(packageTab.getAttribute('aria-selected')).toBe('true');
    expect(formTab.getAttribute('aria-selected')).toBe('false');
    expect(screen.getByRole('heading', { name: 'Choose project folder' })).toBeTruthy();
    expect(screen.queryByText(/1\. Project Identification/i)).toBeNull();

    // Switch to Form tab
    fireEvent.click(formTab);

    expect(formTab.getAttribute('aria-selected')).toBe('true');
    expect(packageTab.getAttribute('aria-selected')).toBe('false');
    expect(screen.getByText(/1\. Project Identification/i)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Choose project folder' })).toBeNull();

    // Switch back to Package tab
    fireEvent.click(packageTab);

    expect(packageTab.getAttribute('aria-selected')).toBe('true');
    expect(formTab.getAttribute('aria-selected')).toBe('false');
    expect(screen.getByRole('heading', { name: 'Choose project folder' })).toBeTruthy();
    expect(screen.queryByText(/1\. Project Identification/i)).toBeNull();
  });

  it('submits form intake and flows into canonical preview validation results', async () => {
    const fakePreviewBatch = {
      previewFingerprint: 'a'.repeat(64),
      mode: 'single',
      selectedRootName: 'form-project-01',
      packageCount: 1,
      selectedFileCount: 3,
      declaredTotalBytes: 45000,
      validPackageCount: 1,
      warningPackageCount: 0,
      invalidPackageCount: 0,
      totalWarnings: 0,
      totalErrors: 0,
      mediaValidationMode: 'descriptor_only',
      batchIssues: [],
      packages: [
        {
          packagePath: 'form-project-01',
          folderName: 'form-project-01',
          proposedPublicId: 'form-project-01',
          metadataSource: 'xlsx',
          status: 'valid',
          previewMetadata: {
            title: 'Automated Microgrid Controller',
            year: '2026',
            program: 'Bachelor of Electrical Engineering',
            discipline: 'Electrical & Electronic Engineering',
            groupName: 'Grid Systems Team',
            teamMemberCount: 2,
            layoutTemplate: 'poster_showcase',
            featuredMedia: 'poster.png',
          },
          filePresence: {
            xlsxPresent: true,
            jsonPresent: false,
            posterImagePresent: true,
            posterPdfPresent: true,
            snapshotPresent: false,
          },
          errors: [],
          warnings: [],
        },
      ],
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (typeof url === 'string' && url.includes('/api/imports/preview')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ success: true, batch: fakePreviewBatch }),
          });
        }
        return Promise.reject(new Error(`Unhandled fetch: ${url}`));
      })
    );

    const fakeFiles = [
      new File(['xlsx'], 'project-details.xlsx'),
      new File(['png'], 'poster.png'),
      new File(['pdf'], 'poster.pdf'),
    ];

    vi.spyOn(clientMaterializer, 'materializeFormIntakePackage').mockResolvedValue({
      success: true,
      package: {
        files: fakeFiles,
        selectedRootName: 'form-project-01',
        totalBytes: 45000,
      },
    });

    render(<BrowserImportPreviewClient />);

    // Switch to Form tab
    fireEvent.click(screen.getByRole('tab', { name: /Enter project using form/i }));

    // Fill minimum required fields
    fireEvent.change(screen.getByLabelText(/Project Identifier \(Public ID\)/i), { target: { value: 'form-project-01' } });
    fireEvent.change(screen.getByLabelText(/Project Title/i), { target: { value: 'Automated Microgrid Controller' } });
    fireEvent.change(screen.getByLabelText(/Short Public Summary/i), { target: { value: 'A distributed power control grid.' } });
    fireEvent.change(screen.getByLabelText(/Study Program/i), { target: { value: 'Bachelor of Electrical Engineering' } });
    fireEvent.change(screen.getByLabelText(/Primary Discipline/i), { target: { value: 'Electrical & Electronic Engineering' } });
    fireEvent.change(screen.getByLabelText(/Group Name/i), { target: { value: 'Grid Systems Team' } });
    fireEvent.change(screen.getByLabelText(/Team Members/i), { target: { value: 'Dev One, Dev Two' } });
    fireEvent.change(screen.getByLabelText(/Poster Full Text/i), { target: { value: 'Microgrid poster transcript.' } });
    fireEvent.change(screen.getByLabelText(/Accessibility Description \(Alt text\)/i), { target: { value: 'Poster illustrating microgrid architecture.' } });

    const posterImg = new File(['fake-png'], 'poster.png', { type: 'image/png' });
    const posterPdf = new File(['fake-pdf'], 'poster.pdf', { type: 'application/pdf' });

    fireEvent.change(screen.getByLabelText(/Poster Image \(poster\.png\)/i), { target: { files: [posterImg] } });
    fireEvent.change(screen.getByLabelText(/Poster PDF \(poster\.pdf\)/i), { target: { files: [posterPdf] } });

    // Submit form
    fireEvent.click(screen.getByRole('button', { name: /Check project and continue/i }));

    // Wait for canonical preview results to be displayed
    expect(await screen.findByText('Automated Microgrid Controller')).toBeTruthy();
    expect(screen.getByText('Grid Systems Team')).toBeTruthy();
  });
});
