/**
 * Pure helper functions for Supabase recovery validation and comparison operations.
 */

/**
 * Recursively canonicalizes a JSON-compatible value by sorting object keys.
 * Preserves array order, preserves scalar values, and avoids mutating input values.
 */
export function canonicalizeJson(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }
  
  const sortedKeys = Object.keys(value).sort();
  const canonicalObj = {};
  for (const key of sortedKeys) {
    canonicalObj[key] = canonicalizeJson(value[key]);
  }
  return canonicalObj;
}

/**
 * Returns a deterministic JSON string representing a value.
 */
export function canonicalJsonString(value) {
  return JSON.stringify(canonicalizeJson(value));
}

/**
 * Validates recovery bucket and file names to enforce exact canonical configurations.
 */
export function validateRecoveryConfig(config) {
  if (!config) {
    throw new Error('INVALID_CONFIGURATION');
  }
  if (config.feedBucket && config.feedBucket !== 'feeds') {
    throw new Error('FEED_BUCKET_CONFIGURATION_INVALID');
  }
  if (config.assetBucket && config.assetBucket !== 'project-assets') {
    throw new Error('ASSET_BUCKET_CONFIGURATION_INVALID');
  }
  if (config.feedFile && config.feedFile !== 'capstones-latest.json') {
    throw new Error('FEED_FILE_CONFIGURATION_INVALID');
  }
  return {
    feedBucket: 'feeds',
    assetBucket: 'project-assets',
    feedFile: 'capstones-latest.json'
  };
}

/**
 * Verifies that all records in an array have unique positive safe integer IDs.
 * Returns true if unique, throws an Error with a safe message if duplicates are found.
 */
export function validateUniqueIds(records, type = 'SEED') {
  if (!Array.isArray(records)) {
    throw new Error('INVALID_DATA_TYPE');
  }
  
  // Validate that every record has a valid positive safe integer project ID
  for (const r of records) {
    if (r === null || typeof r !== 'object' || !Number.isInteger(r.id) || r.id <= 0 || !Number.isSafeInteger(r.id)) {
      throw new Error(type === 'SEED' ? 'SEED_SCHEMA_INVALID' : 'PUBLIC_FEED_SCHEMA_INVALID');
    }
  }

  const ids = records.map(r => r.id);
  const uniqueIds = new Set(ids);
  if (uniqueIds.size < ids.length) {
    throw new Error(type === 'SEED' ? 'DUPLICATE_SEED_IDS' : 'DUPLICATE_FEED_IDS');
  }
  return true;
}

/**
 * Verifies that every record in the public feed exists in the local seed database.
 * Returns true if valid, throws an Error if not.
 */
export function validateFeedSubset(seed, feed) {
  if (!Array.isArray(seed) || !Array.isArray(feed)) {
    throw new Error('INVALID_DATA_TYPE');
  }
  const seedIds = new Set(seed.map(p => p.id));
  const feedIds = feed.map(p => p.id);
  
  const invalidIds = feedIds.filter(id => !seedIds.has(id));
  if (invalidIds.length > 0) {
    throw new Error('FEED_SUBSET_VIOLATION');
  }
  return true;
}

/**
 * Compares expected local project object with actual remote project object canonically.
 */
export function compareProjectData(expected, actual) {
  return canonicalJsonString(expected) === canonicalJsonString(actual);
}

/**
 * Evaluates remote project records against local seed data.
 * Checks for unexpected project IDs and checks if existing records match.
 */
export function evaluateExistingRows(seed, remoteRows) {
  const seedMap = new Map(seed.map(p => [Number(p.id), p]));
  const remoteIds = remoteRows.map(r => Number(r.id));
  
  const unexpected = remoteIds.filter(id => !seedMap.has(id));
  if (unexpected.length > 0) {
    throw new Error('UNEXPECTED_REMOTE_PROJECTS');
  }

  for (const row of remoteRows) {
    const expected = seedMap.get(Number(row.id));
    if (expected) {
      if (!compareProjectData(expected, row.data)) {
        throw new Error('REMOTE_PROJECT_DATA_CONFLICT');
      }
    }
  }
  return true;
}

