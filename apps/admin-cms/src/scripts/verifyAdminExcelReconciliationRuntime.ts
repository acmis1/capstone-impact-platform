import ExcelJS from 'exceljs';
import {
  inspectAdminReferenceWorkbook,
  validateAdminReferenceMapping,
  parseAdminReferenceWorksheet,
  reconcilePackagesAgainstAdminReference,
  computeAdminReferenceWorkbookFingerprint,
} from '../import/adminReferenceReconciliation';
import { generateBrowserPreviewFingerprint } from '../import/prepareBrowserImportCommitIntent';
import { computeCanonicalIntentHash } from '../import/browserImportMetadataStageContract';

async function createSyntheticReferenceWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  const sheet1 = workbook.addWorksheet('SCHOOL_ROSTER_2026');
  sheet1.addRow(['Group Name', 'Academic Year', 'Official Project Title', 'Degree Program', 'Contact Email']);
  sheet1.addRow(['Group Alpha', 2026, 'Smart Grid Energy AI', 'Computer Science', 'alpha@capstone.invalid']);
  sheet1.addRow(['Group Beta', 2026, 'Official School Title Beta', 'Software Engineering', 'beta@capstone.invalid']);
  sheet1.addRow(['Group Gamma', 2026, 'Official School Title Gamma', 'Cyber Security', 'gamma@capstone.invalid']);

  const arrayBuf = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuf);
}

async function createModifiedReferenceWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet1 = workbook.addWorksheet('SCHOOL_ROSTER_2026');
  sheet1.addRow(['Group Name', 'Academic Year', 'Official Project Title', 'Degree Program', 'Contact Email']);
  sheet1.addRow(['Group Alpha', 2026, 'MODIFIED Smart Grid Energy AI', 'Computer Science', 'alpha@capstone.invalid']);

  const arrayBuf = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuf);
}

