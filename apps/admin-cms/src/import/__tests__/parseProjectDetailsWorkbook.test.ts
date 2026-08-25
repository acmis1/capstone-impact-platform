import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { parseProjectDetailsWorkbook } from '../parseProjectDetailsWorkbook';
import { ProjectDetailsWorkbookError, COLUMN_DEFINITIONS } from '../projectDetailsWorkbookContract';
import { buildImportPackageManifestFromWorkbook } from '../workbookManifestAdapter';
import { ACCESSIBLE_CONTENT_LIMITS } from '../../domain/accessibleContent';

async function createWorkbookBuffer(options: {
  sheetName?: string;
  extraSheets?: { name: string; rows: (string | number | boolean | null | undefined)[][] }[];
  leadingEmptyRows?: number;
  headers?: (string | number | boolean | null | undefined)[];
  dataRows?: (string | number | boolean | null | undefined | { formula: string; result?: unknown })[][];
  rawCellMutator?: (sheet: ExcelJS.Worksheet) => void;
}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const mainSheetName = options.sheetName ?? 'Project details';
  const sheet = wb.addWorksheet(mainSheetName);

  const leading = options.leadingEmptyRows ?? 0;
  for (let i = 0; i < leading; i++) {
    sheet.addRow([]);
  }

  if (options.headers) {
    sheet.addRow(options.headers);
  }

  if (options.dataRows) {
    for (const rowData of options.dataRows) {
      const row = sheet.addRow([]);
      rowData.forEach((val, idx) => {
        const cell = row.getCell(idx + 1);
        if (val && typeof val === 'object' && 'formula' in val) {
          cell.value = { formula: val.formula, result: val.result } as ExcelJS.CellValue;
        } else {
          cell.value = val as ExcelJS.CellValue;
        }
      });
    }
  }

  if (options.rawCellMutator) {
    options.rawCellMutator(sheet);
  }

  if (options.extraSheets) {
    for (const extra of options.extraSheets) {
      const eSheet = wb.addWorksheet(extra.name);
      for (const rowData of extra.rows) {
        eSheet.addRow(rowData);
      }
    }
  }

  const rawBuf = await wb.xlsx.writeBuffer();
  return Buffer.from(rawBuf);
}

