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
    globalThis.__dudaQueryTest = { buildDudaNavigationUrl, buildDetailUrl, getRequestedProjectId, parseProjectId, replaceUrlWithAllowedState, normalizeFilterValue, handleSearchChange, clearFilters, setProjects(records) { allProjects = records; }, reconcileFilters() { currentFilters = validateCurrentFilters(readFiltersFromUrl()); }, filterState() { return { ...currentFilters }; } };
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
  window.history = { state: null, replaceState(_state, _title, url) {
    const parsed = new URL(url, 'https://public.example.test');
    location.pathname = parsed.pathname; location.search = parsed.search; location.href = parsed.href;
  } };
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

// Closed filter URL state survives the exact listing/detail navigation helpers.
const filterValues = { search: 'solar project', year: '2026', program: 'Information Technology', discipline: 'Software Engineering', industry: 'Energy' };
const filterParams = new URLSearchParams({ ...filterValues, dm_device: 'mobile', preview: 'true', token: 'never-forward', capability: 'never-forward', utm_source: 'discard' });
const filtered = createHarness(`?${filterParams}`);
filtered.navigation.setProjects([{ id: 202502, title: 'Solar project', year: '2026', program: 'Information Technology', disciplines: ['Software Engineering'], industry: 'Energy' }]);
filtered.navigation.reconcileFilters();
const filteredDetail = new URL(filtered.navigation.buildDetailUrl(202502), 'https://public.example.test/');
for (const [key, value] of Object.entries(filterValues)) assert.equal(filteredDetail.searchParams.get(key), value, `${key} survives detail navigation`);
assert.deepEqual([...filteredDetail.searchParams.keys()].sort(), [...Object.keys(filterValues), 'dm_device', 'preview', 'id'].sort(), 'only explicitly allowed filters and Duda state propagate');
filtered.location.pathname = '/project-detail';
filtered.location.search = filteredDetail.search;
filtered.window.goBack();
const filteredReturn = new URL(filtered.location.href, 'https://public.example.test/');
assert.equal(filteredReturn.pathname, '/sst-school-projects');
assert.equal(filteredReturn.searchParams.has('id'), false);
for (const [key, value] of Object.entries(filterValues)) assert.equal(filteredReturn.searchParams.get(key), value, `${key} survives return`);
const restored = createHarness(filteredReturn.search);
restored.navigation.setProjects([{ year: '2026', program: 'Information Technology', disciplines: ['Software Engineering'], industry: 'Energy' }]);
restored.navigation.reconcileFilters();
assert.deepEqual(JSON.parse(JSON.stringify(restored.navigation.filterState())), filterValues, 'shared URL restores the same exact filter state');
restored.navigation.clearFilters();
const cleared = new URL(restored.location.href, 'https://public.example.test/');
assert.deepEqual([...cleared.searchParams.keys()].sort(), ['dm_device', 'preview'], 'clear removes filter state but preserves approved Duda flags');

const malformed = createHarness(`?year=not-a-year&program=${'a'.repeat(241)}&search=%3Cscript%3Ealert(1)%3C%2Fscript%3E&token=private`);
malformed.navigation.setProjects([{ year: '2026', program: 'IT' }]);
malformed.navigation.reconcileFilters();
assert.equal(malformed.navigation.filterState().year, 'All');
assert.equal(malformed.navigation.filterState().program, 'All');
assert.equal(malformed.navigation.filterState().search.includes('<'), false, 'search normalization rejects executable markup');
assert.equal(malformed.navigation.normalizeFilterValue('a'.repeat(241)), '', 'oversized option does not become a misleading truncated match');
const invalidExplicit = createHarness('?id=bad&token=private');
invalidExplicit.location.pathname = '/project-detail';
invalidExplicit.window.localStorage = { getItem: () => '202502' };
invalidExplicit.navigation.replaceUrlWithAllowedState(true);
assert.equal(invalidExplicit.navigation.parseProjectId(invalidExplicit.navigation.getRequestedProjectId()), null, 'malformed explicit ID never falls back to remembered project');
assert.equal(new URLSearchParams(invalidExplicit.location.search).has('token'), false);
const deniedStorage = createHarness('?id=202502');
Object.defineProperty(deniedStorage.window, 'localStorage', { get() { throw new Error('Storage denied'); } });
deniedStorage.navigation.setProjects([{ id: 202502 }]);
assert.equal(deniedStorage.navigation.getRequestedProjectId(), '202502', 'valid URL works without storage');
assert.doesNotThrow(() => deniedStorage.window.handleProjectClick(202502));
assert.equal(new URL(deniedStorage.location.href, 'https://public.example.test/').searchParams.get('id'), '202502');
const typing = createHarness('');
const rawInput = { value: 'solar ', selectionStart: 6, selectionEnd: 6, setSelectionRange() { throw new Error('Caret must not be overwritten'); } };
typing.navigation.handleSearchChange(rawInput.value, rawInput);
assert.equal(rawInput.value, 'solar ', 'trailing word separator remains visible while typing');
typing.navigation.handleSearchChange('solar project', rawInput);
assert.equal(typing.navigation.filterState().search, 'solar project');
console.log('Duda discovery contracts: shared filters, clear, invalid options/IDs, private-key exclusion, denied storage and multiword typing passed.');
