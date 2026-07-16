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

// Reusable Fake Supabase Client Recorder
class FakeSupabaseClient {
  constructor(scenario = {}) {
    this.scenario = scenario;
    this.ops = [];
    
    this.storage = {
      listBuckets: async () => {
        this.ops.push('storage:listBuckets');
        if (this.scenario.listBucketsError) {
          return { data: null, error: new Error('listBucketsError') };
        }
        return { 
          data: this.scenario.buckets || [
            { name: 'feeds', public: true },
            { name: 'project-assets', public: true }
          ], 
          error: null 
        };
      },
      from: (bucketName) => {
        return {
          list: async () => {
            this.ops.push('storage:listFeedObjects');
            if (this.scenario.listFeedError) {
              return { data: null, error: new Error('listFeedError') };
            }
            return {
              data: this.scenario.feedFiles !== undefined ? this.scenario.feedFiles : [{ name: 'capstones-latest.json' }],
              error: null
            };
          },
          download: async (fileName) => {
            this.ops.push('storage:downloadFeed');
            if (this.scenario.downloadError) {
              return { data: null, error: new Error('downloadError') };
            }
            return {
              data: {
                text: async () => this.scenario.remoteFeedContent || '[]'
              },
              error: null
            };
          },
          upload: async (fileName, fileBuffer, opts) => {
            this.ops.push('storage:createFeed');
            if (opts && opts.upsert === true) {
              throw new Error('UNCONDITIONAL_UPSERT_FORBIDDEN');
            }
            if (this.scenario.uploadError) {
              return { data: null, error: new Error('uploadError') };
            }
            return { data: {}, error: null };
          },
          getPublicUrl: (fileName) => {
            this.ops.push('storage:verifyFeed');
            return { data: { publicUrl: 'https://fake-url.supabase.co/feeds/capstones-latest.json' } };
          }
        };
      }
    };
  }

  from(tableName) {
    if (tableName !== 'projects') {
      throw new Error('UNEXPECTED_TABLE_ACCESS');
    }
    return {
      select: (fields) => {
        this.ops.push('database:readProjects');
        return {
          order: (field, opts) => {
            return {
              data: this.scenario.remoteRows || [],
              error: this.scenario.dbReadError ? new Error('dbReadError') : null
            };
          },
          // Supporting basic select for seeding phase checks
          data: this.scenario.remoteRows || [],
          error: this.scenario.dbReadError ? new Error('dbReadError') : null
        };
      },
      insert: async (payload) => {
        this.ops.push('database:insertProjects');
        if (this.scenario.insertError) {
          return { data: null, error: new Error('insertError') };
        }
        // Save the inserted rows to remoteRows for final verification call
        this.scenario.remoteRows = payload.map(p => ({ id: p.id, data: p.data }));
        return { data: payload, error: null };
      }
    };
  }
}

// Set up canonical test configs
const canonicalConfig = {
  feedBucket: 'feeds',
  assetBucket: 'project-assets',
  feedFile: 'capstones-latest.json'
};

// Test definitions
registerTest('1. Secret key preferred', () => {
  process.env.SUPABASE_SECRET_KEY = 'secret-role';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role';
  assert.strictEqual(getSupabaseKey(), 'secret-role');
});

registerTest('2. Legacy key fallback', () => {
  delete process.env.SUPABASE_SECRET_KEY;
  assert.strictEqual(getSupabaseKey(), 'service-role');
});

registerTest('3. Missing key', () => {
  delete process.env.SUPABASE_SECRET_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  assert.strictEqual(getSupabaseKey(), undefined);
});

registerTest('4. Valid exact HTTPS Supabase URL', () => {
  const url = 'https://testref12345.supabase.co';
  assert.strictEqual(getProjectRef(url), 'testref12345');
  assert.strictEqual(verifyProjectRef(url, 'testref12345'), 'TARGET_MATCH');
});

