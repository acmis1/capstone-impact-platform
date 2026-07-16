import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import { getSupabaseKey, verifyProjectRef } from '../utils/authHelper.js';
import { 
  validateUniqueIds, 
  validateFeedSubset, 
  evaluateExistingRows, 
  evaluateExistingFeed, 
  sanitizeRecoveryFailure,
  canonicalJsonString
} from '../utils/recoveryHelper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Idempotent recovery script for recreating the deleted Prototype Supabase backend.
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

  // Validate seed unique IDs
  try {
    validateUniqueIds(dbData, 'SEED');
  } catch (err) {
    const code = sanitizeRecoveryFailure('DUPLICATE_SEED_IDS', err);
    console.error(`❌ Error: ${code}`);
    process.exit(1);
  }

  // Validate feed unique IDs
  try {
    validateUniqueIds(feedData, 'FEED');
  } catch (err) {
    const code = sanitizeRecoveryFailure('DUPLICATE_FEED_IDS', err);
    console.error(`❌ Error: ${code}`);
    process.exit(1);
  }

  // Validate feed is subset of seed
  try {
    validateFeedSubset(dbData, feedData);
  } catch (err) {
    const code = sanitizeRecoveryFailure('FEED_SUBSET_VIOLATION', err);
    console.error(`❌ Error: ${code}`);
    process.exit(1);
  }

  // Obsolete domain references audit
  const targetPattern = /xojnnhilqaldxoilmxli/g;
  let domainMatchCount = 0;
  const fieldsWithDomain = new Set();
  
  dbData.forEach((project) => {
    // Reset index before parsing JSON string representation
    targetPattern.lastIndex = 0;
    const str = JSON.stringify(project);
    const matches = str.match(targetPattern);
    if (matches) {
      domainMatchCount += matches.length;
      Object.keys(project).forEach((key) => {
        const val = project[key];
        // Reset index for individual test evaluations
        targetPattern.lastIndex = 0;
        if (typeof val === 'string' && targetPattern.test(val)) {
          fieldsWithDomain.add(key);
        } else if (Array.isArray(val)) {
          val.forEach((item) => {
            targetPattern.lastIndex = 0;
            if (typeof item === 'string' && targetPattern.test(item)) {
              fieldsWithDomain.add(`${key} (array item)`);
            }
          });
        }
      });
    }
  });

  // Scan local assets by count and extension only
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
  console.log(`- Feed Subset Verified:        Yes`);
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

  // Enforce safety guards before initializing the client
  const verification = verifyProjectRef(supabaseUrl, expectedRef);
  if (verification !== 'TARGET_MATCH') {
    const errCode = verification === 'TARGET_CONFIGURATION_MISSING' ? 'TARGET_CONFIGURATION_MISSING' : 'TARGET_MISMATCH';
    console.error(`❌ Error: ${errCode}`);
    process.exit(1);
  }

  if (!supabaseUrl || !supabaseKey) {
    console.error('❌ Error: SUPABASE_CLIENT_UNAVAILABLE');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  // Read remote database rows
  console.log('Reading projects from remote database...');
  let remoteData;
  try {
    const { data, error } = await supabase
      .from('projects')
      .select('id, data');
    if (error) throw new Error('READ_FAILED');
    remoteData = data;
  } catch (err) {
    console.error('❌ Error: REMOTE_PROJECTS_READ_FAILED');
    process.exit(1);
  }

  // Validate existing table contents
  try {
    evaluateExistingRows(dbData, remoteData);
  } catch (err) {
    const code = sanitizeRecoveryFailure('DATABASE_VERIFICATION_FAILED', err);
    if (code === 'UNEXPECTED_REMOTE_PROJECTS') {
      const dbIds = new Set(dbData.map(p => Number(p.id)));
      const count = remoteData.filter(r => !dbIds.has(Number(r.id))).length;
      console.error(`❌ Error: UNEXPECTED_REMOTE_PROJECTS (${count} rows)`);
    } else if (code === 'REMOTE_PROJECT_DATA_CONFLICT') {
      console.error('❌ Error: REMOTE_PROJECT_DATA_CONFLICT');
    } else {
      console.error(`❌ Error: ${code}`);
    }
    process.exit(1);
  }

  // Idempotently insert missing rows
  const remoteIdSet = new Set(remoteData.map(r => Number(r.id)));
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
      console.error('❌ Error: DATABASE_WRITE_FAILED');
      process.exit(1);
    }
    console.log('✅ Remote database successfully seeded.');
  } else {
    console.log('✅ All seed project records already exist and match on the remote database. No inserts required.');
  }

  // Re-read remote rows for final verification
  let finalRemoteData;
  try {
    const { data, error } = await supabase
      .from('projects')
      .select('id, data');
    if (error) throw new Error('VERIFICATION_FAILED');
    finalRemoteData = data;
  } catch (err) {
    console.error('❌ Error: RECOVERY_VERIFICATION_FAILED');
    process.exit(1);
  }

  try {
    evaluateExistingRows(dbData, finalRemoteData);
    if (finalRemoteData.length !== dbData.length) {
      throw new Error('COUNT_MISMATCH');
    }
  } catch (err) {
    console.error('❌ Error: RECOVERY_VERIFICATION_FAILED');
    process.exit(1);
  }

  // 3. Safe Feed Restoration Phase
  const bucketName = process.env.SUPABASE_FEED_BUCKET || 'feeds';
  const fileName = process.env.SUPABASE_FEED_FILE || 'capstones-latest.json';

  console.log(`Checking existing feed ${fileName} in bucket ${bucketName}...`);
  let remoteFeedData = null;
  let feedExists = false;

  try {
    const { data: blob, error: downloadError } = await supabase.storage
      .from(bucketName)
      .download(fileName);
      
    if (!downloadError && blob) {
      const text = await blob.text();
      remoteFeedData = JSON.parse(text);
      feedExists = true;
    } else if (downloadError && downloadError.message !== 'Object not found') {
      throw new Error('REMOTE_FEED_READ_FAILED');
    }
  } catch (err) {
    console.error('❌ Error: REMOTE_FEED_READ_FAILED');
    process.exit(1);
  }

  if (feedExists) {
    try {
      evaluateExistingFeed(feedData, remoteFeedData);
      console.log('✅ Remote feed exists and canonically matches local feed. Skipping upload.');
    } catch (err) {
      const code = sanitizeRecoveryFailure('REMOTE_FEED_CONFLICT', err);
      console.error(`❌ Error: ${code}`);
      process.exit(1);
    }
  } else {
    // Feed missing, perform creation upload
    console.log(`Uploading public feed ${fileName}...`);
    const fileBuffer = fs.readFileSync(feedPath);
    
    const { error: uploadError } = await supabase.storage
      .from(bucketName)
      .upload(fileName, fileBuffer, {
        contentType: 'application/json',
        upsert: false // Creation upload only
      });

    if (uploadError) {
      console.error('❌ Error: REMOTE_FEED_UPLOAD_FAILED');
      process.exit(1);
    }
    console.log('✅ Remote feed successfully uploaded.');
  }

  // Final Remote Feed Verification
  try {
    const { data: verifyBlob, error: verifyDownloadError } = await supabase.storage
      .from(bucketName)
      .download(fileName);

    if (verifyDownloadError || !verifyBlob) {
      throw new Error('REMOTE_FEED_VERIFICATION_FAILED');
    }

    const verifyText = await verifyBlob.text();
    const verifyJson = JSON.parse(verifyText);

    // Verify it is array, unique feed IDs, canonical content match, counts match, remains subset of final db
    validateUniqueIds(verifyJson, 'FEED');
    evaluateExistingFeed(feedData, verifyJson);
    
    const dbIdsSet = new Set(finalRemoteData.map(d => Number(d.id)));
    const verifyIds = verifyJson.map(v => Number(v.id));
    if (!verifyIds.every(id => dbIdsSet.has(id))) {
      throw new Error('REMOTE_FEED_VERIFICATION_FAILED');
    }

    console.log('====================================================');
    console.log('🎉 REMOTE_FEED_VERIFIED');
    console.log('====================================================');
    console.log(`Total Database Records:      ${finalRemoteData.length}`);
    console.log(`Total Public Feed Records:   ${verifyJson.length}`);
    console.log('Verification Status:         PASSED');
    console.log('⚠️ project-assets:          inventory audit complete; media restoration requires a separate reviewed manifest and controlled task; recovery:apply must not write to project-assets.');
    console.log('====================================================\n');
  } catch (err) {
    console.error('❌ Error: REMOTE_FEED_VERIFICATION_FAILED');
    process.exit(1);
  }
}

main();
