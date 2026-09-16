import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const bodyEndPath = path.resolve(scriptDirectory, '..', 'duda', 'bodyend.html');
const bodyEndHtml = await readFile(bodyEndPath, 'utf8');
const bodyEndScript = bodyEndHtml.match(/<script>([\s\S]*)<\/script>/)?.[1];

assert.ok(bodyEndScript, 'Duda bodyend script was not found.');
const closingIndex = bodyEndScript.lastIndexOf('})();');
assert.ok(closingIndex >= 0, 'Duda bodyend IIFE was not found.');

// Expose the real lexical URL builder only inside this VM test; production code has no test hook.
const instrumentedScript = `${bodyEndScript.slice(0, closingIndex)}
    globalThis.__dudaQueryTest = { buildDudaNavigationUrl, buildDetailUrl };
${bodyEndScript.slice(closingIndex)}`;

function createHarness(search) {
  const location = {
    pathname: '/sst-school-projects',
    search,
    href: `/sst-school-projects${search}`,
  };
  const window = {
    location,
    CAPSTONE_FEED_URL: undefined,
    __capstoneShowcaseInitialized: false,
    addEventListener() {},
  };
  const document = {
    addEventListener() {},
    createElement() { return {}; },
    getElementById() { return null; },
    querySelector() { return null; },
  };

  const context = {
    URL,
    URLSearchParams,
    console: { log() {}, warn() {}, error() {} },
    document,
    window,
  };
  vm.runInNewContext(instrumentedScript, context, { filename: bodyEndPath });
  return { location, window, navigation: context.__dudaQueryTest };
}

const unallowlistedKeys = [
  'case',
  'nee',
  'showOriginal',
  'dm_checkSync',
  'dm_try_mode',
  'utm_source',
  'utm_campaign',
  'capability',
];

const cases = [
  {
    name: 'mobile Duda preview',
    search: '?case=mobile&dm_device=mobile&preview=true&nee=true&showOriginal=true&dm_checkSync=1&dm_try_mode=true&utm_source=campaign&capability=synthetic-preview&id=stale-project-id',
    expectedDuda: { dm_device: 'mobile', preview: 'true' },
  },
  {
    name: 'desktop Duda preview',
    search: '?case=desktop&dm_device=desktop&preview=true&nee=true&showOriginal=true&dm_checkSync=1&dm_try_mode=true&utm_campaign=desktop-preview&capability=synthetic-preview&id=stale-project-id',
    expectedDuda: { dm_device: 'desktop', preview: 'true' },
  },
  {
    name: 'ordinary published route',
    search: '?case=published&utm_source=campaign&capability=synthetic-public&id=stale-project-id',
    expectedDuda: {},
  },
];

for (const testCase of cases) {
  const harness = createHarness(testCase.search);
  const detailUrl = harness.navigation.buildDetailUrl(202502);
  const detailParams = new URLSearchParams(detailUrl.split('?')[1] || '');

  assert.equal(detailUrl.startsWith('project-detail?'), true, `${testCase.name} uses the detail route`);
  assert.equal(detailParams.get('id'), '202502', `${testCase.name} replaces the stale id`);
  assert.equal(detailParams.getAll('id').length, 1, `${testCase.name} contains exactly one id`);
  for (const [key, value] of Object.entries(testCase.expectedDuda)) {
    assert.equal(detailParams.get(key), value, `${testCase.name} preserves ${key}`);
  }
  for (const key of unallowlistedKeys) {
    assert.equal(detailParams.has(key), false, `${testCase.name} drops unallowlisted ${key}`);
  }
  assert.deepEqual(
    [...detailParams.keys()].sort(),
    [...Object.keys(testCase.expectedDuda), 'id'].sort(),
    `${testCase.name} detail query is closed over the allowlist`,
  );

  harness.location.pathname = '/project-detail';
  harness.location.search = `?${detailParams.toString()}`;
  harness.window.goBack();
  const listingUrl = new URL(harness.location.href, 'https://public.example.test/');
  const listingParams = listingUrl.searchParams;

  assert.equal(listingUrl.pathname, '/sst-school-projects', `${testCase.name} returns to the listing route`);
  assert.equal(listingParams.has('id'), false, `${testCase.name} removes the project id on return`);
  for (const [key, value] of Object.entries(testCase.expectedDuda)) {
    assert.equal(listingParams.get(key), value, `${testCase.name} preserves ${key} on return`);
  }
  for (const key of unallowlistedKeys) {
    assert.equal(listingParams.has(key), false, `${testCase.name} drops unallowlisted ${key} on return`);
  }
  assert.deepEqual(
    [...listingParams.keys()].sort(),
    Object.keys(testCase.expectedDuda).sort(),
    `${testCase.name} return query is closed over the allowlist`,
  );
}

const invalidState = createHarness('?dm_device=phone&preview=false&id=stale-project-id');
const invalidDetail = new URLSearchParams(invalidState.navigation.buildDetailUrl(202502).split('?')[1]);
assert.deepEqual([...invalidDetail.keys()], ['id'], 'invalid Duda state values are not propagated');

console.log(`Duda query-preservation contract: ${cases.length} listing-to-detail-to-listing cases passed.`);
