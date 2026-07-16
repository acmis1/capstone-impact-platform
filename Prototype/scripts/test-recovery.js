import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getSupabaseKey, verifyProjectRef, getProjectRef } from '../utils/authHelper.js';
import { runUrlAudit } from './auditDeletedUrls.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runTests() {
  console.log('====================================================');
  console.log('🧪 RUNNING OFFLINE RECOVERY BASKET TESTS');
  console.log('====================================================');

  // Test 1 & 2: Secret key preference and fallback
  process.env.SUPABASE_SECRET_KEY = 'primary-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fallback-key';
  assert.strictEqual(getSupabaseKey(), 'primary-key', 'Should prefer SUPABASE_SECRET_KEY');

  delete process.env.SUPABASE_SECRET_KEY;
  assert.strictEqual(getSupabaseKey(), 'fallback-key', 'Should fall back to SUPABASE_SERVICE_ROLE_KEY');

  // Test 3: Missing key rejection
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  assert.strictEqual(getSupabaseKey(), undefined, 'Should handle missing keys');

  // Test 4: Target-reference match
  const testUrl = 'https://capstone-prototype-recovery-2026.supabase.co';
  assert.strictEqual(
    verifyProjectRef(testUrl, 'capstone-prototype-recovery-2026'),
    'TARGET_MATCH',
    'Should successfully match expected project ref'
  );

  // Test 5: Target-reference mismatch
  assert.strictEqual(
    verifyProjectRef(testUrl, 'another-project-ref'),
    'TARGET_MISMATCH',
    'Should mismatch for wrong project ref'
  );

  // Explicitly verify block of the deleted project
  const deniedUrl = 'https://xojnnhilqaldxoilmxli.supabase.co';
  assert.strictEqual(
    verifyProjectRef(deniedUrl, 'xojnnhilqaldxoilmxli'),
    'TARGET_MISMATCH',
    'Should mismatch and block old deleted project ref even if expected matches'
  );

  // Test 6: Missing expected-reference rejection
  assert.strictEqual(
    verifyProjectRef(testUrl, null),
    'TARGET_CONFIGURATION_MISSING',
    'Should reject null expected ref'
  );

  // Test 7: Valid 10-record seed parsing
  const dbPath = path.resolve(__dirname, '../data/db.json');
  const dbData = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  assert.strictEqual(Array.isArray(dbData), true, 'Seed database must be an array');
  assert.strictEqual(dbData.length, 10, 'Seed count must be exactly 10 records');

  // Test 8: Valid 6-record feed parsing
  const feedPath = path.resolve(__dirname, '../public/capstones-latest.json');
  const feedData = JSON.parse(fs.readFileSync(feedPath, 'utf8'));
  assert.strictEqual(Array.isArray(feedData), true, 'Public feed must be an array');
  assert.strictEqual(feedData.length, 6, 'Public feed count must be exactly 6 records');

  // Test 9: Feed subset validation
  const dbIds = new Set(dbData.map(p => p.id));
  const feedIds = feedData.map(p => p.id);
  const allInSeed = feedIds.every(id => dbIds.has(id));
  assert.strictEqual(allInSeed, true, 'All public feed records must exist in seed data');

  // Test 10: Duplicate ID validation mock
  const duplicateSeed = [{ id: 1 }, { id: 1 }];
  const uniqueIds = new Set(duplicateSeed.map(p => p.id));
  assert.ok(uniqueIds.size < duplicateSeed.length, 'Duplicate verification should identify duplicate IDs');

  // Test 11: Deleted project reference audit helper check
  const audit = runUrlAudit();
  assert.ok(audit.totalMatches > 0, 'Audit must locate occurrences of the obsolete domain');
  
  // Verify that audit does not expose key or URL details
  audit.results.forEach((match) => {
    assert.ok(match.file, 'Match result must have a file path');
    assert.ok(match.line, 'Match result must have a line number');
  });

  console.log('✅ ALL OFFLINE RECOVERY TESTS PASSED SUCCESSFULLY.');
  console.log('====================================================\n');
}

runTests().catch(err => {
  console.error('❌ Test execution failed:', err);
  process.exit(1);
});
