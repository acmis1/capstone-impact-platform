import ExcelJS from 'exceljs';
import {
  ProjectDetailsWorkbookParseResult,
  ProjectDetailsWorkbookMetadata,
  ProjectDetailsWorkbookIssue,
  ProjectDetailsWorkbookError,
  PREFERRED_WORKSHEET_NAME,
  DEFAULT_LAYOUT_CONFIG,
  COLUMN_DEFINITIONS,
  findColumnDefinitionForHeader,
  ColumnDefinition
} from './projectDetailsWorkbookContract';

function getPrimitiveCellValue(cell: ExcelJS.Cell): { value: unknown; isFormula: boolean; hasUsableResult: boolean } {
  const val = cell.value;
  if (val === null || val === undefined) {
    return { value: '', isFormula: false, hasUsableResult: true };
  }

  if (typeof val === 'object') {
    // Check if formula object
    if ('formula' in val || 'result' in val) {
      const formulaObj = val as { formula?: string; result?: unknown };
      const res = formulaObj.result;
      if (res !== undefined && res !== null && typeof res !== 'object') {
        return { value: res, isFormula: true, hasUsableResult: true };
      }
      return { value: '', isFormula: true, hasUsableResult: false };
    }

    // Check if richText object
    if ('richText' in val && Array.isArray((val as { richText: Array<{ text: string }> }).richText)) {
      const richObj = val as { richText: Array<{ text: string }> };
      const text = richObj.richText.map(t => t.text).join('');
      return { value: text, isFormula: false, hasUsableResult: true };
    }

    // Check if hyperlink object
    if ('text' in val && typeof (val as { text: unknown }).text === 'string') {
      return { value: (val as { text: string }).text, isFormula: false, hasUsableResult: true };
    }

    // Check if Date object
    if (val instanceof Date) {
      return { value: val, isFormula: false, hasUsableResult: true };
    }

    return { value: '', isFormula: false, hasUsableResult: false };
  }

  return { value: val, isFormula: false, hasUsableResult: true };
}

function stringifyValue(val: unknown): string {
  if (val === null || val === undefined) return '';
  if (typeof val === 'string') return val.trim();
  if (typeof val === 'number' || typeof val === 'boolean') return String(val).trim();
  if (val instanceof Date) return val.toISOString();
  return String(val).trim();
}

