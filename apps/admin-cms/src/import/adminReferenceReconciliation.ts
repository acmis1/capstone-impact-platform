import { createHash } from 'crypto';
import ExcelJS from 'exceljs';
import { normalizeParticipantContactEmail } from '../domain/participantContactEmail';
import type { BrowserImportIssue } from './browserImportPreviewContract';
import type { AdminReferenceIntent } from './browserImportCommitIntentContract';
import {
  ADMIN_REFERENCE_LIMITS,
  CANONICAL_MATCHABLE_FIELDS,
  CanonicalMatchableField,
  CANONICAL_COMPARABLE_FIELDS,
  CanonicalComparableField,
  adminReferenceFieldMappingSchema,
  AdminReferenceFieldMapping,
  adminReferenceMappingConfigSchema,
  AdminReferenceMappingConfig,
  WorksheetStructureSummary,
  AdminReferenceInspectionResult,
  AdminReferenceReconciliationStatus,
  AdminReferencePackageResult,
  AdminReferenceReconciliationBatchResult,
} from './adminReferenceSharedContract';

export * from './adminReferenceSharedContract';

export function computeAdminReferenceWorkbookFingerprint(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export function canonicalizeAdminReferenceMapping(
  mapping: AdminReferenceMappingConfig,
  availableHeaders?: string[]
): AdminReferenceMappingConfig {
  const normMap = new Map<string, string>();
  if (availableHeaders) {
    for (const h of availableHeaders) {
      normMap.set(h.trim().toLowerCase().replace(/\s+/g, ' '), h);
    }
  }

  const resolveCol = (col: string) => {
    const norm = col.trim().toLowerCase().replace(/\s+/g, ' ');
    return normMap.get(norm) || col.trim();
  };

  const sortedMatch = [...mapping.matchMappings]
    .map((m) => ({
      canonicalField: m.canonicalField.trim(),
      referenceColumn: resolveCol(m.referenceColumn),
    }))
    .sort((a, b) => a.canonicalField.localeCompare(b.canonicalField));

  const sortedComp = [...mapping.comparisonMappings]
    .map((m) => ({
      canonicalField: m.canonicalField.trim(),
      referenceColumn: resolveCol(m.referenceColumn),
    }))
    .sort((a, b) => a.canonicalField.localeCompare(b.canonicalField));

  return {
    worksheet: mapping.worksheet.trim(),
    matchMappings: sortedMatch,
    comparisonMappings: sortedComp,
    reconciliationContractVersion: 'admin-reference-reconciliation-v1',
  };
}

export function canonicalizeAdminReferenceIntent(intent: AdminReferenceIntent): AdminReferenceIntent {
  return {
    workbookFingerprint: intent.workbookFingerprint,
    ...canonicalizeAdminReferenceMapping({
      worksheet: intent.worksheet,
      matchMappings: intent.matchMappings,
      comparisonMappings: intent.comparisonMappings,
      reconciliationContractVersion: intent.reconciliationContractVersion,
    }),
  };
}

export function adminReferenceIntentsSemanticallyEqual(
  left: AdminReferenceIntent,
  right: AdminReferenceIntent
): boolean {
  return JSON.stringify(canonicalizeAdminReferenceIntent(left)) ===
    JSON.stringify(canonicalizeAdminReferenceIntent(right));
}

function extractCellText(cell: ExcelJS.Cell): string {
  const val = cell.value;
  if (val === null || val === undefined) return '';

  if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
    return String(val).trim();
  }

  if (val instanceof Date) {
    return val.toISOString();
  }

  if (typeof val === 'object') {
    if ('formula' in val || 'result' in val) {
      const res = (val as { result?: unknown }).result;
      if (res !== undefined && res !== null && typeof res !== 'object') {
        return String(res).trim();
      }
      return '';
    }

    if ('richText' in val && Array.isArray((val as { richText: Array<{ text: string }> }).richText)) {
      return (val as { richText: Array<{ text: string }> }).richText.map((t) => t.text).join('').trim();
    }

    if ('text' in val && typeof (val as { text: unknown }).text === 'string') {
      return (val as { text: string }).text.trim();
    }
  }

  return '';
}

