import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());

import { createSupabaseAdminClientCore } from '../lib/supabase/adminCore';
import { validateStagingGuard } from '../security/stagingExecutionGuard';

export async function runCheckMediaAssets(args?: string[]): Promise<boolean> {
  validateStagingGuard({ operationId: 'check-media-assets', args });

  const supabase = createSupabaseAdminClientCore();

  console.log('Querying staging database media assets...');
  const { data: assets, error } = await supabase
    .from('media_assets')
    .select('*, projects(public_id)');

  if (error) {
    console.error('❌ Failed to fetch media assets:', error.message);
    return false;
  }

  const total = assets.length;
  const typeCounts: Record<string, number> = {};
  const bucketCounts: Record<string, number> = {};
  let draftCount = 0;
  let publicCount = 0;

  assets.forEach((asset) => {
    typeCounts[asset.asset_type] = (typeCounts[asset.asset_type] || 0) + 1;
    bucketCounts[asset.storage_bucket] = (bucketCounts[asset.storage_bucket] || 0) + 1;
    if (asset.is_public_approved) {
      publicCount++;
    } else {
      draftCount++;
    }
  });

  console.log('\n====================================================');
  console.log('📊 STAGING DATABASE MEDIA ASSET METRICS');
  console.log('====================================================');
  console.log(`Total Media Assets:       ${total}`);
  console.log(`Draft/Private Assets:     ${draftCount}`);
  console.log(`Public Approved Assets:   ${publicCount}`);
  console.log('----------------------------------------------------');
  console.log('Breakdown by Asset Type:');
  Object.entries(typeCounts).forEach(([type, count]) => {
    console.log(` - [${type.toUpperCase().padEnd(17)}]: ${count}`);
  });
  console.log('----------------------------------------------------');
  console.log('Breakdown by Storage Bucket:');
  Object.entries(bucketCounts).forEach(([bucket, count]) => {
    console.log(` - [${bucket.padEnd(25)}]: ${count}`);
  });
  console.log('----------------------------------------------------');
  console.log('Asset Storage Paths (Excluding URL domains):');
  assets.forEach((asset) => {
    console.log(` - Project: ${asset.projects?.public_id || 'Unknown'} | Type: ${asset.asset_type} | Path: ${asset.storage_bucket}/${asset.storage_path}`);
  });
  console.log('====================================================\n');
  return true;
}

if (require.main === module) {
  runCheckMediaAssets().then((success) => {
    if (!success) process.exit(1);
  }).catch((err) => {
    console.error('❌ Fatal error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
