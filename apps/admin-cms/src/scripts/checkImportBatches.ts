import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());

import { createSupabaseAdminClientCore } from '../lib/supabase/adminCore';

async function run() {
  console.log('====================================================');
  console.log('STAGING WORKSPACE: AUDITING IMPORT BATCHES');
  console.log('====================================================');

  const supabase = createSupabaseAdminClientCore();

  // 1. Fetch totals
  const { count: totalBatches, error: countError } = await supabase
    .from('import_batches')
    .select('*', { count: 'exact', head: true });

  if (countError) {
    console.error(`❌ Failed to query import batches total: ${countError.message}`);
    process.exit(1);
  }

  console.log(`Total Import Batches Logged: ${totalBatches || 0}\n`);

  // 2. Fetch latest 5 batches
  const { data: batches, error: fetchError } = await supabase
    .from('import_batches')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(5);

  if (fetchError) {
    console.error(`❌ Failed to load batches records: ${fetchError.message}`);
    process.exit(1);
  }

  if (!batches || batches.length === 0) {
    console.log('No import batch records found in the database staging environment.');
  } else {
    console.log('LATEST IMPORT BATCH RUNS:');
    batches.forEach((b, index) => {
      console.log(`\n[${index + 1}] Batch ID: ${b.id}`);
      console.log(`    Name:          ${b.batch_name}`);
      console.log(`    Source Folder: ${b.source_folder}`);
      console.log(`    Mode:          ${b.mode}`);
      console.log(`    Status:        [${b.status}]`);
      console.log(`    Total Projects:${b.total_projects}`);
      console.log(`    Errors/Warns:  ${b.error_count || 0} error(s), ${b.warning_count || 0} warning(s)`);
      console.log(`    Created At:    ${b.created_at}`);
    });
  }

  console.log('\n====================================================');
}

run().catch(err => {
  console.error('Fatal Audit Ingestion Exception:', err);
  process.exit(1);
});