/**
 * Evaluates downloaded remote feed content against local feed array.
 */
export function evaluateExistingFeed(localFeed, remoteFeed) {
  if (!Array.isArray(remoteFeed)) {
    throw new Error('REMOTE_FEED_INVALID_JSON');
  }
  if (localFeed.length !== remoteFeed.length) {
    throw new Error('REMOTE_FEED_CONFLICT');
  }
  
  const localCanonical = canonicalJsonString(localFeed);
  const remoteCanonical = canonicalJsonString(remoteFeed);
  
  if (localCanonical !== remoteCanonical) {
    throw new Error('REMOTE_FEED_CONFLICT');
  }
  return true;
}

/**
 * Scans object hierarchy for references to the obsolete project subdomain.
 */
export function scanObsoleteReferences(data) {
  const deniedRef = 'xojnnhilqaldxoilmxli';
  const regex = new RegExp(deniedRef, 'g');
  let matchCount = 0;
  const affectedFields = new Set();

  function scanValue(val, keyContext = null) {
    if (val === null || val === undefined) return;
    if (typeof val === 'string') {
      regex.lastIndex = 0;
      const matches = val.match(regex);
      if (matches) {
        matchCount += matches.length;
        if (keyContext) {
          affectedFields.add(keyContext);
        }
      }
    } else if (Array.isArray(val)) {
      val.forEach(item => scanValue(item, keyContext));
    } else if (typeof val === 'object') {
      Object.keys(val).forEach((k) => {
        scanValue(val[k], keyContext || k);
      });
    }
  }

  scanValue(data);
  return {
    count: matchCount,
    affectedFields: [...affectedFields]
  };
}

/**
 * Generates recovery execution plan declaratively.
 */