async function main() {
  process.stdout.write('[VERIFY Admin Excel Reconciliation Runtime] Starting verification...\n');

  // Check 1: Inspection & Structural Summary
  const refBuffer = await createSyntheticReferenceWorkbook();
  const inspection = await inspectAdminReferenceWorkbook(refBuffer);

  if (!inspection.success || !inspection.referenceWorkbookFingerprint) {
    throw new Error('Check 1 Failed: Inspection did not succeed.');
  }

  const fingerprint = inspection.referenceWorkbookFingerprint;
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new Error('Check 1 Failed: Fingerprint is not a 64-char hex SHA-256 string.');
  }

  if (inspection.worksheets.length !== 1 || inspection.worksheets[0].name !== 'SCHOOL_ROSTER_2026') {
    throw new Error('Check 1 Failed: Worksheet name summary mismatch.');
  }

  const headers = inspection.worksheets[0].headers;
  if (!headers.includes('Group Name') || !headers.includes('Official Project Title')) {
    throw new Error('Check 1 Failed: Inspection missing expected headers.');
  }

  // Privacy Check: raw cell strings like 'Smart Grid Energy AI' must not exist in inspection output
  const jsonInspection = JSON.stringify(inspection);
  if (jsonInspection.includes('Smart Grid Energy AI') || jsonInspection.includes('alpha@capstone.invalid')) {
    throw new Error('Check 1 Failed: Privacy violation! Raw row contents exposed in inspection output.');
  }

  process.stdout.write('  ✓ Check 1 Passed: Reference workbook inspection & structural summary clean.\n');

  // Check 2: Mapping Validation & Canonicalization
  const rawMappingConfig = {
    worksheet: 'SCHOOL_ROSTER_2026',
    matchMappings: [
      { canonicalField: 'year', referenceColumn: 'Academic Year' },
      { canonicalField: 'groupName', referenceColumn: 'Group Name' },
    ],
    comparisonMappings: [
      { canonicalField: 'title', referenceColumn: 'Official Project Title' },
      { canonicalField: 'program', referenceColumn: 'Degree Program' },
    ],
    reconciliationContractVersion: 'admin-reference-reconciliation-v1',
  };

  const mapVal = validateAdminReferenceMapping(rawMappingConfig, headers);
  if (!mapVal.valid) {
    throw new Error(`Check 2 Failed: Mapping validation failed: ${mapVal.error}`);
  }

  const canonicalMapping = mapVal.canonicalMapping;
  if (canonicalMapping.matchMappings[0].canonicalField !== 'groupName') {
    throw new Error('Check 2 Failed: Mapping canonicalization order failed.');
  }

  process.stdout.write('  ✓ Check 2 Passed: Controlled mapping validation & canonicalization clean.\n');

  // Check 3: Reconciliation Engine Execution
  const parsedRows = await parseAdminReferenceWorksheet(refBuffer, canonicalMapping);
  if (parsedRows.length !== 3) {
    throw new Error(`Check 3 Failed: Expected 3 parsed reference rows, got ${parsedRows.length}`);
  }

  const testPackages = [
    {
      packagePath: 'projects/alpha',
      manifest: {
        groupName: '  group alpha  ',
        year: 2026,
        title: 'Smart Grid Energy AI',
        program: 'Computer Science',
      },
    },
    {
      packagePath: 'projects/beta',
      manifest: {
        groupName: 'Group Beta',
        year: 2026,
        title: 'Student Title Beta (Mismatch)',
        program: 'Software Engineering',
      },
    },
    {
      packagePath: 'projects/unmatched',
      manifest: {
        groupName: 'Group Unknown',
        year: 2026,
        title: 'Unknown Title',
        program: 'IT',
      },
    },
  ];

  const reconRes = reconcilePackagesAgainstAdminReference({
    packages: testPackages,
    referenceRows: parsedRows,
    mapping: canonicalMapping,
  });

  const alphaRes = reconRes.packageResults.get('projects/alpha');
  if (!alphaRes || alphaRes.status !== 'RECONCILED' || alphaRes.matchedRowNumber !== 2) {
    throw new Error(`Check 3 Failed: Alpha package expected RECONCILED on row 2, got ${alphaRes?.status}`);
  }

  const betaRes = reconRes.packageResults.get('projects/beta');
  if (!betaRes || betaRes.status !== 'ADMIN_REFERENCE_FIELD_MISMATCH' || !betaRes.mismatchedFields.includes('title')) {
    throw new Error(`Check 3 Failed: Beta package expected FIELD_MISMATCH on title, got ${betaRes?.status}`);
  }

  const unmatchedRes = reconRes.packageResults.get('projects/unmatched');
  if (!unmatchedRes || unmatchedRes.status !== 'ADMIN_REFERENCE_NO_MATCH') {
    throw new Error(`Check 3 Failed: Unmatched package expected NO_MATCH, got ${unmatchedRes?.status}`);
  }

  if (reconRes.unusedReferenceRowCount !== 1) {
    throw new Error(`Check 3 Failed: Expected 1 unused reference row, got ${reconRes.unusedReferenceRowCount}`);
  }

  process.stdout.write('  ✓ Check 3 Passed: Rules-first server reconciliation engine verified.\n');

  // Check 4: TOCTOU Fingerprint Binding & Intent Hash
  const adminReferenceIntentObj = {
    workbookFingerprint: fingerprint,
    worksheet: canonicalMapping.worksheet,
    matchMappings: canonicalMapping.matchMappings,
    comparisonMappings: canonicalMapping.comparisonMappings,
    reconciliationContractVersion: 'admin-reference-reconciliation-v1' as const,
  };

  const previewFingerprint1 = generateBrowserPreviewFingerprint({
    selectedRootName: 'batch-2026',
    fileCount: 10,
    declaredTotalBytes: 500000,
    packages: [
      { packagePath: 'projects/alpha', status: 'valid', errors: [], warnings: [] },
    ],
    adminReference: adminReferenceIntentObj,
  });

  // Verify TOCTOU: changing reference workbook fingerprint alters preview fingerprint
  const modRefBuffer = await createModifiedReferenceWorkbook();
  const modFingerprint = computeAdminReferenceWorkbookFingerprint(modRefBuffer);

  const previewFingerprint2 = generateBrowserPreviewFingerprint({
    selectedRootName: 'batch-2026',
    fileCount: 10,
    declaredTotalBytes: 500000,
    packages: [
      { packagePath: 'projects/alpha', status: 'valid', errors: [], warnings: [] },
    ],
    adminReference: {
      ...adminReferenceIntentObj,
      workbookFingerprint: modFingerprint,
    },
  });

  if (previewFingerprint1 === previewFingerprint2) {
    throw new Error('Check 4 Failed: Modifying reference workbook did not alter preview fingerprint!');
  }

  // Canonical intent hash check
  const intent1 = {
    version: 1 as const,
    previewFingerprint: previewFingerprint1,
    selectedRootName: 'batch-2026',
    fileCount: 10,
    declaredTotalBytes: 500000,
    selectedPackagePaths: ['projects/alpha'],
    acknowledgedWarningPackagePaths: [],
    adminReference: adminReferenceIntentObj,
  };

  const intentHash = computeCanonicalIntentHash(intent1);
  if (!/^[a-f0-9]{64}$/.test(intentHash)) {
    throw new Error('Check 4 Failed: Canonical intent hash is not a 64-char hex string.');
  }

  // Zero raw data check in intent structure
  const jsonIntent = JSON.stringify(intent1);
  if (jsonIntent.includes('Smart Grid Energy AI') || jsonIntent.includes('alpha@capstone.invalid')) {
    throw new Error('Check 4 Failed: Raw workbook rows detected inside commit intent!');
  }

  process.stdout.write('  ✓ Check 4 Passed: TOCTOU fingerprint binding & intent hash clean (zero raw data persisted).\n');

  process.stdout.write('[VERIFY Admin Excel Reconciliation Runtime] All checks passed successfully!\n');
}

main().catch((err) => {
  process.stderr.write(`[VERIFY Admin Excel Reconciliation Runtime] FAILED: ${err.message}\n`);
  process.exit(1);
});
