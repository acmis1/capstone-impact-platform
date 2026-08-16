import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';

import { ACCESSIBLE_CONTENT_LIMITS } from '../../domain/accessibleContent';
import { parseProjectDetailsWorkbook } from '../parseProjectDetailsWorkbook';
import { ProjectDetailsWorkbookError } from '../projectDetailsWorkbookContract';
import { parseProjectDetailsJson, ProjectDetailsJsonError } from '../parseProjectDetailsJson';
import { buildImportPackageManifestFromWorkbook } from '../workbookManifestAdapter';
import { validateImportPackage } from '../validateImportPackage';
import { ImportPackageFileMetadata, ImportPackageManifest, ImportPackageParseResult } from '../importTypes';

const MAX = ACCESSIBLE_CONTENT_LIMITS.snapshotAltText;
const VALID_ALT = 'Bar chart comparing mock throughput before and after the optimisation.';

const BASE_HEADERS = [
  'Project title', 'Short public summary', 'Team members', 'Group name',
  'Study program', 'Primary discipline', 'Project year', 'Poster full text', 'Accessibility text',
];
const BASE_VALUES = [
  'Synthetic Project', 'Synthetic summary.', 'Member A', 'Group A',
  'Bachelor of Engineering', 'Software Engineering', '2026', 'Poster full text body.', 'Poster description.',
];

