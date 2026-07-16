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
  
  // It is an object, sort keys recursively
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
 * Verifies that all records in an array have unique IDs.
 * Returns true if unique, throws an Error with a safe message if duplicates are found.
 */
export function validateUniqueIds(records, type = 'SEED') {
  if (!Array.isArray(records)) {
    throw new Error('INVALID_DATA_TYPE');
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
  
  // Verify no unexpected IDs exist in remote projects
  const unexpected = remoteIds.filter(id => !seedMap.has(id));
  if (unexpected.length > 0) {
    throw new Error('UNEXPECTED_REMOTE_PROJECTS');
  }

  // Verify that any existing record's data matches seed data exactly
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
  
  return stage;
}
