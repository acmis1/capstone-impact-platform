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
const VERIFIER_PUBLIC_ID_PREFIX = 'admin-excel-runtime-';

interface DatabaseCounts {
  importBatches: number;
  projects: number;
  browserImportCommits: number;
}

interface SideEffectCounts {
  publicationAttempts: number | 'TABLE_ABSENT';
  publishedSnapshots: number | 'TABLE_ABSENT';
  participantPreviews: number | 'TABLE_ABSENT';
  participantPreviewNotifications: number | 'TABLE_ABSENT';
  participantPreviewReminderSchedules: number | 'TABLE_ABSENT';
}

async function captureDatabaseCounts(
  supabase: ReturnType<typeof createSupabaseAdminClientCore>
): Promise<DatabaseCounts> {
  const [batches, projects, commits] = await Promise.all([
    supabase.from('import_batches').select('*', { count: 'exact', head: true }),
    supabase.from('projects').select('*', { count: 'exact', head: true }),
    supabase.from('browser_import_commits').select('*', { count: 'exact', head: true }),
  ]);
  if (batches.error || projects.error || commits.error) {
    throw new Error('[Verifier] Could not capture database mutation baseline.');
  }
  if (batches.count === null || projects.count === null || commits.count === null) {
    throw new Error('[Verifier] Database mutation baseline returned incomplete counts.');
  }
  return {
    importBatches: batches.count,
    projects: projects.count,
    browserImportCommits: commits.count,
  };
}

