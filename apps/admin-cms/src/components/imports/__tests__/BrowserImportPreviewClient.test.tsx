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

      expect(screen.getByText('School spreadsheet')).toBeTruthy();
      expect(screen.getByText('Project folder')).toBeTruthy();
      expect(screen.getByText('Check files')).toBeTruthy();
      expect(screen.getByText('Confirm & save')).toBeTruthy();
      expect(screen.getByText('Import media')).toBeTruthy();

      // Step 3 is current
      const currentItem = screen.getByText('Check files').closest('li');
      expect(currentItem?.getAttribute('aria-current')).toBe('step');
      expect(currentItem?.textContent).toContain('current step');

      // Steps 1 and 2 are completed (no aria-current, marked completed for assistive tech)
      const step1Item = screen.getByText('School spreadsheet').closest('li');
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
    it.each([false, true])('restores inspection failure focus without stealing another control (moved: %s)', async (moved) => {
      let resolveResponse!: (value: unknown) => void;
      vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { resolveResponse = resolve; })));
      render(<><button type="button">Another control</button><AdminReferenceDatasetSection onMappingConfigured={vi.fn()} /></>);
      const input = screen.getByLabelText(/Choose School reference spreadsheet/i);
      fireEvent.change(input, { target: { files: [new File(['invalid'], 'reference.xlsx')] } });
      const check = screen.getByRole('button', { name: 'Check spreadsheet' });
      check.focus();
      fireEvent.click(check);
      // In Chromium disabling the active button drops focus to body.
      check.blur();
      const other = screen.getByRole('button', { name: 'Another control' });
      if (moved) other.focus();
      await act(async () => resolveResponse({ ok: false, json: async () => ({ success: false }) }));
      expect(screen.getByRole('alert').textContent).toContain('Check Failed');
      expect(document.activeElement).toBe(moved ? other : check);
    });

    it('renders file selection and initial helper copy', () => {
      const onConfigured = vi.fn();
      render(<AdminReferenceDatasetSection onMappingConfigured={onConfigured} />);

      expect(screen.getByText('School reference spreadsheet')).toBeTruthy();
      expect(
        screen.getByText(/Use the School's reference spreadsheet to match and cross-check/i)
      ).toBeTruthy();
    });

    it('humanizes all canonical field option labels and shows automatic recognition when standard headers match', async () => {
      // Mock successful inspection with standard headers
      const fakeInspection = {
        success: true,
        worksheets: [
          {
            name: 'Sheet1',
            rowCount: 10,
            columnCount: 5,
            headers: ['Group Name', 'Project Title', 'Program', 'Academic Year', 'Participant Contact Email'],
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

      // Upload file and click check
      const input = screen.getByLabelText(/Choose School reference spreadsheet/i);
      const file = new File(['test'], 'reference.xlsx', {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      fireEvent.change(input, { target: { files: [file] } });

      const checkButton = screen.getByRole('button', { name: /Check spreadsheet/i });
      checkButton.focus();
      fireEvent.click(checkButton);
      await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Worksheet:')));

      // Wait for automatic recognition box to render
      expect(await screen.findByText('Columns recognised automatically')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Use these matches' })).toBeTruthy();

      // Click "Use these matches"
      fireEvent.click(screen.getByRole('button', { name: 'Use these matches' }));

      expect(screen.getByText('Matches confirmed')).toBeTruthy();
      expect(onConfigured).toHaveBeenCalledWith(
        expect.objectContaining({
          referenceFile: file,
          mappingConfig: expect.objectContaining({
            worksheet: 'Sheet1',
            matchMappings: [{ canonicalField: 'groupName', referenceColumn: 'Group Name' }],
            comparisonMappings: [
              { canonicalField: 'title', referenceColumn: 'Project Title' },
              { canonicalField: 'program', referenceColumn: 'Program' },
            ],
          }),
        })
      );

      // Open manual column matching to inspect options
      const changeMatchingBtn = screen.getByRole('button', { name: /Change column matching/i });
      fireEvent.click(changeMatchingBtn);

      expect(screen.getByText('1. Match projects using:')).toBeTruthy();

      // Verify humanized field labels exist in options and raw camelCase is not displayed as option text
      expect(screen.getAllByRole('option', { name: 'Project ID' }).length).toBeGreaterThan(0);
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
    });

    it('invalidates confirmation when worksheet changes or a column dropdown is changed', async () => {
      const fakeInspection = {
        success: true,
        worksheets: [
          {
            name: 'Sheet1',
            rowCount: 10,
            columnCount: 3,
            headers: ['Group Name', 'Project Title', 'Program'],
          },
          {
            name: 'Sheet2',
            rowCount: 5,
            columnCount: 3,
            headers: ['GroupName', 'Official Title', 'Degree Program'],
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

      const input = screen.getByLabelText(/Choose School reference spreadsheet/i);
      const file = new File(['test'], 'reference.xlsx', {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      fireEvent.change(input, { target: { files: [file] } });
      fireEvent.click(screen.getByRole('button', { name: /Check spreadsheet/i }));

      expect(await screen.findByText('Columns recognised automatically')).toBeTruthy();

      // Confirm
      fireEvent.click(screen.getByRole('button', { name: 'Use these matches' }));
      expect(screen.getByText('Matches confirmed')).toBeTruthy();

      // Change worksheet -> should unconfirm
      const worksheetSelect = screen.getByLabelText('Worksheet:');
      fireEvent.change(worksheetSelect, { target: { value: 'Sheet2' } });

      expect(screen.queryByText('Matches confirmed')).toBeNull();
      expect(screen.getByRole('button', { name: 'Use these matches' })).toBeTruthy();
      expect(onConfigured).toHaveBeenLastCalledWith(null);
    });
  });

  describe('AdminReferenceDatasetSection automatic versus manual column matching', () => {
    const STANDARD_HEADERS = ['Group Name', 'Project Title', 'Program', 'Academic Year'];

    function stubInspection(worksheets: Array<{ name: string; headers: string[] }>) {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            success: true,
            worksheets: worksheets.map((sheet) => ({
              name: sheet.name,
              rowCount: 10,
              columnCount: sheet.headers.length,
              headers: sheet.headers,
            })),
          }),
        })
      );
    }

    function checkSpreadsheet() {
      const onConfigured = vi.fn();
      render(<AdminReferenceDatasetSection onMappingConfigured={onConfigured} />);
      const input = screen.getByLabelText(/Choose School reference spreadsheet/i);
      const file = new File(['test'], 'reference.xlsx', {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      fireEvent.change(input, { target: { files: [file] } });
      fireEvent.click(screen.getByRole('button', { name: /Check spreadsheet/i }));
      return { file, onConfigured };
    }

    function openManualMatching() {
      fireEvent.click(screen.getByRole('button', { name: /Change column matching/i }));
    }

    it('claims automatic recognition and offers Use these matches only for the pristine suggestion', async () => {
      stubInspection([{ name: 'Sheet1', headers: STANDARD_HEADERS }]);
      checkSpreadsheet();

      expect(await screen.findByText('Columns recognised automatically')).toBeTruthy();
      const useMatches = screen.getByRole('button', { name: 'Use these matches' }) as HTMLButtonElement;
      expect(useMatches.disabled).toBe(false);
      expect(screen.queryByText('Review your column matching')).toBeNull();
    });

    it('withdraws the automatic claim and the confirmation when a project field is changed by hand', async () => {
      stubInspection([{ name: 'Sheet1', headers: STANDARD_HEADERS }]);
      const { onConfigured } = checkSpreadsheet();

      expect(await screen.findByText('Columns recognised automatically')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Use these matches' }));
      expect(screen.getByText('Matches confirmed')).toBeTruthy();

      openManualMatching();
      fireEvent.change(screen.getByLabelText('Match field 1 project field'), {
        target: { value: 'year' },
      });

      // The mappings on screen are no longer what the matcher proposed, so nothing may still be
      // presented as recognised automatically.
      expect(screen.queryByText('Columns recognised automatically')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Use these matches' })).toBeNull();
      expect(screen.queryByText('Matches confirmed')).toBeNull();
      expect(screen.getByText('Review your column matching')).toBeTruthy();
      expect(onConfigured).toHaveBeenLastCalledWith(null);
      expect((screen.getByRole('button', { name: 'Confirm column matching' }) as HTMLButtonElement).disabled).toBe(false);
    });

    it('withdraws the automatic claim when a spreadsheet column is changed by hand', async () => {
      stubInspection([{ name: 'Sheet1', headers: STANDARD_HEADERS }]);
      const { onConfigured } = checkSpreadsheet();

      expect(await screen.findByText('Columns recognised automatically')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Use these matches' }));

      openManualMatching();
      fireEvent.change(screen.getByLabelText('Match field 1 spreadsheet column'), {
        target: { value: 'Academic Year' },
      });

      expect(screen.queryByText('Columns recognised automatically')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Use these matches' })).toBeNull();
      expect(screen.getByText('Review your column matching')).toBeTruthy();
      expect(onConfigured).toHaveBeenLastCalledWith(null);
    });

    it('restores the automatic presentation when the exact automatic mapping is put back by hand', async () => {
      stubInspection([{ name: 'Sheet1', headers: STANDARD_HEADERS }]);
      checkSpreadsheet();

      expect(await screen.findByText('Columns recognised automatically')).toBeTruthy();
      openManualMatching();

      fireEvent.change(screen.getByLabelText('Match field 1 spreadsheet column'), {
        target: { value: 'Academic Year' },
      });
      expect(screen.queryByText('Columns recognised automatically')).toBeNull();

      fireEvent.change(screen.getByLabelText('Match field 1 spreadsheet column'), {
        target: { value: 'Group Name' },
      });

      expect(screen.getByText('Columns recognised automatically')).toBeTruthy();
      expect(screen.getByText('Column matching')).toBeTruthy();
      expect(screen.queryByText('Review your column matching')).toBeNull();
    });

    it('offers no clickable confirmation while a required column is unresolved, and confirms once completed', async () => {
      stubInspection([{ name: 'Sheet1', headers: ['Group Name', 'Academic Year'] }]);
      const { file, onConfigured } = checkSpreadsheet();

      expect(
        await screen.findByText(/We could not confidently match all required columns/i)
      ).toBeTruthy();
      expect(screen.queryByText('Columns recognised automatically')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Use these matches' })).toBeNull();

      const confirmButton = screen.getByRole('button', { name: 'Confirm column matching' }) as HTMLButtonElement;
      expect(confirmButton.disabled).toBe(true);
      expect(
        screen.getByText(/Column matching not confirmed — confirm the matches before preparing projects for import./i)
      ).toBeTruthy();

      fireEvent.change(screen.getByLabelText('Comparison field 1 spreadsheet column'), {
        target: { value: 'Group Name' },
      });
      fireEvent.change(screen.getByLabelText('Comparison field 2 spreadsheet column'), {
        target: { value: 'Academic Year' },
      });

      const readyButton = screen.getByRole('button', { name: 'Confirm column matching' }) as HTMLButtonElement;
      expect(readyButton.disabled).toBe(false);
      fireEvent.click(readyButton);

      expect(screen.getByText('Column matching confirmed')).toBeTruthy();
      expect(onConfigured).toHaveBeenLastCalledWith(
        expect.objectContaining({
          referenceFile: file,
          mappingConfig: expect.objectContaining({
            worksheet: 'Sheet1',
            matchMappings: [{ canonicalField: 'groupName', referenceColumn: 'Group Name' }],
            comparisonMappings: [
              { canonicalField: 'title', referenceColumn: 'Group Name' },
              { canonicalField: 'program', referenceColumn: 'Academic Year' },
            ],
          }),
        })
      );
    });

    it('resets a manually edited configuration and re-derives it when the worksheet changes', async () => {
      stubInspection([
        { name: 'Sheet1', headers: STANDARD_HEADERS },
        { name: 'Sheet2', headers: ['GroupName', 'Official Title', 'Degree Program'] },
      ]);
      const { onConfigured } = checkSpreadsheet();

      expect(await screen.findByText('Columns recognised automatically')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Use these matches' }));
      openManualMatching();
      fireEvent.change(screen.getByLabelText('Match field 1 project field'), {
        target: { value: 'year' },
      });
      expect(screen.getByText('Review your column matching')).toBeTruthy();

      fireEvent.change(screen.getByLabelText('Worksheet:'), { target: { value: 'Sheet2' } });

      expect(screen.queryByText('Review your column matching')).toBeNull();
      expect(screen.getByText('Columns recognised automatically')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Use these matches' })).toBeTruthy();
      expect(screen.queryByText('Matches confirmed')).toBeNull();
      expect(onConfigured).toHaveBeenLastCalledWith(null);
    });

    it('clears the previous mapping identity when the spreadsheet file is replaced', async () => {
      stubInspection([{ name: 'Sheet1', headers: STANDARD_HEADERS }]);
      const { onConfigured } = checkSpreadsheet();

      expect(await screen.findByText('Columns recognised automatically')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Use these matches' }));
      expect(screen.getByText('Matches confirmed')).toBeTruthy();

      const replacement = new File(['other'], 'other-reference.xlsx', {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      fireEvent.change(screen.getByLabelText(/Choose School reference spreadsheet/i), {
        target: { files: [replacement] },
      });

      expect(screen.queryByText('Columns recognised automatically')).toBeNull();
      expect(screen.queryByText('Matches confirmed')).toBeNull();
      expect(screen.queryByText('Column matching')).toBeNull();
      expect(screen.queryByLabelText('Worksheet:')).toBeNull();
      expect(screen.getByRole('button', { name: /Check spreadsheet/i })).toBeTruthy();
      expect(onConfigured).toHaveBeenLastCalledWith(null);
    });
  });

  describe('BrowserImportPreviewClient Presentation Hierarchy & Copy', () => {
    it('renders School Reference section before folder selection controls and sets initial step to Step 1', () => {
      render(<BrowserImportPreviewClient />);

      // School Reference heading exists before folder selection
      const refHeading = screen.getByRole('heading', { name: 'School reference spreadsheet' });
      expect(refHeading).toBeTruthy();

      // Folder selection heading and button exist
      const folderHeading = screen.getByRole('heading', { name: 'Choose project folder' });
      expect(folderHeading).toBeTruthy();
      expect(screen.getByRole('button', { name: /Choose project folder/i })).toBeTruthy();

      // Verify DOM document order: refHeading precedes folderHeading
      const position = refHeading.compareDocumentPosition(folderHeading);
      expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      // Step 1 (School spreadsheet) is initially active because the Reference spreadsheet is REQUIRED
      const step1 = screen.getByText('School spreadsheet').closest('li');
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

    it('associates package issues with an expanded disclosure and wraps long filenames', async () => {
      await renderThroughValidationResults();
      const response = buildPreviewResponse();
      const fileName = 'syntheticfilename'.repeat(4) + '.txt';
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({
        ...response, batch: { ...response.batch, totalWarnings: 1, warningPackageCount: 1, validPackageCount: 0, packages: response.batch.packages.map(pkg => ({
          ...pkg, status: 'warning', warnings: [{ code: 'PACKAGE_UNKNOWN_FILE', severity: 'warning', message: 'Unrecognized file in package root will be ignored.', fileName }],
        })) },
      }) }));
      fireEvent.click(screen.getByRole('button', { name: /Check files and continue/i }));
      const toggle = await screen.findByRole('button', { name: /Show issues/ });
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      toggle.focus();
      fireEvent.click(toggle);
      const region = screen.getByRole('region', { name: 'Issues for demo-project' });
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(toggle.getAttribute('aria-controls')).toBe(region.id);
      expect(screen.getByText('(file: ' + fileName + ')').classList.contains('break-all')).toBe(true);
      expect(document.activeElement).toBe(toggle);
      fireEvent.click(toggle);
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(screen.queryByRole('region', { name: 'Issues for demo-project' })).toBeNull();
      expect(document.activeElement).toBe(toggle);
    });

    it('moves focus through results, confirmation, saved metadata and completed media', async () => {
      await renderThroughValidationResults();
      expect(document.activeElement).toBe(screen.getByText('Validation results'));
      screen.getByRole('button', { name: /Confirm selected projects/i }).focus();
      await confirmSelection();
      expect(document.activeElement).toBe(screen.getByRole('button', { name: STAGE_METADATA_ACTION }));
      await stageMetadata();
      expect(document.activeElement).toBe(screen.getByRole('button', { name: STAGE_MEDIA_ACTION }));
      await completeMedia();
      expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Open import details' }));
    });

    it('restores focus to Choose project folder when Clear selection disappears', async () => {
      Object.defineProperty(HTMLInputElement.prototype, 'webkitdirectory', { configurable: true, value: false });
      await renderThroughValidationResults();
      delete (HTMLInputElement.prototype as Partial<HTMLInputElement>).webkitdirectory;
      const clear = screen.getByRole('button', { name: 'Clear selection' });
      clear.focus();
      fireEvent.click(clear);
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Choose project folder' }));
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