export async function inspectAdminReferenceWorkbook(
  buffer: Buffer
): Promise<AdminReferenceInspectionResult> {
  if (buffer.length > ADMIN_REFERENCE_LIMITS.MAX_WORKBOOK_BYTES) {
    throw new Error('EXCEEDS_MAX_WORKBOOK_BYTES');
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<ExcelJS.Workbook['xlsx']['load']>[0]);

  if (!workbook.worksheets || workbook.worksheets.length === 0) {
    throw new Error('EMPTY_WORKBOOK');
  }

  if (workbook.worksheets.length > ADMIN_REFERENCE_LIMITS.MAX_SHEETS) {
    throw new Error('EXCEEDS_MAX_SHEETS');
  }

  const worksheets: WorksheetStructureSummary[] = [];

  for (const sheet of workbook.worksheets) {
    const sheetName = sheet.name;
    let headers: string[] = [];
    let rowCount = 0;
    let headerRowIndex = -1;

    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (headerRowIndex === -1) {
        const rowHeaders: string[] = [];
        row.eachCell({ includeEmpty: false }, (cell) => {
          const text = extractCellText(cell);
          if (text) {
            if (text.length > ADMIN_REFERENCE_LIMITS.MAX_HEADER_LENGTH) {
              throw new Error('EXCEEDS_MAX_HEADER_LENGTH');
            }
            rowHeaders.push(text);
          }
        });
        if (rowHeaders.length > 0) {
          if (rowHeaders.length > ADMIN_REFERENCE_LIMITS.MAX_COLS_PER_SHEET) {
            throw new Error('EXCEEDS_MAX_COLS');
          }
          headerRowIndex = rowNumber;
          headers = rowHeaders;
        }
      } else {
        rowCount++;
      }
    });

    if (rowCount > ADMIN_REFERENCE_LIMITS.MAX_ROWS_PER_SHEET) {
      throw new Error('EXCEEDS_MAX_ROWS');
    }

    worksheets.push({
      name: sheetName,
      rowCount,
      headers,
    });
  }

  const fingerprint = computeAdminReferenceWorkbookFingerprint(buffer);

  return {
    success: true,
    referenceWorkbookFingerprint: fingerprint,
    fileSizeBytes: buffer.length,
    worksheets,
  };
}

export interface ValidatedMappingResult {
  valid: true;
  canonicalMapping: AdminReferenceMappingConfig;
}

export interface InvalidMappingResult {
  valid: false;
  code: string;
  error: string;
}