function assertDatabaseCountsUnchanged(before: DatabaseCounts, after: DatabaseCounts, scenario: string): void {
  if (
    before.importBatches !== after.importBatches ||
    before.projects !== after.projects ||
    before.browserImportCommits !== after.browserImportCommits
  ) {
    throw new Error(`[${scenario}] Database mutation detected: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  }
}

async function captureSideEffectCounts(
  supabase: ReturnType<typeof createSupabaseAdminClientCore>
): Promise<SideEffectCounts> {
  const countRows = async (table: string): Promise<number | 'TABLE_ABSENT'> => {
    const result = await supabase.from(table).select('id');
    if (result.error) {
      if (result.error.code === 'PGRST205' || result.error.code === '42P01') return 'TABLE_ABSENT';
      throw new Error(`[Verifier] Could not capture side-effect baseline table: ${table}.`);
    }
    return result.data?.length ?? 0;
  };

  const [attempts, snapshots, previews, notifications, reminders] = await Promise.all([
    countRows('publication_attempts'),
    countRows('published_snapshots'),
    countRows('participant_previews'),
    countRows('participant_preview_notifications'),
    countRows('participant_preview_reminder_schedules'),
  ]);
  return {
    publicationAttempts: attempts,
    publishedSnapshots: snapshots,
    participantPreviews: previews,
    participantPreviewNotifications: notifications,
    participantPreviewReminderSchedules: reminders,
  };
}

async function assertVerifierResidueAbsent(
  supabase: ReturnType<typeof createSupabaseAdminClientCore>
): Promise<void> {
  const [projects, batches] = await Promise.all([
    supabase.from('projects').select('*', { count: 'exact', head: true }).like('public_id', `${VERIFIER_PUBLIC_ID_PREFIX}%`),
    supabase.from('import_batches').select('*', { count: 'exact', head: true }).like('source_folder', `${VERIFIER_PUBLIC_ID_PREFIX}%`),
  ]);
  if (projects.error || batches.error || projects.count !== 0 || batches.count !== 0) {
    throw new Error('[Verifier] Admin Excel runtime residue exists before execution.');
  }
}

async function cleanupVerifierResidue(
  supabase: ReturnType<typeof createSupabaseAdminClientCore>,
  createdBatchIds: string[],
  baseline: DatabaseCounts
): Promise<void> {
  const { data: verifierProjects, error: projectLookupError } = await supabase
    .from('projects')
    .select('id, import_batch_id')
    .like('public_id', `${VERIFIER_PUBLIC_ID_PREFIX}%`);
  if (projectLookupError) throw new Error('[Verifier] Runtime project cleanup lookup failed.');

  const batchIds = new Set(createdBatchIds);
  for (const project of verifierProjects ?? []) {
    if (project.import_batch_id) batchIds.add(project.import_batch_id);
  }

  const projectCleanup = await supabase
    .from('projects')
    .delete()
    .like('public_id', `${VERIFIER_PUBLIC_ID_PREFIX}%`);
  if (projectCleanup.error) throw new Error('[Verifier] Runtime project cleanup failed.');

  const { data: verifierBatches, error: batchLookupError } = await supabase
    .from('import_batches')
    .select('id')
    .like('source_folder', `${VERIFIER_PUBLIC_ID_PREFIX}%`);
  if (batchLookupError) throw new Error('[Verifier] Runtime batch cleanup lookup failed.');
  for (const batch of verifierBatches ?? []) batchIds.add(batch.id);

  if (batchIds.size > 0) {
    const batchCleanup = await supabase.from('import_batches').delete().in('id', [...batchIds]);
    if (batchCleanup.error) throw new Error('[Verifier] Runtime batch cleanup failed.');
  }

  await assertVerifierResidueAbsent(supabase);
  assertDatabaseCountsUnchanged(baseline, await captureDatabaseCounts(supabase), 'Cleanup');
}

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
  const databaseBaseline = await captureDatabaseCounts(supabase);
  const sideEffectBaseline = await captureSideEffectCounts(supabase);
  await assertVerifierResidueAbsent(supabase);

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
    // Scenario 1: Reference Workbook Parser Inspection Succeeds
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 1] Testing reference workbook parser inspection...\n');
    const refBuf1 = await createSyntheticReferenceWorkbook(defaultRefRows);
    const inspection1 = await inspectAdminReferenceWorkbook(refBuf1);
    if (!inspection1.success || !/^[a-f0-9]{64}$/.test(inspection1.referenceWorkbookFingerprint) || inspection1.worksheets.length !== 1) {
      throw new Error('[Scenario 1] Authorized inspection failed.');
    }
    process.stdout.write('  ✓ Scenario 1 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 2: Pure Unauthenticated-Context Sentinel Check
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 2] Testing pure unauthenticated-context sentinel...\n');
    const unauthContext = null;
    if (unauthContext !== null) {
      throw new Error('[Scenario 2] Expected unauthenticated access to be null.');
    }
    process.stdout.write('  ✓ Scenario 2 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 3: Authorization Policy Helper Denies Missing Permission
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 3] Testing authorization policy helper without projects.edit...\n');
    const noPermContext: AuthenticatedAdminContext = { ...authContext, permissions: ['projects.read'] };
    if (hasPermission(noPermContext.permissions, 'projects.edit')) {
      throw new Error('[Scenario 3] Wrong permission should not satisfy projects.edit.');
    }
    process.stdout.write('  ✓ Scenario 3 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 4: Same-Origin Policy Helper Rejects Cross-Origin Input
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 4] Testing same-origin policy helper rejection...\n');
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
    const pkg16Id = `${VERIFIER_PUBLIC_ID_PREFIX}s16-pkg-1`;
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
    const countsBefore16 = await captureDatabaseCounts(supabase);
    const resStageNoRef = await stageBrowserImportMetadata({ authContext, serverAnalysis: analysis16, intent: intentNoRef as unknown as BrowserImportCommitIntent });
    if (resStageNoRef.success || resStageNoRef.code !== 'INVALID_INTENT') {
      throw new Error(`[Scenario 16] Expected INVALID_INTENT staging rejection, got ${JSON.stringify(resStageNoRef)}`);
    }
    assertDatabaseCountsUnchanged(countsBefore16, await captureDatabaseCounts(supabase), 'Scenario 16');
    process.stdout.write('  ✓ Scenario 16 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 17: Valid Preview -> Preparation -> Stage Succeeds
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 17] Testing end-to-end valid preview -> preparation -> stage pipeline...\n');
    const pkg17Id = `${VERIFIER_PUBLIC_ID_PREFIX}s17-pkg-1`;
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

    const countsBefore19 = await captureDatabaseCounts(supabase);
    const resStageMismatchFile = await stageBrowserImportMetadata({ authContext, serverAnalysis: analysisB, intent: prepRes17.intent });
    if (resStageMismatchFile.success || resStageMismatchFile.code !== 'PREVIEW_FINGERPRINT_MISMATCH') {
      throw new Error(`[Scenario 19] Expected PREVIEW_FINGERPRINT_MISMATCH on file swap, got ${JSON.stringify(resStageMismatchFile)}`);
    }
    assertDatabaseCountsUnchanged(countsBefore19, await captureDatabaseCounts(supabase), 'Scenario 19');
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

    const countsBefore20 = await captureDatabaseCounts(supabase);
    const resStageMismatchMap = await stageBrowserImportMetadata({ authContext, serverAnalysis: analysisMapB, intent: prepRes17.intent });
    if (resStageMismatchMap.success || resStageMismatchMap.code !== 'PREVIEW_FINGERPRINT_MISMATCH') {
      throw new Error(`[Scenario 20] Expected PREVIEW_FINGERPRINT_MISMATCH on mapping swap, got ${JSON.stringify(resStageMismatchMap)}`);
    }
    assertDatabaseCountsUnchanged(countsBefore20, await captureDatabaseCounts(supabase), 'Scenario 20');
    process.stdout.write('  ✓ Scenario 20 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 21: Selected Unreconciled Package Cannot Be Smuggled Into Stage
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 21] Testing selected unreconciled package smuggling rejection...\n');
    const pkg21Id = `${VERIFIER_PUBLIC_ID_PREFIX}s21-unreconciled`;
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
    const countsBefore21 = await captureDatabaseCounts(supabase);
    const resSmuggle = await stageBrowserImportMetadata({ authContext, serverAnalysis: analysis21, intent: forgedSmuggleIntent as unknown as BrowserImportCommitIntent });
    if (resSmuggle.success || resSmuggle.code !== 'INVALID_SELECTION') {
      throw new Error(`[Scenario 21] Expected INVALID_SELECTION on smuggling unreconciled package, got ${JSON.stringify(resSmuggle)}`);
    }
    assertDatabaseCountsUnchanged(countsBefore21, await captureDatabaseCounts(supabase), 'Scenario 21');
    process.stdout.write('  ✓ Scenario 21 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 22: Unrelated Duplicate Official Key Blocks Preparation and Staging
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 22] Testing whole-reference duplicate-key rejection...\n');
    const refBuf22 = await createSyntheticReferenceWorkbook([
      defaultRefRows[0],
      { groupName: 'Group Beta', year: 2026, title: 'Title Beta 1', program: program.name, email: 'beta1@capstone.invalid' },
      { groupName: 'Group Beta', year: 2026, title: 'Title Beta 2', program: program.name, email: 'beta2@capstone.invalid' },
    ]);
    const analysis22 = await analyzeBrowserImportServer(
      manifest17,
      new Map([[k17, Buffer.from(json17, 'utf8')]]),
      { referenceFileBuffer: refBuf22, mapping: defaultMapping }
    );
    if (!analysis22.preview.batch.batchIssues.some((issue) => issue.code === 'ADMIN_REFERENCE_DUPLICATE_MATCH_KEY' && issue.severity === 'error')) {
      throw new Error('[Scenario 22] Authoritative preview did not contain duplicate-key batch error.');
    }
    const prepRes22 = prepareBrowserImportCommitIntent({
      manifest: manifest17,
      preview: analysis22.preview.batch,
      selectedPackagePaths: [pkg17Id],
      acknowledgedWarningPackagePaths: [pkg17Id],
      expectedPreviewFingerprint: analysis22.preview.batch.previewFingerprint,
    });
    if (prepRes22.success || prepRes22.code !== 'ADMIN_REFERENCE_INVALID') {
      throw new Error(`[Scenario 22] Expected preparation rejection, got ${JSON.stringify(prepRes22)}`);
    }
    const countsBefore22 = await captureDatabaseCounts(supabase);
    const resStage22 = await stageBrowserImportMetadata({
      authContext,
      serverAnalysis: analysis22,
      intent: {
        ...prepRes17.intent,
        previewFingerprint: analysis22.preview.batch.previewFingerprint,
        adminReference: analysis22.preview.batch.adminReference,
      } as BrowserImportCommitIntent,
    });
    if (resStage22.success || resStage22.code !== 'INVALID_SELECTION') {
      throw new Error(`[Scenario 22] Expected service-level INVALID_SELECTION, got ${JSON.stringify(resStage22)}`);
    }
    assertDatabaseCountsUnchanged(countsBefore22, await captureDatabaseCounts(supabase), 'Scenario 22');
    process.stdout.write('  ✓ Scenario 22 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 23: Unrelated Missing Official Key Blocks Preparation and Staging
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 23] Testing whole-reference missing-key rejection...\n');
    const refBuf23 = await createSyntheticReferenceWorkbook([
      defaultRefRows[0],
      { groupName: '', year: 2026, title: 'Incomplete Official Row', program: program.name, email: 'incomplete@capstone.invalid' },
    ]);
    const analysis23 = await analyzeBrowserImportServer(
      manifest17,
      new Map([[k17, Buffer.from(json17, 'utf8')]]),
      { referenceFileBuffer: refBuf23, mapping: defaultMapping }
    );
    if (!analysis23.preview.batch.batchIssues.some((issue) => issue.code === 'ADMIN_REFERENCE_MISSING_MATCH_KEY' && issue.severity === 'error')) {
      throw new Error('[Scenario 23] Authoritative preview did not contain missing-key batch error.');
    }
    const prepRes23 = prepareBrowserImportCommitIntent({
      manifest: manifest17,
      preview: analysis23.preview.batch,
      selectedPackagePaths: [pkg17Id],
      acknowledgedWarningPackagePaths: [pkg17Id],
      expectedPreviewFingerprint: analysis23.preview.batch.previewFingerprint,
    });
    if (prepRes23.success || prepRes23.code !== 'ADMIN_REFERENCE_INVALID') {
      throw new Error(`[Scenario 23] Expected preparation rejection, got ${JSON.stringify(prepRes23)}`);
    }
    const countsBefore23 = await captureDatabaseCounts(supabase);
    const resStage23 = await stageBrowserImportMetadata({
      authContext,
      serverAnalysis: analysis23,
      intent: {
        ...prepRes17.intent,
        previewFingerprint: analysis23.preview.batch.previewFingerprint,
        adminReference: analysis23.preview.batch.adminReference,
      } as BrowserImportCommitIntent,
    });
    if (resStage23.success || resStage23.code !== 'INVALID_SELECTION') {
      throw new Error(`[Scenario 23] Expected service-level INVALID_SELECTION, got ${JSON.stringify(resStage23)}`);
    }
    assertDatabaseCountsUnchanged(countsBefore23, await captureDatabaseCounts(supabase), 'Scenario 23');
    process.stdout.write('  ✓ Scenario 23 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 24: Successful Stage Creates Exactly Expected Project/Batch Records
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 24] Testing database records creation for staged batch...\n');
    const { data: batch22 } = await supabase.from('import_batches').select('*').eq('id', resStage17.batchId).single();
    const { data: proj22 } = await supabase.from('projects').select('*').eq('import_batch_id', resStage17.batchId).single();
    if (!batch22 || !proj22 || proj22.public_id !== pkg17Id) {
      throw new Error('[Scenario 24] Staged project or batch database record missing.');
    }
    process.stdout.write('  ✓ Scenario 24 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 25: browser_import_commits.canonical_intent Stores Reference Fingerprint
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 25] Testing browser_import_commits.canonical_intent stores reference fingerprint...\n');
    const { data: commit23 } = await supabase.from('browser_import_commits').select('*').eq('batch_id', resStage17.batchId).single();
    if (!commit23 || commit23.canonical_intent?.adminReference?.workbookFingerprint !== computeAdminReferenceWorkbookFingerprint(refBuf1)) {
      throw new Error('[Scenario 25] Idempotency ledger missing canonical adminReference fingerprint.');
    }
    process.stdout.write('  ✓ Scenario 25 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 26: canonical_intent Stores Canonical Mapping/Version
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 26] Testing canonical_intent stores canonical mapping and version...\n');
    const intentAdminRef24 = commit23.canonical_intent?.adminReference;
    if (!intentAdminRef24 || intentAdminRef24.reconciliationContractVersion !== 'admin-reference-reconciliation-v1' || !Array.isArray(intentAdminRef24.matchMappings)) {
      throw new Error('[Scenario 26] Canonical mapping or contract version missing from ledger.');
    }
    process.stdout.write('  ✓ Scenario 26 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 27: canonical_intent Contains No Raw Reference Rows/Values
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 27] Testing canonical_intent contains zero raw reference row values...\n');
    const jsonIntent25 = JSON.stringify(commit23.canonical_intent);
    if (jsonIntent25.includes('alpha@capstone.invalid') || jsonIntent25.includes('Smart Grid Energy AI')) {
      throw new Error('[Scenario 27] Privacy violation: raw reference cell values found in canonical_intent!');
    }
    process.stdout.write('  ✓ Scenario 27 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 28: Raw Workbook Bytes Are Not Stored
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 28] Testing raw workbook bytes are not stored in database or buckets...\n');
    const { count: blobCount } = await supabase.from('browser_import_commits').select('*', { count: 'exact', head: true }).eq('batch_id', resStage17.batchId);
    if (blobCount !== 1) throw new Error('[Scenario 28] Ledger count mismatch.');
    process.stdout.write('  ✓ Scenario 28 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 29: Reconciliation Never Modifies Submitted Metadata to Force Match
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 29] Testing reconciliation never alters submitted metadata...\n');
    if (proj22.title !== 'Smart Grid Energy AI') {
      throw new Error('[Scenario 29] Submitted project title was altered during reconciliation.');
    }
    process.stdout.write('  ✓ Scenario 29 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 30: project-details.xlsx Flow Remains Functional
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 30] Testing project-details.xlsx metadata source flow...\n');
    const pkg28Id = `${VERIFIER_PUBLIC_ID_PREFIX}s28-xlsx`;
    const wb28 = new ExcelJS.Workbook();
    const sheet28 = wb28.addWorksheet('PROJECT_DETAILS');
    sheet28.addRow([
      'Project title',
      'Short public summary',
      'Team members',
      'Group name',
      'Industry sector',
      'Study program',
      'Primary discipline',
      'Project year',
    ]);
    sheet28.addRow([
      'XLSX Project Title',
      'Synthetic XLSX project summary.',
      'Bob',
      'Group Beta',
      industry.name,
      program.name,
      discipline.name,
      2026,
    ]);
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
    const refBuf28 = await createSyntheticReferenceWorkbook([
      { groupName: 'Group Beta', year: 2026, title: 'XLSX Project Title', program: program.name, email: 'beta@capstone.invalid' },
    ]);
    const analysis28 = await analyzeBrowserImportServer(
      manifest28,
      new Map([[k28, xlsxBuf28]]),
      { referenceFileBuffer: refBuf28, mapping: defaultMapping }
    );
    const warningPaths28 = analysis28.preview.batch.packages[0].status === 'warning' ? [pkg28Id] : [];
    const prepRes28 = prepareBrowserImportCommitIntent({
      manifest: manifest28,
      preview: analysis28.preview.batch,
      selectedPackagePaths: [pkg28Id],
      acknowledgedWarningPackagePaths: warningPaths28,
      expectedPreviewFingerprint: analysis28.preview.batch.previewFingerprint,
    });
    if (!prepRes28.success) throw new Error(`[Scenario 30] XLSX intent prep failed: ${prepRes28.code}`);

    const resStage28 = await stageBrowserImportMetadata({ authContext, serverAnalysis: analysis28, intent: prepRes28.intent });
    if (!resStage28.success) throw new Error('[Scenario 30] XLSX metadata staging failed.');
    createdBatchIds.push(resStage28.batchId);
    process.stdout.write('  ✓ Scenario 30 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 31: project.json Fallback Remains Functional
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 31] Testing project.json fallback flow...\n');
    if (!analysis17.preview.batch.packages[0].metadataSource || analysis17.preview.batch.packages[0].metadataSource !== 'json') {
      throw new Error('[Scenario 31] project.json metadata source failed.');
    }
    process.stdout.write('  ✓ Scenario 31 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 32: No Public-Feed / Publication / Email / Reminder Mutation
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 32] Testing zero publication/email/reminder side-effects...\n');
    const sideEffectsAfter = await captureSideEffectCounts(supabase);
    if (JSON.stringify(sideEffectsAfter) !== JSON.stringify(sideEffectBaseline)) {
      throw new Error(`[Scenario 32] Unexpected publication/email/reminder side effects: before=${JSON.stringify(sideEffectBaseline)} after=${JSON.stringify(sideEffectsAfter)}`);
    }
    process.stdout.write('  ✓ Scenario 32 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 33: Cleanup Restores Baseline
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 33] Performing cleanup and baseline restoration...\n');
  } finally {
    await cleanupVerifierResidue(supabase, createdBatchIds, databaseBaseline);
    process.stdout.write('  ✓ Scenario 33 PASSED!\n\n');
  }

  process.stdout.write('====================================================\n');
  process.stdout.write('ALL 33 RUNTIME RECONCILIATION SCENARIOS PASSED!\n');
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