export async function parseProjectDetailsWorkbook(
  input: Buffer | Uint8Array
): Promise<ProjectDetailsWorkbookParseResult> {
  const errors: ProjectDetailsWorkbookIssue[] = [];
  const warnings: ProjectDetailsWorkbookIssue[] = [];

  let workbook: ExcelJS.Workbook;
  try {
    workbook = new ExcelJS.Workbook();
    const bufferInput = Buffer.isBuffer(input) ? input : Buffer.from(input);
    await workbook.xlsx.load(bufferInput as unknown as Parameters<ExcelJS.Workbook['xlsx']['load']>[0]);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Invalid or corrupt Excel file';
    throw new ProjectDetailsWorkbookError(`Failed to load Excel workbook: ${msg}`, [
      {
        code: 'WORKBOOK_MALFORMED',
        message: `Failed to load Excel workbook: ${msg}`,
        severity: 'error'
      }
    ]);
  }

  // 1. Identify non-empty worksheets
  const nonEmpWorksheets: { sheet: ExcelJS.Worksheet; name: string }[] = [];
  workbook.eachSheet(sheet => {
    // Verify sheet has at least one cell with content
    let hasContent = false;
    sheet.eachRow({ includeEmpty: false }, row => {
      row.eachCell({ includeEmpty: false }, cell => {
        const primitive = getPrimitiveCellValue(cell);
        if (stringifyValue(primitive.value) !== '') {
          hasContent = true;
        }
      });
    });

    if (hasContent) {
      nonEmpWorksheets.push({ sheet, name: sheet.name.trim() });
    }
  });

  if (nonEmpWorksheets.length === 0) {
    throw new ProjectDetailsWorkbookError('Workbook contains no readable worksheets or data.', [
      {
        code: 'WORKBOOK_NO_DATA',
        message: 'Workbook contains no readable worksheets or data.',
        severity: 'error'
      }
    ]);
  }

  // Preferred worksheet selection
  const prefNormalized = PREFERRED_WORKSHEET_NAME.trim().toLowerCase();
  let selectedSheetObj = nonEmpWorksheets.find(
    s => s.name.toLowerCase() === prefNormalized
  );

  let usedSheetName = '';
  if (selectedSheetObj) {
    usedSheetName = selectedSheetObj.sheet.name;
  } else {
    selectedSheetObj = nonEmpWorksheets[0];
    usedSheetName = selectedSheetObj.sheet.name;
    warnings.push({
      code: 'WORKBOOK_UNEXPECTED_SHEET_NAME',
      message: `Preferred worksheet "${PREFERRED_WORKSHEET_NAME}" was not found. Using worksheet "${usedSheetName}".`,
      severity: 'warning'
    });
  }

  // Check for extra non-empty worksheets
  for (const sheetObj of nonEmpWorksheets) {
    if (sheetObj.sheet !== selectedSheetObj.sheet) {
      warnings.push({
        code: 'WORKBOOK_EXTRA_SHEET',
        message: `Additional worksheet "${sheetObj.sheet.name}" found. Extra worksheets are ignored for project metadata.`,
        severity: 'warning'
      });
    }
  }

  const targetSheet = selectedSheetObj.sheet;

  // 2. Identify Header Row and Project Row
  const nonEmpRows: { rowNumber: number; row: ExcelJS.Row }[] = [];
  targetSheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    let rowHasContent = false;
    row.eachCell({ includeEmpty: false }, cell => {
      const primitive = getPrimitiveCellValue(cell);
      if (stringifyValue(primitive.value) !== '') {
        rowHasContent = true;
      }
    });

    if (rowHasContent) {
      nonEmpRows.push({ rowNumber, row });
    }
  });

  if (nonEmpRows.length === 0) {
    throw new ProjectDetailsWorkbookError('Worksheet contains no readable rows.', [
      {
        code: 'WORKBOOK_NO_DATA',
        message: 'Worksheet contains no readable rows.',
        severity: 'error'
      }
    ]);
  }

  if (nonEmpRows.length === 1) {
    throw new ProjectDetailsWorkbookError('Workbook does not contain a valid project data row.', [
      {
        code: 'WORKBOOK_MISSING_PROJECT_ROW',
        message: 'Workbook contains a header row but no project data row.',
        severity: 'error',
        rowNumber: nonEmpRows[0].rowNumber
      }
    ]);
  }

  if (nonEmpRows.length > 2) {
    throw new ProjectDetailsWorkbookError('Workbook contains multiple project data rows.', [
      {
        code: 'WORKBOOK_MULTIPLE_PROJECT_ROWS',
        message: 'Workbook contains multiple project data rows. Each workbook must contain exactly one project row.',
        severity: 'error'
      }
    ]);
  }

  const headerRowObj = nonEmpRows[0];
  const projectRowObj = nonEmpRows[1];

  // 3. Process Header Row
  const columnMap = new Map<keyof ProjectDetailsWorkbookMetadata | 'templateId' | 'featuredMedia', { colNumber: number; colDef: ColumnDefinition; rawHeader: string }>();
  const mappedFieldNames = new Set<string>();

  headerRowObj.row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const headerStr = stringifyValue(getPrimitiveCellValue(cell).value);
    if (!headerStr) return;

    const colDef = findColumnDefinitionForHeader(headerStr);
    if (!colDef) {
      warnings.push({
        code: 'WORKBOOK_UNKNOWN_COLUMN',
        message: `Unknown column "${headerStr}" ignored.`,
        severity: 'warning',
        columnName: headerStr,
        rowNumber: headerRowObj.rowNumber
      });
      return;
    }

    if (mappedFieldNames.has(colDef.internalField)) {
      errors.push({
        code: 'WORKBOOK_DUPLICATE_COLUMN',
        message: `Duplicate column mapping detected for field "${colDef.internalField}". Column "${headerStr}" maps to the same field as an earlier column.`,
        severity: 'error',
        columnName: headerStr,
        fieldName: colDef.internalField,
        rowNumber: headerRowObj.rowNumber
      });
      return;
    }

    mappedFieldNames.add(colDef.internalField);
    columnMap.set(colDef.internalField, { colNumber, colDef, rawHeader: headerStr });
  });

  // Check required columns present in header
  for (const colDef of COLUMN_DEFINITIONS) {
    if (colDef.required && !columnMap.has(colDef.internalField)) {
      errors.push({
        code: 'WORKBOOK_MISSING_REQUIRED_COLUMN',
        message: `Required column "${colDef.canonicalName}" is missing from header.`,
        severity: 'error',
        fieldName: colDef.internalField,
        rowNumber: headerRowObj.rowNumber
      });
    }
  }

  // If header has blocking errors, stop now
  if (errors.length > 0) {
    throw new ProjectDetailsWorkbookError('Workbook header validation failed.', errors);
  }

  // 4. Extract Project Data Row Cells
  const extractFieldValue = (field: keyof ProjectDetailsWorkbookMetadata | 'templateId' | 'featuredMedia'): { rawString: string; rawPrimitive: unknown; colInfo?: { colNumber: number; colDef: ColumnDefinition; rawHeader: string } } => {
    const colInfo = columnMap.get(field);
    if (!colInfo) {
      return { rawString: '', rawPrimitive: null };
    }

    const cell = projectRowObj.row.getCell(colInfo.colNumber);
    const prim = getPrimitiveCellValue(cell);

    if (prim.isFormula && !prim.hasUsableResult) {
      // Check if this field is required or used
      if (colInfo.colDef.required) {
        errors.push({
          code: 'WORKBOOK_UNUSABLE_FORMULA',
          message: `Formula cell in column "${colInfo.rawHeader}" does not contain a usable cached result.`,
          severity: 'error',
          fieldName: field,
          columnName: colInfo.rawHeader,
          rowNumber: projectRowObj.rowNumber
        });
      }
    }

    const str = stringifyValue(prim.value);
    return { rawString: str, rawPrimitive: prim.value, colInfo };
  };

  // Helper for simple text fields
  const processTextField = (field: keyof ProjectDetailsWorkbookMetadata, required: boolean): string => {
    const { rawString, colInfo } = extractFieldValue(field);
    if (required && !rawString) {
      errors.push({
        code: 'WORKBOOK_MISSING_REQUIRED_VALUE',
        message: `Required field "${colInfo?.colDef.canonicalName || field}" is empty.`,
        severity: 'error',
        fieldName: field,
        columnName: colInfo?.rawHeader,
        rowNumber: projectRowObj.rowNumber
      });
    }
    return rawString;
  };

  const title = processTextField('title', true);
  const summary = processTextField('summary', true);
  const background = processTextField('background', false);
  const solution = processTextField('solution', false);
  const groupName = processTextField('groupName', true);
  const academicSupervisor = processTextField('academicSupervisor', false);
  const industryPartner = processTextField('industryPartner', false);
  const industry = processTextField('industry', false);
  const program = processTextField('program', true);
  const studyProgram = program; // Always set to match program
  const discipline = processTextField('discipline', true);
  const accessibilityText = processTextField('accessibilityText', false);

  // Year validation
  const { rawString: rawYearStr, rawPrimitive: rawYearPrim, colInfo: yearColInfo } = extractFieldValue('year');
  let year = '';
  if (!rawYearStr) {
    errors.push({
      code: 'WORKBOOK_MISSING_REQUIRED_VALUE',
      message: 'Required field "Project year" is empty.',
      severity: 'error',
      fieldName: 'year',
      columnName: yearColInfo?.rawHeader,
      rowNumber: projectRowObj.rowNumber
    });
  } else {
    // Check if raw year is date
    if (rawYearPrim instanceof Date) {
      errors.push({
        code: 'WORKBOOK_INVALID_YEAR',
        message: `Field "${yearColInfo?.rawHeader || 'Project year'}" value is a Date object, expected a 4-digit numeric year.`,
        severity: 'error',
        fieldName: 'year',
        columnName: yearColInfo?.rawHeader,
        rowNumber: projectRowObj.rowNumber
      });
    } else {
      const yearNum = Number(rawYearStr);
      if (
        isNaN(yearNum) ||
        !Number.isInteger(yearNum) ||
        yearNum < 1900 ||
        yearNum > 2100 ||
        !/^\d{4}$/.test(rawYearStr)
      ) {
        errors.push({
          code: 'WORKBOOK_INVALID_YEAR',
          message: `Field "${yearColInfo?.rawHeader || 'Project year'}" must be a 4-digit numeric year between 1900 and 2100.`,
          severity: 'error',
          fieldName: 'year',
          columnName: yearColInfo?.rawHeader,
          rowNumber: projectRowObj.rowNumber
        });
      } else {
        year = String(yearNum);
      }
    }
  }

  // Team members validation
  const { rawString: rawTeamStr, colInfo: teamColInfo } = extractFieldValue('teamMembers');
  const teamMembers: string[] = [];
  if (!rawTeamStr) {
    errors.push({
      code: 'WORKBOOK_MISSING_REQUIRED_VALUE',
      message: 'Required field "Team members" is empty.',
      severity: 'error',
      fieldName: 'teamMembers',
      columnName: teamColInfo?.rawHeader,
      rowNumber: projectRowObj.rowNumber
    });
  } else {
    // Split by newline, semicolon, comma
    const rawNames = rawTeamStr.split(/[\r\n;,]+/).map(n => n.trim()).filter(n => n !== '');
    const seenNames = new Set<string>();

    for (const name of rawNames) {
      const norm = name.toLowerCase();
      if (seenNames.has(norm)) {
        warnings.push({
          code: 'WORKBOOK_DUPLICATE_TEAM_MEMBER',
          message: `Duplicate team member name "${name}" ignored.`,
          severity: 'warning',
          fieldName: 'teamMembers',
          columnName: teamColInfo?.rawHeader,
          rowNumber: projectRowObj.rowNumber
        });
      } else {
        seenNames.add(norm);
        teamMembers.push(name);
      }
    }

    if (teamMembers.length === 0) {
      errors.push({
        code: 'WORKBOOK_MISSING_REQUIRED_VALUE',
        message: 'Required field "Team members" contains no valid member names.',
        severity: 'error',
        fieldName: 'teamMembers',
        columnName: teamColInfo?.rawHeader,
        rowNumber: projectRowObj.rowNumber
      });
    }
  }

  // Layout Normalization (templateId)
  const { rawString: rawLayoutStr, colInfo: layoutColInfo } = extractFieldValue('templateId');
  let templateId: string = DEFAULT_LAYOUT_CONFIG.templateId;
  if (rawLayoutStr) {
    const norm = rawLayoutStr.toLowerCase().replace(/[-_]/g, ' ');
    if (norm === 'poster showcase' || norm === 'poster first showcase' || norm === 'poster' || norm === 'poster showcase') {
      templateId = 'poster_showcase';
    } else if (norm === 'technical report' || norm === 'report first layout' || norm === 'technical detail' || norm === 'technical detail') {
      templateId = 'technical_detail';
    } else if (norm === 'media rich showcase' || norm === 'media rich' || norm === 'video and gallery showcase' || norm === 'media rich') {
      templateId = 'media_rich';
    } else {
      warnings.push({
        code: 'WORKBOOK_UNKNOWN_LAYOUT',
        message: `Unknown showcase layout "${rawLayoutStr}". Defaulting to "poster_showcase".`,
        severity: 'warning',
        fieldName: 'templateId',
        columnName: layoutColInfo?.rawHeader,
        rowNumber: projectRowObj.rowNumber
      });
      templateId = 'poster_showcase';
    }
  }

  // Featured Media Normalization
  const { rawString: rawMediaStr, colInfo: mediaColInfo } = extractFieldValue('featuredMedia');
  let featuredMedia: string = DEFAULT_LAYOUT_CONFIG.featuredMedia;
  if (rawMediaStr) {
    const norm = rawMediaStr.toLowerCase();
    if (norm === 'auto') {
      featuredMedia = 'auto';
    } else if (norm === 'poster') {
      featuredMedia = 'poster';
    } else if (norm === 'gallery' || norm === 'snapshots') {
      featuredMedia = 'snapshots';
    } else if (norm === 'video') {
      featuredMedia = 'video';
    } else {
      warnings.push({
        code: 'WORKBOOK_UNKNOWN_FEATURED_MEDIA',
        message: `Unknown featured media option "${rawMediaStr}". Defaulting to "poster".`,
        severity: 'warning',
        fieldName: 'featuredMedia',
        columnName: mediaColInfo?.rawHeader,
        rowNumber: projectRowObj.rowNumber
      });
      featuredMedia = 'poster';
    }
  }

  // Throw if any blocking errors occurred
  if (errors.length > 0) {
    throw new ProjectDetailsWorkbookError('Workbook contains validation errors.', errors);
  }

  const metadata: ProjectDetailsWorkbookMetadata = {
    title,
    summary,
    background,
    solution,
    teamMembers,
    groupName,
    academicSupervisor,
    industryPartner,
    industry,
    program,
    studyProgram,
    discipline,
    year,
    accessibilityText,
    layoutConfig: {
      templateId,
      featuredMedia,
      sectionOrder: [...DEFAULT_LAYOUT_CONFIG.sectionOrder],
      hiddenSections: [...DEFAULT_LAYOUT_CONFIG.hiddenSections]
    }
  };

  return {
    metadata,
    warnings,
    source: {
      sheetName: usedSheetName,
      headerRowNumber: headerRowObj.rowNumber,
      projectRowNumber: projectRowObj.rowNumber
    }
  };
}
