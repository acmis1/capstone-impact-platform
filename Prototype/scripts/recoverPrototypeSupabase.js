import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { getSupabaseKey, verifyProjectRef } from '../utils/authHelper.js';
import { 
  validateUniqueIds, 
  validateFeedSubset, 
  evaluateExistingRows, 
  evaluateExistingFeed, 
  sanitizeRecoveryFailure,
  scanObsoleteReferences,
  planRecovery,
  validateRecoveryConfig,
  canonicalJsonString
} from '../utils/recoveryHelper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Loads the private recovery environment variables.
 */
export function loadRecoveryEnv({ envPath, dotenvModule, fsModule } = {}) {
  const targetFs = fsModule || fs;
  const targetDotenv = dotenvModule || dotenv;
  const resolvedPath = envPath || path.resolve(__dirname, '../.env');

  if (!targetFs.existsSync(resolvedPath)) {
    return { loaded: false };
  }

  try {
    const result = targetDotenv.config({ path: resolvedPath });
    if (result.error) {
      throw result.error;
    }
    return { loaded: true };
  } catch (err) {
    throw new Error('ENV_FILE_LOAD_FAILED');
  }
}


/**
 * Injected recovery execution function.
 */
export async function runRecovery({
  isApply,
  supabaseUrl,
  supabaseKey,
  expectedRef,
  localSeed,
  localFeed,
  createSupabaseClient,
  logger = console,
  recoveryConfig
}) {
  // Capture local feed source, validate it, and compile an immutable buffer immediately (before any await/network)
  let feedData;
  let immutableFeedBuffer;

  if (typeof localFeed === 'string') {
    try {
      feedData = JSON.parse(localFeed);
    } catch (e) {
      logger.error('❌ Error: PUBLIC_FEED_JSON_INVALID');
      return { success: false, error: 'PUBLIC_FEED_JSON_INVALID' };
    }
    if (!Array.isArray(feedData)) {
      logger.error('❌ Error: PUBLIC_FEED_NOT_ARRAY');
      return { success: false, error: 'PUBLIC_FEED_NOT_ARRAY' };
    }
    immutableFeedBuffer = Buffer.from(localFeed, 'utf8');
  } else {
    feedData = localFeed;
    if (!Array.isArray(feedData)) {
      logger.error('❌ Error: PUBLIC_FEED_NOT_ARRAY');
      return { success: false, error: 'PUBLIC_FEED_NOT_ARRAY' };
    }
    try {
      const serialized = canonicalJsonString(localFeed);
      immutableFeedBuffer = Buffer.from(serialized, 'utf8');
    } catch (e) {
      logger.error('❌ Error: PUBLIC_FEED_JSON_INVALID');
      return { success: false, error: 'PUBLIC_FEED_JSON_INVALID' };
    }
  }

  // Parse seed JSON
  let dbData;
  try {
    dbData = typeof localSeed === 'string' ? JSON.parse(localSeed) : localSeed;
  } catch (e) {
    logger.error('❌ Error: SEED_JSON_INVALID');
    return { success: false, error: 'SEED_JSON_INVALID' };
  }
  if (!Array.isArray(dbData)) {
    logger.error('❌ Error: SEED_NOT_ARRAY');
    return { success: false, error: 'SEED_NOT_ARRAY' };
  }

  // Validate configuration targets first (fails before client creation)
  let validatedConfig;
  try {
    validatedConfig = validateRecoveryConfig(recoveryConfig);
  } catch (err) {
    const code = sanitizeRecoveryFailure('CONFIGURATION_INVALID', err);
    logger.error(`❌ Error: ${code}`);
    return { success: false, error: code };
  }

  // Verify schemas and unique IDs
  try {
    validateUniqueIds(dbData, 'SEED');
  } catch (err) {
    const code = sanitizeRecoveryFailure('SEED_SCHEMA_INVALID', err);
    logger.error(`❌ Error: ${code}`);
    return { success: false, error: code };
  }

  try {
    validateUniqueIds(feedData, 'FEED');
  } catch (err) {
    const code = sanitizeRecoveryFailure('PUBLIC_FEED_SCHEMA_INVALID', err);
    logger.error(`❌ Error: ${code}`);
    return { success: false, error: code };
  }

  // Verify subset relation
  try {
    validateFeedSubset(dbData, feedData);
  } catch (err) {
    const code = sanitizeRecoveryFailure('FEED_SUBSET_VIOLATION', err);
    logger.error(`❌ Error: ${code}`);
    return { success: false, error: code };
  }

  // Obsolete project references checks (apply blocked if any remain)
  const seedObsolete = scanObsoleteReferences(dbData);
  const feedObsolete = scanObsoleteReferences(feedData);
  const totalObsolete = seedObsolete.count + feedObsolete.count;

  logger.log('📋 DRY RUN RESULTS & RECOVERY PLAN');
  logger.log(`- Seed Database Record Count:  ${dbData.length}`);
  logger.log(`- Public Feed Record Count:    ${feedData.length}`);
  logger.log(`- Feed Subset Verified:        Yes`);
  logger.log(`- Obsolete Reference Count:    Seed: ${seedObsolete.count}, Feed: ${feedObsolete.count} (Total: ${totalObsolete})`);
  
  if (totalObsolete > 0) {
    logger.log('READY_FOR_APPLY: false');
    logger.log('APPLY_BLOCKED_OBSOLETE_REFERENCES');
    logger.log('----------------------------------------------------');
    logger.error('❌ Error: APPLY_BLOCKED_OBSOLETE_REFERENCES');
    return { success: false, error: 'APPLY_BLOCKED_OBSOLETE_REFERENCES', exitCode: 2 };
  }

  logger.log('READY_FOR_APPLY: true');
  logger.log('----------------------------------------------------');
  logger.log('✅ Sanitized recovery dry-run check: PASSED.');

  if (!isApply) {
    return { success: true, exitCode: 0 };
  }

  // Prove that parsing the immutable upload payload produces content canonically equal to feedData (before client creation)
  try {
    const parsedPayload = JSON.parse(immutableFeedBuffer.toString('utf8'));
    if (canonicalJsonString(parsedPayload) !== canonicalJsonString(feedData)) {
      throw new Error('VALIDATED_FEED_PAYLOAD_MISMATCH');
    }
  } catch (err) {
    logger.error('❌ Error: VALIDATED_FEED_PAYLOAD_MISMATCH');
    return { success: false, error: 'VALIDATED_FEED_PAYLOAD_MISMATCH' };
  }

  // Target Match Guards
  const verification = verifyProjectRef(supabaseUrl, expectedRef);
  if (verification !== 'TARGET_MATCH') {
    const errCode = verification === 'TARGET_CONFIGURATION_MISSING' ? 'TARGET_CONFIGURATION_MISSING' : 'TARGET_MISMATCH';
    logger.error(`❌ Error: ${errCode}`);
    return { success: false, error: errCode };
  }

  if (!supabaseUrl || !supabaseKey) {
    logger.error('❌ Error: SUPABASE_CLIENT_UNAVAILABLE');
    return { success: false, error: 'SUPABASE_CLIENT_UNAVAILABLE' };
  }

  // Create client via factory
  const supabase = createSupabaseClient(supabaseUrl, supabaseKey);
  if (!supabase) {
    logger.error('❌ Error: SUPABASE_CLIENT_UNAVAILABLE');
    return { success: false, error: 'SUPABASE_CLIENT_UNAVAILABLE' };
  }

  // Storage preflight checks
  const feedsBucketName = validatedConfig.feedBucket;
  const assetsBucketName = validatedConfig.assetBucket;

  logger.log('Performing Storage preflight visibility check...');
  let bucketState = {
    feedsExists: false,
    feedsPublic: false,
    projectAssetsExists: false,
    projectAssetsPublic: false
  };

  try {
    const { data: buckets, error: bucketError } = await supabase.storage.listBuckets();
    if (bucketError || !buckets) {
      throw new Error('STORAGE_PREFLIGHT_FAILED');
    }

    const feedsBucket = buckets.find(b => b.name === feedsBucketName);
    if (!feedsBucket) {
      logger.error('❌ Error: FEEDS_BUCKET_MISSING');
      return { success: false, error: 'FEEDS_BUCKET_MISSING' };
    }
    if (!feedsBucket.public) {
      logger.error('❌ Error: FEEDS_BUCKET_VISIBILITY_INVALID');
      return { success: false, error: 'FEEDS_BUCKET_VISIBILITY_INVALID' };
    }

    const assetsBucket = buckets.find(b => b.name === assetsBucketName);
    if (!assetsBucket) {
      logger.error('❌ Error: PROJECT_ASSETS_BUCKET_MISSING');
      return { success: false, error: 'PROJECT_ASSETS_BUCKET_MISSING' };
    }
    if (!assetsBucket.public) {
      logger.error('❌ Error: PROJECT_ASSETS_BUCKET_VISIBILITY_INVALID');
      return { success: false, error: 'PROJECT_ASSETS_BUCKET_VISIBILITY_INVALID' };
    }

    bucketState = {
      feedsExists: true,
      feedsPublic: true,
      projectAssetsExists: true,
      projectAssetsPublic: true
    };
  } catch (err) {
    logger.error('❌ Error: STORAGE_PREFLIGHT_FAILED');
    return { success: false, error: 'STORAGE_PREFLIGHT_FAILED' };
  }

  // Remote Feed state planning
  const feedFileName = validatedConfig.feedFile;
  logger.log(`Checking existing feed ${feedFileName} in bucket ${feedsBucketName}...`);
  let remoteFeedState = 'MISSING';

  try {
    const { data: files, error: listError } = await supabase.storage
      .from(feedsBucketName)
      .list();

    if (listError) {
      throw new Error('REMOTE_FEED_READ_FAILED');
    }

    const feedFileMeta = files.find(f => f.name === feedFileName);
    if (feedFileMeta) {
      const { data: blob, error: downloadError } = await supabase.storage
        .from(feedsBucketName)
        .download(feedFileName);

      if (downloadError || !blob) {
        throw new Error('REMOTE_FEED_READ_FAILED');
      }

      const text = await blob.text();
      let remoteFeedJson;
      try {
        remoteFeedJson = JSON.parse(text);
      } catch (e) {
        remoteFeedState = 'INVALID_JSON';
        throw new Error('REMOTE_FEED_INVALID_JSON');
      }

      try {
        evaluateExistingFeed(feedData, remoteFeedJson);
        remoteFeedState = 'EXISTS_IDENTICAL';
      } catch (err) {
        remoteFeedState = 'EXISTS_CONFLICTING';
        throw new Error('REMOTE_FEED_CONFLICT');
      }
    }
  } catch (err) {
    const code = sanitizeRecoveryFailure('REMOTE_FEED_READ_FAILED', err);
    logger.error(`❌ Error: ${code}`);
    return { success: false, error: code };
  }

  // Read remote database rows
  logger.log('Reading projects from remote database...');
  let remoteData;
  try {
    const { data, error } = await supabase
      .from('projects')
      .select('id, data');
    if (error) throw new Error('READ_FAILED');
    remoteData = data;
  } catch (err) {
    logger.error('❌ Error: REMOTE_PROJECTS_READ_FAILED');
    return { success: false, error: 'REMOTE_PROJECTS_READ_FAILED' };
  }

  // Atomic planning check
  const plan = planRecovery({
    localSeed: dbData,
    localFeed: feedData,
    remoteRows: remoteData,
    remoteFeedState,
    bucketState
  });

  if (!plan.ready) {
    logger.error(`❌ Error: ${plan.error}`);
    return { success: false, error: plan.error };
  }

  // Execute Database Seeding (Insert only)
  if (plan.shouldInsertDatabaseRecords) {
    const remoteIdSet = new Set(remoteData.map(r => Number(r.id)));
    const missingRecords = dbData.filter(d => !remoteIdSet.has(Number(d.id)));

    logger.log(`Seeding ${missingRecords.length} missing records to remote database...`);
    const insertPayload = missingRecords.map(p => ({
      id: p.id,
      data: p,
      updated_at: new Date().toISOString()
    }));

    const { error: insertError } = await supabase
      .from('projects')
      .insert(insertPayload);

    if (insertError) {
      logger.error('❌ Error: DATABASE_WRITE_FAILED');
      return { success: false, error: 'DATABASE_WRITE_FAILED' };
    }
    logger.log('✅ Remote database successfully seeded.');
  } else {
    logger.log('✅ All seed project records already exist and match on the remote database. No inserts required.');
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
    logger.error('❌ Error: RECOVERY_VERIFICATION_FAILED');
    return { success: false, error: 'RECOVERY_VERIFICATION_FAILED' };
  }

  try {
    evaluateExistingRows(dbData, finalRemoteData);
    if (finalRemoteData.length !== plan.expectedFinalDatabaseCount) {
      throw new Error('COUNT_MISMATCH');
    }
  } catch (err) {
    logger.error('❌ Error: RECOVERY_VERIFICATION_FAILED');
    return { success: false, error: 'RECOVERY_VERIFICATION_FAILED' };
  }

  // Execute Feed Upload using the immutable buffer snapshot
  if (plan.shouldCreateFeed) {
    logger.log(`Uploading public feed ${feedFileName}...`);
    
    const { error: uploadError } = await supabase.storage
      .from(feedsBucketName)
      .upload(feedFileName, immutableFeedBuffer, {
        contentType: 'application/json',
        upsert: false // Creation upload only
      });

    if (uploadError) {
      logger.error('❌ Error: REMOTE_FEED_UPLOAD_FAILED');
      return { success: false, error: 'REMOTE_FEED_UPLOAD_FAILED' };
    }
    logger.log('✅ Remote feed successfully uploaded.');
  }

  // Final remote feed verification using download
  try {
    const { data: verifyBlob, error: verifyDownloadError } = await supabase.storage
      .from(feedsBucketName)
      .download(feedFileName);

    if (verifyDownloadError || !verifyBlob) {
      throw new Error('REMOTE_FEED_VERIFICATION_FAILED');
    }

    const verifyText = await verifyBlob.text();
    const verifyJson = JSON.parse(verifyText);

    validateUniqueIds(verifyJson, 'FEED');
    evaluateExistingFeed(feedData, verifyJson);
    
    const dbIdsSet = new Set(finalRemoteData.map(d => Number(d.id)));
    const verifyIds = verifyJson.map(v => Number(v.id));
    if (!verifyIds.every(id => dbIdsSet.has(id))) {
      throw new Error('REMOTE_FEED_VERIFICATION_FAILED');
    }

    logger.log('====================================================');
    logger.log('🎉 REMOTE_FEED_VERIFIED');
    logger.log('====================================================');
    logger.log(`Total Database Records:      ${finalRemoteData.length}`);
    logger.log(`Total Public Feed Records:   ${verifyJson.length}`);
    logger.log('Verification Status:         PASSED');
    logger.log('⚠️ project-assets:          inventory audit complete; media restoration requires a separate reviewed manifest and controlled task; recovery:apply must not write to project-assets.');
    logger.log('====================================================\n');
    return { success: true, exitCode: 0 };
  } catch (err) {
    logger.error('❌ Error: REMOTE_FEED_VERIFICATION_FAILED');
    return { success: false, error: 'REMOTE_FEED_VERIFICATION_FAILED' };
  }
}