export function planRecovery({
  localSeed,
  localFeed,
  remoteRows,
  remoteFeedState,
  bucketState
}) {
  if (!Array.isArray(localSeed) || !Array.isArray(localFeed)) {
    return {
      ready: false,
      error: 'INVALID_LOCAL_DATA',
      missingDatabaseRecordCount: 0,
      shouldInsertDatabaseRecords: false,
      shouldCreateFeed: false,
      shouldSkipFeedWrite: false,
      expectedFinalDatabaseCount: 0,
      expectedFinalFeedCount: 0
    };
  }

  if (!Array.isArray(remoteRows)) {
    return {
      ready: false,
      error: 'INVALID_REMOTE_ROWS',
      missingDatabaseRecordCount: 0,
      shouldInsertDatabaseRecords: false,
      shouldCreateFeed: false,
      shouldSkipFeedWrite: false,
      expectedFinalDatabaseCount: 0,
      expectedFinalFeedCount: 0
    };
  }

  if (!bucketState || typeof bucketState !== 'object') {
    return {
      ready: false,
      error: 'INVALID_BUCKET_STATE',
      missingDatabaseRecordCount: 0,
      shouldInsertDatabaseRecords: false,
      shouldCreateFeed: false,
      shouldSkipFeedWrite: false,
      expectedFinalDatabaseCount: 0,
      expectedFinalFeedCount: 0
    };
  }

  const requiredBucketFlags = ['feedsExists', 'feedsPublic', 'projectAssetsExists', 'projectAssetsPublic'];
  const hasValidFlags = requiredBucketFlags.every(flag => typeof bucketState[flag] === 'boolean');
  if (!hasValidFlags) {
    return {
      ready: false,
      error: 'INVALID_BUCKET_STATE',
      missingDatabaseRecordCount: 0,
      shouldInsertDatabaseRecords: false,
      shouldCreateFeed: false,
      shouldSkipFeedWrite: false,
      expectedFinalDatabaseCount: 0,
      expectedFinalFeedCount: 0
    };
  }

  const validFeedStates = ['MISSING', 'EXISTS_IDENTICAL', 'EXISTS_CONFLICTING', 'READ_FAILURE', 'INVALID_JSON'];
  if (!validFeedStates.includes(remoteFeedState)) {
    return {
      ready: false,
      error: 'INVALID_REMOTE_FEED_STATE',
      missingDatabaseRecordCount: 0,
      shouldInsertDatabaseRecords: false,
      shouldCreateFeed: false,
      shouldSkipFeedWrite: false,
      expectedFinalDatabaseCount: 0,
      expectedFinalFeedCount: 0
    };
  }

  // 1. Bucket preflight check
  if (!bucketState.feedsExists) {
    return {
      ready: false,
      error: 'FEEDS_BUCKET_MISSING',
      missingDatabaseRecordCount: 0,
      shouldInsertDatabaseRecords: false,
      shouldCreateFeed: false,
      shouldSkipFeedWrite: false,
      expectedFinalDatabaseCount: 0,
      expectedFinalFeedCount: 0
    };
  }
  if (!bucketState.feedsPublic) {
    return {
      ready: false,
      error: 'FEEDS_BUCKET_VISIBILITY_INVALID',
      missingDatabaseRecordCount: 0,
      shouldInsertDatabaseRecords: false,
      shouldCreateFeed: false,
      shouldSkipFeedWrite: false,
      expectedFinalDatabaseCount: 0,
      expectedFinalFeedCount: 0
    };
  }
  if (!bucketState.projectAssetsExists) {
    return {
      ready: false,
      error: 'PROJECT_ASSETS_BUCKET_MISSING',
      missingDatabaseRecordCount: 0,
      shouldInsertDatabaseRecords: false,
      shouldCreateFeed: false,
      shouldSkipFeedWrite: false,
      expectedFinalDatabaseCount: 0,
      expectedFinalFeedCount: 0
    };
  }
  if (!bucketState.projectAssetsPublic) {
    return {
      ready: false,
      error: 'PROJECT_ASSETS_BUCKET_VISIBILITY_INVALID',
      missingDatabaseRecordCount: 0,
      shouldInsertDatabaseRecords: false,
      shouldCreateFeed: false,
      shouldSkipFeedWrite: false,
      expectedFinalDatabaseCount: 0,
      expectedFinalFeedCount: 0
    };
  }

  // 2. Storage Feed status check before DB writes
  if (remoteFeedState === 'READ_FAILURE') {
    return {
      ready: false,
      error: 'REMOTE_FEED_READ_FAILED',
      missingDatabaseRecordCount: 0,
      shouldInsertDatabaseRecords: false,
      shouldCreateFeed: false,
      shouldSkipFeedWrite: false,
      expectedFinalDatabaseCount: 0,
      expectedFinalFeedCount: 0
    };
  }
  if (remoteFeedState === 'INVALID_JSON') {
    return {
      ready: false,
      error: 'REMOTE_FEED_INVALID_JSON',
      missingDatabaseRecordCount: 0,
      shouldInsertDatabaseRecords: false,
      shouldCreateFeed: false,
      shouldSkipFeedWrite: false,
      expectedFinalDatabaseCount: 0,
      expectedFinalFeedCount: 0
    };
  }
  if (remoteFeedState === 'EXISTS_CONFLICTING') {
    return {
      ready: false,
      error: 'REMOTE_FEED_CONFLICT',
      missingDatabaseRecordCount: 0,
      shouldInsertDatabaseRecords: false,
      shouldCreateFeed: false,
      shouldSkipFeedWrite: false,
      expectedFinalDatabaseCount: 0,
      expectedFinalFeedCount: 0
    };
  }

  // 3. Database validation
  const seedIds = new Set(localSeed.map(p => Number(p.id)));
  const remoteIds = remoteRows.map(r => Number(r.id));
  const unexpectedRemoteIds = remoteIds.filter(id => !seedIds.has(id));
  
  if (unexpectedRemoteIds.length > 0) {
    return {
      ready: false,
      error: 'UNEXPECTED_REMOTE_PROJECTS',
      missingDatabaseRecordCount: 0,
      shouldInsertDatabaseRecords: false,
      shouldCreateFeed: false,
      shouldSkipFeedWrite: false,
      expectedFinalDatabaseCount: 0,
      expectedFinalFeedCount: 0
    };
  }

  const seedMap = new Map(localSeed.map(p => [Number(p.id), p]));
  for (const row of remoteRows) {
    const expected = seedMap.get(Number(row.id));
    if (expected) {
      if (!compareProjectData(expected, row.data)) {
        return {
          ready: false,
          error: 'REMOTE_PROJECT_DATA_CONFLICT',
          missingDatabaseRecordCount: 0,
          shouldInsertDatabaseRecords: false,
          shouldCreateFeed: false,
          shouldSkipFeedWrite: false,
          expectedFinalDatabaseCount: 0,
          expectedFinalFeedCount: 0
        };
      }
    }
  }

  const remoteIdSet = new Set(remoteIds);
  const missingCount = localSeed.filter(d => !remoteIdSet.has(Number(d.id))).length;
  
  const shouldInsert = missingCount > 0;
  const shouldCreateFeed = remoteFeedState === 'MISSING';
  const shouldSkipFeedWrite = remoteFeedState === 'EXISTS_IDENTICAL';

  return {
    ready: true,
    error: null,
    missingDatabaseRecordCount: missingCount,
    shouldInsertDatabaseRecords: shouldInsert,
    shouldCreateFeed,
    shouldSkipFeedWrite,
    expectedFinalDatabaseCount: localSeed.length,
    expectedFinalFeedCount: localFeed.length
  };
}

