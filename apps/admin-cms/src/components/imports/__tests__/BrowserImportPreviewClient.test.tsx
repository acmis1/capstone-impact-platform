// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BrowserImportPreviewClient from '../BrowserImportPreviewClient';
import { ImportWorkflowGuide } from '../ImportWorkflowGuide';
import { AdminReferenceDatasetSection } from '../AdminReferenceDatasetSection';

/**
 * Controller stubs for the workflow-phase regression tests.
 *
 * These invoke the *same setters, in the same order*, as the real controllers do
 * (see browserImportPreparationController / browserImportStagingController /
 * browserImportMediaStagingController) so the component's real presentation path
 * is exercised end to end. Nothing test-only is injected into production state.
 */
const controllerStubs = vi.hoisted(() => ({
  preparation: 'success' as 'success' | 'failure',
  metadataStage: 'success' as 'success' | 'failure' | 'pending',
  mediaStage: 'success' as 'success' | 'failure',
  preparationCalls: 0,
  metadataStageCalls: 0,
  mediaStageCalls: 0,
  reset() {
    this.preparation = 'success';
    this.metadataStage = 'success';
    this.mediaStage = 'success';
    this.preparationCalls = 0;
    this.metadataStageCalls = 0;
    this.mediaStageCalls = 0;
  },
}));

const STUB_FINGERPRINT = 'a'.repeat(64);

vi.mock('../../../import/browserImportPreparationController', () => ({
  runBrowserImportPreparation: vi.fn(async (params: {
    setSelectionState: (updater: (prev: never) => never) => void;
  }) => {
    controllerStubs.preparationCalls += 1;
    const { setPreparedSuccess, setPreparedFailure } = await import(
      '../../../import/browserImportCommitIntentContract'
    );
    if (controllerStubs.preparation === 'failure') {
      params.setSelectionState((prev) => setPreparedFailure(prev, 'INVALID_SELECTION') as never);
      return;
    }
    params.setSelectionState((prev) =>
      setPreparedSuccess(prev, {
        version: 1,
        previewFingerprint: STUB_FINGERPRINT,
        selectedRootName: 'demo-project',
        fileCount: 3,
        declaredTotalBytes: 3000,
        selectedPackagePaths: ['demo-project'],
        acknowledgedWarningPackagePaths: [],
      }) as never
    );
  }),
}));

vi.mock('../../../import/browserImportStagingController', () => ({
  runBrowserImportMetadataStaging: vi.fn(async (params: {
    setIsStaging: (value: boolean) => void;
    setStagingError: (error: string | null) => void;
    setStagedResult: (result: {
      batchId: string;
      projectCount: number;
      warningCount: number;
      result: 'created' | 'already_staged';
    }) => void;
  }) => {
    controllerStubs.metadataStageCalls += 1;
    params.setIsStaging(true);
    params.setStagingError(null);
    if (controllerStubs.metadataStage === 'pending') {
      // Leaves the operation in flight so duplicate-submit protection can be observed.
      return new Promise<void>(() => {});
    }
    if (controllerStubs.metadataStage === 'failure') {
      params.setStagingError('The metadata staging operation could not be saved.');
      params.setIsStaging(false);
      return;
    }
    params.setStagedResult({
      batchId: '11111111-1111-4111-8111-111111111111',
      projectCount: 1,
      warningCount: 0,
      result: 'created',
    });
    params.setIsStaging(false);
  }),
}));