async function main() {
  try {
    loadRecoveryEnv();
  } catch (err) {
    console.error('❌ Error: ENV_FILE_LOAD_FAILED');
    process.exit(1);
  }

  const isApply = process.argv.includes('--apply');
  const dbPath = path.resolve(__dirname, '../data/db.json');
  const feedPath = path.resolve(__dirname, '../public/capstones-latest.json');
  
  const localSeed = fs.readFileSync(dbPath, 'utf8');
  const localFeed = fs.readFileSync(feedPath, 'utf8');

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = getSupabaseKey();
  const expectedRef = process.env.SUPABASE_EXPECTED_PROJECT_REF;

  const recoveryConfig = {
    feedBucket: process.env.SUPABASE_FEED_BUCKET || 'feeds',
    assetBucket: process.env.SUPABASE_ASSET_BUCKET || 'project-assets',
    feedFile: process.env.SUPABASE_FEED_FILE || 'capstones-latest.json'
  };

  const result = await runRecovery({
    isApply,
    supabaseUrl,
    supabaseKey,
    expectedRef,
    localSeed,
    localFeed,
    createSupabaseClient: createClient,
    logger: console,
    recoveryConfig
  });

  if (!result.success) {
    process.exit(result.exitCode !== undefined ? result.exitCode : 1);
  }
  process.exit(0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
