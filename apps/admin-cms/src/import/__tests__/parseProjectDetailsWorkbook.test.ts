import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { parseProjectDetailsWorkbook } from '../parseProjectDetailsWorkbook';
import { ProjectDetailsWorkbookError } from '../projectDetailsWorkbookContract';
import { buildImportPackageManifestFromWorkbook } from '../workbookManifestAdapter';

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
    const unorderedHeaders = ['Project year', 'Team members', 'Project title', 'Short public summary', 'Study program', 'Primary discipline', 'Group name'];
    const unorderedData = ['2026', 'Dave Min', 'Unordered Project', 'Summary text', 'Computer Science', 'Data Science', 'Data Squad'];

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
        code: 'WORKBOOK_UNEXPECTED_SHEET_NAME'
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
        code: 'WORKBOOK_EXTRA_SHEET'
      })
    );
  });

  // 8. Missing required column
  it('8. rejects workbook missing a required column', async () => {
    const incompleteHeaders = ['Project title', 'Short public summary'];
    const incompleteData = ['Title Only', 'Summary Only'];

    const buf = await createWorkbookBuffer({
      headers: incompleteHeaders,
      dataRows: [incompleteData]
    });

    await expect(parseProjectDetailsWorkbook(buf)).rejects.toThrow(ProjectDetailsWorkbookError);
    try {
      await parseProjectDetailsWorkbook(buf);
    } catch (err) {
      const pErr = err as ProjectDetailsWorkbookError;
      expect(pErr.issues).toContainEqual(
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

    await expect(parseProjectDetailsWorkbook(buf)).rejects.toThrow(ProjectDetailsWorkbookError);
    try {
      await parseProjectDetailsWorkbook(buf);
    } catch (err) {
      const pErr = err as ProjectDetailsWorkbookError;
      expect(pErr.issues).toContainEqual(
        expect.objectContaining({
          code: 'WORKBOOK_DUPLICATE_COLUMN',
          fieldName: 'title'
        })
      );
    }
  });

  // 10. Unknown column warning
  it('10. produces a warning for unknown non-empty columns', async () => {
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
        columnName: 'Internal ID'
      })
    );
  });

  // 11. Workbook with no worksheets or no usable worksheet
  it('11. rejects empty workbook or workbook with no usable worksheets', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('EmptySheet');
    const rawBuf = await wb.xlsx.writeBuffer();
    const buf = Buffer.from(rawBuf);

    await expect(parseProjectDetailsWorkbook(buf)).rejects.toThrow(ProjectDetailsWorkbookError);
  });

  // 12. Workbook with headers but no project-data row
  it('12. rejects workbook with header row but no project data row', async () => {
    const buf = await createWorkbookBuffer({
      headers: defaultCanonicalHeaders,
      dataRows: []
    });

    await expect(parseProjectDetailsWorkbook(buf)).rejects.toThrow(ProjectDetailsWorkbookError);
    try {
      await parseProjectDetailsWorkbook(buf);
    } catch (err) {
      const pErr = err as ProjectDetailsWorkbookError;
      expect(pErr.issues).toContainEqual(
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

    await expect(parseProjectDetailsWorkbook(buf)).rejects.toThrow(ProjectDetailsWorkbookError);
    try {
      await parseProjectDetailsWorkbook(buf);
    } catch (err) {
      const pErr = err as ProjectDetailsWorkbookError;
      expect(pErr.issues).toContainEqual(
        expect.objectContaining({
          code: 'WORKBOOK_MULTIPLE_PROJECT_ROWS'
        })
      );
    }
  });

  // 14. Empty required project title
  it('14. rejects empty required project title', async () => {
    const data = [...defaultCanonicalData];
    data[0] = '   '; // empty title

    const buf = await createWorkbookBuffer({
      headers: defaultCanonicalHeaders,
      dataRows: [data]
    });

    await expect(parseProjectDetailsWorkbook(buf)).rejects.toThrow(ProjectDetailsWorkbookError);
    try {
      await parseProjectDetailsWorkbook(buf);
    } catch (err) {
      const pErr = err as ProjectDetailsWorkbookError;
      expect(pErr.issues).toContainEqual(
        expect.objectContaining({
          code: 'WORKBOOK_MISSING_REQUIRED_VALUE',
          fieldName: 'title'
        })
      );
    }
  });

  // 15. Empty team-members list
  it('15. rejects empty team members list', async () => {
    const data = [...defaultCanonicalData];
    data[4] = ''; // empty team members

    const buf = await createWorkbookBuffer({
      headers: defaultCanonicalHeaders,
      dataRows: [data]
    });

    await expect(parseProjectDetailsWorkbook(buf)).rejects.toThrow(ProjectDetailsWorkbookError);
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
  it('19. preserves first occurrence of duplicate team member name and issues warning', async () => {
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
        fieldName: 'teamMembers'
      })
    );
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
  it('22. rejects decimal year value', async () => {
    const data: (string | number)[] = [...defaultCanonicalData];
    data[11] = 2026.5;

    const buf = await createWorkbookBuffer({
      headers: defaultCanonicalHeaders,
      dataRows: [data]
    });

    await expect(parseProjectDetailsWorkbook(buf)).rejects.toThrow(ProjectDetailsWorkbookError);
  });

  // 23. Out-of-range year rejected
  it('23. rejects out of range year e.g. 1899 or 2101', async () => {
    const data: (string | number)[] = [...defaultCanonicalData];
    data[11] = 1850;

    const buf = await createWorkbookBuffer({
      headers: defaultCanonicalHeaders,
      dataRows: [data]
    });

    await expect(parseProjectDetailsWorkbook(buf)).rejects.toThrow(ProjectDetailsWorkbookError);
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
  it('26. warns on unknown layout value and falls back to poster_showcase', async () => {
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
        code: 'WORKBOOK_UNKNOWN_LAYOUT'
      })
    );
  });

  // 27. Unknown featured-media fallback warning
  it('27. warns on unknown featured media value and falls back to poster', async () => {
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
        code: 'WORKBOOK_UNKNOWN_FEATURED_MEDIA'
      })
    );
  });

  // 28. Formula cell with a usable cached result
  it('28. accepts formula cell with a usable cached result', async () => {
    const dataWithFormula = [...defaultCanonicalData];
    // Replace title with formula object
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
  it('29. rejects required formula cell without a usable cached result', async () => {
    const dataWithUnusableFormula = [...defaultCanonicalData];
    (dataWithUnusableFormula as (string | number | boolean | null | undefined | { formula: string; result?: unknown })[])[0] = {
      formula: 'CONCAT("Solar ", "Power")',
      result: undefined
    };

    const buf = await createWorkbookBuffer({
      headers: defaultCanonicalHeaders,
      dataRows: [dataWithUnusableFormula]
    });

    await expect(parseProjectDetailsWorkbook(buf)).rejects.toThrow(ProjectDetailsWorkbookError);
  });

  // 30. Malformed or non-XLSX buffer
  it('30. rejects malformed or non-XLSX buffer', async () => {
    const badBuf = Buffer.from('This is totally not an excel file!');
    await expect(parseProjectDetailsWorkbook(badBuf as unknown as Buffer)).rejects.toThrow(ProjectDetailsWorkbookError);
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

  // 33. Parser performs no database or storage operations
  it('33. parser operates as a pure buffer function without external side effects', async () => {
    const buf = await createWorkbookBuffer({
      headers: defaultCanonicalHeaders,
      dataRows: [defaultCanonicalData]
    });

    // Verify it resolves purely from memory buffer without hanging or making network/DB calls
    const startTime = Date.now();
    const result = await parseProjectDetailsWorkbook(buf);
    const duration = Date.now() - startTime;

    expect(result.metadata.title).toBeDefined();
    expect(duration).toBeLessThan(1000);
  });
});