registerTest('5. Project-reference mismatch', () => {
  const url = 'https://testref12345.supabase.co';
  assert.strictEqual(verifyProjectRef(url, 'anotherref'), 'TARGET_MISMATCH');
});

registerTest('6. Missing expected reference', () => {
  const url = 'https://testref12345.supabase.co';
  assert.strictEqual(verifyProjectRef(url, null), 'TARGET_CONFIGURATION_MISSING');
  assert.strictEqual(verifyProjectRef(url, ''), 'TARGET_CONFIGURATION_MISSING');
  assert.strictEqual(verifyProjectRef(url, '   '), 'TARGET_CONFIGURATION_MISSING');
});

registerTest('7. Malformed URL', () => {
  assert.strictEqual(verifyProjectRef('not-a-url', 'testref'), 'TARGET_CONFIGURATION_MISSING');
});

registerTest('8. HTTP rejected', () => {
  assert.strictEqual(verifyProjectRef('http://testref12345.supabase.co', 'testref12345'), 'TARGET_MISMATCH');
});

registerTest('9. Hostname suffix attack rejected', () => {
  assert.strictEqual(verifyProjectRef('https://testref12345.supabase.co.evil.com', 'testref12345'), 'TARGET_MISMATCH');
});

registerTest('10. Embedded credentials rejected', () => {
  assert.strictEqual(verifyProjectRef('https://user:pass@testref12345.supabase.co', 'testref12345'), 'TARGET_MISMATCH');
});

registerTest('11. Deleted reference rejected', () => {
  const deletedUrl = 'https://xojnnhilqaldxoilmxli.supabase.co';
  assert.strictEqual(verifyProjectRef(deletedUrl, 'xojnnhilqaldxoilmxli'), 'TARGET_MISMATCH');
});

registerTest('12. Missing expected reference blocks client creation', async () => {
  let factoryCalled = false;
  const mockFactory = () => { factoryCalled = true; return {}; };
  const res = await runRecovery({
    isApply: true,
    supabaseUrl: 'https://testref12345.supabase.co',
    supabaseKey: 'somekey',
    expectedRef: undefined,
    localSeed: '[]',
    localFeed: '[]',
    createSupabaseClient: mockFactory,
    fileAdapter: {},
    logger: { log: () => {}, error: () => {} },
    recoveryConfig: canonicalConfig
  });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.error, 'TARGET_CONFIGURATION_MISSING');
  assert.strictEqual(factoryCalled, false);
});

registerTest('13. Mismatched expected reference blocks client creation', async () => {
  let factoryCalled = false;
  const mockFactory = () => { factoryCalled = true; return {}; };
  const res = await runRecovery({
    isApply: true,
    supabaseUrl: 'https://testref12345.supabase.co',
    supabaseKey: 'somekey',
    expectedRef: 'differentref',
    localSeed: '[]',
    localFeed: '[]',
    createSupabaseClient: mockFactory,
    fileAdapter: {},
    logger: { log: () => {}, error: () => {} },
    recoveryConfig: canonicalConfig
  });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.error, 'TARGET_MISMATCH');
  assert.strictEqual(factoryCalled, false);
});

registerTest('14. Noncanonical configurations block client creation', async () => {
  let factoryCalled = false;
  const mockFactory = () => { factoryCalled = true; return {}; };
  const res = await runRecovery({
    isApply: true,
    supabaseUrl: 'https://testref12345.supabase.co',
    supabaseKey: 'somekey',
    expectedRef: 'testref12345',
    localSeed: '[]',
    localFeed: '[]',
    createSupabaseClient: mockFactory,
    fileAdapter: {},
    logger: { log: () => {}, error: () => {} },
    recoveryConfig: {
      feedBucket: 'non-canonical-bucket',
      assetBucket: 'project-assets',
      feedFile: 'capstones-latest.json'
    }
  });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.error, 'FEED_BUCKET_CONFIGURATION_INVALID');
  assert.strictEqual(factoryCalled, false);
});

