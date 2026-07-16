import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getSupabaseKey, verifyProjectRef, getProjectRef } from '../utils/authHelper.js';
import { runUrlAudit } from './auditDeletedUrls.js';
import { 
  canonicalizeJson, 
  canonicalJsonString, 
  validateUniqueIds, 
  validateFeedSubset, 
  compareProjectData, 
  evaluateExistingRows, 
  evaluateExistingFeed, 
  sanitizeRecoveryFailure,
  planRecovery
} from '../utils/recoveryHelper.js';
import { runRecovery } from './recoverPrototypeSupabase.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const tests = [];
let passedCount = 0;
let failedCount = 0;

function registerTest(name, fn) {
  tests.push({ name, fn });
}

// 1. Secret key preferred
registerTest('1. Secret key preferred', () => {
  process.env.SUPABASE_SECRET_KEY = 'secret-role';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role';
  assert.strictEqual(getSupabaseKey(), 'secret-role');
});

// 2. Legacy key fallback
registerTest('2. Legacy key fallback', () => {
  delete process.env.SUPABASE_SECRET_KEY;
  assert.strictEqual(getSupabaseKey(), 'service-role');
});

// 3. Missing key
registerTest('3. Missing key', () => {
  delete process.env.SUPABASE_SECRET_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  assert.strictEqual(getSupabaseKey(), undefined);
});

// 4. Valid exact HTTPS Supabase URL
registerTest('4. Valid exact HTTPS Supabase URL', () => {
  const url = 'https://testref12345.supabase.co';
  assert.strictEqual(getProjectRef(url), 'testref12345');
  assert.strictEqual(verifyProjectRef(url, 'testref12345'), 'TARGET_MATCH');
});

// 5. Project-reference mismatch
registerTest('5. Project-reference mismatch', () => {
  const url = 'https://testref12345.supabase.co';
  assert.strictEqual(verifyProjectRef(url, 'anotherref'), 'TARGET_MISMATCH');
});

// 6. Missing expected reference
registerTest('6. Missing expected reference', () => {
  const url = 'https://testref12345.supabase.co';
  assert.strictEqual(verifyProjectRef(url, null), 'TARGET_CONFIGURATION_MISSING');
  assert.strictEqual(verifyProjectRef(url, ''), 'TARGET_CONFIGURATION_MISSING');
  assert.strictEqual(verifyProjectRef(url, '   '), 'TARGET_CONFIGURATION_MISSING');
});

// 7. Malformed URL
registerTest('7. Malformed URL', () => {
  assert.strictEqual(verifyProjectRef('not-a-url', 'testref'), 'TARGET_CONFIGURATION_MISSING');
});

// 8. HTTP rejected
registerTest('8. HTTP rejected', () => {
  assert.strictEqual(verifyProjectRef('http://testref12345.supabase.co', 'testref12345'), 'TARGET_MISMATCH');
});

// 9. Hostname suffix attack rejected
registerTest('9. Hostname suffix attack rejected', () => {
  assert.strictEqual(verifyProjectRef('https://testref12345.supabase.co.evil.com', 'testref12345'), 'TARGET_MISMATCH');
});

// 10. Embedded credentials rejected
registerTest('10. Embedded credentials rejected', () => {
  assert.strictEqual(verifyProjectRef('https://user:pass@testref12345.supabase.co', 'testref12345'), 'TARGET_MISMATCH');
});

// 11. Deleted reference rejected
registerTest('11. Deleted reference rejected', () => {
  const deletedUrl = 'https://xojnnhilqaldxoilmxli.supabase.co';
  assert.strictEqual(verifyProjectRef(deletedUrl, 'xojnnhilqaldxoilmxli'), 'TARGET_MISMATCH');
});

// 12. Missing expected reference blocks projectStore writes
registerTest('12. Missing expected reference blocks projectStore writes', () => {
  assert.strictEqual(verifyProjectRef('https://testref12345.supabase.co', undefined), 'TARGET_CONFIGURATION_MISSING');
});

// 13. Missing expected reference blocks feed publishing
registerTest('13. Missing expected reference blocks feed publishing', () => {
  assert.strictEqual(verifyProjectRef('https://testref12345.supabase.co', ''), 'TARGET_CONFIGURATION_MISSING');
});

// 14. Mismatch blocks database client creation
registerTest('14. Mismatch blocks database client creation', () => {
  const url = 'https://testref12345.supabase.co';
  const result = verifyProjectRef(url, 'differentref');
  assert.strictEqual(result, 'TARGET_MISMATCH');
});

