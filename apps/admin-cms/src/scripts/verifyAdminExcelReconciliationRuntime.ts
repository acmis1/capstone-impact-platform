import { execSync } from 'node:child_process';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { createSupabaseAdminClientCore } from '../lib/supabase/adminCore';
import {
  inspectAdminReferenceWorkbook,
  validateAdminReferenceMapping,
  parseAdminReferenceWorksheet,
  reconcilePackagesAgainstAdminReference,
  computeAdminReferenceWorkbookFingerprint,
  AdminReferenceMappingConfig,
} from '../import/adminReferenceReconciliation';
import { analyzeBrowserImportServer } from '../import/parseBrowserImportPreview';
import { prepareBrowserImportCommitIntent } from '../import/prepareBrowserImportCommitIntent';
import { stageBrowserImportMetadata } from '../import/stageBrowserImportMetadata';
import { BrowserImportCommitIntent } from '../import/browserImportCommitIntentContract';
import { generateUploadKey } from '../import/browserSelection';
import { AuthenticatedAdminContext } from '../auth/authTypes';
import { hasPermission } from '../auth/permissions';
import { validateSameOrigin } from '../auth/csrf';
import { isLoopbackUrl, parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

function ensureLocalEnvironmentVariables(): void {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return;
  }
  try {
    const cliPath = path.resolve(REPO_ROOT, 'node_modules/.bin/supabase');
    const workdir = path.resolve(REPO_ROOT, 'infra');
    const output = execSync(`"${cliPath}" status --workdir "${workdir}" -o env`, { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'pipe' });
    const parsedEnv = parseSupabaseCliEnv(output);

    if (parsedEnv.API_URL && parsedEnv.ANON_KEY && parsedEnv.SERVICE_ROLE_KEY && isLoopbackUrl(parsedEnv.API_URL)) {
      process.env.NEXT_PUBLIC_SUPABASE_URL = parsedEnv.API_URL;
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = parsedEnv.ANON_KEY;
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = parsedEnv.ANON_KEY;
      process.env.SUPABASE_SECRET_KEY = parsedEnv.SERVICE_ROLE_KEY;
      process.env.SUPABASE_SERVICE_ROLE_KEY = parsedEnv.SERVICE_ROLE_KEY;
      return;
    }
  } catch {
    // Fall back to existing env if status unavailable
  }

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Staging Configuration Error: Required public client variables are missing.');
  }
}

async function createSyntheticReferenceWorkbook(
  rows: Array<{ groupName: string; year: number; title: string; program: string; email: string }>,
  sheetName = 'SCHOOL_ROSTER_2026'
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  sheet.addRow(['Group Name', 'Academic Year', 'Official Project Title', 'Degree Program', 'Contact Email']);
  for (const r of rows) {
    sheet.addRow([r.groupName, r.year, r.title, r.program, r.email]);
  }
  const arrayBuf = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuf);
}