export function validateAdminReferenceMapping(
  mappingInput: unknown,
  availableHeaders: string[]
): ValidatedMappingResult | InvalidMappingResult {
  const zodRes = adminReferenceMappingConfigSchema.safeParse(mappingInput);
  if (!zodRes.success) {
    return {
      valid: false,
      code: 'INVALID_MAPPING_SCHEMA',
      error: 'Admin reference mapping schema validation failed.',
    };
  }

  const mapping = zodRes.data;

  // Check duplicate normalized headers in availableHeaders
  const normHeaderMap = new Map<string, string[]>();
  for (const h of availableHeaders) {
    const norm = h.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!normHeaderMap.has(norm)) normHeaderMap.set(norm, []);
    normHeaderMap.get(norm)!.push(h);
  }

  for (const [normKey, headers] of normHeaderMap.entries()) {
    if (headers.length > 1) {
      const allMappedCols = [...mapping.matchMappings, ...mapping.comparisonMappings].map((m) =>
        m.referenceColumn.trim().toLowerCase().replace(/\s+/g, ' ')
      );
      if (allMappedCols.includes(normKey)) {
        return {
          valid: false,
          code: 'DUPLICATE_NORMALIZED_HEADER',
          error: `Ambiguous duplicate normalized header in worksheet: '${headers[0]}'`,
        };
      }
    }
  }

  // Check canonical field validity
  const matchCanonicals = new Set<string>();
  for (const m of mapping.matchMappings) {
    if (!CANONICAL_MATCHABLE_FIELDS.includes(m.canonicalField as CanonicalMatchableField)) {
      return {
        valid: false,
        code: 'UNKNOWN_CANONICAL_FIELD',
        error: `Unknown canonical match field: ${m.canonicalField}`,
      };
    }
    if (matchCanonicals.has(m.canonicalField)) {
      return {
        valid: false,
        code: 'DUPLICATE_CANONICAL_MATCH_FIELD',
        error: `Duplicate canonical match field: ${m.canonicalField}`,
      };
    }
    matchCanonicals.add(m.canonicalField);
  }

  const compCanonicals = new Set<string>();
  for (const m of mapping.comparisonMappings) {
    if (!CANONICAL_COMPARABLE_FIELDS.includes(m.canonicalField as CanonicalComparableField)) {
      return {
        valid: false,
        code: 'UNKNOWN_CANONICAL_FIELD',
        error: `Unknown canonical comparison field: ${m.canonicalField}`,
      };
    }
    if (compCanonicals.has(m.canonicalField)) {
      return {
        valid: false,
        code: 'DUPLICATE_CANONICAL_COMPARISON_FIELD',
        error: `Duplicate canonical comparison field: ${m.canonicalField}`,
      };
    }
    compCanonicals.add(m.canonicalField);
  }

  // Check reference column existence and prevent mapping same reference column to multiple canonical fields
  const normHeadersSet = new Set(availableHeaders.map((h) => h.trim().toLowerCase().replace(/\s+/g, ' ')));
  const mappedRefCols = new Map<string, string>();

  for (const m of [...mapping.matchMappings, ...mapping.comparisonMappings]) {
    const normCol = m.referenceColumn.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!normHeadersSet.has(normCol)) {
      return {
        valid: false,
        code: 'MISSING_REFERENCE_COLUMN',
        error: `Reference column does not exist in worksheet: ${m.referenceColumn}`,
      };
    }
    if (mappedRefCols.has(normCol)) {
      return {
        valid: false,
        code: 'DUPLICATE_REFERENCE_COLUMN_MAPPING',
        error: `Reference column '${m.referenceColumn}' cannot be mapped to multiple canonical fields.`,
      };
    }
    mappedRefCols.set(normCol, m.canonicalField);
  }

  return {
    valid: true,
    canonicalMapping: canonicalizeAdminReferenceMapping(mapping, availableHeaders),
  };
}

export interface ParsedAdminReferenceRow {
  rowNumber: number;
  values: Record<string, string>;
}

export async function parseAdminReferenceWorksheet(
  buffer: Buffer,
  mapping: AdminReferenceMappingConfig
): Promise<ParsedAdminReferenceRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<ExcelJS.Workbook['xlsx']['load']>[0]);

  const sheet = workbook.getWorksheet(mapping.worksheet);
  if (!sheet) {
    throw new Error(`Worksheet '${mapping.worksheet}' not found in reference workbook.`);
  }

  const allMappings = [...mapping.matchMappings, ...mapping.comparisonMappings];
  const targetCols = new Map<string, string>();
  for (const m of allMappings) {
    targetCols.set(m.referenceColumn.trim().toLowerCase().replace(/\s+/g, ' '), m.canonicalField);
  }

  let headerRowNumber = -1;
  const colToCanonical = new Map<number, string>();
  let dataRowCount = 0;

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (headerRowNumber === -1) {
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        const headerText = extractCellText(cell).trim().toLowerCase().replace(/\s+/g, ' ');
        if (targetCols.has(headerText)) {
          colToCanonical.set(colNumber, targetCols.get(headerText)!);
        }
      });
      if (colToCanonical.size > 0) {
        headerRowNumber = rowNumber;
      }
    } else {
      dataRowCount++;
    }
  });

  if (dataRowCount > ADMIN_REFERENCE_LIMITS.MAX_ROWS_PER_SHEET) {
    throw new Error('EXCEEDS_MAX_ROWS');
  }

  if (headerRowNumber === -1) {
    return [];
  }

  const rows: ParsedAdminReferenceRow[] = [];

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= headerRowNumber) return;

    const values: Record<string, string> = {};
    let hasAnyValue = false;

    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const canonicalField = colToCanonical.get(colNumber);
      if (canonicalField) {
        const text = extractCellText(cell);
        if (text) {
          if (text.length > ADMIN_REFERENCE_LIMITS.MAX_CELL_STRING_LENGTH) {
            throw new Error('EXCEEDS_MAX_CELL_STRING_LENGTH');
          }
          values[canonicalField] = text;
          hasAnyValue = true;
        }
      }
    });

    if (hasAnyValue) {
      rows.push({
        rowNumber,
        values,
      });
    }
  });

  return rows;
}