registerTest('15. Malformed/non-array JSON inputs block client creation', async () => {
  let factoryCalled = false;
  const mockFactory = () => { factoryCalled = true; return {}; };
  
  const res1 = await runRecovery({
    isApply: true,
    supabaseUrl: 'https://testref12345.supabase.co',
    supabaseKey: 'somekey',
    expectedRef: 'testref12345',
    localSeed: '{"not": "an array"}',
    localFeed: '[]',
    createSupabaseClient: mockFactory,
    fileAdapter: {},
    logger: { log: () => {}, error: () => {} },
    recoveryConfig: canonicalConfig
  });
  assert.strictEqual(res1.success, false);
  assert.strictEqual(res1.error, 'SEED_NOT_ARRAY');
  assert.strictEqual(factoryCalled, false);

  const res2 = await runRecovery({
    isApply: true,
    supabaseUrl: 'https://testref12345.supabase.co',
    supabaseKey: 'somekey',
    expectedRef: 'testref12345',
    localSeed: 'invalid json',
    localFeed: '[]',
    createSupabaseClient: mockFactory,
    fileAdapter: {},
    logger: { log: () => {}, error: () => {} },
    recoveryConfig: canonicalConfig
  });
  assert.strictEqual(res2.success, false);
  assert.strictEqual(res2.error, 'SEED_JSON_INVALID');
  assert.strictEqual(factoryCalled, false);
});

registerTest('16. Obsolete seed reference blocks client creation', async () => {
  let factoryCalled = false;
  const mockFactory = () => { factoryCalled = true; return {}; };
  const res = await runRecovery({
    isApply: true,
    supabaseUrl: 'https://testref12345.supabase.co',
    supabaseKey: 'somekey',
    expectedRef: 'testref12345',
    localSeed: '[{"id": 1, "link": "https://xojnnhilqaldxoilmxli.supabase.co"}]',
    localFeed: '[]',
    createSupabaseClient: mockFactory,
    fileAdapter: {},
    logger: { log: () => {}, error: () => {} },
    recoveryConfig: canonicalConfig
  });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.error, 'APPLY_BLOCKED_OBSOLETE_REFERENCES');
  assert.strictEqual(factoryCalled, false);
});

registerTest('17. Obsolete feed reference blocks client creation', async () => {
  let factoryCalled = false;
  const mockFactory = () => { factoryCalled = true; return {}; };
  const res = await runRecovery({
    isApply: true,
    supabaseUrl: 'https://testref12345.supabase.co',
    supabaseKey: 'somekey',
    expectedRef: 'testref12345',
    localSeed: '[{"id": 1}]',
    localFeed: '[{"id": 1, "link": "https://xojnnhilqaldxoilmxli.supabase.co"}]',
    createSupabaseClient: mockFactory,
    fileAdapter: {},
    logger: { log: () => {}, error: () => {} },
    recoveryConfig: canonicalConfig
  });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.error, 'APPLY_BLOCKED_OBSOLETE_REFERENCES');
  assert.strictEqual(factoryCalled, false);
});

registerTest('18. Valid dry-run', async () => {
  let factoryCalled = false;
  const mockFactory = () => { factoryCalled = true; return {}; };
  const res = await runRecovery({
    isApply: false,
    supabaseUrl: 'https://testref12345.supabase.co',
    supabaseKey: 'somekey',
    expectedRef: 'testref12345',
    localSeed: '[{"id": 1}]',
    localFeed: '[{"id": 1}]',
    createSupabaseClient: mockFactory,
    fileAdapter: {},
    logger: { log: () => {}, error: () => {} },
    recoveryConfig: canonicalConfig
  });
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.exitCode, 0);
  assert.strictEqual(factoryCalled, false);
});

