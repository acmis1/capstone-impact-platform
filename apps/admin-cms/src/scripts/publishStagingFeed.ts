import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());

import { SupabaseProjectRepository } from '../repositories/SupabaseProjectRepository';
import { compilePublicFeed } from '../feed/compilePublicFeed';
import { validatePublicFeed } from '../feed/validatePublicFeed';
import { uploadPublicFeedToStorage } from '../storage/publicFeedStorage';
import { createSupabaseAdminClientCore } from '../lib/supabase/adminCore';
import { getServerEnv } from '../lib/env';

async function publish() {
  const env = getServerEnv();
  const repository = new SupabaseProjectRepository();
  const supabase = createSupabaseAdminClientCore();

  console.log('Fetching projects from staging database...');
  let projects;
  try {
    projects = await repository.listProjects();
  } catch (e: any) {
    console.error('❌ Failed to fetch projects from database:', e.message);
    process.exit(1);
  }

  console.log(`Loaded ${projects.length} projects from database.`);

  // 1. Compile Approved/Published projects only
  console.log('Sanitizing and compiling approved-only public feed...');
  const feed = compilePublicFeed(projects);
  console.log(`Compiled feed contains ${feed.length} public records.`);

  // 2. Validate feed against schema allow-list
  console.log('Validating feed against staging public feed contract...');
  const validation = validatePublicFeed(feed);

  if (!validation.valid) {
    console.error('❌ Staging Feed Contract Validation FAILED:');
    validation.errors.forEach((err) => console.error(` - Error: ${err}`));
    process.exit(1);
  }

  console.log('✅ Staging Feed Contract Validation PASSED!');
  if (validation.warnings.length > 0) {
    console.log(`⚠️ Warnings detected (${validation.warnings.length}):`);
    validation.warnings.forEach((warn) => console.log(` - Warning: ${warn}`));
  }

  // 3. Upload compiled JSON feed to Supabase Storage
  console.log('Uploading compiled JSON feed to storage...');
  let uploadResult;
  try {
    uploadResult = await uploadPublicFeedToStorage({ feed });
  } catch (e: any) {
    console.error('❌ Storage upload failed:', e.message);
    process.exit(1);
  }

  // 4. Record published snapshot inside DB audit log
  console.log('Recording audit log snapshot in database...');
  const { error: snapshotError } = await supabase
    .from('published_snapshots')
    .insert({
      feed_file_name: env.SUPABASE_PUBLIC_FEED_FILE,
      storage_bucket: env.SUPABASE_PUBLIC_FEEDS_BUCKET,
      storage_path: uploadResult.storagePath,
      public_url: uploadResult.publicUrl,
      record_count: uploadResult.recordCount,
      feed_hash: uploadResult.feedHash
    });

  if (snapshotError) {
    console.error('❌ Failed to insert published snapshot log:', snapshotError.message);
    process.exit(1);
  }

  console.log('\n====================================================');
  console.log('✅ FEED PUBLICATION SUCCESSFUL!');
  console.log('====================================================');
  console.log(`Total DB Projects Loaded:    ${projects.length}`);
  console.log(`Public Feed Record Count:    ${uploadResult.recordCount}`);
  console.log(`Validation Warnings:         ${validation.warnings.length}`);
  console.log(`Uploaded Storage Path:       ${uploadResult.storagePath}`);
  console.log(`Public Showcase Feed URL:    ${uploadResult.publicUrl}`);
  console.log(`Feed SHA-256 Checksum:       ${uploadResult.feedHash}`);
  console.log('====================================================\n');
}

publish();
