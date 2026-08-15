import { z } from 'zod';
import type { BrowserImportIssue } from './browserImportPreviewContract';

export const ADMIN_REFERENCE_LIMITS = {
  MAX_WORKBOOK_BYTES: 5 * 1024 * 1024, // 5 MB
  MAX_SHEETS: 20,
  MAX_ROWS_PER_SHEET: 2000,
  MAX_COLS_PER_SHEET: 50,
  MAX_HEADER_LENGTH: 100,
  MAX_CELL_STRING_LENGTH: 1000,
  MAX_MATCH_FIELDS: 3,
  MAX_COMPARISON_FIELDS: 20,
} as const;

export const CANONICAL_MATCHABLE_FIELDS = [
  'publicId',
  'title',
  'groupName',
  'year',
  'program',
  'studyProgram',
  'academicSupervisor',
  'industryPartner',
  'participantContactEmail',
] as const;

export type CanonicalMatchableField = typeof CANONICAL_MATCHABLE_FIELDS[number];

export const CANONICAL_COMPARABLE_FIELDS = [
  'title',
  'groupName',
  'year',
  'program',
  'studyProgram',
  'academicSupervisor',
  'industryPartner',
  'participantContactEmail',
  'teamMembers',
] as const;

export type CanonicalComparableField = typeof CANONICAL_COMPARABLE_FIELDS[number];

export const adminReferenceFieldMappingSchema = z
  .object({
    canonicalField: z.string().min(1).max(50),
    referenceColumn: z.string().min(1).max(100),
  })
  .strict();

export type AdminReferenceFieldMapping = z.infer<typeof adminReferenceFieldMappingSchema>;

export const adminReferenceMappingConfigSchema = z
  .object({
    worksheet: z.string().min(1).max(100),
    matchMappings: z
      .array(adminReferenceFieldMappingSchema)
      .min(1)
      .max(ADMIN_REFERENCE_LIMITS.MAX_MATCH_FIELDS),
    comparisonMappings: z
      .array(adminReferenceFieldMappingSchema)
      .min(1)
      .max(ADMIN_REFERENCE_LIMITS.MAX_COMPARISON_FIELDS),
    reconciliationContractVersion: z.literal('admin-reference-reconciliation-v1'),
  })
  .strict();

export type AdminReferenceMappingConfig = z.infer<typeof adminReferenceMappingConfigSchema>;

export interface WorksheetStructureSummary {
  name: string;
  rowCount: number;
  headers: string[];
}

export interface AdminReferenceInspectionResult {
  success: true;
  referenceWorkbookFingerprint: string;
  fileSizeBytes: number;
  worksheets: WorksheetStructureSummary[];
}

export type AdminReferenceReconciliationStatus =
  | 'RECONCILED'
  | 'ADMIN_REFERENCE_NO_MATCH'
  | 'ADMIN_REFERENCE_AMBIGUOUS_MATCH'
  | 'ADMIN_REFERENCE_FIELD_MISMATCH'
  | 'ADMIN_REFERENCE_VALUE_INVALID';

export interface AdminReferencePackageResult {
  status: AdminReferenceReconciliationStatus;
  matchedRowNumber?: number;
  mismatchedFields: string[];
  issues: BrowserImportIssue[];
}

export interface AdminReferenceReconciliationBatchResult {
  packageResults: Map<string, AdminReferencePackageResult>;
  unusedReferenceRowCount: number;
  totalReferenceRowsCount: number;
  batchIssues: BrowserImportIssue[];
}