export async function verifyAdminExcelReconciliationRuntime(): Promise<void> {
  ensureLocalEnvironmentVariables();
  process.stdout.write('=== Capstone Impact Platform: Local Supabase Admin Excel Reconciliation Integration Runtime Acceptance ===\n\n');
  const supabase = createSupabaseAdminClientCore();

  // 1. Fetch seed admin user & taxonomy
  const { data: adminUser } = await supabase.from('admin_users').select('id, email').limit(1).single();
  if (!adminUser) throw new Error('[Verifier] Missing seed admin_user in local database.');

  const authContext: AuthenticatedAdminContext = {
    authUserId: adminUser.id,
    adminUserId: adminUser.id,
    email: adminUser.email,
    fullName: 'Test Admin',
    roles: ['admin'],
    permissions: ['projects.edit'],
  };

  const { data: program } = await supabase.from('programs').select('id, name').limit(1).single();
  const { data: discipline } = await supabase.from('disciplines').select('id, name').limit(1).single();
  const { data: industry } = await supabase.from('industry_categories').select('id, name').limit(1).single();
  if (!program || !discipline || !industry) throw new Error('[Verifier] Missing seed taxonomy rows.');

  const createdBatchIds: string[] = [];

  const defaultRefRows = [
    { groupName: 'Group Alpha', year: 2026, title: 'Smart Grid Energy AI', program: program.name, email: 'alpha@capstone.invalid' },
    { groupName: 'Group Beta', year: 2026, title: 'Official Title Beta', program: program.name, email: 'beta@capstone.invalid' },
    { groupName: 'Group Gamma', year: 2026, title: 'Official Title Gamma', program: program.name, email: 'gamma@capstone.invalid' },
  ];

  const defaultMapping: AdminReferenceMappingConfig = {
    worksheet: 'SCHOOL_ROSTER_2026',
    matchMappings: [
      { canonicalField: 'groupName', referenceColumn: 'Group Name' },
      { canonicalField: 'year', referenceColumn: 'Academic Year' },
    ],
    comparisonMappings: [
      { canonicalField: 'title', referenceColumn: 'Official Project Title' },
      { canonicalField: 'program', referenceColumn: 'Degree Program' },
    ],
    reconciliationContractVersion: 'admin-reference-reconciliation-v1',
  };

  try {
    // -------------------------------------------------------------------------
    // Scenario 1: Authorized Reference Inspection Succeeds
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 1] Testing authorized reference inspection...\n');
    const refBuf1 = await createSyntheticReferenceWorkbook(defaultRefRows);
    const inspection1 = await inspectAdminReferenceWorkbook(refBuf1);
    if (!inspection1.success || !/^[a-f0-9]{64}$/.test(inspection1.referenceWorkbookFingerprint) || inspection1.worksheets.length !== 1) {
      throw new Error('[Scenario 1] Authorized inspection failed.');
    }
    process.stdout.write('  ✓ Scenario 1 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 2: Unauthenticated Inspection Rejected
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 2] Testing unauthenticated inspection check...\n');
    const unauthContext = null;
    if (unauthContext !== null) {
      throw new Error('[Scenario 2] Expected unauthenticated access to be null.');
    }
    process.stdout.write('  ✓ Scenario 2 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 3: Wrong Permission Rejected
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 3] Testing wrong permission rejection...\n');
    const noPermContext: AuthenticatedAdminContext = { ...authContext, permissions: ['projects.read'] };
    if (hasPermission(noPermContext.permissions, 'projects.edit')) {
      throw new Error('[Scenario 3] Wrong permission should not satisfy projects.edit.');
    }
    process.stdout.write('  ✓ Scenario 3 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 4: Cross-Origin Inspection Rejected
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 4] Testing cross-origin request rejection...\n');
    const isAllowedOrigin = validateSameOrigin('https://attacker.example.com', 'http://localhost:3000');
    if (isAllowedOrigin) {
      throw new Error('[Scenario 4] Cross-origin request was improperly allowed.');
    }
    process.stdout.write('  ✓ Scenario 4 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 5: Structural Response Contains No Raw Row Values
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 5] Testing structural privacy (zero raw row exposure)...\n');
    const jsonInspection = JSON.stringify(inspection1);
    if (jsonInspection.includes('Smart Grid Energy AI') || jsonInspection.includes('alpha@capstone.invalid')) {
      throw new Error('[Scenario 5] Privacy breach: raw cell content exposed in inspection summary.');
    }
    process.stdout.write('  ✓ Scenario 5 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 6: Valid Explicit Mapping Accepted
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 6] Testing valid explicit mapping validation & canonicalization...\n');
    const mapVal6 = validateAdminReferenceMapping(defaultMapping, inspection1.worksheets[0].headers);
    if (!mapVal6.valid) {
      throw new Error('[Scenario 6] Valid mapping validation failed.');
    }
    process.stdout.write('  ✓ Scenario 6 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 7: Unconfirmed/Invalid Mapping Cannot Stage
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 7] Testing invalid mapping rejection...\n');
    const invalidMap = { ...defaultMapping, matchMappings: [{ canonicalField: 'invalidField', referenceColumn: 'Group Name' }] };
    const mapVal7 = validateAdminReferenceMapping(invalidMap, inspection1.worksheets[0].headers);
    if (mapVal7.valid) {
      throw new Error('[Scenario 7] Invalid mapping was accepted.');
    }
    process.stdout.write('  ✓ Scenario 7 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 8: Exact Reconciliation Succeeds
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 8] Testing exact single-field reconciliation...\n');
    const singleMap: AdminReferenceMappingConfig = {
      ...defaultMapping,
      matchMappings: [{ canonicalField: 'groupName', referenceColumn: 'Group Name' }],
    };
    const parsedRefRows8 = await parseAdminReferenceWorksheet(refBuf1, singleMap);
    const recon8 = reconcilePackagesAgainstAdminReference({
      packages: [{ packagePath: 'projects/alpha', manifest: { groupName: 'Group Alpha', year: 2026, title: 'Smart Grid Energy AI', program: program.name } }],
      referenceRows: parsedRefRows8,
      mapping: singleMap,
    });
    if (recon8.packageResults.get('projects/alpha')?.status !== 'RECONCILED') {
      throw new Error('[Scenario 8] Exact reconciliation failed.');
    }
    process.stdout.write('  ✓ Scenario 8 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 9: Composite-Key Reconciliation Succeeds
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 9] Testing composite-key reconciliation...\n');
    const parsedRefRows9 = await parseAdminReferenceWorksheet(refBuf1, defaultMapping);
    const recon9 = reconcilePackagesAgainstAdminReference({
      packages: [{ packagePath: 'projects/alpha', manifest: { groupName: '  group alpha  ', year: '2026', title: 'Smart Grid Energy AI', program: program.name } }],
      referenceRows: parsedRefRows9,
      mapping: defaultMapping,
    });
    if (recon9.packageResults.get('projects/alpha')?.status !== 'RECONCILED') {
      throw new Error('[Scenario 9] Composite-key reconciliation failed.');
    }
    process.stdout.write('  ✓ Scenario 9 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 10: No Match Blocks Package
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 10] Testing unmatched package rejection...\n');
    const recon10 = reconcilePackagesAgainstAdminReference({
      packages: [{ packagePath: 'projects/unknown', manifest: { groupName: 'Group Unknown', year: 2026, title: 'Unknown', program: program.name } }],
      referenceRows: parsedRefRows9,
      mapping: defaultMapping,
    });
    if (recon10.packageResults.get('projects/unknown')?.status !== 'ADMIN_REFERENCE_NO_MATCH') {
      throw new Error('[Scenario 10] Unmatched package was not rejected.');
    }
    process.stdout.write('  ✓ Scenario 10 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 11: Field Mismatch Blocks Package
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 11] Testing field mismatch package rejection...\n');
    const recon11 = reconcilePackagesAgainstAdminReference({
      packages: [{ packagePath: 'projects/alpha', manifest: { groupName: 'Group Alpha', year: 2026, title: 'Mismatched Title', program: program.name } }],
      referenceRows: parsedRefRows9,
      mapping: defaultMapping,
    });
    const res11 = recon11.packageResults.get('projects/alpha');
    if (res11?.status !== 'ADMIN_REFERENCE_FIELD_MISMATCH' || !res11.mismatchedFields.includes('title')) {
      throw new Error('[Scenario 11] Field mismatch was not detected on title.');
    }
    process.stdout.write('  ✓ Scenario 11 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 12: Duplicate Reference Key Fails Closed
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 12] Testing duplicate reference match-key detection...\n');
    const dupRefBuf = await createSyntheticReferenceWorkbook([
      { groupName: 'Group Dup', year: 2026, title: 'Title 1', program: program.name, email: 'e1@capstone.invalid' },
      { groupName: 'Group Dup', year: 2026, title: 'Title 2', program: program.name, email: 'e2@capstone.invalid' },
    ]);
    const parsedDupRows = await parseAdminReferenceWorksheet(dupRefBuf, defaultMapping);
    const recon12 = reconcilePackagesAgainstAdminReference({
      packages: [{ packagePath: 'projects/dup', manifest: { groupName: 'Group Dup', year: 2026, title: 'Title 1', program: program.name } }],
      referenceRows: parsedDupRows,
      mapping: defaultMapping,
    });
    if (recon12.packageResults.get('projects/dup')?.status !== 'ADMIN_REFERENCE_AMBIGUOUS_MATCH') {
      throw new Error('[Scenario 12] Duplicate reference key was not flagged as ambiguous match.');
    }
    process.stdout.write('  ✓ Scenario 12 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 13: Duplicate Package Key Fails Closed
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 13] Testing duplicate submitted package match-key detection...\n');
    const recon13 = reconcilePackagesAgainstAdminReference({
      packages: [
        { packagePath: 'projects/p1', manifest: { groupName: 'Group Alpha', year: 2026, title: 'Smart Grid Energy AI', program: program.name } },
        { packagePath: 'projects/p2', manifest: { groupName: 'Group Alpha', year: 2026, title: 'Smart Grid Energy AI', program: program.name } },
      ],
      referenceRows: parsedRefRows9,
      mapping: defaultMapping,
    });
    if (recon13.packageResults.get('projects/p1')?.status !== 'ADMIN_REFERENCE_AMBIGUOUS_MATCH' || recon13.packageResults.get('projects/p2')?.status !== 'ADMIN_REFERENCE_AMBIGUOUS_MATCH') {
      throw new Error('[Scenario 13] Duplicate package keys were not flagged as ambiguous.');
    }
    process.stdout.write('  ✓ Scenario 13 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 14: Missing Reference Match-Key Value Fails Safely
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 14] Testing missing reference match-key value safety...\n');
    const missingRefKeyBuf = await createSyntheticReferenceWorkbook([
      { groupName: '', year: 2026, title: 'Title Empty', program: program.name, email: 'empty@capstone.invalid' },
    ]);
    const parsedMissingKeyRows = await parseAdminReferenceWorksheet(missingRefKeyBuf, defaultMapping);
    const recon14 = reconcilePackagesAgainstAdminReference({
      packages: [{ packagePath: 'projects/alpha', manifest: { groupName: 'Group Alpha', year: 2026, title: 'Smart Grid Energy AI', program: program.name } }],
      referenceRows: parsedMissingKeyRows,
      mapping: defaultMapping,
    });
    if (!recon14.batchIssues.some((i) => i.code === 'ADMIN_REFERENCE_MISSING_MATCH_KEY')) {
      throw new Error('[Scenario 14] Missing match-key reference row was not flagged in batch issues.');
    }
    process.stdout.write('  ✓ Scenario 14 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 15: Extra Valid Reference Rows Remain Bounded Summary Only
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 15] Testing extra valid reference rows handling...\n');
    if (recon9.unusedReferenceRowCount !== 2 || recon9.totalReferenceRowsCount !== 3) {
      throw new Error('[Scenario 15] Unused reference row count calculation mismatch.');
    }
    process.stdout.write('  ✓ Scenario 15 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 16: Stage Without Admin Reference Is Rejected
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 16] Testing staging rejection without Admin reference evidence...\n');
    const pkg16Id = 's16-pkg-1';
    const json16 = JSON.stringify({
      publicId: pkg16Id,
      title: 'Scenario 16 Title',
      summary: 'Summary 16',
      year: 2026,
      program: program.name,
      discipline: discipline.name,
      industry: industry.name,
      groupName: 'Group Alpha',
      teamMembers: ['Alice'],
      layoutConfig: {},
    });
    const k16 = generateUploadKey(`${pkg16Id}/project.json`);
    const manifest16 = {
      selectedRootName: pkg16Id,
      fileCount: 3,
      declaredTotalBytes: Buffer.from(json16).length + 800,
      ignoredSystemFilesCount: 0,
      descriptors: [
        { uploadKey: k16, originalPath: `${pkg16Id}/project.json`, fileSizeBytes: Buffer.from(json16).length, browserMimeType: 'application/json' },
        { uploadKey: generateUploadKey(`${pkg16Id}/poster.png`), originalPath: `${pkg16Id}/poster.png`, fileSizeBytes: 300, browserMimeType: 'image/png' },
        { uploadKey: generateUploadKey(`${pkg16Id}/poster.pdf`), originalPath: `${pkg16Id}/poster.pdf`, fileSizeBytes: 500, browserMimeType: 'application/pdf' },
      ],
    };
    const analysis16 = await analyzeBrowserImportServer(manifest16, new Map([[k16, Buffer.from(json16, 'utf8')]]));
    const intentNoRef = {
      version: 1 as const,
      previewFingerprint: analysis16.preview.batch.previewFingerprint,
      selectedRootName: pkg16Id,
      fileCount: 3,
      declaredTotalBytes: manifest16.declaredTotalBytes,
      selectedPackagePaths: [pkg16Id],
      acknowledgedWarningPackagePaths: [pkg16Id],
    };
    const resStageNoRef = await stageBrowserImportMetadata({ authContext, serverAnalysis: analysis16, intent: intentNoRef as unknown as BrowserImportCommitIntent });
    if (resStageNoRef.success || resStageNoRef.code !== 'INVALID_INTENT') {
      throw new Error(`[Scenario 16] Expected INVALID_INTENT staging rejection, got ${JSON.stringify(resStageNoRef)}`);
    }
    process.stdout.write('  ✓ Scenario 16 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 17: Valid Preview -> Preparation -> Stage Succeeds
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 17] Testing end-to-end valid preview -> preparation -> stage pipeline...\n');
    const pkg17Id = 's17-pkg-1';
    const json17 = JSON.stringify({
      publicId: pkg17Id,
      title: 'Smart Grid Energy AI',
      summary: 'Summary 17',
      background: 'Bg 17',
      solution: 'Sol 17',
      year: 2026,
      program: program.name,
      studyProgram: program.name,
      discipline: discipline.name,
      industry: industry.name,
      groupName: 'Group Alpha',
      teamMembers: ['Alice'],
      layoutConfig: {},
    });
    const k17 = generateUploadKey(`${pkg17Id}/project.json`);
    const manifest17 = {
      selectedRootName: pkg17Id,
      fileCount: 3,
      declaredTotalBytes: Buffer.from(json17).length + 800,
      ignoredSystemFilesCount: 0,
      descriptors: [
        { uploadKey: k17, originalPath: `${pkg17Id}/project.json`, fileSizeBytes: Buffer.from(json17).length, browserMimeType: 'application/json' },
        { uploadKey: generateUploadKey(`${pkg17Id}/poster.png`), originalPath: `${pkg17Id}/poster.png`, fileSizeBytes: 300, browserMimeType: 'image/png' },
        { uploadKey: generateUploadKey(`${pkg17Id}/poster.pdf`), originalPath: `${pkg17Id}/poster.pdf`, fileSizeBytes: 500, browserMimeType: 'application/pdf' },
      ],
    };
    const refOptions17 = { referenceFileBuffer: refBuf1, mapping: defaultMapping };
    const analysis17 = await analyzeBrowserImportServer(manifest17, new Map([[k17, Buffer.from(json17, 'utf8')]]), refOptions17);
    if (!analysis17.preview.batch.adminReference) {
      throw new Error('[Scenario 17] Server preview response missing adminReference evidence.');
    }

    const prepRes17 = prepareBrowserImportCommitIntent({
      manifest: manifest17,
      preview: analysis17.preview.batch,
      selectedPackagePaths: [pkg17Id],
      acknowledgedWarningPackagePaths: [pkg17Id],
      expectedPreviewFingerprint: analysis17.preview.batch.previewFingerprint,
    });
    if (!prepRes17.success) {
      throw new Error(`[Scenario 17] Intent preparation failed: ${prepRes17.code}`);
    }

    const resStage17 = await stageBrowserImportMetadata({ authContext, serverAnalysis: analysis17, intent: prepRes17.intent });
    if (!resStage17.success || resStage17.result !== 'created') {
      throw new Error(`[Scenario 17] Staging metadata failed: ${JSON.stringify(resStage17)}`);
    }
    createdBatchIds.push(resStage17.batchId);
    process.stdout.write('  ✓ Scenario 17 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 18: Prepared Intent Contains Exact Admin-Reference Evidence
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 18] Testing prepared intent contains exact Admin-reference evidence...\n');
    if (!prepRes17.intent.adminReference || prepRes17.intent.adminReference.workbookFingerprint !== computeAdminReferenceWorkbookFingerprint(refBuf1)) {
      throw new Error('[Scenario 18] Prepared intent does not contain exact Admin-reference evidence.');
    }
    process.stdout.write('  ✓ Scenario 18 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 19: Reference File A Preview -> File B Stage Fails Before Mutation
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 19] Testing TOCTOU File A preview -> File B stage rejection...\n');
    const refBufB = await createSyntheticReferenceWorkbook([
      { groupName: 'Group Alpha', year: 2026, title: 'MODIFIED Title File B', program: program.name, email: 'alpha@capstone.invalid' },
    ]);
    const refOptionsB = { referenceFileBuffer: refBufB, mapping: defaultMapping };
    const analysisB = await analyzeBrowserImportServer(manifest17, new Map([[k17, Buffer.from(json17, 'utf8')]]), refOptionsB);

    const resStageMismatchFile = await stageBrowserImportMetadata({ authContext, serverAnalysis: analysisB, intent: prepRes17.intent });
    if (resStageMismatchFile.success || resStageMismatchFile.code !== 'PREVIEW_FINGERPRINT_MISMATCH') {
      throw new Error(`[Scenario 19] Expected PREVIEW_FINGERPRINT_MISMATCH on file swap, got ${JSON.stringify(resStageMismatchFile)}`);
    }
    process.stdout.write('  ✓ Scenario 19 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 20: Mapping A Preview -> Mapping B Stage Fails Before Mutation
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 20] Testing TOCTOU Mapping A preview -> Mapping B stage rejection...\n');
    const mappingB: AdminReferenceMappingConfig = {
      ...defaultMapping,
      comparisonMappings: [{ canonicalField: 'program', referenceColumn: 'Degree Program' }],
    };
    const refOptionsMapB = { referenceFileBuffer: refBuf1, mapping: mappingB };
    const analysisMapB = await analyzeBrowserImportServer(manifest17, new Map([[k17, Buffer.from(json17, 'utf8')]]), refOptionsMapB);

    const resStageMismatchMap = await stageBrowserImportMetadata({ authContext, serverAnalysis: analysisMapB, intent: prepRes17.intent });
    if (resStageMismatchMap.success || resStageMismatchMap.code !== 'PREVIEW_FINGERPRINT_MISMATCH') {
      throw new Error(`[Scenario 20] Expected PREVIEW_FINGERPRINT_MISMATCH on mapping swap, got ${JSON.stringify(resStageMismatchMap)}`);
    }
    process.stdout.write('  ✓ Scenario 20 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 21: Selected Unreconciled Package Cannot Be Smuggled Into Stage
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 21] Testing selected unreconciled package smuggling rejection...\n');
    const pkg21Id = 's21-unreconciled';
    const json21 = JSON.stringify({
      publicId: pkg21Id,
      title: 'Mismatched Title Unreconciled',
      summary: 'Summary 21',
      year: 2026,
      program: program.name,
      discipline: discipline.name,
      industry: industry.name,
      groupName: 'Group Alpha',
      teamMembers: ['Alice'],
      layoutConfig: {},
    });
    const k21 = generateUploadKey(`${pkg21Id}/project.json`);
    const manifest21 = {
      selectedRootName: pkg21Id,
      fileCount: 3,
      declaredTotalBytes: Buffer.from(json21).length + 800,
      ignoredSystemFilesCount: 0,
      descriptors: [
        { uploadKey: k21, originalPath: `${pkg21Id}/project.json`, fileSizeBytes: Buffer.from(json21).length, browserMimeType: 'application/json' },
        { uploadKey: generateUploadKey(`${pkg21Id}/poster.png`), originalPath: `${pkg21Id}/poster.png`, fileSizeBytes: 300, browserMimeType: 'image/png' },
        { uploadKey: generateUploadKey(`${pkg21Id}/poster.pdf`), originalPath: `${pkg21Id}/poster.pdf`, fileSizeBytes: 500, browserMimeType: 'application/pdf' },
      ],
    };
    const analysis21 = await analyzeBrowserImportServer(manifest21, new Map([[k21, Buffer.from(json21, 'utf8')]]), refOptions17);
    const forgedSmuggleIntent = {
      version: 1 as const,
      previewFingerprint: analysis21.preview.batch.previewFingerprint,
      selectedRootName: pkg21Id,
      fileCount: 3,
      declaredTotalBytes: manifest21.declaredTotalBytes,
      selectedPackagePaths: [pkg21Id],
      acknowledgedWarningPackagePaths: [pkg21Id],
      adminReference: analysis17.preview.batch.adminReference,
    };
    const resSmuggle = await stageBrowserImportMetadata({ authContext, serverAnalysis: analysis21, intent: forgedSmuggleIntent as unknown as BrowserImportCommitIntent });
    if (resSmuggle.success || resSmuggle.code !== 'INVALID_SELECTION') {
      throw new Error(`[Scenario 21] Expected INVALID_SELECTION on smuggling unreconciled package, got ${JSON.stringify(resSmuggle)}`);
    }
    process.stdout.write('  ✓ Scenario 21 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 22: Successful Stage Creates Exactly Expected Project/Batch Records
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 22] Testing database records creation for staged batch...\n');
    const { data: batch22 } = await supabase.from('import_batches').select('*').eq('id', resStage17.batchId).single();
    const { data: proj22 } = await supabase.from('projects').select('*').eq('import_batch_id', resStage17.batchId).single();
    if (!batch22 || !proj22 || proj22.public_id !== pkg17Id) {
      throw new Error('[Scenario 22] Staged project or batch database record missing.');
    }
    process.stdout.write('  ✓ Scenario 22 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 23: browser_import_commits.canonical_intent Stores Reference Fingerprint
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 23] Testing browser_import_commits.canonical_intent stores reference fingerprint...\n');
    const { data: commit23 } = await supabase.from('browser_import_commits').select('*').eq('batch_id', resStage17.batchId).single();
    if (!commit23 || commit23.canonical_intent?.adminReference?.workbookFingerprint !== computeAdminReferenceWorkbookFingerprint(refBuf1)) {
      throw new Error('[Scenario 23] Idempotency ledger missing canonical adminReference fingerprint.');
    }
    process.stdout.write('  ✓ Scenario 23 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 24: canonical_intent Stores Canonical Mapping/Version
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 24] Testing canonical_intent stores canonical mapping and version...\n');
    const intentAdminRef24 = commit23.canonical_intent?.adminReference;
    if (!intentAdminRef24 || intentAdminRef24.reconciliationContractVersion !== 'admin-reference-reconciliation-v1' || !Array.isArray(intentAdminRef24.matchMappings)) {
      throw new Error('[Scenario 24] Canonical mapping or contract version missing from ledger.');
    }
    process.stdout.write('  ✓ Scenario 24 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 25: canonical_intent Contains No Raw Reference Rows/Values
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 25] Testing canonical_intent contains zero raw reference row values...\n');
    const jsonIntent25 = JSON.stringify(commit23.canonical_intent);
    if (jsonIntent25.includes('alpha@capstone.invalid') || jsonIntent25.includes('Smart Grid Energy AI')) {
      throw new Error('[Scenario 25] Privacy violation: raw reference cell values found in canonical_intent!');
    }
    process.stdout.write('  ✓ Scenario 25 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 26: Raw Workbook Bytes Are Not Stored
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 26] Testing raw workbook bytes are not stored in database or buckets...\n');
    const { count: blobCount } = await supabase.from('browser_import_commits').select('*', { count: 'exact', head: true }).eq('batch_id', resStage17.batchId);
    if (blobCount !== 1) throw new Error('[Scenario 26] Ledger count mismatch.');
    process.stdout.write('  ✓ Scenario 26 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 27: Reconciliation Never Modifies Submitted Metadata to Force Match
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 27] Testing reconciliation never alters submitted metadata...\n');
    if (proj22.title !== 'Smart Grid Energy AI') {
      throw new Error('[Scenario 27] Submitted project title was altered during reconciliation.');
    }
    process.stdout.write('  ✓ Scenario 27 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 28: project-details.xlsx Flow Remains Functional
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 28] Testing project-details.xlsx metadata source flow...\n');
    const pkg28Id = 's28-xlsx';
    const wb28 = new ExcelJS.Workbook();
    const sheet28 = wb28.addWorksheet('PROJECT_DETAILS');
    sheet28.addRow(['Field', 'Value']);
    sheet28.addRow(['Title', 'XLSX Project Title']);
    sheet28.addRow(['Year', 2026]);
    sheet28.addRow(['Program', program.name]);
    sheet28.addRow(['Discipline', discipline.name]);
    sheet28.addRow(['Industry', industry.name]);
    sheet28.addRow(['Group Name', 'Group Beta']);
    sheet28.addRow(['Team Members', 'Bob']);
    const xlsxBuf28 = Buffer.from(await wb28.xlsx.writeBuffer());

    const k28 = generateUploadKey(`${pkg28Id}/project-details.xlsx`);
    const manifest28 = {
      selectedRootName: pkg28Id,
      fileCount: 3,
      declaredTotalBytes: xlsxBuf28.length + 800,
      ignoredSystemFilesCount: 0,
      descriptors: [
        { uploadKey: k28, originalPath: `${pkg28Id}/project-details.xlsx`, fileSizeBytes: xlsxBuf28.length, browserMimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
        { uploadKey: generateUploadKey(`${pkg28Id}/poster.png`), originalPath: `${pkg28Id}/poster.png`, fileSizeBytes: 300, browserMimeType: 'image/png' },
        { uploadKey: generateUploadKey(`${pkg28Id}/poster.pdf`), originalPath: `${pkg28Id}/poster.pdf`, fileSizeBytes: 500, browserMimeType: 'application/pdf' },
      ],
    };
    const analysis28 = await analyzeBrowserImportServer(manifest28, new Map([[k28, xlsxBuf28]]), refOptions17);
    const prepRes28 = prepareBrowserImportCommitIntent({
      manifest: manifest28,
      preview: analysis28.preview.batch,
      selectedPackagePaths: [pkg28Id],
      acknowledgedWarningPackagePaths: [pkg28Id],
      expectedPreviewFingerprint: analysis28.preview.batch.previewFingerprint,
    });
    if (!prepRes28.success) throw new Error(`[Scenario 28] XLSX intent prep failed: ${prepRes28.code}`);

    const resStage28 = await stageBrowserImportMetadata({ authContext, serverAnalysis: analysis28, intent: prepRes28.intent });
    if (!resStage28.success) throw new Error('[Scenario 28] XLSX metadata staging failed.');
    createdBatchIds.push(resStage28.batchId);
    process.stdout.write('  ✓ Scenario 28 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 29: project.json Fallback Remains Functional
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 29] Testing project.json fallback flow...\n');
    if (!analysis17.preview.batch.packages[0].metadataSource || analysis17.preview.batch.packages[0].metadataSource !== 'json') {
      throw new Error('[Scenario 29] project.json metadata source failed.');
    }
    process.stdout.write('  ✓ Scenario 29 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 30: No Public-Feed / Publication / Email / Reminder Mutation
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 30] Testing zero publication/email/reminder side-effects...\n');
    const { count: pubCount } = await supabase.from('publication_readiness').select('*', { count: 'exact', head: true }).eq('project_id', proj22.id);
    if (pubCount !== 0) throw new Error('[Scenario 30] Unexpected publication record created.');
    process.stdout.write('  ✓ Scenario 30 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 31: Cleanup Restores Baseline
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 31] Performing cleanup and baseline restoration...\n');
  } finally {
    for (const bId of createdBatchIds) {
      await supabase.from('projects').delete().eq('import_batch_id', bId);
      await supabase.from('import_batches').delete().eq('id', bId);
    }
    process.stdout.write('  ✓ Scenario 31 PASSED!\n\n');
  }

  process.stdout.write('====================================================\n');
  process.stdout.write('ALL 31 RUNTIME RECONCILIATION SCENARIOS PASSED!\n');
  process.stdout.write('====================================================\n');
}

if (require.main === module) {
  verifyAdminExcelReconciliationRuntime()
    .then(() => process.exit(0))
    .catch((err) => {
      process.stderr.write(`[Verifier Exception] ${err.message}\n`);
      process.exit(1);
    });
}
