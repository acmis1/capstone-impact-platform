import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());

import * as path from 'path';
import { parseLocalImportPackage } from '../import/parseImportPackage';
import { validateImportPackage } from '../import/validateImportPackage';
import { createSupabaseAdminClientCore } from '../lib/supabase/adminCore';
import { uploadDraftMediaAsset } from '../storage/mediaStorage';

async function run() {
  const packagePath = 'fixtures/import-packages/runtime-import-demo';
  const resolvedPath = path.resolve(packagePath);

  console.log(`Starting staging package import from: [${packagePath}]`);

  // 1. Parse Package
  let parsed;
  try {
    parsed = await parseLocalImportPackage(resolvedPath);
  } catch (err: any) {
    console.error(`❌ Parse Failed: ${err.message}`);
    process.exit(1);
  }

  // 2. Validate Package
  const validation = validateImportPackage(parsed);
  const totalErrors = validation.errors.length;
  const totalWarnings = validation.warnings.length;

  console.log(`Validation Results: ${totalErrors} error(s), ${totalWarnings} warning(s)`);

  const supabase = createSupabaseAdminClientCore();

  // If there are blocking validation errors, we fail the import.
  // Note: For staging import package foundation safety, we exit cleanly but fail status.
  if (!validation.valid) {
    console.error(`❌ Ingestion Blocked: Staging package validation failed with ${totalErrors} blocking error(s).`);
    validation.errors.forEach(e => console.error(` - [${e.ruleCode}] ${e.message}`));
    process.exit(1);
  }

  // 3. Create import_batches row
  const batchRow = {
    batch_name: `Import Batch ${new Date().toLocaleDateString()}`,
    mode: 'single',
    source_folder: packagePath,
    status: 'processing',
    total_projects: 1,
    warning_count: totalWarnings,
    error_count: totalErrors
  };

  const { data: dbBatch, error: batchError } = await supabase
    .from('import_batches')
    .insert(batchRow)
    .select()
    .single();

  if (batchError || !dbBatch) {
    console.error(`❌ Failed to record import batch: ${batchError?.message}`);
    process.exit(1);
  }

  const batchId = dbBatch.id;
  console.log(`Created Import Batch. ID: [${batchId}]`);

  // 4. Create or Update Project in DB
  const manifest = parsed.manifest;
  const dbRow: any = {
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

  let projectId: string;
  if (existingProject) {
    console.log(`Updating existing project [${manifest.publicId}]...`);
    const { data: updatedProj, error: updateError } = await supabase
      .from('projects')
      .update(dbRow)
      .eq('id', existingProject.id)
      .select('id')
      .single();

    if (updateError || !updatedProj) {
      console.error(`❌ Failed to update staging project: ${updateError?.message}`);
      await supabase.from('import_batches').update({ status: 'failed' }).eq('id', batchId);
      process.exit(1);
    }
    projectId = updatedProj.id;
  } else {
    console.log(`Inserting new project [${manifest.publicId}]...`);
    const { data: insertedProj, error: insertError } = await supabase
      .from('projects')
      .insert(dbRow)
      .select('id')
      .single();

    if (insertError || !insertedProj) {
      console.error(`❌ Failed to insert staging project: ${insertError?.message}`);
      await supabase.from('import_batches').update({ status: 'failed' }).eq('id', batchId);
      process.exit(1);
    }
    projectId = insertedProj.id;
  }

  // 5. Upload media files as draft private media
  let mediaUploadedCount = 0;

  try {
    if (parsed.posterImage) {
      await uploadDraftMediaAsset({
        projectPublicId: manifest.publicId,
        projectDbId: projectId,
        assetType: 'poster_image',
        fileName: parsed.posterImage.fileName,
        content: parsed.posterImage.content,
        mimeType: parsed.posterImage.mimeType
      });
      mediaUploadedCount++;
    }

    if (parsed.posterPdf) {
      await uploadDraftMediaAsset({
        projectPublicId: manifest.publicId,
        projectDbId: projectId,
        assetType: 'poster_pdf',
        fileName: parsed.posterPdf.fileName,
        content: parsed.posterPdf.content,
        mimeType: parsed.posterPdf.mimeType
      });
      mediaUploadedCount++;
    }

    if (parsed.snapshot1) {
      await uploadDraftMediaAsset({
        projectPublicId: manifest.publicId,
        projectDbId: projectId,
        assetType: 'snapshot_image',
        fileName: parsed.snapshot1.fileName,
        content: parsed.snapshot1.content,
        mimeType: parsed.snapshot1.mimeType
      });
      mediaUploadedCount++;
    }
  } catch (err: any) {
    console.error(`❌ Error uploading draft media: ${err.message}`);
    await supabase.from('import_batches').update({ status: 'failed' }).eq('id', batchId);
    process.exit(1);
  }

  // 6. Insert validation_flags rows (warnings or errors)
  const validationFlags: any[] = [];
  validation.errors.forEach(e => {
    validationFlags.push({
      project_id: projectId,
      severity: 'error',
      rule_code: e.ruleCode,
      message: e.message,
      field_name: e.fieldName || null
    });
  });
  validation.warnings.forEach(w => {
    validationFlags.push({
      project_id: projectId,
      severity: 'warning',
      rule_code: w.ruleCode,
      message: w.message,
      field_name: w.fieldName || null
    });
  });

  if (validationFlags.length > 0) {
    console.log(`Recording ${validationFlags.length} validation flag(s) in staging DB...`);
    const { error: flagsError } = await supabase
      .from('validation_flags')
      .insert(validationFlags);

    if (flagsError) {
      console.warn(`⚠️ Warning: Failed to record validation flags: ${flagsError.message}`);
    }
  }

  // 7. Mark batch completed
  const { error: completeError } = await supabase
    .from('import_batches')
    .update({ status: 'completed' })
    .eq('id', batchId);

  if (completeError) {
    console.warn(`⚠️ Warning: Failed to set batch status to completed: ${completeError.message}`);
  }

  // Final Output
  console.log('\n====================================================');
  console.log('✅ STAGING WORKSPACE IMPORT COMPLETED SUCCESSFULLY!');
  console.log('====================================================');
  console.log(`Import Batch ID:     [${batchId}]`);
  console.log(`Project Public ID:   [${manifest.publicId}]`);
  console.log(`Warning Count:       ${totalWarnings}`);
  console.log(`Error Count:         ${totalErrors}`);
  console.log(`Draft Media Upload:  ${mediaUploadedCount} file(s)`);
  console.log(`Status Mapped:       [in_review]`);
  console.log('====================================================\n');
}

run().catch(err => {
  console.error('Fatal Uncaught Importer Exception:', err);
  process.exit(1);
});