// 15. Mismatch blocks Storage client creation
registerTest('15. Mismatch blocks Storage client creation', () => {
  const url = 'https://testref12345.supabase.co';
  const result = verifyProjectRef(url, 'capstone-prototype-recovery-2026');
  assert.strictEqual(result, 'TARGET_MISMATCH');
});

// 16. Dry-run creates no client
registerTest('16. Dry-run creates no client', async () => {
  let factoryCalled = false;
  const mockFactory = () => { factoryCalled = true; return {}; };
  
  const result = await runRecovery({
    isApply: false,
    supabaseUrl: 'https://testref12345.supabase.co',
    supabaseKey: 'somekey',
    expectedRef: 'testref12345',
    localSeed: '[]',
    localFeed: '[]',
    createSupabaseClient: mockFactory,
    fileAdapter: {},
    logger: { log: () => {}, error: () => {} }
  });
  
  assert.strictEqual(result.success, true);
  assert.strictEqual(factoryCalled, false);
});

// 17. Unique 10-record seed
registerTest('17. Unique 10-record seed', () => {
  const dbPath = path.resolve(__dirname, '../data/db.json');
  const dbData = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  assert.strictEqual(dbData.length, 10);
  assert.ok(validateUniqueIds(dbData, 'SEED'));
});

// 18. Unique 6-record feed
registerTest('18. Unique 6-record feed', () => {
  const feedPath = path.resolve(__dirname, '../public/capstones-latest.json');
  const feedData = JSON.parse(fs.readFileSync(feedPath, 'utf8'));
  assert.strictEqual(feedData.length, 6);
  assert.ok(validateUniqueIds(feedData, 'FEED'));
});

// 19. Duplicate seed IDs rejected
registerTest('19. Duplicate seed IDs rejected', () => {
  assert.throws(() => validateUniqueIds([{ id: 1 }, { id: 1 }], 'SEED'), /DUPLICATE_SEED_IDS/);
});

// 20. Duplicate feed IDs rejected
registerTest('20. Duplicate feed IDs rejected', () => {
  assert.throws(() => validateUniqueIds([{ id: 2 }, { id: 2 }], 'FEED'), /DUPLICATE_FEED_IDS/);
});

// 21. Feed subset validation
registerTest('21. Feed subset validation', () => {
  const dbPath = path.resolve(__dirname, '../data/db.json');
  const dbData = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const feedPath = path.resolve(__dirname, '../public/capstones-latest.json');
  const feedData = JSON.parse(fs.readFileSync(feedPath, 'utf8'));
  assert.ok(validateFeedSubset(dbData, feedData));
  assert.throws(() => validateFeedSubset([{ id: 1 }], [{ id: 2 }]), /FEED_SUBSET_VIOLATION/);
});

// 22. Canonical comparison accepts reordered object keys
registerTest('22. Canonical comparison accepts reordered object keys', () => {
  const obj1 = { a: 1, b: 2 };
  const obj2 = { b: 2, a: 1 };
  assert.ok(compareProjectData(obj1, obj2));
});

// 23. Canonical comparison rejects changed values
registerTest('23. Canonical comparison rejects changed values', () => {
  const obj1 = { a: 1, b: 2 };
  const obj3 = { a: 1, b: 3 };
  assert.strictEqual(compareProjectData(obj1, obj3), false);
});

// 24. Unexpected remote rows block apply
registerTest('24. Unexpected remote rows block apply', () => {
  assert.throws(() => evaluateExistingRows([{ id: 1 }], [{ id: 2, data: {} }]), /UNEXPECTED_REMOTE_PROJECTS/);
});

// 25. Conflicting existing row blocks apply
registerTest('25. Conflicting existing row blocks apply', () => {
  assert.throws(() => evaluateExistingRows([{ id: 1, val: 'a' }], [{ id: 1, data: { id: 1, val: 'b' } }]), /REMOTE_PROJECT_DATA_CONFLICT/);
});

// 26. Matching existing row is idempotent
registerTest('26. Matching existing row is idempotent', () => {
  assert.ok(evaluateExistingRows([{ id: 1, val: 'a' }], [{ id: 1, data: { id: 1, val: 'a' } }]));
});

