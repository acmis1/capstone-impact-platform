import { execFileSync, execSync } from 'node:child_process';
import path from 'node:path';
import { createSupabaseAdminClientCore } from '../lib/supabase/adminCore';
import { analyzeBrowserImportServer } from '../import/parseBrowserImportPreview';
import { stageBrowserImportMetadata } from '../import/stageBrowserImportMetadata';
import { generateUploadKey } from '../import/browserSelection';
import { AuthenticatedAdminContext } from '../auth/authTypes';
import { isLoopbackUrl, parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';
import { getStagingBuckets } from '../lib/supabase/buckets';

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
    // If CLI status fails, fall back to checking if environment is already configured
  }

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Staging Configuration Error: Required public client variables are missing. NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing.');
  }
}

interface StorageSnapshot {
  draftObjects: string[];
  publicObjects: string[];
}

async function captureStorageSnapshot(): Promise<StorageSnapshot> {
  const supabase = createSupabaseAdminClientCore();
  const buckets = getStagingBuckets();

  return {
    draftObjects: await listStorageObjects(supabase, buckets.DRAFT_PRIVATE),
    publicObjects: await listStorageObjects(supabase, buckets.PUBLIC_ASSETS),
  };
}

async function listStorageObjects(
  supabase: ReturnType<typeof createSupabaseAdminClientCore>,
  bucket: string,
  prefix = ''
): Promise<string[]> {
  const { data, error } = await supabase.storage.from(bucket).list(prefix, { limit: 1000 });
  if (error || !data) {
    throw new Error(`[Verifier Storage Failure] Could not list configured bucket ${bucket}.`);
  }

  const paths: string[] = [];
  for (const entry of data) {
    const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.id === null) {
      paths.push(...await listStorageObjects(supabase, bucket, fullPath));
    } else {
      paths.push(fullPath);
    }
  }
  return paths.sort();
}

function assertStorageUnchanged(before: StorageSnapshot, after: StorageSnapshot, label: string): void {
  if (
    before.draftObjects.length !== after.draftObjects.length ||
    !before.draftObjects.every((name, i) => name === after.draftObjects[i]) ||
    before.publicObjects.length !== after.publicObjects.length ||
    !before.publicObjects.every((name, i) => name === after.publicObjects[i])
  ) {
    throw new Error(`[Verifier Storage Failure] Storage objects mutated during scenario: ${label}`);
  }
}