describe('parseProjectDetailsWorkbook', () => {
  const defaultCanonicalHeaders = [
    'Project title',
    'Short public summary',
    'Project background',
    'Solution / impact',
    'Team members',
    'Group name',
    'Academic supervisor',
    'Industry partner',
    'Industry sector',
    'Study program',
    'Primary discipline',
    'Project year',
    'Showcase layout',
    'Main media to feature',
    'Poster full text',
    'Accessibility text'
  ];

  const defaultCanonicalData = [
    'Solar Power Optimizer',
    'AI-powered solar optimizer.',
    'High energy loss in solar grids.',
    'Smart dynamic micro-inverter controller.',
    'Alice Smith, Bob Jones',
    'Solar Team',
    'Dr. Carol Vance',
    'CleanEnergy Corp',
    'Renewable Energy',
    'Bachelor of Software Engineering',
    'Software Engineering',
    '2026',
    'Poster showcase',
    'Poster',
    'Solar Power Optimizer. Problem: high energy loss in distributed solar grids. Method: smart dynamic micro-inverter controller. Results: 12% yield improvement across six test sites.',
    'Poster shows solar inverter architecture diagram.'
  ];

  // 1. Valid workbook using canonical staff headers
  it('1. parses a valid workbook using canonical staff headers', async () => {
    const buf = await createWorkbookBuffer({
      headers: defaultCanonicalHeaders,
      dataRows: [defaultCanonicalData]
    });

    const result = await parseProjectDetailsWorkbook(buf);
    expect(result.metadata.title).toBe('Solar Power Optimizer');
    expect(result.metadata.summary).toBe('AI-powered solar optimizer.');
    expect(result.metadata.year).toBe('2026');
    expect(result.metadata.teamMembers).toEqual(['Alice Smith', 'Bob Jones']);
    expect(result.metadata.layoutConfig.templateId).toBe('poster_showcase');
    expect(result.metadata.layoutConfig.featuredMedia).toBe('poster');
    expect(result.warnings).toHaveLength(0);
  });
  it('1b. parses multiple gallery alt text columns and preserves deterministic positions', async () => {
    const headers = [
      ...defaultCanonicalHeaders,
      'Snapshot image alt text',
      'Snapshot 2 alt text',
      'Snapshot 3 alt text',
    ];

    const data = [
      ...defaultCanonicalData,
      'Overview of the project interface.',
      'Dashboard showing project results.',
      'Mobile view of the participant workflow.',
    ];

    const buf = await createWorkbookBuffer({
      headers,
      dataRows: [data],
    });

    const result = await parseProjectDetailsWorkbook(buf);

    expect(result.metadata.snapshotAltText).toBe(
      'Overview of the project interface.',
    );

    expect(result.metadata.galleryAltTexts).toEqual([
      {
        position: 1,
        altText: 'Overview of the project interface.',
      },
      {
        position: 2,
        altText: 'Dashboard showing project results.',
      },
      {
        position: 3,
        altText: 'Mobile view of the participant workflow.',
      },
    ]);

    const manifest = buildImportPackageManifestFromWorkbook({
      parsedWorkbook: result,
      publicId: '2026-gallery-test',
    });

    expect(manifest.snapshotAltText).toBe(
      'Overview of the project interface.',
    );

    expect(manifest.galleryAltTexts).toEqual([
      {
        position: 1,
        altText: 'Overview of the project interface.',
      },
      {
        position: 2,
        altText: 'Dashboard showing project results.',
      },
      {
        position: 3,
        altText: 'Mobile view of the participant workflow.',
      },
    ]);
  });

  // 2. Valid workbook using technical aliases
  it('2. parses a valid workbook using technical aliases', async () => {
    const techHeaders = [
      'title',
      'summary',
      'background',
      'solution',
      'participants',
      'groupName',
      'supervisor',
      'industryPartner',
      'industry',
      'program',
      'discipline',
      'year',
      'templateId',
      'featuredMedia',
      'poster text',
      'accessibilityText'
    ];

    const buf = await createWorkbookBuffer({
      headers: techHeaders,
      dataRows: [defaultCanonicalData]
    });

    const result = await parseProjectDetailsWorkbook(buf);
    expect(result.metadata.title).toBe('Solar Power Optimizer');
    expect(result.metadata.academicSupervisor).toBe('Dr. Carol Vance');
    expect(result.metadata.teamMembers).toEqual(['Alice Smith', 'Bob Jones']);
  });

  // 3. Columns in a different order
  it('3. handles columns in a different order', async () => {
    const unorderedHeaders = ['Project year', 'Accessibility text', 'Team members', 'Project title', 'Poster full text', 'Short public summary', 'Study program', 'Primary discipline', 'Group name'];
    const unorderedData = ['2026', 'Poster describing a data pipeline', 'Dave Min', 'Unordered Project', 'Unordered Project poster full text.', 'Summary text', 'Computer Science', 'Data Science', 'Data Squad'];

    const buf = await createWorkbookBuffer({
      headers: unorderedHeaders,
      dataRows: [unorderedData]
    });

    const result = await parseProjectDetailsWorkbook(buf);
    expect(result.metadata.title).toBe('Unordered Project');
    expect(result.metadata.year).toBe('2026');
    expect(result.metadata.teamMembers).toEqual(['Dave Min']);
  });

  // 4. Leading blank rows before the header
  it('4. ignores leading blank rows before the header', async () => {
    const buf = await createWorkbookBuffer({
      leadingEmptyRows: 3,
      headers: defaultCanonicalHeaders,
      dataRows: [defaultCanonicalData]
    });

    const result = await parseProjectDetailsWorkbook(buf);
    expect(result.source.headerRowNumber).toBe(4);
    expect(result.source.projectRowNumber).toBe(5);
    expect(result.metadata.title).toBe('Solar Power Optimizer');
  });

  // 5. Preferred "Project details" sheet
  it('5. uses the preferred "Project details" sheet', async () => {
    const buf = await createWorkbookBuffer({
      sheetName: '  Project Details  ',
      headers: defaultCanonicalHeaders,
      dataRows: [defaultCanonicalData]
    });

    const result = await parseProjectDetailsWorkbook(buf);
    expect(result.source.sheetName).toBe('  Project Details  ');
    expect(result.warnings).toHaveLength(0);
  });

  // 6. Fallback to a differently named non-empty sheet with a warning
  it('6. falls back to a differently named worksheet with a warning', async () => {
    const buf = await createWorkbookBuffer({
      sheetName: 'Sheet1',
      headers: defaultCanonicalHeaders,
      dataRows: [defaultCanonicalData]
    });

    const result = await parseProjectDetailsWorkbook(buf);
    expect(result.source.sheetName).toBe('Sheet1');
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: 'WORKBOOK_UNEXPECTED_SHEET_NAME',
        message: 'Preferred worksheet "Project details" was not found. Using default worksheet.'
      })
    );
  });

  // 7. Additional non-empty worksheets with a warning
  it('7. issues a warning for extra non-empty worksheets', async () => {
    const buf = await createWorkbookBuffer({
      sheetName: 'Project details',
      headers: defaultCanonicalHeaders,
      dataRows: [defaultCanonicalData],
      extraSheets: [{ name: 'Instructions', rows: [['Some guide text']] }]
    });

    const result = await parseProjectDetailsWorkbook(buf);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: 'WORKBOOK_EXTRA_SHEET',
        message: 'Additional non-empty worksheet detected and ignored.'
      })
    );
  });

  // 8. Missing required column
  it('8. rejects workbook missing a required column with structured details', async () => {
    const incompleteHeaders = ['Project title', 'Short public summary'];
    const incompleteData = ['Title Only', 'Summary Only'];

    const buf = await createWorkbookBuffer({
      headers: incompleteHeaders,
      dataRows: [incompleteData]
    });

    try {
      await parseProjectDetailsWorkbook(buf);
      expect.unreachable('Should have thrown ProjectDetailsWorkbookError');
    } catch (err) {
      const pErr = err as ProjectDetailsWorkbookError;
      expect(pErr.errors).toContainEqual(
        expect.objectContaining({
          code: 'WORKBOOK_MISSING_REQUIRED_COLUMN',
          fieldName: 'teamMembers'
        })
      );
    }
  });

  // 9. Duplicate canonical/alias columns mapping to the same field
  it('9. rejects duplicate columns mapping to the same field', async () => {
    const dupHeaders = ['Project title', 'title', 'Short public summary', 'Team members', 'Group name', 'Study program', 'Primary discipline', 'Project year'];
    const dupData = ['Title 1', 'Title 2', 'Summary', 'Alice', 'Group', 'Program', 'Discipline', '2026'];

    const buf = await createWorkbookBuffer({
      headers: dupHeaders,
      dataRows: [dupData]
    });

    try {
      await parseProjectDetailsWorkbook(buf);
      expect.unreachable('Should have thrown ProjectDetailsWorkbookError');
    } catch (err) {
      const pErr = err as ProjectDetailsWorkbookError;
      expect(pErr.errors).toContainEqual(
        expect.objectContaining({
          code: 'WORKBOOK_DUPLICATE_COLUMN',
          fieldName: 'title'
        })
      );
    }
  });

  // 10. Unknown column warning
  it('10. produces a warning for unknown non-empty columns without leaking content', async () => {
    const headers = [...defaultCanonicalHeaders, 'Internal ID'];
    const data = [...defaultCanonicalData, '12345'];

    const buf = await createWorkbookBuffer({
      headers,
      dataRows: [data]
    });

    const result = await parseProjectDetailsWorkbook(buf);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: 'WORKBOOK_UNKNOWN_COLUMN',
        columnName: 'Internal ID',
        message: 'Unknown column header ignored.'
      })
    );
  });

  // 11. Workbook with no worksheets or no usable worksheet
  it('11. rejects empty workbook or workbook with no usable worksheets', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('EmptySheet');
    const rawBuf = await wb.xlsx.writeBuffer();
    const buf = Buffer.from(rawBuf);

    try {
      await parseProjectDetailsWorkbook(buf);
      expect.unreachable('Should have thrown ProjectDetailsWorkbookError');
    } catch (err) {
      const pErr = err as ProjectDetailsWorkbookError;
      expect(pErr.errors).toContainEqual(
        expect.objectContaining({
          code: 'WORKBOOK_NO_DATA'
        })
      );
    }
  });

  // 12. Workbook with headers but no project-data row
  it('12. rejects workbook with header row but no project data row', async () => {
    const buf = await createWorkbookBuffer({
      headers: defaultCanonicalHeaders,
      dataRows: []
    });

    try {
      await parseProjectDetailsWorkbook(buf);
      expect.unreachable('Should have thrown ProjectDetailsWorkbookError');
    } catch (err) {
      const pErr = err as ProjectDetailsWorkbookError;
      expect(pErr.errors).toContainEqual(
        expect.objectContaining({
          code: 'WORKBOOK_MISSING_PROJECT_ROW'
        })
      );
    }
  });

  // 13. Workbook with more than one project-data row
  it('13. rejects workbook with more than one project data row', async () => {
    const buf = await createWorkbookBuffer({
      headers: defaultCanonicalHeaders,
      dataRows: [defaultCanonicalData, defaultCanonicalData]
    });

    try {
      await parseProjectDetailsWorkbook(buf);
      expect.unreachable('Should have thrown ProjectDetailsWorkbookError');
    } catch (err) {
      const pErr = err as ProjectDetailsWorkbookError;
      expect(pErr.errors).toContainEqual(
        expect.objectContaining({
          code: 'WORKBOOK_MULTIPLE_PROJECT_ROWS'
        })
      );
    }
  });

  // 14. Empty required project title
  it('14. rejects empty required project title', async () => {
    const data = [...defaultCanonicalData];
    data[0] = '   ';

    const buf = await createWorkbookBuffer({
      headers: defaultCanonicalHeaders,
      dataRows: [data]
    });

    try {
      await parseProjectDetailsWorkbook(buf);
      expect.unreachable('Should have thrown ProjectDetailsWorkbookError');
    } catch (err) {
      const pErr = err as ProjectDetailsWorkbookError;
      expect(pErr.errors).toContainEqual(
        expect.objectContaining({
          code: 'WORKBOOK_MISSING_REQUIRED_VALUE',
          fieldName: 'title'
        })
      );
    }
  });

  // 15. Empty team-members list
  it('15. rejects empty team members list with structured field error', async () => {
    const data = [...defaultCanonicalData];
    data[4] = '';

    const buf = await createWorkbookBuffer({
      headers: defaultCanonicalHeaders,
      dataRows: [data]
    });

    try {
      await parseProjectDetailsWorkbook(buf);
      expect.unreachable('Should have thrown ProjectDetailsWorkbookError');
    } catch (err) {
      const pErr = err as ProjectDetailsWorkbookError;
      expect(pErr.errors).toContainEqual(
        expect.objectContaining({
          code: 'WORKBOOK_MISSING_REQUIRED_VALUE',
          fieldName: 'teamMembers'
        })
      );
    }
  });

  // 16. Team members separated by commas
  it('16. parses team members separated by commas', async () => {
    const data = [...defaultCanonicalData];
    data[4] = 'Alice Smith, Bob Jones, Carol Danvers';

    const buf = await createWorkbookBuffer({
      headers: defaultCanonicalHeaders,
      dataRows: [data]
    });

    const result = await parseProjectDetailsWorkbook(buf);
    expect(result.metadata.teamMembers).toEqual(['Alice Smith', 'Bob Jones', 'Carol Danvers']);
  });

  // 17. Team members separated by semicolons
  it('17. parses team members separated by semicolons', async () => {
    const data = [...defaultCanonicalData];
    data[4] = 'Alice Smith; Bob Jones; Carol Danvers';

    const buf = await createWorkbookBuffer({
      headers: defaultCanonicalHeaders,
      dataRows: [data]
    });

    const result = await parseProjectDetailsWorkbook(buf);
    expect(result.metadata.teamMembers).toEqual(['Alice Smith', 'Bob Jones', 'Carol Danvers']);
  });

  // 18. Team members separated by new lines
  it('18. parses team members separated by newlines', async () => {
    const data = [...defaultCanonicalData];
    data[4] = 'Alice Smith\nBob Jones\r\nCarol Danvers';

    const buf = await createWorkbookBuffer({
      headers: defaultCanonicalHeaders,
      dataRows: [data]
    });

    const result = await parseProjectDetailsWorkbook(buf);
    expect(result.metadata.teamMembers).toEqual(['Alice Smith', 'Bob Jones', 'Carol Danvers']);
  });

  // 19. Duplicate team-member warning
  it('19. preserves first occurrence of duplicate team member name without echoing participant name', async () => {
    const data = [...defaultCanonicalData];
    data[4] = 'Alice Smith, Bob Jones, alice smith';

    const buf = await createWorkbookBuffer({
      headers: defaultCanonicalHeaders,
      dataRows: [data]
    });

    const result = await parseProjectDetailsWorkbook(buf);
    expect(result.metadata.teamMembers).toEqual(['Alice Smith', 'Bob Jones']);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: 'WORKBOOK_DUPLICATE_TEAM_MEMBER',
        message: 'A duplicate team member entry was removed.',
        fieldName: 'teamMembers'
      })
    );
    expect(result.warnings[0].message).not.toContain('Alice');
    expect(result.warnings[0].message).not.toContain('smith');
  });

  // 20. Numeric year normalized to a string
  it('20. normalizes numeric year e.g. 2026 to string "2026"', async () => {
    const data: (string | number)[] = [...defaultCanonicalData];
    data[11] = 2026;

    const buf = await createWorkbookBuffer({
      headers: defaultCanonicalHeaders,
      dataRows: [data]
    });

    const result = await parseProjectDetailsWorkbook(buf);
    expect(result.metadata.year).toBe('2026');
  });

  // 21. Text year normalized to a string
  it('21. normalizes text year "2026" to string "2026"', async () => {
    const data: (string | number)[] = [...defaultCanonicalData];
    data[11] = ' 2026 ';

    const buf = await createWorkbookBuffer({
      headers: defaultCanonicalHeaders,
      dataRows: [data]
    });

    const result = await parseProjectDetailsWorkbook(buf);
    expect(result.metadata.year).toBe('2026');
  });

  // 22. Decimal year rejected
  it('22. rejects decimal year value with structured field error', async () => {
    const data: (string | number)[] = [...defaultCanonicalData];
    data[11] = 2026.5;

    const buf = await createWorkbookBuffer({
      headers: defaultCanonicalHeaders,
      dataRows: [data]
    });

    try {
      await parseProjectDetailsWorkbook(buf);
      expect.unreachable('Should have thrown ProjectDetailsWorkbookError');
    } catch (err) {
      const pErr = err as ProjectDetailsWorkbookError;
      expect(pErr.errors).toContainEqual(
        expect.objectContaining({
          code: 'WORKBOOK_INVALID_YEAR',
          fieldName: 'year'
        })
      );
    }
  });

  // 23. Out-of-range year rejected
  it('23. rejects out of range year e.g. 1850 with structured field error', async () => {
    const data: (string | number)[] = [...defaultCanonicalData];
    data[11] = 1850;

    const buf = await createWorkbookBuffer({
      headers: defaultCanonicalHeaders,
      dataRows: [data]
    });

    try {
      await parseProjectDetailsWorkbook(buf);
      expect.unreachable('Should have thrown ProjectDetailsWorkbookError');
    } catch (err) {
      const pErr = err as ProjectDetailsWorkbookError;
      expect(pErr.errors).toContainEqual(
        expect.objectContaining({
          code: 'WORKBOOK_INVALID_YEAR',
          fieldName: 'year'
        })
      );
    }
  });

  // 24. Layout friendly aliases normalized
  it('24. normalizes showcase layout friendly aliases', async () => {
    const layouts = [
      { input: 'Poster showcase', expected: 'poster_showcase' },
      { input: 'Technical report', expected: 'technical_detail' },
      { input: 'Media-rich showcase', expected: 'media_rich' }
    ];

    for (const item of layouts) {
      const data = [...defaultCanonicalData];
      data[12] = item.input;

      const buf = await createWorkbookBuffer({
        headers: defaultCanonicalHeaders,
        dataRows: [data]
      });

      const result = await parseProjectDetailsWorkbook(buf);
      expect(result.metadata.layoutConfig.templateId).toBe(item.expected);
    }
  });

  // 25. Featured-media friendly aliases normalized
  it('25. normalizes featured media friendly aliases', async () => {
    const mediaOpts = [
      { input: 'Auto', expected: 'auto' },
      { input: 'Poster', expected: 'poster' },
      { input: 'Gallery', expected: 'snapshots' },
      { input: 'Video', expected: 'video' }
    ];

    for (const item of mediaOpts) {
      const data = [...defaultCanonicalData];
      data[13] = item.input;

      const buf = await createWorkbookBuffer({
        headers: defaultCanonicalHeaders,
        dataRows: [data]
      });

      const result = await parseProjectDetailsWorkbook(buf);
      expect(result.metadata.layoutConfig.featuredMedia).toBe(item.expected);
    }
  });

  // 26. Unknown layout fallback warning
  it('26. warns on unknown layout value without leaking cell content', async () => {
    const data = [...defaultCanonicalData];
    data[12] = 'Super Hologram Showcase';

    const buf = await createWorkbookBuffer({
      headers: defaultCanonicalHeaders,
      dataRows: [data]
    });

    const result = await parseProjectDetailsWorkbook(buf);
    expect(result.metadata.layoutConfig.templateId).toBe('poster_showcase');
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: 'WORKBOOK_UNKNOWN_LAYOUT',
        message: 'Unknown showcase layout specified. Defaulting to "poster_showcase".'
      })
    );
    expect(result.warnings[0].message).not.toContain('Hologram');
  });

  // 27. Unknown featured-media fallback warning
  it('27. warns on unknown featured media value without leaking cell content', async () => {
    const data = [...defaultCanonicalData];
    data[13] = 'VR Headset Stream';

    const buf = await createWorkbookBuffer({
      headers: defaultCanonicalHeaders,
      dataRows: [data]
    });

    const result = await parseProjectDetailsWorkbook(buf);
    expect(result.metadata.layoutConfig.featuredMedia).toBe('poster');
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: 'WORKBOOK_UNKNOWN_FEATURED_MEDIA',
        message: 'Unknown featured media option specified. Defaulting to "poster".'
      })
    );
    expect(result.warnings[0].message).not.toContain('VR');
  });

  // 28. Formula cell with a usable cached result
  it('28. accepts formula cell with a usable cached result', async () => {
    const dataWithFormula = [...defaultCanonicalData];
    (dataWithFormula as (string | number | boolean | null | undefined | { formula: string; result?: unknown })[])[0] = {
      formula: 'CONCAT("Solar ", "Power")',
      result: 'Solar Power'
    };

    const buf = await createWorkbookBuffer({
      headers: defaultCanonicalHeaders,
      dataRows: [dataWithFormula]
    });

    const result = await parseProjectDetailsWorkbook(buf);
    expect(result.metadata.title).toBe('Solar Power');
  });

  // 29. Formula cell without a usable result
  it('29. rejects required formula cell without a usable cached result with structured code', async () => {
    const dataWithUnusableFormula = [...defaultCanonicalData];
    (dataWithUnusableFormula as (string | number | boolean | null | undefined | { formula: string; result?: unknown })[])[0] = {
      formula: 'CONCAT("Solar ", "Power")',
      result: undefined
    };

    const buf = await createWorkbookBuffer({
      headers: defaultCanonicalHeaders,
      dataRows: [dataWithUnusableFormula]
    });

    try {
      await parseProjectDetailsWorkbook(buf);
      expect.unreachable('Should have thrown ProjectDetailsWorkbookError');
    } catch (err) {
      const pErr = err as ProjectDetailsWorkbookError;
      expect(pErr.errors).toContainEqual(
        expect.objectContaining({
          code: 'WORKBOOK_UNUSABLE_FORMULA',
          fieldName: 'title'
        })
      );
    }
  });

  // 30. Malformed or non-XLSX buffer
  it('30. rejects malformed buffer with safe generic message without dependency details', async () => {
    const badBuf = Buffer.from('This is totally not an excel file!');
    try {
      await parseProjectDetailsWorkbook(badBuf as unknown as Buffer);
      expect.unreachable('Should have thrown ProjectDetailsWorkbookError');
    } catch (err) {
      const pErr = err as ProjectDetailsWorkbookError;
      expect(pErr.message).toBe('The uploaded file could not be read as a valid .xlsx workbook.');
      expect(pErr.errors[0].code).toBe('WORKBOOK_MALFORMED');
      expect(pErr.errors[0].message).toBe('The uploaded file could not be read as a valid .xlsx workbook.');
    }
  });

  // 31. Adapter requires a caller-provided publicId
  it('31. adapter requires caller-provided publicId', async () => {
    const buf = await createWorkbookBuffer({
      headers: defaultCanonicalHeaders,
      dataRows: [defaultCanonicalData]
    });
    const parsed = await parseProjectDetailsWorkbook(buf);

    expect(() =>
      buildImportPackageManifestFromWorkbook({
        parsedWorkbook: parsed,
        publicId: ''
      })
    ).toThrow('publicId');
  });

  // 32. Adapter output is compatible with ImportPackageManifest
  it('32. adapter produces output matching ImportPackageManifest structure', async () => {
    const buf = await createWorkbookBuffer({
      headers: defaultCanonicalHeaders,
      dataRows: [defaultCanonicalData]
    });
    const parsed = await parseProjectDetailsWorkbook(buf);

    const manifest = buildImportPackageManifestFromWorkbook({
      parsedWorkbook: parsed,
      publicId: '2026-solar-power-optimizer',
      posterText: 'Extracted OCR Poster Text'
    });

    expect(manifest.publicId).toBe('2026-solar-power-optimizer');
    expect(manifest.title).toBe('Solar Power Optimizer');
    expect(manifest.program).toBe('Bachelor of Software Engineering');
    expect(manifest.studyProgram).toBe('Bachelor of Software Engineering');
    expect(manifest.posterText).toBe('Extracted OCR Poster Text');
    expect(manifest.layoutConfig.templateId).toBe('poster_showcase');
  });

  // 33. Deterministic pure buffer parsing test
  it('33. operates purely in-memory on buffer inputs without external dependencies', async () => {
    const buf = await createWorkbookBuffer({
      headers: defaultCanonicalHeaders,
      dataRows: [defaultCanonicalData]
    });

    const result = await parseProjectDetailsWorkbook(buf);
    expect(result.metadata.title).toBe('Solar Power Optimizer');
    expect(result.source.headerRowNumber).toBe(1);
    expect(result.source.projectRowNumber).toBe(2);
  });

  // --- NEW REVIEW REGRESSION TESTS ---

  // 34. Layout aliases with repeated internal spaces
  it('34. normalizes layout aliases with repeated internal spaces', async () => {
    const data = [...defaultCanonicalData];
    data[12] = 'POSTER   SHOWCASE';

    const buf = await createWorkbookBuffer({
      headers: defaultCanonicalHeaders,
      dataRows: [data]
    });

    const result = await parseProjectDetailsWorkbook(buf);
    expect(result.metadata.layoutConfig.templateId).toBe('poster_showcase');
  });

  // 35. Layout aliases with mixed case
  it('35. normalizes layout aliases with mixed case', async () => {
    const data = [...defaultCanonicalData];
    data[12] = 'Technical Report';

    const buf = await createWorkbookBuffer({
      headers: defaultCanonicalHeaders,
      dataRows: [data]
    });

    const result = await parseProjectDetailsWorkbook(buf);
    expect(result.metadata.layoutConfig.templateId).toBe('technical_detail');
  });

  // 36. Canonical underscore values
  it('36. accepts canonical underscore values directly', async () => {
    const canonicalValues = [
      { fieldIdx: 12, val: 'poster_showcase', field: 'templateId', expected: 'poster_showcase' },
      { fieldIdx: 12, val: 'technical_detail', field: 'templateId', expected: 'technical_detail' },
      { fieldIdx: 12, val: 'media_rich', field: 'templateId', expected: 'media_rich' },
      { fieldIdx: 13, val: 'snapshots', field: 'featuredMedia', expected: 'snapshots' }
    ];

    for (const item of canonicalValues) {
      const data = [...defaultCanonicalData];
      data[item.fieldIdx] = item.val;

      const buf = await createWorkbookBuffer({
        headers: defaultCanonicalHeaders,
        dataRows: [data]
      });

      const result = await parseProjectDetailsWorkbook(buf);
      if (item.field === 'templateId') {
        expect(result.metadata.layoutConfig.templateId).toBe(item.expected);
      } else {
        expect(result.metadata.layoutConfig.featuredMedia).toBe(item.expected);
      }
    }
  });

  // 37. Warnings preserved when blocking errors exist
  it('37. preserves warnings when blocking errors exist', async () => {
    const incompleteHeaders = ['Project title', 'Short public summary'];
    const incompleteData = ['Title', 'Summary'];

    const buf = await createWorkbookBuffer({
      sheetName: 'CustomSheetName',
      headers: incompleteHeaders,
      dataRows: [incompleteData]
    });

    try {
      await parseProjectDetailsWorkbook(buf);
      expect.unreachable('Should have thrown ProjectDetailsWorkbookError');
    } catch (err) {
      const pErr = err as ProjectDetailsWorkbookError;
      expect(pErr.warnings).toContainEqual(
        expect.objectContaining({
          code: 'WORKBOOK_UNEXPECTED_SHEET_NAME'
        })
      );
      expect(pErr.errors).toContainEqual(
        expect.objectContaining({
          code: 'WORKBOOK_MISSING_REQUIRED_COLUMN'
        })
      );
      expect(pErr.issues).toHaveLength(pErr.warnings.length + pErr.errors.length);
    }
  });

  // 38. Required unusable formula generates no duplicate missing-value issue
  it('38. required unusable formula generates WORKBOOK_UNUSABLE_FORMULA without duplicate WORKBOOK_MISSING_REQUIRED_VALUE', async () => {
    const dataWithFormula = [...defaultCanonicalData];
    (dataWithFormula as (string | number | boolean | null | undefined | { formula: string; result?: unknown })[])[0] = {
      formula: 'SUM(A1:A5)',
      result: undefined
    };

    const buf = await createWorkbookBuffer({
      headers: defaultCanonicalHeaders,
      dataRows: [dataWithFormula]
    });

    try {
      await parseProjectDetailsWorkbook(buf);
      expect.unreachable('Should have thrown ProjectDetailsWorkbookError');
    } catch (err) {
      const pErr = err as ProjectDetailsWorkbookError;
      const titleIssues = pErr.errors.filter(i => i.fieldName === 'title');
      expect(titleIssues).toHaveLength(1);
      expect(titleIssues[0].code).toBe('WORKBOOK_UNUSABLE_FORMULA');
    }
  });

  // 39. Declared technical header aliases test
  it('39. supports all declared technical header aliases', async () => {
    for (const colDef of COLUMN_DEFINITIONS) {
      for (const alias of colDef.aliases) {
        const headers = defaultCanonicalHeaders.map(h => {
          const matched = COLUMN_DEFINITIONS.find(c => c.canonicalName === h);
          if (matched && matched.internalField === colDef.internalField) {
            return alias;
          }
          return h;
        });

        const buf = await createWorkbookBuffer({
          headers,
          dataRows: [defaultCanonicalData]
        });

        const result = await parseProjectDetailsWorkbook(buf);
        expect(result.metadata).toBeDefined();
      }
    }
  });

  // 40. Adapter defensively clones nested arrays
  it('40. adapter defensively clones sectionOrder and hiddenSections nested arrays', async () => {
    const buf = await createWorkbookBuffer({
      headers: defaultCanonicalHeaders,
      dataRows: [defaultCanonicalData]
    });
    const parsed = await parseProjectDetailsWorkbook(buf);

    const manifest = buildImportPackageManifestFromWorkbook({
      parsedWorkbook: parsed,
      publicId: '2026-solar-power-optimizer'
    });

    const manifestLayout = manifest.layoutConfig as { sectionOrder: string[]; hiddenSections: string[] };

    // Mutate returned manifest arrays
    manifestLayout.sectionOrder.push('extra_section');
    manifestLayout.hiddenSections.push('hidden_test');

    // Confirm parsed metadata arrays remain unmutated
    expect(parsed.metadata.layoutConfig.sectionOrder).not.toContain('extra_section');
    expect(parsed.metadata.layoutConfig.hiddenSections).not.toContain('hidden_test');
  });

  // 41-45. Authoritative participant/group contact email column
  describe('participant contact email column', () => {
    const headersWithContact = [...defaultCanonicalHeaders, 'Participant contact email'];

    it('41. normalizes a supplied contact email to trimmed lowercase', async () => {
      const buf = await createWorkbookBuffer({
        headers: headersWithContact,
        dataRows: [[...defaultCanonicalData, '  Solar.Team@Example.INVALID  ']]
      });

      const result = await parseProjectDetailsWorkbook(buf);
      expect(result.metadata.participantContactEmail).toBe('solar.team@example.invalid');
      expect(result.warnings).toHaveLength(0);
    });

    it('42. treats an absent column and a blank cell alike, as no authoritative contact', async () => {
      const withoutColumn = await createWorkbookBuffer({
        headers: defaultCanonicalHeaders,
        dataRows: [defaultCanonicalData]
      });
      expect((await parseProjectDetailsWorkbook(withoutColumn)).metadata.participantContactEmail).toBe('');

      const blankCell = await createWorkbookBuffer({
        headers: headersWithContact,
        dataRows: [[...defaultCanonicalData, '   ']]
      });
      expect((await parseProjectDetailsWorkbook(blankCell)).metadata.participantContactEmail).toBe('');
    });

    it('43. rejects a malformed address rather than importing an unusable contact', async () => {
      const buf = await createWorkbookBuffer({
        headers: headersWithContact,
        dataRows: [[...defaultCanonicalData, 'not-an-email']]
      });

      await expect(parseProjectDetailsWorkbook(buf)).rejects.toThrow(ProjectDetailsWorkbookError);
      try {
        await parseProjectDetailsWorkbook(buf);
      } catch (err) {
        const pErr = err as ProjectDetailsWorkbookError;
        const issues = pErr.errors.filter(i => i.fieldName === 'participantContactEmail');
        expect(issues).toHaveLength(1);
        expect(issues[0].code).toBe('WORKBOOK_INVALID_PARTICIPANT_CONTACT_EMAIL');
        // The raw cell value must never be echoed back into a staff-facing issue message.
        expect(issues[0].message).not.toContain('not-an-email');
      }
    });

    it('44. rejects an address carrying a header-injection payload', async () => {
      const CRLF = String.fromCharCode(13) + String.fromCharCode(10);
      const buf = await createWorkbookBuffer({
        headers: headersWithContact,
        dataRows: [[...defaultCanonicalData, `solar@example.invalid${CRLF}Bcc: attacker@evil.test`]]
      });

      await expect(parseProjectDetailsWorkbook(buf)).rejects.toThrow(ProjectDetailsWorkbookError);
    });

    it('45. carries the normalized contact through the import manifest adapter', async () => {
      const buf = await createWorkbookBuffer({
        headers: [...defaultCanonicalHeaders, 'Group contact email'],
        dataRows: [[...defaultCanonicalData, 'Solar.Team@Example.INVALID']]
      });
      const parsed = await parseProjectDetailsWorkbook(buf);

      const manifest = buildImportPackageManifestFromWorkbook({
        parsedWorkbook: parsed,
        publicId: '2026-solar-power-optimizer'
      });

      expect(manifest.participantContactEmail).toBe('solar.team@example.invalid');
    });
  });

  /**
   * Accessible poster content. Both values are staff-authored in the workbook — the parser never
   * derives, transcribes, or generates either one, and applies no quality judgement beyond
   * presence and a bounded length.
   */
  describe('accessible poster content columns', () => {
    const headerIndex = (canonicalName: string) => defaultCanonicalHeaders.indexOf(canonicalName);
    const posterTextColumn = headerIndex('Poster full text');
    const accessibilityTextColumn = headerIndex('Accessibility text');

    const withoutColumn = (canonicalName: string) => {
      const index = headerIndex(canonicalName);
      return {
        headers: defaultCanonicalHeaders.filter((_, i) => i !== index),
        dataRows: [defaultCanonicalData.filter((_, i) => i !== index)],
      };
    };

    const withValue = (
      column: number,
      value: string | { formula: string; result?: unknown }
    ) => {
      const row: (string | { formula: string; result?: unknown })[] = [...defaultCanonicalData];
      row[column] = value;
      return { headers: defaultCanonicalHeaders, dataRows: [row] };
    };

    const errorsFor = async (buf: Buffer, fieldName: string) => {
      try {
        await parseProjectDetailsWorkbook(buf);
        throw new Error('Expected the workbook to be rejected.');
      } catch (err) {
        expect(err).toBeInstanceOf(ProjectDetailsWorkbookError);
        return (err as ProjectDetailsWorkbookError).errors.filter((i) => i.fieldName === fieldName);
      }
    };

    it('46. parses a workbook carrying both accessible content values', async () => {
      const result = await parseProjectDetailsWorkbook(
        await createWorkbookBuffer({ headers: defaultCanonicalHeaders, dataRows: [defaultCanonicalData] })
      );

      expect(result.metadata.posterText).toContain('Solar Power Optimizer. Problem:');
      expect(result.metadata.accessibilityText).toBe('Poster shows solar inverter architecture diagram.');
      expect(result.warnings).toHaveLength(0);
    });

    it('47. declares both accessible content columns required', () => {
      const posterDef = COLUMN_DEFINITIONS.find((c) => c.internalField === 'posterText');
      const accessibilityDef = COLUMN_DEFINITIONS.find((c) => c.internalField === 'accessibilityText');

      expect(posterDef?.required).toBe(true);
      expect(posterDef?.canonicalName).toBe('Poster full text');
      expect(accessibilityDef?.required).toBe(true);
      expect(accessibilityDef?.canonicalName).toBe('Accessibility text');
    });

    it('48. rejects a workbook missing the Poster full text column', async () => {
      const issues = await errorsFor(await createWorkbookBuffer(withoutColumn('Poster full text')), 'posterText');
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe('WORKBOOK_MISSING_REQUIRED_COLUMN');
    });

    it('49. rejects a workbook missing the Accessibility text column', async () => {
      const issues = await errorsFor(await createWorkbookBuffer(withoutColumn('Accessibility text')), 'accessibilityText');
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe('WORKBOOK_MISSING_REQUIRED_COLUMN');
    });

    it('50. rejects a blank Poster full text value', async () => {
      const issues = await errorsFor(await createWorkbookBuffer(withValue(posterTextColumn, '   ')), 'posterText');
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe('WORKBOOK_MISSING_REQUIRED_VALUE');
    });

    it('51. rejects a blank Accessibility text value', async () => {
      const issues = await errorsFor(await createWorkbookBuffer(withValue(accessibilityTextColumn, '')), 'accessibilityText');
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe('WORKBOOK_MISSING_REQUIRED_VALUE');
    });

    it('52. rejects a Poster full text formula with no usable cached result', async () => {
      const issues = await errorsFor(
        await createWorkbookBuffer(withValue(posterTextColumn, { formula: 'CONCAT(A1,B1)' })),
        'posterText'
      );
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe('WORKBOOK_UNUSABLE_FORMULA');
    });

    it('53. rejects an Accessibility text formula with no usable cached result', async () => {
      const issues = await errorsFor(
        await createWorkbookBuffer(withValue(accessibilityTextColumn, { formula: 'CONCAT(A1,B1)' })),
        'accessibilityText'
      );
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe('WORKBOOK_UNUSABLE_FORMULA');
    });

    it('54. accepts a formula that carries a usable cached result', async () => {
      const result = await parseProjectDetailsWorkbook(
        await createWorkbookBuffer(withValue(posterTextColumn, { formula: 'A1', result: 'Cached poster full text.' }))
      );
      expect(result.metadata.posterText).toBe('Cached poster full text.');
    });

    it('55. rejects accessible content beyond the bounded technical ceiling', async () => {
      const posterIssues = await errorsFor(
        await createWorkbookBuffer(withValue(posterTextColumn, 'x'.repeat(ACCESSIBLE_CONTENT_LIMITS.posterText + 1))),
        'posterText'
      );
      expect(posterIssues[0].code).toBe('WORKBOOK_VALUE_TOO_LONG');

      const accessibilityIssues = await errorsFor(
        await createWorkbookBuffer(
          withValue(accessibilityTextColumn, 'x'.repeat(ACCESSIBLE_CONTENT_LIMITS.accessibilityText + 1))
        ),
        'accessibilityText'
      );
      expect(accessibilityIssues[0].code).toBe('WORKBOOK_VALUE_TOO_LONG');
    });

    it('56. accepts accessible content exactly at the bounded ceiling', async () => {
      const atLimit = 'x'.repeat(ACCESSIBLE_CONTENT_LIMITS.posterText);
      const result = await parseProjectDetailsWorkbook(
        await createWorkbookBuffer(withValue(posterTextColumn, atLimit))
      );
      expect(result.metadata.posterText).toHaveLength(ACCESSIBLE_CONTENT_LIMITS.posterText);
    });

    it('57. trims outer whitespace without altering inner content', async () => {
      const result = await parseProjectDetailsWorkbook(
        await createWorkbookBuffer(withValue(posterTextColumn, '  Heading.  Body   with   inner   spacing.  '))
      );
      expect(result.metadata.posterText).toBe('Heading.  Body   with   inner   spacing.');
    });

    it('58. preserves multiline poster full text exactly', async () => {
      const multiline = 'Aim\nInvestigate turbine spacing.\n\nMethod\nCFD simulation across six layouts.';
      const result = await parseProjectDetailsWorkbook(
        await createWorkbookBuffer(withValue(posterTextColumn, multiline))
      );
      expect(result.metadata.posterText).toBe(multiline);
    });

    it('59. preserves multiline accessibility text exactly', async () => {
      const multiline = 'Research poster.\nLeft column: three diagrams.\nRight column: results table.';
      const result = await parseProjectDetailsWorkbook(
        await createWorkbookBuffer(withValue(accessibilityTextColumn, multiline))
      );
      expect(result.metadata.accessibilityText).toBe(multiline);
    });

    it('60. rejects a duplicate Poster full text alias header', async () => {
      const issues = await errorsFor(
        await createWorkbookBuffer({
          headers: [...defaultCanonicalHeaders, 'poster text'],
          dataRows: [[...defaultCanonicalData, 'Duplicate mapping']],
        }),
        'posterText'
      );
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe('WORKBOOK_DUPLICATE_COLUMN');
    });

    it('61. rejects a duplicate Accessibility text alias header', async () => {
      const issues = await errorsFor(
        await createWorkbookBuffer({
          headers: [...defaultCanonicalHeaders, 'accessibilitytext'],
          dataRows: [[...defaultCanonicalData, 'Duplicate mapping']],
        }),
        'accessibilityText'
      );
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe('WORKBOOK_DUPLICATE_COLUMN');
    });

    it('62. carries both accessible content values through the manifest adapter', async () => {
      const parsed = await parseProjectDetailsWorkbook(
        await createWorkbookBuffer({ headers: defaultCanonicalHeaders, dataRows: [defaultCanonicalData] })
      );

      const manifest = buildImportPackageManifestFromWorkbook({
        parsedWorkbook: parsed,
        publicId: '2026-solar-power-optimizer',
      });

      expect(manifest.posterText).toBe(parsed.metadata.posterText);
      expect(manifest.accessibilityText).toBe(parsed.metadata.accessibilityText);
    });

    it('63. leaves every other required field behaving exactly as before', async () => {
      const issues = await errorsFor(await createWorkbookBuffer(withValue(headerIndex('Project title'), '')), 'title');
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe('WORKBOOK_MISSING_REQUIRED_VALUE');
    });
  });
});
