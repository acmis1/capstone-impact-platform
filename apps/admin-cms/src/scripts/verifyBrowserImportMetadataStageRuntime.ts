import { createSupabaseAdminClientCore } from '../lib/supabase/adminCore';
import { analyzeBrowserImportServer } from '../import/parseBrowserImportPreview';
import { stageBrowserImportMetadata } from '../import/stageBrowserImportMetadata';
import { generateUploadKey } from '../import/browserSelection';
import { AuthenticatedAdminContext } from '../auth/authTypes';

export async function verifyBrowserImportMetadataStageRuntime(): Promise<void> {
  process.stdout.write('[Verifier] Starting Local Supabase Runtime Staging Verification...\n');
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

  // 2. Fetch seed program, discipline, industry category
  const { data: program } = await supabase.from('programs').select('name').limit(1).single();
  const { data: discipline } = await supabase.from('disciplines').select('name').limit(1).single();
  const { data: industry } = await supabase.from('industry_categories').select('name').limit(1).single();

  if (!program || !discipline || !industry) {
    throw new Error('[Verifier] Missing required seed taxonomy rows in local database.');
  }

  const testPublicId = `verifier-pkg-${Date.now()}`;
  const jsonContent = JSON.stringify({
    publicId: testPublicId,
    title: 'Verifier Project Title',
    summary: 'Verifier Project Summary',
    background: 'Verifier Background',
    solution: 'Verifier Solution',
    year: 2026,
    program: program.name,
    studyProgram: program.name,
    discipline: discipline.name,
    industry: industry.name,
    groupName: 'Verifier Team',
    teamMembers: ['Tester One'],
    layoutConfig: { templateId: 'poster_showcase', featuredMedia: 'poster' },
  });

  const uploadKey = generateUploadKey(`${testPublicId}/project.json`);
  const manifest = {
    selectedRootName: testPublicId,
    fileCount: 2,
    declaredTotalBytes: Buffer.from(jsonContent).length + 300,
    ignoredSystemFilesCount: 0,
    descriptors: [
      { uploadKey, originalPath: `${testPublicId}/project.json`, fileSizeBytes: Buffer.from(jsonContent).length, browserMimeType: 'application/json' },
      { uploadKey: generateUploadKey(`${testPublicId}/poster.png`), originalPath: `${testPublicId}/poster.png`, fileSizeBytes: 300, browserMimeType: 'image/png' },
    ],
  };

  const metadataFiles = new Map<string, Buffer>();
  metadataFiles.set(uploadKey, Buffer.from(jsonContent, 'utf8'));

  const analysis = await analyzeBrowserImportServer(manifest, metadataFiles);

  const intent = {
    version: 1 as const,
    previewFingerprint: analysis.preview.batch.previewFingerprint,
    selectedRootName: testPublicId,
    fileCount: 2,
    declaredTotalBytes: manifest.declaredTotalBytes,
    selectedPackagePaths: [testPublicId],
    acknowledgedWarningPackagePaths: [],
  };

  // Test Staging Call 1: Creation
  const res1 = await stageBrowserImportMetadata({ authContext, serverAnalysis: analysis, intent });
  if (!res1.success || res1.result !== 'created') {
    throw new Error(`[Verifier] Call 1 creation failed: ${JSON.stringify(res1)}`);
  }
  process.stdout.write(`[Verifier] Call 1 success! Batch ID: ${res1.batchId}\n`);

  // Test Staging Call 2: Idempotency check
  const res2 = await stageBrowserImportMetadata({ authContext, serverAnalysis: analysis, intent });
  if (!res2.success || res2.result !== 'already_staged' || res2.batchId !== res1.batchId) {
    throw new Error(`[Verifier] Call 2 idempotency check failed: ${JSON.stringify(res2)}`);
  }
  process.stdout.write('[Verifier] Call 2 idempotency verified successfully!\n');

  // Verify Zero media_assets created
  const { count: mediaCount } = await supabase
    .from('media_assets')
    .select('*', { count: 'exact', head: true })
    .eq('import_batch_id', res1.batchId);

  if ((mediaCount || 0) !== 0) {
    throw new Error(`[Verifier] Violation: expected 0 media_assets rows, found ${mediaCount}`);
  }

  // Cleanup verifier test data
  await supabase.from('import_batches').delete().eq('id', res1.batchId);
  process.stdout.write('[Verifier] Verification complete & clean!\n');
}