vi.mock('../../../import/browserImportMediaStagingController', () => ({
  runBrowserImportMediaStaging: vi.fn(async (params: {
    setIsCompletingMedia: (value: boolean) => void;
    setMediaCompleteError: (error: string | null) => void;
    setMediaCompleteResult: (result: {
      batchId: string;
      mediaAssetCount: number;
      result: 'completed' | 'already_completed';
    }) => void;
  }) => {
    controllerStubs.mediaStageCalls += 1;
    params.setIsCompletingMedia(true);
    params.setMediaCompleteError(null);
    if (controllerStubs.mediaStage === 'failure') {
      params.setMediaCompleteError('A media file could not be uploaded. Please try again.');
      params.setIsCompletingMedia(false);
      return;
    }
    params.setMediaCompleteResult({
      batchId: '11111111-1111-4111-8111-111111111111',
      mediaAssetCount: 2,
      result: 'completed',
    });
    params.setIsCompletingMedia(false);
  }),
}));

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
      expect(screen.getByText('Check files')).toBeTruthy();
      expect(screen.getByText('Confirm & save')).toBeTruthy();
      expect(screen.getByText('Import media')).toBeTruthy();

      // Step 3 is current
      const currentItem = screen.getByText('Check files').closest('li');
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
      expect(screen.getByText(/snapshot-1\s*…\s*snapshot-10/i)).toBeTruthy();

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

      // Verify JPEG and WEBP are not advertised for poster.png or anywhere in the poster details
      const posterLabel = screen.getByText('poster.png');
      const posterDetails = posterLabel.parentElement;

      expect(posterDetails?.textContent).toContain('PNG');
      expect(posterDetails?.textContent).toContain('maximum 5 MB');
      expect(posterDetails?.textContent).not.toContain('JPEG');
      expect(posterDetails?.textContent).not.toContain('WEBP');
      expect(posterDetails?.textContent).not.toContain('WebP');
    });

    it('advertises snapshot-1 through snapshot-10 gallery contract with PNG, JPEG, WebP support, 10 max, and required alt text per position', () => {
      render(<ImportWorkflowGuide currentStep={1} />);

      // Expand guide
      const toggleButton = screen.getByRole('button', {
        name: /show.*guide/i,
      });
      fireEvent.click(toggleButton);

      // Verify snapshot gallery entry exists and communicates the bounded gallery contract
      const snapshotHeading = screen.getByText(/snapshot-1\s*…\s*snapshot-10/i);
      expect(snapshotHeading).toBeTruthy();

      const snapshotContainer = snapshotHeading.closest('div');
      expect(snapshotContainer).not.toBeNull();

      const snapshotText = snapshotContainer?.textContent ?? '';
      expect(snapshotText).toMatch(/snapshot-1\s*…\s*snapshot-10/i);
      expect(snapshotText).toMatch(/optional/i);
      expect(snapshotText).toMatch(/up to 10 total/i);
      expect(snapshotText).toMatch(/PNG\/JPEG\/WebP/i);
      expect(snapshotText).toMatch(/maximum 5 MB each/i);
      expect(snapshotText).toMatch(/Every included snapshot must have matching alt text for its numeric gallery position in the metadata spreadsheet/i);

      // Distinguish from poster contract (poster is PNG-only, snapshot gallery supports PNG/JPEG/WebP)
      const posterContainer = screen.getByText('poster.png').closest('div');
      expect(posterContainer?.textContent).toContain('PNG');
      expect(posterContainer?.textContent).not.toContain('JPEG');
      expect(posterContainer?.textContent).not.toContain('WebP');
      expect(posterContainer?.textContent).not.toContain('WEBP');
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

      // Step 1 (Reference file) is initially active because the Admin Reference is REQUIRED,
      // not optional: prepareBrowserImportCommitIntentClient returns MISSING_ADMIN_REFERENCE
      // when the preview carries no Admin Reference reconciliation result, so no selection can
      // be prepared or staged until a mapping is confirmed.
      const step1 = screen.getByText('Reference file').closest('li');
      expect(step1?.getAttribute('aria-current')).toBe('step');
    });

    it('does not contain developer jargon like (Idempotent) or private draft storage in rendered strings', () => {
      const { container } = render(<BrowserImportPreviewClient />);
      expect(container.textContent).not.toContain('(Idempotent)');
      expect(container.textContent).not.toContain('private draft storage');
    });
  });

  describe('BrowserImportPreviewClient workflow-phase presentation exclusivity', () => {
    const NOT_SAVED_YET = /These project details have not been saved yet/i;
    const METADATA_SAVED = /Project details saved to the test environment/i;
    const MEDIA_NOT_IMPORTED = /Media files have not been imported yet/i;
    const IMPORT_NOT_COMPLETE = /this import is not complete/i;
    const IMPORT_COMPLETED = /Import completed successfully/i;
    const STAGE_METADATA_ACTION = /Import selected project details/i;
    const STAGE_MEDIA_ACTION = /Import media and finish/i;

    function buildPreviewResponse() {
      return {
        success: true,
        batch: {
          previewFingerprint: STUB_FINGERPRINT,
          mode: 'single',
          selectedRootName: 'demo-project',
          packageCount: 1,
          selectedFileCount: 3,
          declaredTotalBytes: 3000,
          validPackageCount: 1,
          warningPackageCount: 0,
          invalidPackageCount: 0,
          totalWarnings: 0,
          totalErrors: 0,
          mediaValidationMode: 'descriptor_only',
          batchIssues: [],
          packages: [
            {
              packagePath: 'demo-project',
              folderName: 'demo-project',
              proposedPublicId: 'demo-project',
              metadataSource: 'xlsx',
              status: 'valid',
              previewMetadata: {
                title: 'Demo Capstone Project',
                year: '2026',
                program: 'Bachelor of Engineering',
                discipline: 'Software Engineering',
                groupName: 'Group Demo',
                teamMemberCount: 3,
                layoutTemplate: 'standard',
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
        },
      };
    }

    function buildSelectedFile(relativePath: string, contents: string): File {
      const fileName = relativePath.split('/').pop() as string;
      const file = new File([contents], fileName);
      Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
      return file;
    }

    /** Drives the real component through folder selection and the file check. */
    async function renderThroughValidationResults() {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => buildPreviewResponse(),
        })
      );

      render(<BrowserImportPreviewClient />);

      const folderInput = screen.getByLabelText('Upload project directory');
      await act(async () => {
        fireEvent.change(folderInput, {
          target: {
            files: [
              buildSelectedFile('demo-project/project-details.xlsx', 'xlsx-bytes'),
              buildSelectedFile('demo-project/poster.png', 'png-bytes'),
              buildSelectedFile('demo-project/poster.pdf', 'pdf-bytes'),
            ],
          },
        });
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Check files and continue/i }));
      });

      await waitFor(() => expect(screen.getByText(/Validation results/i)).toBeTruthy());
    }

    async function confirmSelection() {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Confirm selected projects/i }));
      });
      await waitFor(() => expect(controllerStubs.preparationCalls).toBeGreaterThan(0));
    }

    async function stageMetadata() {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: STAGE_METADATA_ACTION }));
      });
      await waitFor(() => expect(controllerStubs.metadataStageCalls).toBeGreaterThan(0));
    }

    async function completeMedia() {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: STAGE_MEDIA_ACTION }));
      });
      await waitFor(() => expect(controllerStubs.mediaStageCalls).toBeGreaterThan(0));
    }

    beforeEach(() => {
      controllerStubs.reset();
    });

    it('shows only the prepared surface after preparation succeeds', async () => {
      await renderThroughValidationResults();
      await confirmSelection();

      expect(screen.getByText('Selection confirmed')).toBeTruthy();
      expect(screen.getByText(NOT_SAVED_YET)).toBeTruthy();
      expect(screen.getByRole('button', { name: STAGE_METADATA_ACTION })).toBeTruthy();

      expect(screen.queryByText(METADATA_SAVED)).toBeNull();
      expect(screen.queryByText(MEDIA_NOT_IMPORTED)).toBeNull();
      expect(screen.queryByText(IMPORT_COMPLETED)).toBeNull();
      expect(screen.queryByRole('button', { name: STAGE_MEDIA_ACTION })).toBeNull();
    });

    it('shows only the metadata-staged surface after metadata staging succeeds', async () => {
      await renderThroughValidationResults();
      await confirmSelection();
      await stageMetadata();

      expect(screen.getByText(METADATA_SAVED)).toBeTruthy();
      expect(screen.getByText(MEDIA_NOT_IMPORTED)).toBeTruthy();
      expect(screen.getByRole('button', { name: STAGE_MEDIA_ACTION })).toBeTruthy();

      expect(screen.queryByText(NOT_SAVED_YET)).toBeNull();
      expect(screen.queryByText('Selection confirmed')).toBeNull();
      expect(screen.queryByRole('button', { name: STAGE_METADATA_ACTION })).toBeNull();
      expect(screen.queryByText(IMPORT_COMPLETED)).toBeNull();
    });

    it('shows only the completed surface after media completion succeeds', async () => {
      await renderThroughValidationResults();
      await confirmSelection();
      await stageMetadata();
      await completeMedia();

      expect(screen.getByText(IMPORT_COMPLETED)).toBeTruthy();

      expect(screen.queryByText(NOT_SAVED_YET)).toBeNull();
      expect(screen.queryByRole('button', { name: STAGE_METADATA_ACTION })).toBeNull();
      expect(screen.queryByText(MEDIA_NOT_IMPORTED)).toBeNull();
      expect(screen.queryByText(IMPORT_NOT_COMPLETE)).toBeNull();
      expect(screen.queryByRole('button', { name: STAGE_MEDIA_ACTION })).toBeNull();
    });

    it('keeps the prepared surface visible when metadata staging fails', async () => {
      controllerStubs.metadataStage = 'failure';
      await renderThroughValidationResults();
      await confirmSelection();
      await stageMetadata();

      expect(screen.getByText('Selection confirmed')).toBeTruthy();
      expect(screen.getByText(NOT_SAVED_YET)).toBeTruthy();
      expect(screen.getByRole('button', { name: STAGE_METADATA_ACTION })).toBeTruthy();
      expect(screen.getByText('Project Details Import Failed')).toBeTruthy();

      expect(screen.queryByText(METADATA_SAVED)).toBeNull();
      expect(screen.queryByText(IMPORT_COMPLETED)).toBeNull();
    });

    it('keeps the metadata-staged surface visible when media staging fails', async () => {
      controllerStubs.mediaStage = 'failure';
      await renderThroughValidationResults();
      await confirmSelection();
      await stageMetadata();
      await completeMedia();

      expect(screen.getByText(METADATA_SAVED)).toBeTruthy();
      expect(screen.getByText(MEDIA_NOT_IMPORTED)).toBeTruthy();
      expect(screen.getByRole('button', { name: STAGE_MEDIA_ACTION })).toBeTruthy();
      expect(screen.getByText('Media Import Failed')).toBeTruthy();

      expect(screen.queryByText(NOT_SAVED_YET)).toBeNull();
      expect(screen.queryByText(IMPORT_COMPLETED)).toBeNull();
    });

    it('stays in the pre-prepared selection state when preparation fails', async () => {
      controllerStubs.preparation = 'failure';
      await renderThroughValidationResults();
      await confirmSelection();

      expect(screen.getByText('Selection Could Not Be Confirmed')).toBeTruthy();
      expect(screen.getByRole('button', { name: /Confirm selected projects/i })).toBeTruthy();

      expect(screen.queryByText('Selection confirmed')).toBeNull();
      expect(screen.queryByText(NOT_SAVED_YET)).toBeNull();
      expect(screen.queryByText(METADATA_SAVED)).toBeNull();
      expect(screen.queryByText(IMPORT_COMPLETED)).toBeNull();
    });

    it('blocks a duplicate metadata-stage submission while one is in flight', async () => {
      controllerStubs.metadataStage = 'pending';
      await renderThroughValidationResults();
      await confirmSelection();
      await stageMetadata();

      const inFlightButton = screen.getByRole('button', { name: /Saving project details…/i });
      expect(inFlightButton.hasAttribute('disabled')).toBe(true);

      await act(async () => {
        fireEvent.click(inFlightButton);
      });

      expect(controllerStubs.metadataStageCalls).toBe(1);
    });
  });
});