/**
 * Sanitizes errors to report only standard safe error codes.
 */
export function sanitizeRecoveryFailure(stage, err) {
  const message = err.message || '';
  if (message.includes('TARGET_MISMATCH')) return 'TARGET_MISMATCH';
  if (message.includes('TARGET_CONFIGURATION_MISSING')) return 'TARGET_CONFIGURATION_MISSING';
  if (message.includes('DUPLICATE_SEED_IDS')) return 'DUPLICATE_SEED_IDS';
  if (message.includes('DUPLICATE_FEED_IDS')) return 'DUPLICATE_FEED_IDS';
  if (message.includes('FEED_SUBSET_VIOLATION')) return 'FEED_SUBSET_VIOLATION';
  if (message.includes('UNEXPECTED_REMOTE_PROJECTS')) return 'UNEXPECTED_REMOTE_PROJECTS';
  if (message.includes('REMOTE_PROJECT_DATA_CONFLICT')) return 'REMOTE_PROJECT_DATA_CONFLICT';
  if (message.includes('REMOTE_FEED_CONFLICT')) return 'REMOTE_FEED_CONFLICT';
  if (message.includes('REMOTE_FEED_INVALID_JSON')) return 'REMOTE_FEED_INVALID_JSON';
  if (message.includes('SEED_SCHEMA_INVALID')) return 'SEED_SCHEMA_INVALID';
  if (message.includes('PUBLIC_FEED_SCHEMA_INVALID')) return 'PUBLIC_FEED_SCHEMA_INVALID';
  if (message.includes('FEED_BUCKET_CONFIGURATION_INVALID')) return 'FEED_BUCKET_CONFIGURATION_INVALID';
  if (message.includes('ASSET_BUCKET_CONFIGURATION_INVALID')) return 'ASSET_BUCKET_CONFIGURATION_INVALID';
  if (message.includes('FEED_FILE_CONFIGURATION_INVALID')) return 'FEED_FILE_CONFIGURATION_INVALID';
  
  return stage;
}
