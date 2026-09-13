import ExcelJS from 'exceljs';
import {
  COLUMN_DEFINITIONS,
  PREFERRED_WORKSHEET_NAME,
} from './projectDetailsWorkbookContract';
import type { FormIntakeMetadata } from './formIntakeContract';

/**
 * Server-only utility to materialize a canonical project-details.xlsx workbook
 * from standardized intake form metadata.
 *
 * Guaranteed to match the workbook schema expected by parseProjectDetailsWorkbook.
 */
export async function materializeFormIntakeWorkbook(
  metadata: FormIntakeMetadata
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Admin Form Intake Materializer';
  workbook.lastModifiedBy = 'Admin Form Intake Materializer';
  const now = new Date();
  workbook.created = now;
  workbook.modified = now;

  const worksheet = workbook.addWorksheet(PREFERRED_WORKSHEET_NAME);

  // Row 1: Canonical header names
  const headers = COLUMN_DEFINITIONS.map((def) => def.canonicalName);
  worksheet.addRow(headers);

  // Row 2: Project values mapped by internalField
  const rowValues = COLUMN_DEFINITIONS.map((def) => {
    const field = def.internalField as keyof FormIntakeMetadata;
    const rawVal = metadata[field];
    if (rawVal === undefined || rawVal === null) return '';
    return typeof rawVal === 'string' ? rawVal.trim() : String(rawVal);
  });
  worksheet.addRow(rowValues);

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}