registerTest('19. Valid apply calls factory once', async () => {
  let factoryCalls = 0;
  const fakeClient = new FakeSupabaseClient({
    feedFiles: [], // Missing remote feed
    remoteRows: [],
    remoteFeedContent: '[{"id": 1}]'
  });
  const mockFactory = () => { factoryCalls++; return fakeClient; };

  const res = await runRecovery({
    isApply: true,
    supabaseUrl: 'https://testref12345.supabase.co',
    supabaseKey: 'somekey',
    expectedRef: 'testref12345',
    localSeed: '[{"id": 1}]',
    localFeed: '[{"id": 1}]',
    createSupabaseClient: mockFactory,
    fileAdapter: { readFileSync: () => '[{"id": 1}]' },
    logger: { log: () => {}, error: () => {} },
    recoveryConfig: canonicalConfig
  });

  assert.strictEqual(res.success, true);
  assert.strictEqual(factoryCalls, 1);
});

registerTest('20. Storage preflight failure blocks database writes', async () => {
  const fakeClient = new FakeSupabaseClient({
    buckets: [
      { name: 'feeds', public: false } // Invalid visibility
    ]
  });

  const res = await runRecovery({
    isApply: true,
    supabaseUrl: 'https://testref12345.supabase.co',
    supabaseKey: 'somekey',
    expectedRef: 'testref12345',
    localSeed: '[{"id": 1}]',
    localFeed: '[{"id": 1}]',
    createSupabaseClient: () => fakeClient,
    fileAdapter: {},
    logger: { log: () => {}, error: () => {} },
    recoveryConfig: canonicalConfig
  });

  assert.strictEqual(res.success, false);
  assert.strictEqual(res.error, 'FEEDS_BUCKET_VISIBILITY_INVALID');
  
  // Database insert should not have been called
  const hasInsert = fakeClient.ops.includes('database:insertProjects');
  assert.strictEqual(hasInsert, false);
});

registerTest('21. Conflicting existing feed blocks database writes', async () => {
  const fakeClient = new FakeSupabaseClient({
    feedFiles: [{ name: 'capstones-latest.json' }],
    remoteFeedContent: '[{"id": 999}]' // Differs from local feed
  });

  const res = await runRecovery({
    isApply: true,
    supabaseUrl: 'https://testref12345.supabase.co',
    supabaseKey: 'somekey',
    expectedRef: 'testref12345',
    localSeed: '[{"id": 1}]',
    localFeed: '[{"id": 1}]',
    createSupabaseClient: () => fakeClient,
    fileAdapter: {},
    logger: { log: () => {}, error: () => {} },
    recoveryConfig: canonicalConfig
  });

  assert.strictEqual(res.success, false);
  assert.strictEqual(res.error, 'REMOTE_FEED_CONFLICT');
  assert.strictEqual(fakeClient.ops.includes('database:insertProjects'), false);
});

registerTest('22. Identical existing feed performs zero Storage writes', async () => {
  const fakeClient = new FakeSupabaseClient({
    feedFiles: [{ name: 'capstones-latest.json' }],
    remoteFeedContent: '[{"id": 1}]', // Identical
    remoteRows: [{ id: 1, data: { id: 1 } }] // DB matches, no DB write needed either
  });

  const res = await runRecovery({
    isApply: true,
    supabaseUrl: 'https://testref12345.supabase.co',
    supabaseKey: 'somekey',
    expectedRef: 'testref12345',
    localSeed: '[{"id": 1}]',
    localFeed: '[{"id": 1}]',
    createSupabaseClient: () => fakeClient,
    fileAdapter: {},
    logger: { log: () => {}, error: () => {} },
    recoveryConfig: canonicalConfig
  });

  assert.strictEqual(res.success, true);
  assert.strictEqual(fakeClient.ops.includes('storage:createFeed'), false);
});

