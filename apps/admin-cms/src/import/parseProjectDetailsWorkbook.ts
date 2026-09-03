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
  ColumnDefinition,
  normalizeShowcaseLayout,
  normalizeFeaturedMedia
} from './projectDetailsWorkbookContract';
import { validateParticipantContactEmail } from '../domain/participantContactEmail';
import { ACCESSIBLE_CONTENT_LIMITS } from '../domain/accessibleContent';
import {
  PROJECT_CONTROLLED_URL_MAX_LENGTH,
  validateProjectControlledUrl,
} from '../domain/projectControlledUrl';
type WorkbookInternalField =
  (typeof COLUMN_DEFINITIONS)[number]['internalField'];

interface CellExtractionResult {
  rawString: string;
  rawPrimitive: unknown;
  isFormula: boolean;
  hasUsableResult: boolean;
  colInfo?: { colNumber: number; colDef: ColumnDefinition; rawHeader: string };
}

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
  } catch {
    throw new ProjectDetailsWorkbookError(
      'The uploaded file could not be read as a valid .xlsx workbook.',
      [
        {
          code: 'WORKBOOK_MALFORMED',
          message: 'The uploaded file could not be read as a valid .xlsx workbook.',
          severity: 'error'
        }
      ]
    );
  }

  // 1. Identify non-empty worksheets
  const nonEmpWorksheets: { sheet: ExcelJS.Worksheet; name: string }[] = [];
  workbook.eachSheet(sheet => {
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
    throw new ProjectDetailsWorkbookError(
      'Workbook contains no readable worksheets or data.',
      [
        {
          code: 'WORKBOOK_NO_DATA',
          message: 'Workbook contains no readable worksheets or data.',
          severity: 'error'
        }
      ]
    );
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
      message: 'Preferred worksheet "Project details" was not found. Using default worksheet.',
      severity: 'warning'
    });
  }

  // Check for extra non-empty worksheets
  for (const sheetObj of nonEmpWorksheets) {
    if (sheetObj.sheet !== selectedSheetObj.sheet) {
      warnings.push({
        code: 'WORKBOOK_EXTRA_SHEET',
        message: 'Additional non-empty worksheet detected and ignored.',
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
    throw new ProjectDetailsWorkbookError(
      'Worksheet contains no readable rows.',
      [
        ...warnings,
        {
          code: 'WORKBOOK_NO_DATA',
          message: 'Worksheet contains no readable rows.',
          severity: 'error'
        }
      ]
    );
  }

  if (nonEmpRows.length === 1) {
    throw new ProjectDetailsWorkbookError(
      'Workbook contains a header row but no project data row.',
      [
        ...warnings,
        {
          code: 'WORKBOOK_MISSING_PROJECT_ROW',
          message: 'Workbook contains a header row but no project data row.',
          severity: 'error',
          rowNumber: nonEmpRows[0].rowNumber
        }
      ]
    );
  }

  if (nonEmpRows.length > 2) {
    throw new ProjectDetailsWorkbookError(
      'Workbook contains multiple project data rows.',
      [
        ...warnings,
        {
          code: 'WORKBOOK_MULTIPLE_PROJECT_ROWS',
          message: 'Workbook contains multiple project data rows. Each workbook must contain exactly one project row.',
          severity: 'error'
        }
      ]
    );
  }

  const headerRowObj = nonEmpRows[0];
  const projectRowObj = nonEmpRows[1];

  // 3. Process Header Row
  const columnMap = new Map<
    WorkbookInternalField,
    { colNumber: number; colDef: ColumnDefinition; rawHeader: string }
  >();
  const mappedFieldNames = new Set<string>();

  headerRowObj.row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const headerStr = stringifyValue(getPrimitiveCellValue(cell).value);
    if (!headerStr) return;

    const colDef = findColumnDefinitionForHeader(headerStr);
    if (!colDef) {
      warnings.push({
        code: 'WORKBOOK_UNKNOWN_COLUMN',
        message: 'Unknown column header ignored.',
        severity: 'warning',
        columnName: headerStr,
        rowNumber: headerRowObj.rowNumber
      });
      return;
    }

    if (mappedFieldNames.has(colDef.internalField)) {
      errors.push({
        code: 'WORKBOOK_DUPLICATE_COLUMN',
        message: 'Duplicate column header mapping detected.',
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
        message: 'Required column is missing from header.',
        severity: 'error',
        fieldName: colDef.internalField,
        rowNumber: headerRowObj.rowNumber
      });
    }
  }

  // If header has blocking errors, stop now, preserving warnings
  if (errors.length > 0) {
    throw new ProjectDetailsWorkbookError(
      'Workbook header validation failed.',
      [...warnings, ...errors]
    );
  }

  // 4. Extract Project Data Row Cells
  const extractFieldValue = (
    field: WorkbookInternalField
  ): CellExtractionResult => {
    const colInfo = columnMap.get(field);
    if (!colInfo) {
      return { rawString: '', rawPrimitive: null, isFormula: false, hasUsableResult: true };
    }

    const cell = projectRowObj.row.getCell(colInfo.colNumber);
    const prim = getPrimitiveCellValue(cell);

    return {
      rawString: stringifyValue(prim.value),
      rawPrimitive: prim.value,
      isFormula: prim.isFormula,
      hasUsableResult: prim.hasUsableResult,
      colInfo
    };
  };

  // Helper for simple text fields
  const processTextField = (
    field: keyof ProjectDetailsWorkbookMetadata,
    required: boolean
  ): string => {
    const cellExt = extractFieldValue(field);
    if (cellExt.isFormula && !cellExt.hasUsableResult) {
      if (required) {
        errors.push({
          code: 'WORKBOOK_UNUSABLE_FORMULA',
          message: 'Formula cell does not contain a usable cached result.',
          severity: 'error',
          fieldName: field,
          columnName: cellExt.colInfo?.rawHeader,
          rowNumber: projectRowObj.rowNumber
        });
      }
      return '';
    }

    if (required && !cellExt.rawString) {
      errors.push({
        code: 'WORKBOOK_MISSING_REQUIRED_VALUE',
        message: 'Required field is empty.',
        severity: 'error',
        fieldName: field,
        columnName: cellExt.colInfo?.rawHeader,
        rowNumber: projectRowObj.rowNumber
      });
    }
    return cellExt.rawString;
  };

  // Required accessible-content fields follow the same cached-formula-result and blank-value policy
  // as every other required field, and additionally reject values beyond the bounded technical
  // ceiling so an oversized cell can never be staged and then become uneditable in the CMS.
  const processBoundedAccessibleTextField = (
    field: 'posterText' | 'accessibilityText',
    maximumLength: number
  ): string => {
    const value = processTextField(field, true);
    if (value.length > maximumLength) {
      errors.push({
        code: 'WORKBOOK_VALUE_TOO_LONG',
        message: `Required field exceeds the maximum of ${maximumLength} characters.`,
        severity: 'error',
        fieldName: field,
        columnName: extractFieldValue(field).colInfo?.rawHeader,
        rowNumber: projectRowObj.rowNumber
      });
      return '';
    }
    return value;
  };

  const title = processTextField('title', true);
  const summary = processTextField('summary', true);
  const background = processTextField('background', false);
  const solution = processTextField('solution', false);
  const groupName = processTextField('groupName', true);

  // Optional participant/group contact address. Staff may leave the column blank — an ordinary
  // preview never needs one — but a value that is present and unusable is a blocking error rather
  // than something silently discarded, because a wrong address means correspondence goes nowhere or
  // to the wrong people. The raw cell value is deliberately never echoed into the issue message.
  const contactEmailRaw = processTextField('participantContactEmail', false);
  const contactEmailValidation = validateParticipantContactEmail(contactEmailRaw);
  let participantContactEmail = '';
  if (contactEmailValidation.valid) {
    participantContactEmail = contactEmailValidation.email;
  } else if (contactEmailValidation.reason === 'INVALID') {
    errors.push({
      code: 'WORKBOOK_INVALID_PARTICIPANT_CONTACT_EMAIL',
      message: 'Participant contact email is not a valid single email address.',
      severity: 'error',
      fieldName: 'participantContactEmail',
      columnName: extractFieldValue('participantContactEmail').colInfo?.rawHeader,
      rowNumber: projectRowObj.rowNumber
    });
  }

  const academicSupervisor = processTextField('academicSupervisor', false);
  const industryPartner = processTextField('industryPartner', false);
  const industry = processTextField('industry', false);
  const program = processTextField('program', true);
  const studyProgram = program;
  const discipline = processTextField('discipline', true);
  const processOptionalControlledUrl = (
    field: 'videoUrl' | 'demoUrl' | 'repositoryUrl',
  ): string => {
    const cell = extractFieldValue(field);

    if (cell.isFormula && !cell.hasUsableResult) {
      errors.push({
        code: 'WORKBOOK_UNUSABLE_FORMULA',
        message: 'Formula cell does not contain a usable cached result.',
        severity: 'error',
        fieldName: field,
        columnName: cell.colInfo?.rawHeader,
        rowNumber: projectRowObj.rowNumber,
      });
      return '';
    }

    const raw = cell.rawString;
    const validation = validateProjectControlledUrl(raw);

    if (!validation.valid && validation.reason === 'BLANK') {
      return '';
    }

    if (validation.valid) {
      return validation.url;
    }

    errors.push({
      code:
        validation.reason === 'TOO_LONG'
          ? 'WORKBOOK_VALUE_TOO_LONG'
          : 'WORKBOOK_INVALID_URL',
      message:
        validation.reason === 'TOO_LONG'
          ? `URL exceeds the maximum of ${PROJECT_CONTROLLED_URL_MAX_LENGTH} characters.`
          : 'URL must be an absolute public HTTP(S) address without embedded credentials.',
      severity: 'error',
      fieldName: field,
      columnName: cell.colInfo?.rawHeader,
      rowNumber: projectRowObj.rowNumber,
    });

    return '';
  };

  const videoUrl = processOptionalControlledUrl('videoUrl');
  const demoUrl = processOptionalControlledUrl('demoUrl');
  const repositoryUrl = processOptionalControlledUrl('repositoryUrl');

  // Required accessible poster content. Both values are staff-authored in the workbook — nothing
  // here derives, transcribes, or generates them. The only rules applied are presence after trim
  // and a transport/storage safety ceiling; the prose itself is never judged.
  const posterText = processBoundedAccessibleTextField('posterText', ACCESSIBLE_CONTENT_LIMITS.posterText);
  const accessibilityText = processBoundedAccessibleTextField(
    'accessibilityText',
    ACCESSIBLE_CONTENT_LIMITS.accessibilityText
  );

  // Snapshot image alt text. The parser cannot see the package's files, so it deliberately does not
  // decide whether a blank value is acceptable — that is the package-aware boundary's job, because
  // the value is required only when snapshot-1.png actually exists. What the parser can decide is
  // enforced here and is unconditional: a formula cell with no usable cached result is unreadable
  // rather than blank, and an oversized value is rejected instead of being silently truncated.
  const galleryAltFields = [
    { position: 1, fieldName: 'snapshotAltText' },
    { position: 2, fieldName: 'snapshot2AltText' },
    { position: 3, fieldName: 'snapshot3AltText' },
    { position: 4, fieldName: 'snapshot4AltText' },
    { position: 5, fieldName: 'snapshot5AltText' },
    { position: 6, fieldName: 'snapshot6AltText' },
    { position: 7, fieldName: 'snapshot7AltText' },
    { position: 8, fieldName: 'snapshot8AltText' },
    { position: 9, fieldName: 'snapshot9AltText' },
    { position: 10, fieldName: 'snapshot10AltText' },
  ] as const;

  let snapshotAltText = '';

  const galleryAltTexts: {
    position: number;
    altText: string;
  }[] = [];

  for (const { position, fieldName } of galleryAltFields) {
    const altCell = extractFieldValue(fieldName);

    if (altCell.isFormula && !altCell.hasUsableResult) {
      errors.push({
        code: 'WORKBOOK_UNUSABLE_FORMULA',
        message: 'Formula cell does not contain a usable cached result.',
        severity: 'error',
        fieldName,
        columnName: altCell.colInfo?.rawHeader,
        rowNumber: projectRowObj.rowNumber,
      });

      continue;
    }

    if (
      altCell.rawString.length >
      ACCESSIBLE_CONTENT_LIMITS.snapshotAltText
    ) {
      errors.push({
        code: 'WORKBOOK_VALUE_TOO_LONG',
        message: `Required field exceeds the maximum of ${ACCESSIBLE_CONTENT_LIMITS.snapshotAltText} characters.`,
        severity: 'error',
        fieldName,
        columnName: altCell.colInfo?.rawHeader,
        rowNumber: projectRowObj.rowNumber,
      });

      continue;
    }

    const altText = altCell.rawString.trim();

    if (position === 1) {
      snapshotAltText = altText;
    }

    if (altText !== '') {
      galleryAltTexts.push({
        position,
        altText,
      });
    }
  }

  // Year validation
  const yearCell = extractFieldValue('year');
  let year = '';
  if (yearCell.isFormula && !yearCell.hasUsableResult) {
    errors.push({
      code: 'WORKBOOK_UNUSABLE_FORMULA',
      message: 'Formula cell does not contain a usable cached result.',
      severity: 'error',
      fieldName: 'year',
      columnName: yearCell.colInfo?.rawHeader,
      rowNumber: projectRowObj.rowNumber
    });
  } else if (!yearCell.rawString) {
    errors.push({
      code: 'WORKBOOK_MISSING_REQUIRED_VALUE',
      message: 'Required field is empty.',
      severity: 'error',
      fieldName: 'year',
      columnName: yearCell.colInfo?.rawHeader,
      rowNumber: projectRowObj.rowNumber
    });
  } else {
    if (yearCell.rawPrimitive instanceof Date) {
      errors.push({
        code: 'WORKBOOK_INVALID_YEAR',
        message: 'Project year must be a 4-digit numeric year between 1900 and 2100.',
        severity: 'error',
        fieldName: 'year',
        columnName: yearCell.colInfo?.rawHeader,
        rowNumber: projectRowObj.rowNumber
      });
    } else {
      const yearNum = Number(yearCell.rawString);
      if (
        isNaN(yearNum) ||
        !Number.isInteger(yearNum) ||
        yearNum < 1900 ||
        yearNum > 2100 ||
        !/^\d{4}$/.test(yearCell.rawString)
      ) {
        errors.push({
          code: 'WORKBOOK_INVALID_YEAR',
          message: 'Project year must be a 4-digit numeric year between 1900 and 2100.',
          severity: 'error',
          fieldName: 'year',
          columnName: yearCell.colInfo?.rawHeader,
          rowNumber: projectRowObj.rowNumber
        });
      } else {
        year = String(yearNum);
      }
    }
  }

  // Team members validation
  const teamCell = extractFieldValue('teamMembers');
  const teamMembers: string[] = [];
  if (teamCell.isFormula && !teamCell.hasUsableResult) {
    errors.push({
      code: 'WORKBOOK_UNUSABLE_FORMULA',
      message: 'Formula cell does not contain a usable cached result.',
      severity: 'error',
      fieldName: 'teamMembers',
      columnName: teamCell.colInfo?.rawHeader,
      rowNumber: projectRowObj.rowNumber
    });
  } else if (!teamCell.rawString) {
    errors.push({
      code: 'WORKBOOK_MISSING_REQUIRED_VALUE',
      message: 'Required field is empty.',
      severity: 'error',
      fieldName: 'teamMembers',
      columnName: teamCell.colInfo?.rawHeader,
      rowNumber: projectRowObj.rowNumber
    });
  } else {
    const rawNames = teamCell.rawString
      .split(/[\r\n;,]+/)
      .map(n => n.trim())
      .filter(n => n !== '');
    const seenNames = new Set<string>();

    for (const name of rawNames) {
      const norm = name.toLowerCase();
      if (seenNames.has(norm)) {
        warnings.push({
          code: 'WORKBOOK_DUPLICATE_TEAM_MEMBER',
          message: 'A duplicate team member entry was removed.',
          severity: 'warning',
          fieldName: 'teamMembers',
          columnName: teamCell.colInfo?.rawHeader,
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
        message: 'Required field is empty.',
        severity: 'error',
        fieldName: 'teamMembers',
        columnName: teamCell.colInfo?.rawHeader,
        rowNumber: projectRowObj.rowNumber
      });
    }
  }

  // Layout Normalization (templateId)
  const layoutCell = extractFieldValue('templateId');
  let templateId: string = DEFAULT_LAYOUT_CONFIG.templateId;
  if (layoutCell.rawString) {
    const norm = normalizeShowcaseLayout(layoutCell.rawString);
    if (norm) {
      templateId = norm;
    } else {
      warnings.push({
        code: 'WORKBOOK_UNKNOWN_LAYOUT',
        message: 'Unknown showcase layout specified. Defaulting to "poster_showcase".',
        severity: 'warning',
        fieldName: 'templateId',
        columnName: layoutCell.colInfo?.rawHeader,
        rowNumber: projectRowObj.rowNumber
      });
      templateId = DEFAULT_LAYOUT_CONFIG.templateId;
    }
  }

  // Featured Media Normalization
  const mediaCell = extractFieldValue('featuredMedia');
  let featuredMedia: string = DEFAULT_LAYOUT_CONFIG.featuredMedia;
  if (mediaCell.rawString) {
    const norm = normalizeFeaturedMedia(mediaCell.rawString);
    if (norm) {
      featuredMedia = norm;
    } else {
      warnings.push({
        code: 'WORKBOOK_UNKNOWN_FEATURED_MEDIA',
        message: 'Unknown featured media option specified. Defaulting to "poster".',
        severity: 'warning',
        fieldName: 'featuredMedia',
        columnName: mediaCell.colInfo?.rawHeader,
        rowNumber: projectRowObj.rowNumber
      });
      featuredMedia = DEFAULT_LAYOUT_CONFIG.featuredMedia;
    }
  }

  // Throw if any blocking errors occurred, preserving all warnings
  if (errors.length > 0) {
    throw new ProjectDetailsWorkbookError(
      'Workbook contains validation errors.',
      [...warnings, ...errors]
    );
  }

  const metadata: ProjectDetailsWorkbookMetadata = {
    title,
    summary,
    background,
    solution,
    teamMembers,
    groupName,
    participantContactEmail,
    academicSupervisor,
    industryPartner,
    industry,
    program,
    studyProgram,
    discipline,
    year,
    videoUrl,
    demoUrl,
    repositoryUrl,
    posterText,
    accessibilityText,
    snapshotAltText,
    galleryAltTexts,
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
