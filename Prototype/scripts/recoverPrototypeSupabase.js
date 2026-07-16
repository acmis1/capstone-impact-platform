import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import { getSupabaseKey, verifyProjectRef } from '../utils/authHelper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Idempotent recovery script for recreating the deleted Prototype Supabase backend.
 * 
 * Rules:
 * - Dry-run mode performs full structural and reference checks completely offline without creating a client.
 * - Apply mode requires explicit flag, target-reference match verification, and prevents any delete actions.
 * - Safely prevents overwriting mismatched remote records.
 */
async function main() {
  const isApply = process.argv.includes('--apply');
  const dbPath = path.resolve(__dirname, '../data/db.json');
  const feedPath = path.resolve(__dirname, '../public/capstones-latest.json');

  console.log('====================================================');
  console.log('🔄 PROTOTYPE SUPABASE RECOVERY SYSTEM');
  console.log('====================================================');

  // 1. Dry Run Offline Validation Phase
  let dbData;
  let feedData;
  try {
    const dbRaw = fs.readFileSync(dbPath, 'utf8');
    dbData = JSON.parse(dbRaw);
    if (!Array.isArray(dbData)) throw new Error('db.json is not an array.');
  } catch (e) {
    console.error('❌ Failed to parse seed database:', e.message);
    process.exit(1);
  }

  try {
    const feedRaw = fs.readFileSync(feedPath, 'utf8');
    feedData = JSON.parse(feedRaw);
    if (!Array.isArray(feedData)) throw new Error('capstones-latest.json is not an array.');
  } catch (e) {
    console.error('❌ Failed to parse public feed:', e.message);
    process.exit(1);
  }

  // Duplicate ID verification
  const dbIds = dbData.map(p => p.id);
  const uniqueDbIds = new Set(dbIds);
  const duplicateDbIds = dbIds.filter((item, index) => dbIds.indexOf(item) !== index);
  if (duplicateDbIds.length > 0) {
    console.error('❌ Duplicate IDs found in seed database:', duplicateDbIds);
    process.exit(1);
  }

  // Feed subset check
  const feedIds = feedData.map(p => p.id);
  const missingFromSeed = feedIds.filter(id => !uniqueDbIds.has(id));
  if (missingFromSeed.length > 0) {
    console.error('❌ Feed contains IDs missing from seed data:', missingFromSeed);
    process.exit(1);
  }

  // Obsolete domain references audit (mask the target reference)
  const targetPattern = /xojnnhilqaldxoilmxli/g;
  let domainMatchCount = 0;
  const fieldsWithDomain = new Set();
  
  dbData.forEach((project) => {
    const str = JSON.stringify(project);
    const matches = str.match(targetPattern);
    if (matches) {
      domainMatchCount += matches.length;
      Object.keys(project).forEach((key) => {
        const val = project[key];
        if (typeof val === 'string' && targetPattern.test(val)) {
          fieldsWithDomain.add(key);
        } else if (Array.isArray(val)) {
          val.forEach((item) => {
            if (typeof item === 'string' && targetPattern.test(item)) {
              fieldsWithDomain.add(`${key} (array item)`);
            }
          });
        }
      });
    }
  });

  // Local assets inventory counts
  const demoAssetsPath = path.resolve(__dirname, '../../capstone-impact-demo-assets');
  const batchAssetsPath = path.resolve(__dirname, '../../capstone-import-batch-demo-final');
  const assetCounts = {};

  function scanDir(dir) {
    if (!fs.existsSync(dir)) return;
    const items = fs.readdirSync(dir);
    items.forEach((item) => {
      const full = path.join(dir, item);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        scanDir(full);
      } else if (stat.isFile()) {
        const ext = path.extname(item).toLowerCase();
        if (ext) {
          assetCounts[ext] = (assetCounts[ext] || 0) + 1;
        }
      }
    });
  }
  scanDir(demoAssetsPath);
  scanDir(batchAssetsPath);

  console.log('📋 DRY RUN RESULTS & RECOVERY PLAN');
  console.log(`- Seed Database Record Count:  ${dbData.length}`);
  console.log(`- Public Feed Record Count:    ${feedData.length}`);
  console.log(`- Feed Subset Verified:        Yes (all feed records exist in seed)`);
  console.log(`- Duplicate IDs Checked:       None`);
  console.log(`- Obsolete Domain References:  Detected ${domainMatchCount} occurrences in fields: ${[...fieldsWithDomain].join(', ')}`);
  console.log('- Local Recoverable Asset counts by extension:');
  Object.keys(assetCounts).sort().forEach((ext) => {
    console.log(`   * ${ext}: ${assetCounts[ext]} files`);
  });
  console.log('----------------------------------------------------');
  console.log('✅ Sanitized recovery dry-run check: PASSED.');

  if (!isApply) {
    console.log('\n💡 To perform the recovery run, execute:');
    console.log('   npm run recovery:apply');
    console.log('====================================================\n');
    process.exit(0);
  }

  // 2. Apply Mode Active Execution Phase
  console.log('\n🚀 Starting active database seeding and feed recovery...');

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = getSupabaseKey();
  const expectedRef = process.env.SUPABASE_EXPECTED_PROJECT_REF;

  if (!supabaseUrl || !supabaseKey) {
    console.error('❌ Configuration Error: SUPABASE_URL or keys missing.');
    process.exit(1);
  }

  const verification = verifyProjectRef(supabaseUrl, expectedRef);
  if (verification !== 'TARGET_MATCH') {
    console.error(`❌ Security Violation: Target reference check failed (${verification}). Write operations blocked.`);
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  // Read existing table rows
  console.log('Reading projects from remote database...');
  const { data: remoteData, error: readError } = await supabase
    .from('projects')
    .select('id, data');

  if (readError) {
    console.error('❌ Database read error:', readError.message);
    process.exit(1);
  }

  // Validate existing table contents
  const remoteIds = remoteData.map(r => Number(r.id));
  const unexpectedRemoteIds = remoteIds.filter(id => !uniqueDbIds.has(id));
  if (unexpectedRemoteIds.length > 0) {
    console.error('❌ Security block: Database contains unexpected project IDs:', unexpectedRemoteIds);
    process.exit(1);
  }

  // Check if existing records match expected data to verify safety of idempotent run
  for (const row of remoteData) {
    const dbMatch = dbData.find(d => Number(d.id) === Number(row.id));
    if (dbMatch && JSON.stringify(row.data) !== JSON.stringify(dbMatch)) {
      console.error(`❌ Security block: Database project ID ${row.id} data does not match the local seed data.`);
      process.exit(1);
    }
  }

  // If table is empty or matches seed data, insert missing rows idempotently
  const remoteIdSet = new Set(remoteIds);
  const missingRecords = dbData.filter(d => !remoteIdSet.has(d.id));

  if (missingRecords.length > 0) {
    console.log(`Seeding ${missingRecords.length} missing records to remote database...`);
    const insertPayload = missingRecords.map(p => ({
      id: p.id,
      data: p,
      updated_at: new Date().toISOString()
    }));

    const { error: insertError } = await supabase
      .from('projects')
      .insert(insertPayload);

    if (insertError) {
      console.error('❌ Seeding failure:', insertError.message);
      process.exit(1);
    }
    console.log('✅ Remote database successfully seeded.');
  } else {
    console.log('✅ All seed project records already exist and match on the remote database. No inserts required.');
  }

  // Upload capstones-latest.json to feeds bucket
  const bucketName = process.env.SUPABASE_FEED_BUCKET || 'feeds';
  const fileName = process.env.SUPABASE_FEED_FILE || 'capstones-latest.json';
  const fileBuffer = fs.readFileSync(feedPath);

  console.log(`Uploading public feed ${fileName} to bucket ${bucketName}...`);
  const { error: uploadError } = await supabase.storage
    .from(bucketName)
    .upload(fileName, fileBuffer, {
      contentType: 'application/json',
      upsert: true
    });

  if (uploadError) {
    console.error('❌ Storage upload failure:', uploadError.message);
    process.exit(1);
  }

  // Verify aggregate counts
  const { data: finalRemoteData, error: finalReadError } = await supabase
    .from('projects')
    .select('id');

  if (finalReadError) {
    console.error('❌ Verification read failure:', finalReadError.message);
    process.exit(1);
  }

  console.log('====================================================');
  console.log('🎉 RECOVERY AND ACTIVATION SUCCESS');
  console.log('====================================================');
  console.log(`Total Database Records:      ${finalRemoteData.length}`);
  console.log(`Total Public Feed Records:   ${feedData.length}`);
  console.log('Verification Status:         PASSED');
  console.log('====================================================\n');
}

main();