async function buildWorkbook(
  extraHeaders: string[] = [],
  extraValues: (string | ExcelJS.CellValue)[] = [],
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Project details');
  sheet.addRow([...BASE_HEADERS, ...extraHeaders]);
  sheet.addRow([...BASE_VALUES, ...extraValues]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function parseWorkbookIssues(buffer: Buffer): Promise<string[]> {
  try {
    await parseProjectDetailsWorkbook(buffer);
    return [];
  } catch (error) {
    if (error instanceof ProjectDetailsWorkbookError) {
      return error.errors.map((issue) => `${issue.code}:${issue.fieldName ?? ''}`);
    }
    throw error;
  }
}

const file: ImportPackageFileMetadata = { fileName: 'snapshot-1.png', fileSizeBytes: 2048, mimeType: 'image/png' };
const posterImage: ImportPackageFileMetadata = { fileName: 'poster.png', fileSizeBytes: 2048, mimeType: 'image/png' };
const posterPdf: ImportPackageFileMetadata = { fileName: 'poster.pdf', fileSizeBytes: 4096, mimeType: 'application/pdf' };

function packageOf(
  manifest: Partial<ImportPackageManifest>,
  snapshotPresent: boolean,
): ImportPackageParseResult<ImportPackageFileMetadata> {
  return {
    manifest: {
      publicId: '2026-synthetic', title: 'T', summary: 'S', background: '', solution: '', year: '2026',
      program: 'P', studyProgram: 'P', discipline: 'D', industry: '', industryPartner: '',
      academicSupervisor: '', groupName: 'G', participantContactEmail: '', teamMembers: ['A'],
      layoutConfig: { templateId: 'poster_showcase' },
      ...manifest,
    },
    posterImage,
    posterPdf,
    snapshot1: snapshotPresent ? file : null,
  };
}

const ruleCodes = (result: ReturnType<typeof validateImportPackage>) => result.errors.map((e) => e.ruleCode);

describe('standard project-details.xlsx snapshot alt text contract', () => {
  it('accepts a snapshot alt value and carries it onto the manifest', async () => {
    const parsed = await parseProjectDetailsWorkbook(
      await buildWorkbook(['Snapshot image alt text'], [VALID_ALT]),
    );
    expect(parsed.metadata.snapshotAltText).toBe(VALID_ALT);

    const manifest = buildImportPackageManifestFromWorkbook({ parsedWorkbook: parsed, publicId: '2026-synthetic' });
    expect(manifest.snapshotAltText).toBe(VALID_ALT);
  });

  it('recognises every deterministic alias', async () => {
    for (const alias of [
      'snapshot image alt text', 'Snapshot alt text', 'snapshot accessibility text',
      'snapshotimagealttext', 'snapshotalttext',
    ]) {
      const parsed = await parseProjectDetailsWorkbook(await buildWorkbook([alias], [VALID_ALT]));
      expect(parsed.metadata.snapshotAltText).toBe(VALID_ALT);
    }
  });

  it('does not fuzzy-match an unrelated header', async () => {
    const parsed = await parseProjectDetailsWorkbook(await buildWorkbook(['Snapshot notes'], [VALID_ALT]));
    expect(parsed.metadata.snapshotAltText).toBe('');
    expect(parsed.warnings.some((w) => w.code === 'WORKBOOK_UNKNOWN_COLUMN')).toBe(true);
  });

  it('rejects two headers mapping to the same snapshot-alt field', async () => {
    const issues = await parseWorkbookIssues(
      await buildWorkbook(['Snapshot image alt text', 'snapshot alt text'], [VALID_ALT, VALID_ALT]),
    );
    expect(issues).toContain('WORKBOOK_DUPLICATE_COLUMN:snapshotAltText');
  });

  it('rejects a formula cell with no usable cached result', async () => {
    const issues = await parseWorkbookIssues(
      await buildWorkbook(['Snapshot image alt text'], [{ formula: 'A1&B1', result: undefined }]),
    );
    expect(issues).toContain('WORKBOOK_UNUSABLE_FORMULA:snapshotAltText');
  });

  it('accepts the exact maximum and rejects one character beyond it', async () => {
    const atMax = await parseProjectDetailsWorkbook(await buildWorkbook(['Snapshot image alt text'], ['a'.repeat(MAX)]));
    expect(atMax.metadata.snapshotAltText).toHaveLength(MAX);

    const issues = await parseWorkbookIssues(await buildWorkbook(['Snapshot image alt text'], ['a'.repeat(MAX + 1)]));
    expect(issues).toContain('WORKBOOK_VALUE_TOO_LONG:snapshotAltText');
  });

  it('never silently truncates an oversized value', async () => {
    const buffer = await buildWorkbook(['Snapshot image alt text'], ['a'.repeat(MAX + 1)]);
    await expect(parseProjectDetailsWorkbook(buffer)).rejects.toThrow(ProjectDetailsWorkbookError);
  });

  it('preserves the inherited required-column guarantees', async () => {
    // Poster full text and Accessibility text stay required columns; the snapshot-alt column does not
    // become required merely because it was added to the contract.
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Project details');
    sheet.addRow(BASE_HEADERS.filter((h) => h !== 'Poster full text'));
    sheet.addRow(BASE_VALUES.filter((_, index) => BASE_HEADERS[index] !== 'Poster full text'));
    const issues = await parseWorkbookIssues(Buffer.from(await workbook.xlsx.writeBuffer()));
    expect(issues).toContain('WORKBOOK_MISSING_REQUIRED_COLUMN:posterText');
  });
});

describe('package-aware snapshot alt text rule', () => {
  it('blocks a standard xlsx package whose snapshot has no alt text', () => {
    const result = validateImportPackage(packageOf({}, true), { metadataSource: 'xlsx' });
    expect(ruleCodes(result)).toContain('METADATA_MISSING_SNAPSHOT_ALT_TEXT');
    expect(result.valid).toBe(false);
  });

  it('blocks a standard xlsx package whose snapshot alt is only whitespace', () => {
    const result = validateImportPackage(packageOf({ snapshotAltText: '   \n\t ' }, true), { metadataSource: 'xlsx' });
    expect(ruleCodes(result)).toContain('METADATA_MISSING_SNAPSHOT_ALT_TEXT');
  });

  it('accepts a standard xlsx package whose snapshot has alt text', () => {
    const result = validateImportPackage(packageOf({ snapshotAltText: VALID_ALT }, true), { metadataSource: 'xlsx' });
    expect(ruleCodes(result)).not.toContain('METADATA_MISSING_SNAPSHOT_ALT_TEXT');
    expect(result.valid).toBe(true);
  });

  it('does not ask a package without a snapshot image to describe one', () => {
    const absentColumn = validateImportPackage(packageOf({}, false), { metadataSource: 'xlsx' });
    expect(ruleCodes(absentColumn)).not.toContain('METADATA_MISSING_SNAPSHOT_ALT_TEXT');
    expect(absentColumn.valid).toBe(true);

    const blankValue = validateImportPackage(packageOf({ snapshotAltText: '  ' }, false), { metadataSource: 'xlsx' });
    expect(ruleCodes(blankValue)).not.toContain('METADATA_MISSING_SNAPSHOT_ALT_TEXT');
    expect(blankValue.valid).toBe(true);

    // The snapshot image itself stays optional, so its absence remains a warning, never an error.
    expect(absentColumn.warnings.map((w) => w.ruleCode)).toContain('FILE_MISSING_RECOMMENDED');
  });

  it('does not block a legacy project.json package for an absent snapshot alt', () => {
    const result = validateImportPackage(packageOf({}, true), { metadataSource: 'json' });
    expect(ruleCodes(result)).not.toContain('METADATA_MISSING_SNAPSHOT_ALT_TEXT');
    expect(result.valid).toBe(true);
  });

  it('rejects an oversized value from either source', () => {
    for (const metadataSource of ['xlsx', 'json'] as const) {
      const result = validateImportPackage(
        packageOf({ snapshotAltText: 'a'.repeat(MAX + 1) }, true),
        { metadataSource },
      );
      expect(ruleCodes(result)).toContain('METADATA_SNAPSHOT_ALT_TEXT_TOO_LONG');
    }
  });

  it('treats an unspecified metadata source as legacy, preserving existing callers', () => {
    const result = validateImportPackage(packageOf({}, true));
    expect(result.valid).toBe(true);
  });
});

describe('legacy project.json snapshot alt text compatibility', () => {
  const json = (body: Record<string, unknown>) => Buffer.from(JSON.stringify({
    title: 'T', summary: 'S', year: '2026', program: 'P', discipline: 'D', groupName: 'G',
    teamMembers: ['A'], ...body,
  }));

  it('stays compatible when the field is absent', () => {
    const parsed = parseProjectDetailsJson(json({}), '2026-synthetic');
    expect(parsed.manifest.snapshotAltText).toBeUndefined();
  });

  it('persists a supplied value verbatim after trimming', () => {
    const parsed = parseProjectDetailsJson(json({ snapshotAltText: `  ${VALID_ALT}  ` }), '2026-synthetic');
    expect(parsed.manifest.snapshotAltText).toBe(VALID_ALT);
  });

  it('rejects an oversized supplied value before it can be persisted', () => {
    expect(() => parseProjectDetailsJson(json({ snapshotAltText: 'a'.repeat(MAX + 1) }), '2026-synthetic'))
      .toThrow(ProjectDetailsJsonError);
  });

  it('accepts the exact maximum', () => {
    const parsed = parseProjectDetailsJson(json({ snapshotAltText: 'a'.repeat(MAX) }), '2026-synthetic');
    expect(parsed.manifest.snapshotAltText).toHaveLength(MAX);
  });
});