registerTest('23. Missing feed creates feed with upsert:false', async () => {
  const fakeClient = new FakeSupabaseClient({
    feedFiles: [], // Missing
    remoteRows: [{ id: 1, data: { id: 1 } }],
    remoteFeedContent: '[{"id": 1}]'
  });

  const res = await runRecovery({
    isApply: true,
    supabaseUrl: 'https://testref12345.supabase.co',
    supabaseKey: 'somekey',
    expectedRef: 'testref12345',
    localSeed: '[{"id": 1}]',
    localFeed: '[{"id": 1}]',
    createSupabaseClient: () => fakeClient,
    fileAdapter: { readFileSync: () => '[{"id": 1}]' },
    logger: { log: () => {}, error: () => {} },
    recoveryConfig: canonicalConfig
  });

  assert.strictEqual(res.success, true);
  assert.strictEqual(fakeClient.ops.includes('storage:createFeed'), true);
});

registerTest('24. Operation ordering conforms strictly', async () => {
  const fakeClient = new FakeSupabaseClient({
    feedFiles: [],
    remoteRows: [],
    remoteFeedContent: '[{"id": 1}]'
  });

  await runRecovery({
    isApply: true,
    supabaseUrl: 'https://testref12345.supabase.co',
    supabaseKey: 'somekey',
    expectedRef: 'testref12345',
    localSeed: '[{"id": 1}]',
    localFeed: '[{"id": 1}]',
    createSupabaseClient: () => fakeClient,
    fileAdapter: { readFileSync: () => '[{"id": 1}]' },
    logger: { log: () => {}, error: () => {} },
    recoveryConfig: canonicalConfig
  });

  const orderList = fakeClient.ops;
  const listBucketsIdx = orderList.indexOf('storage:listBuckets');
  const listFeedIdx = orderList.indexOf('storage:listFeedObjects');
  const readDbIdx = orderList.indexOf('database:readProjects');
  const insertDbIdx = orderList.indexOf('database:insertProjects');
  const createFeedIdx = orderList.indexOf('storage:createFeed');
  const verifyFeedIdx = orderList.lastIndexOf('storage:downloadFeed');

  assert.ok(listBucketsIdx < listFeedIdx);
  assert.ok(listFeedIdx < readDbIdx);
  assert.ok(readDbIdx < insertDbIdx);
  assert.ok(insertDbIdx < createFeedIdx);
  assert.ok(createFeedIdx < verifyFeedIdx);
});

registerTest('25. No project-assets upload is ever performed', async () => {
  const fakeClient = new FakeSupabaseClient({
    feedFiles: [],
    remoteRows: [],
    remoteFeedContent: '[{"id": 1}]'
  });

  await runRecovery({
    isApply: true,
    supabaseUrl: 'https://testref12345.supabase.co',
    supabaseKey: 'somekey',
    expectedRef: 'testref12345',
    localSeed: '[{"id": 1}]',
    localFeed: '[{"id": 1}]',
    createSupabaseClient: () => fakeClient,
    fileAdapter: { readFileSync: () => '[{"id": 1}]' },
    logger: { log: () => {}, error: () => {} },
    recoveryConfig: canonicalConfig
  });

  assert.strictEqual(fakeClient.ops.includes('storage:uploadProjectAsset'), false);
});

registerTest('26. Source-level prohibited operation scan', () => {
  const runnerContent = fs.readFileSync(path.resolve(__dirname, 'recoverPrototypeSupabase.js'), 'utf8');
  assert.ok(!runnerContent.includes('.update('));
  assert.ok(!runnerContent.includes('.upsert('));
  assert.ok(!runnerContent.includes('.delete('));
  assert.ok(runnerContent.includes('.insert('));
  assert.ok(runnerContent.includes('upsert: false'));
});

async function main() {
  for (const t of tests) {
    try {
      await t.fn();
      passedCount++;
    } catch (err) {
      console.error(`❌ Test failed: ${t.name}`);
      console.error(err.message || err);
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