function executeLocalDatabaseSql(sql: string): void {
  const containers = execSync('docker ps --filter "name=^/supabase_db_" --format "{{.Names}}"', {
    encoding: 'utf8',
  })
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter((name) => /^supabase_db_[a-z0-9_-]+$/i.test(name));

  if (containers.length !== 1) {
    throw new Error('Expected exactly one disposable local Supabase database container.');
  }

  execFileSync(
    'docker',
    ['exec', '-i', containers[0], 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'],
    { input: sql, stdio: ['pipe', 'ignore', 'pipe'] }
  );
}

function assertRollbackResidueAbsent(packageId: string): void {
  if (!/^[a-z0-9-]+$/i.test(packageId)) {
    throw new Error('Rollback fixture package ID is invalid.');
  }
  executeLocalDatabaseSql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM public.import_batches WHERE source_folder = '${packageId}')
        OR EXISTS (SELECT 1 FROM public.projects WHERE public_id = '${packageId}')
        OR EXISTS (SELECT 1 FROM public.project_disciplines pd JOIN public.projects p ON p.id = pd.project_id WHERE p.public_id = '${packageId}')
        OR EXISTS (SELECT 1 FROM public.project_industry_categories pic JOIN public.projects p ON p.id = pic.project_id WHERE p.public_id = '${packageId}')
        OR EXISTS (SELECT 1 FROM public.validation_flags vf JOIN public.projects p ON p.id = vf.project_id WHERE p.public_id = '${packageId}')
        OR EXISTS (SELECT 1 FROM public.browser_import_commits bic JOIN public.import_batches ib ON ib.id = bic.batch_id WHERE ib.source_folder = '${packageId}')
        OR EXISTS (SELECT 1 FROM public.media_assets ma JOIN public.projects p ON p.id = ma.project_id WHERE p.public_id = '${packageId}') THEN
        RAISE EXCEPTION 'Rollback residue detected for ${packageId}';
      END IF;
    END;
    $$;
  `);
}

export async function verifyBrowserImportMetadataStageRuntime(): Promise<void> {
  ensureLocalEnvironmentVariables();
  process.stdout.write('=== Capstone Impact Platform: Local Supabase Browser Metadata Staging Runtime Acceptance ===\n\n');
  const supabase = createSupabaseAdminClientCore();

  // 1. Fetch valid seed administrator user
  const { data: adminUser, error: adminErr } = await supabase
    .from('admin_users')
    .select('id, email')
    .limit(1)
    .single();

  if (adminErr || !adminUser) {
    throw new Error(`[Verifier] Failed to find seed admin_user: ${adminErr?.message || 'No rows'}`);
  }

  const authContext: AuthenticatedAdminContext = {
    authUserId: adminUser.id,
    adminUserId: adminUser.id,
    email: adminUser.email,
    fullName: 'Test Admin',
    roles: ['admin'],
    permissions: ['projects.edit'],
  };

  // 2. Fetch seed taxonomy rows
  const { data: program } = await supabase.from('programs').select('id, name').limit(1).single();
  const { data: discipline } = await supabase.from('disciplines').select('id, name').limit(1).single();
  const { data: industry } = await supabase.from('industry_categories').select('id, name').limit(1).single();

  if (!program || !discipline || !industry) {
    throw new Error('[Verifier] Missing required seed taxonomy rows in local database.');
  }

  const createdBatchIds: string[] = [];

  try {
    // -------------------------------------------------------------------------
    // Scenario 1: Single-Package Staging & Deep Database Verification
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 1] Testing single-package staging and deep database row verification...\n');
    const storageBefore1 = await captureStorageSnapshot();
    const pkg1Id = 's1-pkg-1';
    const json1 = JSON.stringify({
      publicId: pkg1Id,
      title: 'Scenario 1 Title',
      summary: 'Scenario 1 Summary',
      background: 'Scenario 1 Background',
      solution: 'Scenario 1 Solution',
      year: 2026,
      program: program.name,
      studyProgram: 'Custom Study Program',
      discipline: discipline.name,
      industry: industry.name,
      groupName: 'Group Alpha',
      teamMembers: ['Alice', 'Bob'],
      layoutConfig: { templateId: 'poster_showcase', featuredMedia: 'poster' },
    });

    const key1 = generateUploadKey(`${pkg1Id}/project.json`);
    const manifest1 = {
      selectedRootName: pkg1Id,
      fileCount: 3,
      declaredTotalBytes: Buffer.from(json1).length + 800,
      ignoredSystemFilesCount: 0,
      descriptors: [
        { uploadKey: key1, originalPath: `${pkg1Id}/project.json`, fileSizeBytes: Buffer.from(json1).length, browserMimeType: 'application/json' },
        { uploadKey: generateUploadKey(`${pkg1Id}/poster.png`), originalPath: `${pkg1Id}/poster.png`, fileSizeBytes: 300, browserMimeType: 'image/png' },
        { uploadKey: generateUploadKey(`${pkg1Id}/poster.pdf`), originalPath: `${pkg1Id}/poster.pdf`, fileSizeBytes: 500, browserMimeType: 'application/pdf' },
      ],
    };
    const metaFiles1 = new Map<string, Buffer>([[key1, Buffer.from(json1, 'utf8')]]);
    const analysis1 = await analyzeBrowserImportServer(manifest1, metaFiles1);
    const intent1 = {
      version: 1 as const,
      previewFingerprint: analysis1.preview.batch.previewFingerprint,
      selectedRootName: pkg1Id,
      fileCount: 3,
      declaredTotalBytes: manifest1.declaredTotalBytes,
      selectedPackagePaths: [pkg1Id],
      acknowledgedWarningPackagePaths: [pkg1Id],
    };

    const res1 = await stageBrowserImportMetadata({ authContext, serverAnalysis: analysis1, intent: intent1 });
    if (!res1.success || res1.result !== 'created') {
      const pkgInfo = analysis1.packages[0];
      throw new Error(`[Scenario 1] Staging failed: ${JSON.stringify(res1)} | PkgStatus=${pkgInfo?.status} | PkgErrors=${JSON.stringify(pkgInfo?.errors)} | PkgWarnings=${JSON.stringify(pkgInfo?.warnings)}`);
    }
    createdBatchIds.push(res1.batchId);

    // Deep DB verification for Scenario 1
    const { data: batchRow } = await supabase.from('import_batches').select('*').eq('id', res1.batchId).single();
    if (!batchRow || batchRow.status !== 'metadata_staged' || batchRow.total_projects !== 1) {
      throw new Error('[Scenario 1] Import batch verification failed.');
    }

    const { data: projRow } = await supabase.from('projects').select('*').eq('import_batch_id', res1.batchId).single();
    if (!projRow || projRow.status !== 'draft' || projRow.public_id !== pkg1Id || projRow.program_id !== program.id) {
      throw new Error('[Scenario 1] Project row verification failed.');
    }

    const { count: discCount } = await supabase.from('project_disciplines').select('*', { count: 'exact', head: true }).eq('project_id', projRow.id);
    if (discCount !== 1) throw new Error('[Scenario 1] Discipline mapping count verification failed.');

    const { count: indCount } = await supabase.from('project_industry_categories').select('*', { count: 'exact', head: true }).eq('project_id', projRow.id);
    if (indCount !== 1) throw new Error('[Scenario 1] Industry mapping count verification failed.');

    const { data: commitRow, error: commitErr } = await supabase.from('browser_import_commits').select('*').eq('batch_id', res1.batchId).maybeSingle();
    if (!commitRow) {
      const { data: allCommits, error: allErr } = await supabase.from('browser_import_commits').select('*');
      throw new Error(`[Scenario 1] Idempotency ledger row missing for batch ${res1.batchId}. commitErr=${JSON.stringify(commitErr)} | allErr=${JSON.stringify(allErr)} | Existing ledger rows: ${JSON.stringify(allCommits)}`);
    }

    const storageAfter1 = await captureStorageSnapshot();
    assertStorageUnchanged(storageBefore1, storageAfter1, 'Scenario 1');
    process.stdout.write('  ✓ Scenario 1 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 2: Multi-Package Staging & Idempotent Retry & Storage Check
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 2] Testing multi-package selected staging & exact idempotency retry...\n');
    const storageBefore2 = await captureStorageSnapshot();
    const batchRoot2 = 's2-batch-1';
    const p1Path = `${batchRoot2}/pkg-a`;
    const p2Path = `${batchRoot2}/pkg-b`;

    const json2a = JSON.stringify({
      publicId: 's2-pkg-a',
      title: 'Batch Pkg A',
      summary: 'Summary A',
      background: 'Bg A',
      solution: 'Sol A',
      year: 2026,
      program: program.name,
      studyProgram: program.name,
      discipline: discipline.name,
      industry: industry.name,
      groupName: 'Group A',
      teamMembers: ['Alice'],
      layoutConfig: {},
    });

    const json2b = JSON.stringify({
      publicId: 's2-pkg-b',
      title: 'Batch Pkg B',
      summary: 'Summary B',
      background: 'Bg B',
      solution: 'Sol B',
      year: 2026,
      program: program.name,
      studyProgram: program.name,
      discipline: discipline.name,
      industry: industry.name,
      groupName: 'Group B',
      teamMembers: ['Bob'],
      layoutConfig: {},
    });

    const k2a = generateUploadKey(`${p1Path}/project.json`);
    const k2b = generateUploadKey(`${p2Path}/project.json`);
    const manifest2 = {
      selectedRootName: batchRoot2,
      fileCount: 6,
      declaredTotalBytes: Buffer.from(json2a).length + Buffer.from(json2b).length + 1600,
      ignoredSystemFilesCount: 0,
      descriptors: [
        { uploadKey: k2a, originalPath: `${p1Path}/project.json`, fileSizeBytes: Buffer.from(json2a).length, browserMimeType: 'application/json' },
        { uploadKey: generateUploadKey(`${p1Path}/poster.png`), originalPath: `${p1Path}/poster.png`, fileSizeBytes: 300, browserMimeType: 'image/png' },
        { uploadKey: generateUploadKey(`${p1Path}/poster.pdf`), originalPath: `${p1Path}/poster.pdf`, fileSizeBytes: 500, browserMimeType: 'application/pdf' },
        { uploadKey: k2b, originalPath: `${p2Path}/project.json`, fileSizeBytes: Buffer.from(json2b).length, browserMimeType: 'application/json' },
        { uploadKey: generateUploadKey(`${p2Path}/poster.png`), originalPath: `${p2Path}/poster.png`, fileSizeBytes: 300, browserMimeType: 'image/png' },
        { uploadKey: generateUploadKey(`${p2Path}/poster.pdf`), originalPath: `${p2Path}/poster.pdf`, fileSizeBytes: 500, browserMimeType: 'application/pdf' },
      ],
    };

    const metaFiles2 = new Map<string, Buffer>([
      [k2a, Buffer.from(json2a, 'utf8')],
      [k2b, Buffer.from(json2b, 'utf8')],
    ]);

    const analysis2 = await analyzeBrowserImportServer(manifest2, metaFiles2);
    const intent2 = {
      version: 1 as const,
      previewFingerprint: analysis2.preview.batch.previewFingerprint,
      selectedRootName: batchRoot2,
      fileCount: 6,
      declaredTotalBytes: manifest2.declaredTotalBytes,
      selectedPackagePaths: [p1Path, p2Path].sort(),
      acknowledgedWarningPackagePaths: [p1Path, p2Path].sort(),
    };

    const res2a = await stageBrowserImportMetadata({ authContext, serverAnalysis: analysis2, intent: intent2 });
    if (!res2a.success || res2a.result !== 'created' || res2a.projectCount !== 2) {
      throw new Error(`[Scenario 2] Multi-package staging creation failed: ${JSON.stringify(res2a)}`);
    }
    createdBatchIds.push(res2a.batchId);

    // Exact retry check
    const res2b = await stageBrowserImportMetadata({ authContext, serverAnalysis: analysis2, intent: intent2 });
    if (!res2b.success || res2b.result !== 'already_staged' || res2b.batchId !== res2a.batchId) {
      throw new Error(`[Scenario 2] Idempotent retry failed: ${JSON.stringify(res2b)}`);
    }

    const storageAfter2 = await captureStorageSnapshot();
    assertStorageUnchanged(storageBefore2, storageAfter2, 'Scenario 2');
    process.stdout.write('  ✓ Scenario 2 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 3: Real Concurrent Execution Protection
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 3] Testing real concurrent staging with Promise.all...\n');
    const storageBefore3 = await captureStorageSnapshot();
    const pkg3Id = 's3-pkg-1';
    const json3 = JSON.stringify({
      publicId: pkg3Id,
      title: 'Scenario 3 Title',
      summary: 'Scenario 3 Summary',
      year: 2026,
      program: program.name,
      discipline: discipline.name,
      groupName: 'Group Gamma',
      teamMembers: ['Charlie'],
      layoutConfig: {},
    });

    const k3 = generateUploadKey(`${pkg3Id}/project.json`);
    const manifest3 = {
      selectedRootName: pkg3Id,
      fileCount: 3,
      declaredTotalBytes: Buffer.from(json3).length + 800,
      ignoredSystemFilesCount: 0,
      descriptors: [
        { uploadKey: k3, originalPath: `${pkg3Id}/project.json`, fileSizeBytes: Buffer.from(json3).length, browserMimeType: 'application/json' },
        { uploadKey: generateUploadKey(`${pkg3Id}/poster.png`), originalPath: `${pkg3Id}/poster.png`, fileSizeBytes: 300, browserMimeType: 'image/png' },
        { uploadKey: generateUploadKey(`${pkg3Id}/poster.pdf`), originalPath: `${pkg3Id}/poster.pdf`, fileSizeBytes: 500, browserMimeType: 'application/pdf' },
      ],
    };
    const metaFiles3 = new Map<string, Buffer>([[k3, Buffer.from(json3, 'utf8')]]);
    const analysis3 = await analyzeBrowserImportServer(manifest3, metaFiles3);
    const intent3 = {
      version: 1 as const,
      previewFingerprint: analysis3.preview.batch.previewFingerprint,
      selectedRootName: pkg3Id,
      fileCount: 3,
      declaredTotalBytes: manifest3.declaredTotalBytes,
      selectedPackagePaths: [pkg3Id],
      acknowledgedWarningPackagePaths: [pkg3Id],
    };

    const [c3a, c3b] = await Promise.all([
      stageBrowserImportMetadata({ authContext, serverAnalysis: analysis3, intent: intent3 }),
      stageBrowserImportMetadata({ authContext, serverAnalysis: analysis3, intent: intent3 }),
    ]);

    if (!c3a.success || !c3b.success || c3a.batchId !== c3b.batchId) {
      throw new Error(`[Scenario 3] Concurrency check failed: ${JSON.stringify(c3a)} vs ${JSON.stringify(c3b)}`);
    }
    createdBatchIds.push(c3a.batchId);

    const { count: bCount3 } = await supabase.from('import_batches').select('*', { count: 'exact', head: true }).eq('source_folder', pkg3Id);
    if (bCount3 !== 1) throw new Error(`[Scenario 3] Expected exactly 1 import_batches row, found ${bCount3}`);

    const storageAfter3 = await captureStorageSnapshot();
    assertStorageUnchanged(storageBefore3, storageAfter3, 'Scenario 3');
    process.stdout.write('  ✓ Scenario 3 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 4: Controlled Failure Cases Before Mutations
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 4] Testing controlled failures before mutations and zero row residue...\n');
    const storageBefore4 = await captureStorageSnapshot();

    // 4a. Duplicate public ID conflict in database
    const conflictJson = json1.replace('Scenario 1 Title', 'Scenario 4 Conflict Title');
    const conflictKey = generateUploadKey(`${pkg1Id}/project.json`);
    const conflictManifest = {
      ...manifest1,
      declaredTotalBytes: Buffer.from(conflictJson).length + 800,
      descriptors: manifest1.descriptors.map((descriptor) =>
        descriptor.uploadKey === key1
          ? { ...descriptor, uploadKey: conflictKey, fileSizeBytes: Buffer.from(conflictJson).length }
          : descriptor
      ),
    };
    const conflictAnalysis = await analyzeBrowserImportServer(
      conflictManifest,
      new Map([[conflictKey, Buffer.from(conflictJson, 'utf8')]])
    );
    const failIntentDuplicatePubId = {
      ...intent1,
      previewFingerprint: conflictAnalysis.preview.batch.previewFingerprint,
      declaredTotalBytes: conflictManifest.declaredTotalBytes,
    };
    const resFail1 = await stageBrowserImportMetadata({
      authContext,
      serverAnalysis: conflictAnalysis,
      intent: failIntentDuplicatePubId,
    });
    if (resFail1.success || resFail1.code !== 'PROJECT_ALREADY_EXISTS') {
      throw new Error(`[Scenario 4a] Expected PROJECT_ALREADY_EXISTS, got ${JSON.stringify(resFail1)}`);
    }

    // 4b. Invalid taxonomy program lookup
    const jsonBadProgram = JSON.stringify({
      publicId: 'bad-prog-1',
      title: 'Bad Prog Title',
      summary: 'Bad Prog Summary',
      year: 2026,
      program: 'Nonexistent Program 999',
      discipline: discipline.name,
      groupName: 'Group X',
      teamMembers: ['Xavier'],
      layoutConfig: {},
    });
    const kBadProg = generateUploadKey('bad-prog-1/project.json');
    const manifestBadProg = {
      selectedRootName: 'bad-prog-1',
      fileCount: 3,
      declaredTotalBytes: Buffer.from(jsonBadProgram).length + 800,
      ignoredSystemFilesCount: 0,
      descriptors: [
        { uploadKey: kBadProg, originalPath: 'bad-prog-1/project.json', fileSizeBytes: Buffer.from(jsonBadProgram).length, browserMimeType: 'application/json' },
        { uploadKey: generateUploadKey('bad-prog-1/poster.png'), originalPath: 'bad-prog-1/poster.png', fileSizeBytes: 300, browserMimeType: 'image/png' },
        { uploadKey: generateUploadKey('bad-prog-1/poster.pdf'), originalPath: 'bad-prog-1/poster.pdf', fileSizeBytes: 500, browserMimeType: 'application/pdf' },
      ],
    };
    const analysisBadProg = await analyzeBrowserImportServer(manifestBadProg, new Map([[kBadProg, Buffer.from(jsonBadProgram, 'utf8')]]));
    const intentBadProg = {
      version: 1 as const,
      previewFingerprint: analysisBadProg.preview.batch.previewFingerprint,
      selectedRootName: 'bad-prog-1',
      fileCount: 3,
      declaredTotalBytes: manifestBadProg.declaredTotalBytes,
      selectedPackagePaths: ['bad-prog-1'],
      acknowledgedWarningPackagePaths: ['bad-prog-1'],
    };
    const resFail2 = await stageBrowserImportMetadata({ authContext, serverAnalysis: analysisBadProg, intent: intentBadProg });
    if (resFail2.success || resFail2.code !== 'LOOKUP_NOT_FOUND') {
      throw new Error(`[Scenario 4b] Expected LOOKUP_NOT_FOUND, got ${JSON.stringify(resFail2)}`);
    }

    const storageAfter4 = await captureStorageSnapshot();
    assertStorageUnchanged(storageBefore4, storageAfter4, 'Scenario 4');
    process.stdout.write('  ✓ Scenario 4 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 5: Database Rollback-Injection Tests
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 5] Testing all post-mutation rollback boundaries...\n');
    const rollbackBoundaries = [
      ['batch', 'import_batches'], ['project', 'projects'], ['mapping', 'project_disciplines'],
      ['warning', 'validation_flags'], ['idempotency', 'browser_import_commits'],
    ] as const;
    for (const [boundary, table] of rollbackBoundaries) {
      const rollbackPkgId = `rollback-${boundary}-pkg-1`;
      const storageBefore5 = await captureStorageSnapshot();
      const triggerName = `trg_test_fail_${boundary}`;
      const functionName = `test_fail_${boundary}_trg`;
      executeLocalDatabaseSql(`
        CREATE OR REPLACE FUNCTION public.${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'TEST_INJECTED_${boundary.toUpperCase()}_FAILURE'; END; $$;
        DROP TRIGGER IF EXISTS ${triggerName} ON public.${table};
        CREATE TRIGGER ${triggerName} AFTER INSERT ON public.${table}
        FOR EACH ROW EXECUTE FUNCTION public.${functionName}();
      `);
      try {
      const jsonRollback = JSON.stringify({
        publicId: rollbackPkgId,
        title: 'Rollback Title',
        summary: 'Rollback Summary',
        year: 2026,
        program: program.name,
        discipline: discipline.name,
        groupName: 'Rollback Group',
        teamMembers: ['Tester'],
        layoutConfig: {},
      });
      const kRollback = generateUploadKey(`${rollbackPkgId}/project.json`);
      const manifestRollback = {
        selectedRootName: rollbackPkgId,
        fileCount: 3,
        declaredTotalBytes: Buffer.from(jsonRollback).length + 800,
        ignoredSystemFilesCount: 0,
        descriptors: [
          { uploadKey: kRollback, originalPath: `${rollbackPkgId}/project.json`, fileSizeBytes: Buffer.from(jsonRollback).length, browserMimeType: 'application/json' },
          { uploadKey: generateUploadKey(`${rollbackPkgId}/poster.png`), originalPath: `${rollbackPkgId}/poster.png`, fileSizeBytes: 300, browserMimeType: 'image/png' },
          { uploadKey: generateUploadKey(`${rollbackPkgId}/poster.pdf`), originalPath: `${rollbackPkgId}/poster.pdf`, fileSizeBytes: 500, browserMimeType: 'application/pdf' },
        ],
      };
      const analysisRollback = await analyzeBrowserImportServer(manifestRollback, new Map([[kRollback, Buffer.from(jsonRollback, 'utf8')]]));

      // Inject a fake warning flag into analysis package so insertion hits validation_flags
      analysisRollback.packages[0].warnings.push({
        code: 'TEST_WARNING',
        message: 'Test warning message',
        severity: 'warning',
        packagePath: rollbackPkgId,
      });

      const intentRollback = {
        version: 1 as const,
        previewFingerprint: analysisRollback.preview.batch.previewFingerprint,
        selectedRootName: rollbackPkgId,
        fileCount: 3,
        declaredTotalBytes: manifestRollback.declaredTotalBytes,
        selectedPackagePaths: [rollbackPkgId],
        acknowledgedWarningPackagePaths: [rollbackPkgId],
      };

        const resRollback = await stageBrowserImportMetadata({ authContext, serverAnalysis: analysisRollback, intent: intentRollback });
        if (resRollback.success || resRollback.code !== 'PERSISTENCE_FAILED') {
          throw new Error(`[Scenario 5:${boundary}] Expected injected persistence failure, got ${JSON.stringify(resRollback)}`);
        }
        assertRollbackResidueAbsent(rollbackPkgId);
        assertStorageUnchanged(storageBefore5, await captureStorageSnapshot(), `Scenario 5 ${boundary}`);
        process.stdout.write(`  ✓ Scenario 5 ${boundary} rollback PASSED!\n`);
      } finally {
        executeLocalDatabaseSql(`
          DROP TRIGGER IF EXISTS ${triggerName} ON public.${table};
          DROP FUNCTION IF EXISTS public.${functionName}();
        `);
      }
    }
    process.stdout.write('  ✓ Scenario 5 PASSED!\n\n');

  } finally {
    // Global cleanup must remove projects before their batches; the foreign key intentionally
    // preserves projects by setting import_batch_id to null when a batch alone is deleted.
    for (const bId of createdBatchIds) {
      const projectCleanup = await supabase.from('projects').delete().eq('import_batch_id', bId);
      if (projectCleanup.error) throw new Error('Runtime project cleanup failed.');
      const batchCleanup = await supabase.from('import_batches').delete().eq('id', bId);
      if (batchCleanup.error) throw new Error('Runtime batch cleanup failed.');
    }
  }

  process.stdout.write('====================================================\n');
  process.stdout.write('ALL RUNTIME STAGING ACCEPTANCE SCENARIOS PASSED!\n');
  process.stdout.write('====================================================\n');
}

if (require.main === module) {
  verifyBrowserImportMetadataStageRuntime()
    .then(() => process.exit(0))
    .catch((err) => {
      process.stderr.write(`[Verifier Exception] ${err.message}\n`);
      process.exit(1);
    });
}
