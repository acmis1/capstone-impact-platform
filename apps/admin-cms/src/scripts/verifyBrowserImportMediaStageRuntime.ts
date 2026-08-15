import { execFileSync, execSync } from 'node:child_process';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { createSupabaseAdminClientCore } from '../lib/supabase/adminCore';
import { getStagingBuckets } from '../lib/supabase/buckets';
import { analyzeBrowserImportServer } from '../import/parseBrowserImportPreview';
import { stageBrowserImportMetadata } from '../import/stageBrowserImportMetadata';
import { stageBrowserImportMedia, MediaFileToStage } from '../import/stageBrowserImportMedia';
import { computeCanonicalIntentHash } from '../import/browserImportMetadataStageServerCore';
import { generateUploadKey } from '../import/browserSelection';
import { AuthenticatedAdminContext } from '../auth/authTypes';
import { isLoopbackUrl, parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF', 'ascii');
const VERIFIER_PUBLIC_IDS = [
  'ms1-pkg-1',
  'ms2-pkg-a',
  'ms2-pkg-b',
  'ms3-pkg-1',
  'ms4-pkg-1',
  'ms4b-pkg-1',
  'ms5c-pkg-1',
  'ms6-pkg-1',
] as const;
const VERIFIER_PRIVATE_PATHS = VERIFIER_PUBLIC_IDS.flatMap((publicId) => [
  `drafts/${publicId}/poster_image/poster.png`,
  `drafts/${publicId}/poster_pdf/poster.pdf`,
  `drafts/${publicId}/snapshot_image/snapshot-1.png`,
]);

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

async function downloadStorageObject(
  supabase: ReturnType<typeof createSupabaseAdminClientCore>,
  bucket: string,
  storagePath: string
): Promise<Buffer> {
  const { data, error } = await supabase.storage.from(bucket).download(storagePath);
  if (error || !data) {
    throw new Error(`[Verifier Storage Failure] Could not download ${bucket}/${storagePath}: ${error?.message || 'no data'}`);
  }
  return Buffer.from(await data.arrayBuffer());
}

function assertArraysEqual(before: string[], after: string[], label: string): void {
  if (before.length !== after.length || !before.every((name, i) => name === after[i])) {
    throw new Error(`[Verifier Storage Failure] Public bucket objects mutated: ${label}`);
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

interface FixturePackageSpec {
  publicId: string;
  packagePath: string;
}

interface StagedFixture {
  batchId: string;
  metadataIntentHash: string;
}

async function stageFixtureMetadataBatch(params: {
  authContext: AuthenticatedAdminContext;
  rootName: string;
  packages: FixturePackageSpec[];
  program: string;
  discipline: string;
  industry: string;
}): Promise<StagedFixture> {
  const { authContext, rootName, packages, program, discipline, industry } = params;

  const descriptors: Array<{ uploadKey: string; originalPath: string; fileSizeBytes: number; browserMimeType: string }> = [];
  const metaFiles = new Map<string, Buffer>();
  let declaredTotalBytes = 0;

  for (const pkg of packages) {
    const json = JSON.stringify({
      publicId: pkg.publicId,
      title: `Title ${pkg.publicId}`,
      summary: `Summary ${pkg.publicId}`,
      year: 2026,
      program,
      discipline,
      industry,
      groupName: `Group ${pkg.publicId}`,
      teamMembers: ['Tester'],
      layoutConfig: {},
    });
    const jsonBytes = Buffer.from(json, 'utf8');
    const jsonKey = generateUploadKey(`${pkg.packagePath}/project.json`);
    descriptors.push({ uploadKey: jsonKey, originalPath: `${pkg.packagePath}/project.json`, fileSizeBytes: jsonBytes.length, browserMimeType: 'application/json' });
    metaFiles.set(jsonKey, jsonBytes);
    declaredTotalBytes += jsonBytes.length;

    descriptors.push({ uploadKey: generateUploadKey(`${pkg.packagePath}/poster.png`), originalPath: `${pkg.packagePath}/poster.png`, fileSizeBytes: PNG_BYTES.length, browserMimeType: 'image/png' });
    declaredTotalBytes += PNG_BYTES.length;
    descriptors.push({ uploadKey: generateUploadKey(`${pkg.packagePath}/poster.pdf`), originalPath: `${pkg.packagePath}/poster.pdf`, fileSizeBytes: PDF_BYTES.length, browserMimeType: 'application/pdf' });
    declaredTotalBytes += PDF_BYTES.length;
    descriptors.push({ uploadKey: generateUploadKey(`${pkg.packagePath}/snapshot-1.png`), originalPath: `${pkg.packagePath}/snapshot-1.png`, fileSizeBytes: PNG_BYTES.length, browserMimeType: 'image/png' });
    declaredTotalBytes += PNG_BYTES.length;
  }

  const manifest = {
    selectedRootName: rootName,
    fileCount: descriptors.length,
    declaredTotalBytes,
    ignoredSystemFilesCount: 0,
    descriptors,
  };

  const referenceWorkbook = new ExcelJS.Workbook();
  const referenceWorksheet = referenceWorkbook.addWorksheet('REFERENCE');
  referenceWorksheet.addRow(['Public ID', 'Official Project Title']);
  for (const pkg of packages) referenceWorksheet.addRow([pkg.publicId, `Title ${pkg.publicId}`]);
  const analysis = await analyzeBrowserImportServer(manifest, metaFiles, {
    referenceFileBuffer: Buffer.from(await referenceWorkbook.xlsx.writeBuffer()),
    mapping: {
      worksheet: 'REFERENCE',
      matchMappings: [{ canonicalField: 'publicId', referenceColumn: 'Public ID' }],
      comparisonMappings: [{ canonicalField: 'title', referenceColumn: 'Official Project Title' }],
      reconciliationContractVersion: 'admin-reference-reconciliation-v1',
    },
  });
  const selectedPackagePaths = packages.map((p) => p.packagePath).sort();

  const intent = {
    version: 1 as const,
    previewFingerprint: analysis.preview.batch.previewFingerprint,
    selectedRootName: rootName,
    fileCount: descriptors.length,
    declaredTotalBytes,
    selectedPackagePaths,
    acknowledgedWarningPackagePaths: selectedPackagePaths,
    adminReference: analysis.preview.batch.adminReference,
  };

  const res = await stageBrowserImportMetadata({ authContext, serverAnalysis: analysis, intent });
  if (!res.success) {
    throw new Error(`[Fixture] Metadata staging failed: ${JSON.stringify(res)}`);
  }

  return { batchId: res.batchId, metadataIntentHash: computeCanonicalIntentHash(intent) };
}

/** Synthetic staff-authored description used by this suite's snapshot fixtures. */
const MEDIA_STAGE_SNAPSHOT_ALT_TEXT =
  'Synthetic snapshot image used by the browser media staging runtime verifier.';

function buildMediaFiles(packages: FixturePackageSpec[]): MediaFileToStage[] {
  const files: MediaFileToStage[] = [];
  for (const pkg of packages) {
    files.push({
      packagePath: pkg.packagePath,
      projectPublicId: pkg.publicId,
      assetType: 'poster_image',
      fileName: 'poster.png',
      fileSizeBytes: PNG_BYTES.length,
      canonicalMimeType: 'image/png',
      // The poster's text alternative stays the project-level accessibility text.
      snapshotAltText: null,
      content: PNG_BYTES,
    });
    files.push({
      packagePath: pkg.packagePath,
      projectPublicId: pkg.publicId,
      assetType: 'poster_pdf',
      fileName: 'poster.pdf',
      fileSizeBytes: PDF_BYTES.length,
      canonicalMimeType: 'application/pdf',
      snapshotAltText: null,
      content: PDF_BYTES,
    });
    files.push({
      packagePath: pkg.packagePath,
      projectPublicId: pkg.publicId,
      assetType: 'snapshot_image',
      fileName: 'snapshot-1.png',
      fileSizeBytes: PNG_BYTES.length,
      canonicalMimeType: 'image/png',
      snapshotAltText: MEDIA_STAGE_SNAPSHOT_ALT_TEXT,
      content: PNG_BYTES,
    });
  }
  return files;
}

export async function verifyBrowserImportMediaStageRuntime(): Promise<void> {
  ensureLocalEnvironmentVariables();
  process.stdout.write('=== Capstone Impact Platform: Local Supabase Browser Media Staging Runtime Acceptance ===\n\n');
  const supabase = createSupabaseAdminClientCore();
  const buckets = getStagingBuckets();

  const { data: adminUser, error: adminErr } = await supabase.from('admin_users').select('id, email').limit(1).single();
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

  const { data: program } = await supabase.from('programs').select('id, name').limit(1).single();
  const { data: discipline } = await supabase.from('disciplines').select('id, name').limit(1).single();
  const { data: industry } = await supabase.from('industry_categories').select('id, name').limit(1).single();
  if (!program || !discipline || !industry) {
    throw new Error('[Verifier] Missing required seed taxonomy rows in local database.');
  }

  const createdBatchIds: string[] = [];
  const publicSnapshotBefore = await listStorageObjects(supabase, buckets.PUBLIC_ASSETS);
  const staleStorageCleanup = await supabase.storage.from(buckets.DRAFT_PRIVATE).remove(VERIFIER_PRIVATE_PATHS);
  if (staleStorageCleanup.error) throw new Error('Stale runtime storage cleanup failed.');

  try {
    // -------------------------------------------------------------------------
    // Scenario 1: Single-Project Media Completion & Deep Verification
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 1] Testing single-project media completion and deep verification...\n');
    const pkg1: FixturePackageSpec = { publicId: 'ms1-pkg-1', packagePath: 'ms1-pkg-1' };
    const fixture1 = await stageFixtureMetadataBatch({
      authContext, rootName: 'ms1-pkg-1', packages: [pkg1],
      program: program.name, discipline: discipline.name, industry: industry.name,
    });
    createdBatchIds.push(fixture1.batchId);

    const res1 = await stageBrowserImportMedia({
      authContext, batchId: fixture1.batchId, metadataIntentHash: fixture1.metadataIntentHash,
      files: buildMediaFiles([pkg1]),
    });
    if (!res1.success || res1.result !== 'completed' || res1.mediaAssetCount !== 3) {
      throw new Error(`[Scenario 1] Media completion failed: ${JSON.stringify(res1)}`);
    }

    const { data: batchRow1 } = await supabase.from('import_batches').select('*').eq('id', fixture1.batchId).single();
    if (!batchRow1 || batchRow1.status !== 'completed') throw new Error('[Scenario 1] Batch was not marked completed.');

    const { data: projRow1 } = await supabase.from('projects').select('*').eq('import_batch_id', fixture1.batchId).single();
    if (!projRow1 || projRow1.status !== 'draft') throw new Error('[Scenario 1] Project did not remain draft.');

    const { data: assetRows1 } = await supabase.from('media_assets').select('*').eq('project_id', projRow1.id);
    if (!assetRows1 || assetRows1.length !== 3) throw new Error(`[Scenario 1] Expected 3 media_assets rows, found ${assetRows1?.length}`);

    for (const row of assetRows1) {
      if (row.is_public_approved !== false || row.public_url !== null) {
        throw new Error('[Scenario 1] Media asset was not private/unapproved.');
      }
      if (row.storage_bucket !== buckets.DRAFT_PRIVATE) {
        throw new Error(`[Scenario 1] Media asset used wrong bucket: ${row.storage_bucket}`);
      }
      const expectedPath = `drafts/${pkg1.publicId}/${row.asset_type}/${row.asset_type === 'poster_pdf' ? 'poster.pdf' : row.asset_type === 'poster_image' ? 'poster.png' : 'snapshot-1.png'}`;
      if (row.storage_path !== expectedPath) {
        throw new Error(`[Scenario 1] Unexpected storage path: ${row.storage_path} !== ${expectedPath}`);
      }
    }

    const { data: existsPoster } = await supabase.storage.from(buckets.DRAFT_PRIVATE).list(`drafts/${pkg1.publicId}/poster_image`);
    if (!existsPoster?.some((f) => f.name === 'poster.png')) throw new Error('[Scenario 1] poster.png object missing from private storage.');

    const { data: mediaCommitRow1 } = await supabase.from('browser_import_media_commits').select('*').eq('batch_id', fixture1.batchId).maybeSingle();
    if (!mediaCommitRow1 || mediaCommitRow1.asset_count !== 3) throw new Error('[Scenario 1] Media idempotency ledger row missing or incorrect.');

    process.stdout.write('  ✓ Scenario 1 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 2: Multi-Project Completion & Sequential + Concurrent Idempotency
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 2] Testing multi-project completion and idempotent retry...\n');
    // The staged project's public_id is derived server-side from the package folder name
    // (the last path segment of packagePath), never from the manifest's own publicId field —
    // so the folder name here must itself be the intended, collision-safe public_id.
    const pkg2a: FixturePackageSpec = { publicId: 'ms2-pkg-a', packagePath: 'ms2-batch/ms2-pkg-a' };
    const pkg2b: FixturePackageSpec = { publicId: 'ms2-pkg-b', packagePath: 'ms2-batch/ms2-pkg-b' };
    const fixture2 = await stageFixtureMetadataBatch({
      authContext, rootName: 'ms2-batch', packages: [pkg2a, pkg2b],
      program: program.name, discipline: discipline.name, industry: industry.name,
    });
    createdBatchIds.push(fixture2.batchId);

    const mediaFiles2 = buildMediaFiles([pkg2a, pkg2b]);
    const res2a = await stageBrowserImportMedia({ authContext, batchId: fixture2.batchId, metadataIntentHash: fixture2.metadataIntentHash, files: mediaFiles2 });
    if (!res2a.success || res2a.result !== 'completed' || res2a.mediaAssetCount !== 6) {
      throw new Error(`[Scenario 2] Multi-project completion failed: ${JSON.stringify(res2a)}`);
    }

    const storageBeforeRetry = await listStorageObjects(supabase, buckets.DRAFT_PRIVATE, `drafts`);

    // Sequential exact retry
    const res2b = await stageBrowserImportMedia({ authContext, batchId: fixture2.batchId, metadataIntentHash: fixture2.metadataIntentHash, files: mediaFiles2 });
    if (!res2b.success || res2b.result !== 'already_completed' || res2b.mediaAssetCount !== 6) {
      throw new Error(`[Scenario 2] Sequential idempotent retry failed: ${JSON.stringify(res2b)}`);
    }

    const { count: assetCountAfterSeqRetry } = await supabase.from('media_assets').select('*', { count: 'exact', head: true })
      .in('project_id', (await supabase.from('projects').select('id').eq('import_batch_id', fixture2.batchId)).data!.map((p: { id: string }) => p.id));
    if (assetCountAfterSeqRetry !== 6) throw new Error(`[Scenario 2] Duplicate media_assets rows created by sequential retry: ${assetCountAfterSeqRetry}`);

    const storageAfterSeqRetry = await listStorageObjects(supabase, buckets.DRAFT_PRIVATE, `drafts`);
    assertArraysEqual(storageBeforeRetry, storageAfterSeqRetry, 'Scenario 2 sequential retry');

    // Concurrent identical retry
    const [c2a, c2b] = await Promise.all([
      stageBrowserImportMedia({ authContext, batchId: fixture2.batchId, metadataIntentHash: fixture2.metadataIntentHash, files: mediaFiles2 }),
      stageBrowserImportMedia({ authContext, batchId: fixture2.batchId, metadataIntentHash: fixture2.metadataIntentHash, files: mediaFiles2 }),
    ]);
    if (!c2a.success || !c2b.success || c2a.mediaAssetCount !== 6 || c2b.mediaAssetCount !== 6) {
      throw new Error(`[Scenario 2] Concurrent retry failed: ${JSON.stringify(c2a)} vs ${JSON.stringify(c2b)}`);
    }

    const { count: assetCountAfterConcurrent } = await supabase.from('media_assets').select('*', { count: 'exact', head: true })
      .in('project_id', (await supabase.from('projects').select('id').eq('import_batch_id', fixture2.batchId)).data!.map((p: { id: string }) => p.id));
    if (assetCountAfterConcurrent !== 6) throw new Error(`[Scenario 2] Duplicate media_assets rows created by concurrent retry: ${assetCountAfterConcurrent}`);

    const storageAfterConcurrent = await listStorageObjects(supabase, buckets.DRAFT_PRIVATE, `drafts`);
    assertArraysEqual(storageBeforeRetry, storageAfterConcurrent, 'Scenario 2 concurrent retry');

    process.stdout.write('  ✓ Scenario 2 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 3: Rejections
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 3] Testing rejection cases...\n');

    // 3a. Nonexistent batch
    const resFakeBatch = await stageBrowserImportMedia({
      authContext, batchId: '99999999-9999-4999-8999-999999999999',
      metadataIntentHash: 'a'.repeat(64), files: buildMediaFiles([{ publicId: 'nope', packagePath: 'nope' }]),
    });
    if (resFakeBatch.success || resFakeBatch.code !== 'BATCH_INTENT_MISMATCH') {
      throw new Error(`[Scenario 3a] Expected BATCH_INTENT_MISMATCH for nonexistent batch, got ${JSON.stringify(resFakeBatch)}`);
    }

    // 3b. Tampered metadata intent hash on a real, valid batch
    const pkg3: FixturePackageSpec = { publicId: 'ms3-pkg-1', packagePath: 'ms3-pkg-1' };
    const fixture3 = await stageFixtureMetadataBatch({
      authContext, rootName: 'ms3-pkg-1', packages: [pkg3],
      program: program.name, discipline: discipline.name, industry: industry.name,
    });
    createdBatchIds.push(fixture3.batchId);

    const resTampered = await stageBrowserImportMedia({
      authContext, batchId: fixture3.batchId,
      metadataIntentHash: fixture3.metadataIntentHash === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64),
      files: buildMediaFiles([pkg3]),
    });
    if (resTampered.success || resTampered.code !== 'BATCH_INTENT_MISMATCH') {
      throw new Error(`[Scenario 3b] Expected BATCH_INTENT_MISMATCH for tampered intent hash, got ${JSON.stringify(resTampered)}`);
    }

    const { data: batchRow3Untouched } = await supabase.from('import_batches').select('status').eq('id', fixture3.batchId).single();
    if (batchRow3Untouched?.status !== 'metadata_staged') throw new Error('[Scenario 3b] Batch state was mutated by a rejected request.');

    // 3c. Batch not in metadata_staged state
    await supabase.from('import_batches').update({ status: 'failed' }).eq('id', fixture3.batchId);
    const resWrongState = await stageBrowserImportMedia({
      authContext, batchId: fixture3.batchId, metadataIntentHash: fixture3.metadataIntentHash, files: buildMediaFiles([pkg3]),
    });
    if (resWrongState.success || resWrongState.code !== 'INVALID_BATCH_STATE') {
      throw new Error(`[Scenario 3c] Expected INVALID_BATCH_STATE, got ${JSON.stringify(resWrongState)}`);
    }
    // Restore state for later reuse safety (not required, batch will be cleaned up regardless)

    process.stdout.write('  ✓ Scenario 3 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 4: Storage Conflict Safety (pre-existing mismatched object)
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 4] Testing storage conflict safety against a pre-existing mismatched object...\n');
    const pkg4: FixturePackageSpec = { publicId: 'ms4-pkg-1', packagePath: 'ms4-pkg-1' };
    const fixture4 = await stageFixtureMetadataBatch({
      authContext, rootName: 'ms4-pkg-1', packages: [pkg4],
      program: program.name, discipline: discipline.name, industry: industry.name,
    });
    createdBatchIds.push(fixture4.batchId);

    const conflictPath = `drafts/${pkg4.publicId}/poster_image/poster.png`;
    const wrongContent = Buffer.concat([PNG_BYTES, Buffer.from('unexpected-extra-bytes')]);
    const { error: preUploadErr } = await supabase.storage.from(buckets.DRAFT_PRIVATE).upload(conflictPath, wrongContent, { contentType: 'image/png', upsert: false });
    if (preUploadErr) throw new Error(`[Scenario 4] Failed to seed conflicting object: ${preUploadErr.message}`);

    const resConflict = await stageBrowserImportMedia({
      authContext, batchId: fixture4.batchId, metadataIntentHash: fixture4.metadataIntentHash, files: buildMediaFiles([pkg4]),
    });
    if (resConflict.success || resConflict.code !== 'STORAGE_CONFLICT') {
      throw new Error(`[Scenario 4] Expected STORAGE_CONFLICT, got ${JSON.stringify(resConflict)}`);
    }

    const { data: batchRow4 } = await supabase.from('import_batches').select('status').eq('id', fixture4.batchId).single();
    if (batchRow4?.status !== 'metadata_staged') throw new Error('[Scenario 4] Batch was falsely completed despite storage conflict.');

    const { count: assetCount4 } = await supabase.from('media_assets').select('*', { count: 'exact', head: true })
      .in('project_id', (await supabase.from('projects').select('id').eq('import_batch_id', fixture4.batchId)).data!.map((p: { id: string }) => p.id));
    if (assetCount4 !== 0) throw new Error('[Scenario 4] A media_assets row was created despite storage conflict.');

    // The pre-existing (unrelated, mismatched) object must remain completely untouched.
    const { data: postConflictListing } = await supabase.storage.from(buckets.DRAFT_PRIVATE).list(`drafts/${pkg4.publicId}/poster_image`, { search: 'poster.png' });
    const conflictEntry = postConflictListing?.find((f) => f.name === 'poster.png');
    const conflictSize = conflictEntry?.metadata && typeof conflictEntry.metadata === 'object' ? (conflictEntry.metadata as Record<string, unknown>).size : undefined;
    if (conflictSize !== wrongContent.length) throw new Error('[Scenario 4] Pre-existing mismatched object was altered.');

    process.stdout.write('  ✓ Scenario 4 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 4b: Storage Conflict Safety (same-size, different-content object)
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 4b] Testing storage conflict safety against a same-size, different-content object...\n');
    const pkg4b: FixturePackageSpec = { publicId: 'ms4b-pkg-1', packagePath: 'ms4b-pkg-1' };
    const fixture4b = await stageFixtureMetadataBatch({
      authContext, rootName: 'ms4b-pkg-1', packages: [pkg4b],
      program: program.name, discipline: discipline.name, industry: industry.name,
    });
    createdBatchIds.push(fixture4b.batchId);

    // Exactly the same byte length as PNG_BYTES and still begins with the real PNG file
    // signature (first 8 bytes), so this specifically exercises content-identity verification
    // rather than only a size check or only a signature check.
    const sameSizeDifferentContent = Buffer.concat([
      PNG_BYTES.slice(0, 8),
      Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x00]),
    ]);
    if (sameSizeDifferentContent.length !== PNG_BYTES.length) {
      throw new Error('[Scenario 4b] Fixture construction error: byte lengths must match.');
    }
    if (sameSizeDifferentContent.equals(PNG_BYTES)) {
      throw new Error('[Scenario 4b] Fixture construction error: content must differ from the expected media.');
    }

    const conflictPath4b = `drafts/${pkg4b.publicId}/poster_image/poster.png`;
    const { error: preUploadErr4b } = await supabase.storage
      .from(buckets.DRAFT_PRIVATE)
      .upload(conflictPath4b, sameSizeDifferentContent, { contentType: 'image/png', upsert: false });
    if (preUploadErr4b) throw new Error(`[Scenario 4b] Failed to seed conflicting object: ${preUploadErr4b.message}`);

    const resConflict4b = await stageBrowserImportMedia({
      authContext, batchId: fixture4b.batchId, metadataIntentHash: fixture4b.metadataIntentHash, files: buildMediaFiles([pkg4b]),
    });
    if (resConflict4b.success || resConflict4b.code !== 'STORAGE_CONFLICT') {
      throw new Error(`[Scenario 4b] Expected STORAGE_CONFLICT for same-size different-content object, got ${JSON.stringify(resConflict4b)}`);
    }

    const { data: batchRow4b } = await supabase.from('import_batches').select('status').eq('id', fixture4b.batchId).single();
    if (batchRow4b?.status !== 'metadata_staged') throw new Error('[Scenario 4b] Batch was falsely completed despite same-size content conflict.');

    const { count: assetCount4b } = await supabase.from('media_assets').select('*', { count: 'exact', head: true })
      .in('project_id', (await supabase.from('projects').select('id').eq('import_batch_id', fixture4b.batchId)).data!.map((p: { id: string }) => p.id));
    if (assetCount4b !== 0) throw new Error('[Scenario 4b] A media_assets row was created despite same-size content conflict.');

    const { data: ledgerRow4b } = await supabase.from('browser_import_media_commits').select('*').eq('batch_id', fixture4b.batchId).maybeSingle();
    if (ledgerRow4b) throw new Error('[Scenario 4b] Idempotency ledger row was created despite same-size content conflict.');

    // The pre-existing (unrelated, same-size, mismatched) object must remain completely
    // untouched, byte-for-byte -- not just the same size.
    const postConflictBytes4b = await downloadStorageObject(supabase, buckets.DRAFT_PRIVATE, conflictPath4b);
    if (!postConflictBytes4b.equals(sameSizeDifferentContent)) {
      throw new Error('[Scenario 4b] Pre-existing same-size mismatched object was altered.');
    }

    process.stdout.write('  ✓ Scenario 4b PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 5: Concurrent FIRST-TIME Submissions (no prior completion)
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 5] Testing concurrent first-time submissions for the same metadata_staged batch...\n');
    const pkg5c: FixturePackageSpec = { publicId: 'ms5c-pkg-1', packagePath: 'ms5c-pkg-1' };
    const fixture5c = await stageFixtureMetadataBatch({
      authContext, rootName: 'ms5c-pkg-1', packages: [pkg5c],
      program: program.name, discipline: discipline.name, industry: industry.name,
    });
    createdBatchIds.push(fixture5c.batchId);

    const mediaFiles5c = buildMediaFiles([pkg5c]);
    // Neither call has staged media for this batch yet. This exercises the real storage-upload
    // race (both requests may upload before either reaches the database advisory lock inside
    // the finalization RPC), not merely a retry of an already-completed batch.
    const [conc5a, conc5b] = await Promise.all([
      stageBrowserImportMedia({ authContext, batchId: fixture5c.batchId, metadataIntentHash: fixture5c.metadataIntentHash, files: mediaFiles5c }),
      stageBrowserImportMedia({ authContext, batchId: fixture5c.batchId, metadataIntentHash: fixture5c.metadataIntentHash, files: mediaFiles5c }),
    ]);

    if (!conc5a.success || !conc5b.success) {
      throw new Error(`[Scenario 5] Concurrent first submission did not converge safely: ${JSON.stringify(conc5a)} vs ${JSON.stringify(conc5b)}`);
    }
    if (conc5a.mediaAssetCount !== 3 || conc5b.mediaAssetCount !== 3) {
      throw new Error(`[Scenario 5] Concurrent first submission produced inconsistent asset counts: ${JSON.stringify(conc5a)} vs ${JSON.stringify(conc5b)}`);
    }
    const resultPair5c = [conc5a.result, conc5b.result].sort();
    if (resultPair5c[0] !== 'already_completed' || resultPair5c[1] !== 'completed') {
      throw new Error(`[Scenario 5] Expected exactly one 'completed' and one 'already_completed' result, got ${JSON.stringify(resultPair5c)}`);
    }

    const { data: batchRow5c } = await supabase.from('import_batches').select('status').eq('id', fixture5c.batchId).single();
    if (batchRow5c?.status !== 'completed') throw new Error('[Scenario 5] Batch did not converge to completed.');

    const { data: proj5c } = await supabase.from('projects').select('id, status').eq('import_batch_id', fixture5c.batchId).single();
    if (!proj5c || proj5c.status !== 'draft') throw new Error('[Scenario 5] Project did not remain draft.');

    const { data: assetRows5c } = await supabase.from('media_assets').select('*').eq('project_id', proj5c.id);
    if (!assetRows5c || assetRows5c.length !== 3) throw new Error(`[Scenario 5] Expected exactly 3 media_assets rows, found ${assetRows5c?.length}`);

    const seenPaths5c = new Set<string>();
    for (const row of assetRows5c) {
      const key = `${row.storage_bucket}/${row.storage_path}`;
      if (seenPaths5c.has(key)) throw new Error(`[Scenario 5] Duplicate media_assets row for the same storage object: ${key}`);
      seenPaths5c.add(key);

      const expectedFile = mediaFiles5c.find((f) => f.assetType === row.asset_type);
      if (!expectedFile) throw new Error(`[Scenario 5] Unexpected asset_type registered: ${row.asset_type}`);

      const objectBytes = await downloadStorageObject(supabase, row.storage_bucket, row.storage_path);
      if (!objectBytes.equals(expectedFile.content)) {
        throw new Error(`[Scenario 5] Registered storage object bytes do not match expected content for ${row.storage_path}`);
      }
    }

    const { data: mediaCommitRow5c } = await supabase.from('browser_import_media_commits').select('*').eq('batch_id', fixture5c.batchId).maybeSingle();
    if (!mediaCommitRow5c || mediaCommitRow5c.asset_count !== 3) {
      throw new Error('[Scenario 5] Media idempotency ledger row missing or incorrect after concurrent first submission.');
    }

    process.stdout.write('  ✓ Scenario 5 PASSED!\n\n');

    // -------------------------------------------------------------------------
    // Scenario 6: Database Finalization Failure -> Deletion-Safety & Retry Convergence
    // -------------------------------------------------------------------------
    process.stdout.write('[Scenario 6] Testing database finalization failure, deletion-safety, and retry convergence...\n');
    const pkg6: FixturePackageSpec = { publicId: 'ms6-pkg-1', packagePath: 'ms6-pkg-1' };
    const fixture6 = await stageFixtureMetadataBatch({
      authContext, rootName: 'ms6-pkg-1', packages: [pkg6],
      program: program.name, discipline: discipline.name, industry: industry.name,
    });
    createdBatchIds.push(fixture6.batchId);

    const mediaFiles6 = buildMediaFiles([pkg6]);

    // Pre-seed ONE of the expected objects with the exact expected bytes, standing in for a
    // concurrent attempt that already uploaded it and may be relying on it going into the
    // failing attempt below. The about-to-fail attempt must observe it as an already-uploaded,
    // content-verified match (never re-upload it) and, on failure, must not delete it.
    const preSeededFile6 = mediaFiles6.find((f) => f.assetType === 'poster_image')!;
    const preSeededPath6 = `drafts/${pkg6.publicId}/poster_image/poster.png`;
    const { error: preSeedErr6 } = await supabase.storage
      .from(buckets.DRAFT_PRIVATE)
      .upload(preSeededPath6, preSeededFile6.content, { contentType: preSeededFile6.canonicalMimeType, upsert: false });
    if (preSeedErr6) throw new Error(`[Scenario 6] Failed to pre-seed object simulating a concurrent attempt: ${preSeedErr6.message}`);

    const triggerName = 'trg_test_fail_media_assets_insert';
    const functionName = 'test_fail_media_assets_insert_trg';
    executeLocalDatabaseSql(`
      CREATE OR REPLACE FUNCTION public.${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'TEST_INJECTED_MEDIA_ASSETS_FAILURE'; END; $$;
      DROP TRIGGER IF EXISTS ${triggerName} ON public.media_assets;
      CREATE TRIGGER ${triggerName} AFTER INSERT ON public.media_assets
      FOR EACH ROW EXECUTE FUNCTION public.${functionName}();
    `);

    let resFail: Awaited<ReturnType<typeof stageBrowserImportMedia>>;
    try {
      resFail = await stageBrowserImportMedia({
        authContext, batchId: fixture6.batchId, metadataIntentHash: fixture6.metadataIntentHash, files: mediaFiles6,
      });
    } finally {
      executeLocalDatabaseSql(`
        DROP TRIGGER IF EXISTS ${triggerName} ON public.media_assets;
        DROP FUNCTION IF EXISTS public.${functionName}();
      `);
    }

    if (resFail.success || resFail.code !== 'PERSISTENCE_FAILED') {
      throw new Error(`[Scenario 6] Expected injected persistence failure, got ${JSON.stringify(resFail)}`);
    }

    const { data: batchRow6AfterFail } = await supabase.from('import_batches').select('status').eq('id', fixture6.batchId).single();
    if (batchRow6AfterFail?.status !== 'metadata_staged') throw new Error('[Scenario 6] Batch was falsely completed despite injected DB failure.');

    const { data: proj6 } = await supabase.from('projects').select('id').eq('import_batch_id', fixture6.batchId).single();
    const { count: assetCount6AfterFail } = await supabase.from('media_assets').select('*', { count: 'exact', head: true }).eq('project_id', proj6!.id);
    if (assetCount6AfterFail !== 0) throw new Error('[Scenario 6] An orphaned media_assets row survived the injected failure.');

    const { data: ledgerRow6 } = await supabase.from('browser_import_media_commits').select('*').eq('batch_id', fixture6.batchId).maybeSingle();
    if (ledgerRow6) throw new Error('[Scenario 6] Idempotency ledger row was created despite injected failure.');

    // Deletion-safety proof: the pre-seeded object (standing in for a concurrent attempt's
    // dependency) AND the objects this now-failed attempt itself uploaded must ALL survive the
    // failure, byte-for-byte -- there is no safe way for this attempt to prove nobody else needs
    // them, so nothing it touched is deleted.
    for (const file of mediaFiles6) {
      const expectedPath = `drafts/${pkg6.publicId}/${file.assetType}/${file.fileName}`;
      const bytes = await downloadStorageObject(supabase, buckets.DRAFT_PRIVATE, expectedPath);
      if (!bytes.equals(file.content)) {
        throw new Error(`[Scenario 6] Deterministic private object at ${expectedPath} was altered or lost after the injected failure.`);
      }
    }

    // Exact retry after the injected failure is removed must converge to success, reusing the
    // surviving objects (including the one standing in for a concurrent attempt) rather than
    // re-uploading or duplicating them.
    const resRetryAfterFail = await stageBrowserImportMedia({
      authContext, batchId: fixture6.batchId, metadataIntentHash: fixture6.metadataIntentHash, files: mediaFiles6,
    });
    if (!resRetryAfterFail.success || resRetryAfterFail.result !== 'completed' || resRetryAfterFail.mediaAssetCount !== 3) {
      throw new Error(`[Scenario 6] Retry after injected failure did not converge: ${JSON.stringify(resRetryAfterFail)}`);
    }

    const { count: assetCount6AfterRetry } = await supabase.from('media_assets').select('*', { count: 'exact', head: true }).eq('project_id', proj6!.id);
    if (assetCount6AfterRetry !== 3) throw new Error(`[Scenario 6] Retry produced unexpected asset row count: ${assetCount6AfterRetry}`);

    const storageAfterRetry6 = await listStorageObjects(supabase, buckets.DRAFT_PRIVATE, `drafts/${pkg6.publicId}`);
    if (storageAfterRetry6.length !== 3) throw new Error(`[Scenario 6] Retry left an unexpected number of storage objects: ${storageAfterRetry6.length}`);

    process.stdout.write('  ✓ Scenario 6 PASSED!\n\n');

  } finally {
    const storageCleanup = await supabase.storage.from(buckets.DRAFT_PRIVATE).remove(VERIFIER_PRIVATE_PATHS);
    if (storageCleanup.error) throw new Error('Runtime storage cleanup failed.');
    for (const bId of createdBatchIds) {
      const projectCleanup = await supabase.from('projects').delete().eq('import_batch_id', bId);
      if (projectCleanup.error) throw new Error('Runtime project cleanup failed.');
      const batchCleanup = await supabase.from('import_batches').delete().eq('id', bId);
      if (batchCleanup.error) throw new Error('Runtime batch cleanup failed.');
    }
  }

  // -------------------------------------------------------------------------
  // Public Boundary: prove project-public-assets is byte-for-byte unchanged
  // -------------------------------------------------------------------------
  const publicSnapshotAfter = await listStorageObjects(supabase, buckets.PUBLIC_ASSETS);
  assertArraysEqual(publicSnapshotBefore, publicSnapshotAfter, 'Full media-stage runtime suite (public bucket boundary)');

  process.stdout.write('====================================================\n');
  process.stdout.write('ALL MEDIA STAGE RUNTIME ACCEPTANCE SCENARIOS PASSED!\n');
  process.stdout.write('====================================================\n');
}

if (require.main === module) {
  verifyBrowserImportMediaStageRuntime()
    .then(() => process.exit(0))
    .catch((err) => {
      process.stderr.write(`[Verifier Exception] ${err.message}\n`);
      process.exit(1);
    });
}