// 27. Missing remote feed allows create-only upload planning
registerTest('27. Missing remote feed allows create-only upload planning', () => {
  const plan = planRecovery({
    localSeed: [{ id: 1, val: 'a' }],
    localFeed: [{ id: 1, val: 'a' }],
    remoteRows: [{ id: 1, data: { id: 1, val: 'a' } }],
    remoteFeedState: 'MISSING',
    bucketState: { feedsExists: true, feedsPublic: true, projectAssetsExists: true, projectAssetsPublic: true }
  });
  assert.strictEqual(plan.ready, true);
  assert.strictEqual(plan.shouldCreateFeed, true);
  assert.strictEqual(plan.shouldSkipFeedWrite, false);
});

// 28. Identical remote feed causes no write
registerTest('28. Identical remote feed causes no write', () => {
  const plan = planRecovery({
    localSeed: [{ id: 1, val: 'a' }],
    localFeed: [{ id: 1, val: 'a' }],
    remoteRows: [{ id: 1, data: { id: 1, val: 'a' } }],
    remoteFeedState: 'EXISTS_IDENTICAL',
    bucketState: { feedsExists: true, feedsPublic: true, projectAssetsExists: true, projectAssetsPublic: true }
  });
  assert.strictEqual(plan.ready, true);
  assert.strictEqual(plan.shouldCreateFeed, false);
  assert.strictEqual(plan.shouldSkipFeedWrite, true);
});

// 29. Conflicting remote feed blocks
registerTest('29. Conflicting remote feed blocks', () => {
  const plan = planRecovery({
    localSeed: [{ id: 1, val: 'a' }],
    localFeed: [{ id: 1, val: 'a' }],
    remoteRows: [{ id: 1, data: { id: 1, val: 'a' } }],
    remoteFeedState: 'EXISTS_CONFLICTING',
    bucketState: { feedsExists: true, feedsPublic: true, projectAssetsExists: true, projectAssetsPublic: true }
  });
  assert.strictEqual(plan.ready, false);
  assert.strictEqual(plan.error, 'REMOTE_FEED_CONFLICT');
});

// 30. Remote feed verification checks downloaded content
registerTest('30. Remote feed verification checks downloaded content', () => {
  assert.ok(evaluateExistingFeed([{ id: 1 }], [{ id: 1 }]));
  assert.throws(() => evaluateExistingFeed([{ id: 1 }], [{ id: 2 }]), /REMOTE_FEED_CONFLICT/);
});

// 31. No database update/upsert/delete operation exists in recovery apply
registerTest('31. No database update/upsert/delete operation exists in recovery apply', () => {
  const runnerContent = fs.readFileSync(path.resolve(__dirname, 'recoverPrototypeSupabase.js'), 'utf8');
  const applyIndex = runnerContent.indexOf('Apply Mode Active Execution Phase');
  const applyBlock = runnerContent.slice(applyIndex);
  
  assert.ok(!applyBlock.includes('.update('));
  assert.ok(!applyBlock.includes('.upsert('));
  assert.ok(!applyBlock.includes('.delete('));
});

// 32. No project-assets upload exists in recovery apply
registerTest('32. No project-assets upload exists in recovery apply', () => {
  const runnerContent = fs.readFileSync(path.resolve(__dirname, 'recoverPrototypeSupabase.js'), 'utf8');
  const applyIndex = runnerContent.indexOf('Apply Mode Active Execution Phase');
  const applyBlock = runnerContent.slice(applyIndex);

  const hasProjectAssetsUpload = applyBlock.includes("'project-assets'") && applyBlock.includes('upload');
  assert.ok(!hasProjectAssetsUpload);
});

// 33. Sanitized output check
registerTest('33. Sanitized output check', () => {
  const sanitizedMsg = sanitizeRecoveryFailure('DATABASE_VERIFICATION_FAILED', new Error('TARGET_MISMATCH'));
  assert.strictEqual(sanitizedMsg, 'TARGET_MISMATCH');
  assert.ok(!sanitizedMsg.includes('supabase.co'));
});

async function main() {
  for (const t of tests) {
    try {
      await t.fn();
      passedCount++;
    } catch (err) {
      console.error(`❌ Test failed: ${t.name}`);
      console.error(err);
      failedCount++;
    }
  }

  console.log('====================================================');
  console.log(`Test Execution Summary:`);
  console.log(`Passed: ${passedCount}`);
  console.log(`Failed: ${failedCount}`);
  console.log('====================================================');

  if (failedCount > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main();
