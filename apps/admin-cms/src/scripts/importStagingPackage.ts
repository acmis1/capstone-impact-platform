import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());

import * as fs from 'fs';
import * as path from 'path';
import { createSupabaseAdminClientCore } from '../lib/supabase/adminCore';
import { parseLocalImportPackage } from '../import/parseImportPackage';
import { validateImportPackage } from '../import/validateImportPackage';
import { getStagingBuckets } from '../lib/supabase/buckets';
import { cleanupStagingMediaForProjects } from '../storage/mediaCleanup';

async function main() {
  const packagePath = process.argv[2] || 'packages/sample-capstone-package';
  const resolvedPackagePath = path.resolve(packagePath);

  console.log(`Starting staging package ingestion from: [${resolvedPackagePath}]`);

  if (!fs.existsSync(resolvedPackagePath)) {
    console.error(`❌ Error: Package path does not exist: [${resolvedPackagePath}]`);
    process.exit(1);
  }

  // 1. Parse local package
  console.log('Parsing project.json manifest and media assets...');
  let parseResult;
  try {
    parseResult = await parseLocalImportPackage(resolvedPackagePath);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown parsing error';
    console.error(`❌ Ingestion Parse Failed: ${message}`);
    process.exit(1);
  }

  const { manifest, posterImage, posterPdf, snapshot1 } = parseResult;
  console.log(`Parsed Manifest for project: [${manifest.publicId}] - "${manifest.title}"`);

  // 2. Validate manifest and assets against contract rules
  console.log('Validating parsed package against administrative criteria...');
  const validation = validateImportPackage(parseResult);

  if (!validation.valid) {
    console.error('❌ Package Validation FAILED with blocking errors:');
    validation.errors.forEach((e) => console.error(` - [${e.ruleCode}] Field "${e.fieldName || 'package'}": ${e.message}`));
    process.exit(1);
  }

  console.log('✅ Package Validation PASSED!');
  if (validation.warnings.length > 0) {
    console.log(`⚠️ Package Warnings Detected (${validation.warnings.length}):`);
    validation.warnings.forEach((w) => console.log(` - [${w.ruleCode}] ${w.message}`));
  }

  // 3. Connect to Staging Supabase
  const supabase = createSupabaseAdminClientCore();

  // Create an audit import_batches row
  const batchName = `Staging CLI Ingestion - ${path.basename(resolvedPackagePath)}`;
  const { data: batchRow, error: batchError } = await supabase
    .from('import_batches')
    .insert({
      batch_name: batchName,
      source_folder: packagePath,
      mode: 'local_package_cli',
      status: 'processing',
      total_projects: 1,
      error_count: validation.errors.length,
      warning_count: validation.warnings.length
    })
    .select('id')
    .single();

  if (batchError || !batchRow) {
    console.error(`❌ Failed to create import_batches row: ${batchError?.message}`);
    process.exit(1);
  }

  const batchId = batchRow.id;
  console.log(`Created Ingestion Batch ID: [${batchId}]`);

  // 4. Upsert target project record
  const projectRow = {
    public_id: manifest.publicId,
    title: manifest.title,
    summary: manifest.summary,
    background: manifest.background,
    solution: manifest.solution,
    year: parseInt(manifest.year, 10),
    program_name: manifest.program,
    study_program: manifest.studyProgram,
    discipline: manifest.discipline,
    industry: manifest.industry,
    industry_partner: manifest.industryPartner,
    academic_supervisor: manifest.academicSupervisor,
    group_name: manifest.groupName,
    team_members: manifest.teamMembers,
    poster_text_public: manifest.posterText || null,
    accessibility_text_public: manifest.accessibilityText || null,
    layout_config: manifest.layoutConfig,
    status: 'in_review',
    import_batch_id: batchId,
    source_folder: packagePath,
    // Store validation summary array directly in the project object JSON column
    validation_errors: validation.errors.map(e => e.message),
    validation_warnings: validation.warnings.map(e => e.message)
  };

  // Check if project already exists
  const { data: existingProject } = await supabase
    .from('projects')
    .select('id')
    .eq('public_id', manifest.publicId)
    .maybeSingle();

  // Robust Idempotency Cleanup: Clean database media rows and storage objects before re-upload
  console.log(`Cleaning existing staging media for [${manifest.publicId}] to prevent duplicates...`);
  const cleanup = await cleanupStagingMediaForProjects([manifest.publicId]);
  console.log(`🧹 Database media rows deleted:       ${cleanup.removedMediaRows}`);
  console.log(`🧹 Storage private objects removed:    ${cleanup.removedPrivateObjects}`);
  console.log(`🧹 Storage public objects removed:     ${cleanup.removedPublicObjects}`);

  let projectId: string;
  if (existingProject) {
    console.log(`Updating existing project [${manifest.publicId}]...`);
    
    // Clean existing validation flags for this project to prevent accumulation of stale warnings/errors
    const { error: deleteFlagsError } = await supabase
      .from('validation_flags')
      .delete()
      .eq('project_id', existingProject.id);
    if (deleteFlagsError) {
      console.warn(`⚠️ Warning: Failed to clear old validation flags: ${deleteFlagsError.message}`);
    }

    const { data: updated, error: updateError } = await supabase
      .from('projects')
      .update(projectRow)
      .eq('id', existingProject.id)
      .select('id')
      .single();

    if (updateError || !updated) {
      console.error(`❌ Failed to update project record: ${updateError?.message}`);
      process.exit(1);
    }
    projectId = updated.id;
  } else {
    console.log(`Creating new project [${manifest.publicId}]...`);
    const { data: created, error: createError } = await supabase
      .from('projects')
      .insert(projectRow)
      .select('id')
      .single();

    if (createError || !created) {
      console.error(`❌ Failed to create project record: ${createError?.message}`);
      process.exit(1);
    }
    projectId = created.id;
  }

  // Record audit validation flags inside validation_flags table
  const flagRows = [
    ...validation.errors.map(e => ({
      project_id: projectId,
      rule_code: e.ruleCode,
      severity: 'error',
      field_name: e.fieldName || null,
      message: e.message
    })),
    ...validation.warnings.map(w => ({
      project_id: projectId,
      rule_code: w.ruleCode,
      severity: 'warning',
      field_name: w.fieldName || null,
      message: w.message
    }))
  ];

  if (flagRows.length > 0) {
    const { error: insertFlagsError } = await supabase
      .from('validation_flags')
      .insert(flagRows);

    if (insertFlagsError) {
      console.warn(`⚠️ Warning: Failed to insert validation audit flags: ${insertFlagsError.message}`);
    }
  }

  // 5. Upload media files to private draft storage bucket
  const buckets = getStagingBuckets();
  const draftBucket = buckets.DRAFT_PRIVATE;
  console.log(`Uploading package media to private draft storage bucket: [${draftBucket}]...`);

  const mediaFilesToUpload = [
    { file: posterImage, type: 'poster_image' },
    { file: posterPdf, type: 'poster_pdf' },
    { file: snapshot1, type: 'snapshot' }
  ].filter(item => item.file !== null);

  for (const { file, type } of mediaFilesToUpload) {
    if (!file) continue;
    const storagePath = `drafts/${manifest.publicId}/${file.fileName}`;

    console.log(` - Uploading ${file.fileName} (${file.fileSizeBytes} bytes) -> [${storagePath}]...`);
    const { error: uploadError } = await supabase.storage
      .from(draftBucket)
      .upload(storagePath, file.content, {
        contentType: file.mimeType,
        upsert: true
      });

    if (uploadError) {
      console.error(`❌ Storage upload failed for ${file.fileName}: ${uploadError.message}`);
      process.exit(1);
    }

    // Insert database record in media_assets table
    const { error: mediaDbError } = await supabase
      .from('media_assets')
      .insert({
        project_id: projectId,
        file_name: file.fileName,
        asset_type: type,
        storage_bucket: draftBucket,
        storage_path: storagePath,
        mime_type: file.mimeType,
        file_size_bytes: file.fileSizeBytes,
        is_public_approved: false
      });

    if (mediaDbError) {
      console.warn(`⚠️ Warning: Failed to record media asset in DB: ${mediaDbError.message}`);
    }
  }

  // Update batch status to completed
  await supabase
    .from('import_batches')
    .update({ status: 'completed' })
    .eq('id', batchId);

  console.log('\n====================================================');
  console.log('✅ INGESTION COMPLETED SUCCESSFULLY!');
  console.log('====================================================');
  console.log(`Batch ID:          ${batchId}`);
  console.log(`Project Public ID: ${manifest.publicId}`);
  console.log(`Database UUID:     ${projectId}`);
  console.log(`Status Set To:     in_review (Requires admin approval)`);
  console.log(`Uploaded Assets:   ${mediaFilesToUpload.length} file(s) in private draft bucket`);
  console.log('====================================================\n');
}

main().catch((err) => {
  console.error('Fatal CLI Ingestion Error:', err);
  process.exit(1);
});