export interface PackageReconciliationInput {
  packagePath: string;
  manifest: {
    publicId?: string;
    title?: string;
    groupName?: string;
    year?: number | string;
    program?: string;
    studyProgram?: string;
    academicSupervisor?: string;
    industryPartner?: string;
    participantContactEmail?: string;
    teamMembers?: string[];
  };
}

function normalizeString(val: string | undefined): string {
  if (!val) return '';
  return val.trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizeYear(val: number | string | undefined): string {
  if (val === undefined || val === null || val === '') return '';
  const num = Number(val);
  return Number.isInteger(num) ? String(num) : String(val).trim();
}

function normalizeFieldValue(canonicalField: string, rawVal: unknown): string {
  if (rawVal === undefined || rawVal === null) return '';
  if (canonicalField === 'year') {
    return normalizeYear(rawVal as number | string);
  }
  if (canonicalField === 'participantContactEmail') {
    return (normalizeParticipantContactEmail(String(rawVal)) || '').toLowerCase();
  }
  if (canonicalField === 'teamMembers') {
    let members: string[] = [];
    if (Array.isArray(rawVal)) {
      members = rawVal.map((m) => String(m));
    } else if (typeof rawVal === 'string') {
      members = rawVal.split(/[,;\n]/).map((m) => m.trim());
    } else if (rawVal !== undefined && rawVal !== null) {
      members = [String(rawVal)];
    }
    const sorted = members
      .map((m) => normalizeString(m))
      .filter((m) => m !== '')
      .sort((a, b) => a.localeCompare(b));
    return sorted.join('||');
  }
  return normalizeString(String(rawVal));
}

export function buildCompositeMatchKey(
  mapping: AdminReferenceMappingConfig,
  fieldValues: Record<string, unknown>
): string {
  const parts: string[] = [];
  for (const m of mapping.matchMappings) {
    const raw = fieldValues[m.canonicalField];
    const norm = normalizeFieldValue(m.canonicalField, raw);
    if (!norm) return '';
    parts.push(`${m.canonicalField}:${norm}`);
  }
  return parts.join('||');
}

export function reconcilePackagesAgainstAdminReference(params: {
  packages: PackageReconciliationInput[];
  referenceRows: ParsedAdminReferenceRow[];
  mapping: AdminReferenceMappingConfig;
}): AdminReferenceReconciliationBatchResult {
  const { packages, referenceRows, mapping } = params;
  const canonicalMapping = canonicalizeAdminReferenceMapping(mapping);
  const batchIssues: BrowserImportIssue[] = [];

  // Build match key index for reference rows & validate keyspace
  const referenceKeyMap = new Map<string, ParsedAdminReferenceRow[]>();

  for (const row of referenceRows) {
    const key = buildCompositeMatchKey(canonicalMapping, row.values);
    if (!key) {
      batchIssues.push({
        code: 'ADMIN_REFERENCE_MISSING_MATCH_KEY',
        message: `Official reference row ${row.rowNumber} is missing required match key values.`,
        severity: 'error',
        rowNumber: row.rowNumber,
      });
      continue;
    }
    if (!referenceKeyMap.has(key)) {
      referenceKeyMap.set(key, []);
    }
    referenceKeyMap.get(key)!.push(row);
  }

  // Check duplicate reference match keys
  const duplicateRefKeys = new Set<string>();
  for (const [key, rows] of referenceKeyMap.entries()) {
    if (rows.length > 1) {
      duplicateRefKeys.add(key);
      batchIssues.push({
        code: 'ADMIN_REFERENCE_DUPLICATE_MATCH_KEY',
        message: `Multiple reference rows (e.g. #${rows[0].rowNumber}, #${rows[1].rowNumber}) share identical composite match key.`,
        severity: 'error',
      });
    }
  }

  // Build match key index for submitted packages
  const packageKeyMap = new Map<string, string[]>();
  for (const pkg of packages) {
    const key = buildCompositeMatchKey(canonicalMapping, pkg.manifest as Record<string, unknown>);
    if (key) {
      if (!packageKeyMap.has(key)) {
        packageKeyMap.set(key, []);
      }
      packageKeyMap.get(key)!.push(pkg.packagePath);
    }
  }

  const packageResults = new Map<string, AdminReferencePackageResult>();
  const matchedReferenceRowNumbers = new Set<number>();

  for (const pkg of packages) {
    const pkgMatchKey = buildCompositeMatchKey(
      canonicalMapping,
      pkg.manifest as Record<string, unknown>
    );

    if (!pkgMatchKey) {
      packageResults.set(pkg.packagePath, {
        status: 'ADMIN_REFERENCE_VALUE_INVALID',
        mismatchedFields: [],
        issues: [
          {
            code: 'ADMIN_REFERENCE_VALUE_INVALID',
            message: 'Submitted project is missing one or more required match key fields.',
            severity: 'error',
            packagePath: pkg.packagePath,
          },
        ],
      });
      continue;
    }

    // Check duplicate package match key
    if ((packageKeyMap.get(pkgMatchKey)?.length ?? 0) > 1) {
      packageResults.set(pkg.packagePath, {
        status: 'ADMIN_REFERENCE_AMBIGUOUS_MATCH',
        mismatchedFields: [],
        issues: [
          {
            code: 'ADMIN_REFERENCE_DUPLICATE_PACKAGE_KEY',
            message: 'Multiple submitted packages share the same composite match key.',
            severity: 'error',
            packagePath: pkg.packagePath,
          },
        ],
      });
      continue;
    }

    // Check duplicate reference match key
    if (duplicateRefKeys.has(pkgMatchKey)) {
      packageResults.set(pkg.packagePath, {
        status: 'ADMIN_REFERENCE_AMBIGUOUS_MATCH',
        mismatchedFields: [],
        issues: [
          {
            code: 'ADMIN_REFERENCE_DUPLICATE_MATCH_KEY',
            message: 'Multiple administrative reference rows match the package key.',
            severity: 'error',
            packagePath: pkg.packagePath,
          },
        ],
      });
      continue;
    }

    const matchedRefRows = referenceKeyMap.get(pkgMatchKey);
    if (!matchedRefRows || matchedRefRows.length === 0) {
      packageResults.set(pkg.packagePath, {
        status: 'ADMIN_REFERENCE_NO_MATCH',
        mismatchedFields: [],
        issues: [
          {
            code: 'ADMIN_REFERENCE_NO_MATCH',
            message: 'No matching administrative reference row found.',
            severity: 'error',
            packagePath: pkg.packagePath,
          },
        ],
      });
      continue;
    }

    const refRow = matchedRefRows[0];
    matchedReferenceRowNumbers.add(refRow.rowNumber);

    // Cross-check comparison fields
    const mismatchedFields: string[] = [];
    for (const comp of canonicalMapping.comparisonMappings) {
      const field = comp.canonicalField;
      const pkgNorm = normalizeFieldValue(field, pkg.manifest[field as keyof typeof pkg.manifest]);
      const refNorm = normalizeFieldValue(field, refRow.values[field]);

      if (pkgNorm !== refNorm) {
        mismatchedFields.push(field);
      }
    }

    if (mismatchedFields.length > 0) {
      packageResults.set(pkg.packagePath, {
        status: 'ADMIN_REFERENCE_FIELD_MISMATCH',
        matchedRowNumber: refRow.rowNumber,
        mismatchedFields,
        issues: [
          {
            code: 'ADMIN_REFERENCE_FIELD_MISMATCH',
            message: `Admin reference field mismatch: ${mismatchedFields.join(', ')}`,
            severity: 'error',
            packagePath: pkg.packagePath,
            rowNumber: refRow.rowNumber,
          },
        ],
      });
    } else {
      packageResults.set(pkg.packagePath, {
        status: 'RECONCILED',
        matchedRowNumber: refRow.rowNumber,
        mismatchedFields: [],
        issues: [],
      });
    }
  }

  const unusedReferenceRowCount = referenceRows.length - matchedReferenceRowNumbers.size;

  return {
    packageResults,
    unusedReferenceRowCount: Math.max(0, unusedReferenceRowCount),
    totalReferenceRowsCount: referenceRows.length,
    batchIssues,
  };
}
