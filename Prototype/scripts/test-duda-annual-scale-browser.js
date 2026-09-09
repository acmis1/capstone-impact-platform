import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const dudaDirectory = path.resolve(scriptDirectory, '..', 'duda');
const annualRecordCount = 120;
const localFeedHost = 'annualfixture.supabase.co';
const localFeedUrl = `https://${localFeedHost}/storage/v1/object/public/public-feeds/capstones-latest.json`;

const [bodyEndHtml, listingHtml, listingCss, detailHtml, detailCss, fixtureText] = await Promise.all([
  readFile(path.join(dudaDirectory, 'bodyend.html'), 'utf8'),
  readFile(path.join(dudaDirectory, 'listing-page.html'), 'utf8'),
  readFile(path.join(dudaDirectory, 'listing-page.css'), 'utf8'),
  readFile(path.join(dudaDirectory, 'detail-page.html'), 'utf8'),
  readFile(path.join(dudaDirectory, 'detail-page.css'), 'utf8'),
  readFile(path.join(dudaDirectory, 'current-feed-demo-fixture.json'), 'utf8'),
]);

const seedRecords = JSON.parse(fixtureText);
const years = ['2026', '2025', '2024', '2023', '2022', '2021'];
const programs = [
  'Bachelor of Software Engineering',
  'Master of Cyber Security',
  'Bachelor of Information Technology',
  'Bachelor of Design',
];
const disciplines = ['Software Engineering', 'Cyber Security', 'User Experience Design', 'Data Analytics'];
const industries = ['Emergency Services', 'Financial Services', 'Healthcare', 'Education'];
const templates = ['poster_showcase', 'technical_detail', 'media_rich'];

function escapeInlineJson(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}

function makeAnnualRecord(index) {
  const serial = String(index + 1).padStart(3, '0');
  const seed = structuredClone(seedRecords[index % seedRecords.length]);
  const program = programs[index % programs.length];
  const discipline = disciplines[(index * 3) % disciplines.length];
  const industry = industries[Math.floor(index / 4) % industries.length];
  const token = `annual-scale-${serial}`;
  const mediaBase = `https://media.example.test/${token}`;
  const templateId = templates[index % templates.length];
  const snapshots = [
    `${mediaBase}/snapshots/overview.svg`,
    `${mediaBase}/snapshots/detail.svg`,
  ];

  return {
    ...seed,
    id: 260000 + index + 1,
    publicId: token,
    title: `Annual Scale Project ${serial}`,
    summary: `Synthetic annual-scale summary for project ${serial}.`,
    background: `Synthetic annual-scale background for project ${serial}.`,
    solution: `Synthetic annual-scale solution for project ${serial}.`,
    year: years[Math.floor(index / 20)],
    program,
    studyProgram: program,
    discipline,
    disciplines: [discipline],
    industry,
    industryPartner: `Annual Partner ${industries.indexOf(industry) + 1}`,
    academicSupervisor: `Annual Supervisor ${((index + 1) % 6) + 1}`,
    groupName: `Annual Team ${((index + 2) % 6) + 1}`,
    teamMembers: [`Annual Participant ${serial}A`, `Annual Participant ${serial}B`],
    poster: `${mediaBase}/posters/poster.svg`,
    posterPdf: `${mediaBase}/posters/poster.pdf`,
    posterText: `Full synthetic poster text for annual-scale project ${serial}.`,
    accessibilityText: `Synthetic poster for annual-scale project ${serial}, with project overview artwork.`,
    snapshots,
    snapshotMedia: [
      {
        url: snapshots[0],
        altText: `Governed overview snapshot for annual-scale project ${serial}.`,
        galleryPosition: 1,
      },
      {
        url: snapshots[1],
        altText: `Governed detail snapshot for annual-scale project ${serial}.`,
        galleryPosition: 2,
      },
    ],
    videoUrl: `${mediaBase}/videos/presentation.mp4`,
    demoUrl: `${mediaBase}/demo`,
    repositoryUrl: `${mediaBase}/repository`,
    externalLinks: [{ label: 'Synthetic project overview', url: `${mediaBase}/overview` }],
    citations: [`Synthetic annual-scale reference for project ${serial}.`],
    layoutConfig: {
      templateId,
      featuredMedia: templateId === 'technical_detail' ? 'snapshots' : 'video',
      sectionOrder: [...seed.layoutConfig.sectionOrder],
    },
  };
}

const fixture = Array.from({ length: annualRecordCount }, (_, index) => makeAnnualRecord(index));

function assertGeneratedFixture(records) {
  assert.equal(records.length, annualRecordCount, 'annual fixture has exactly 120 records');
  assert.equal(new Set(records.map((record) => record.id)).size, annualRecordCount, 'annual IDs are unique');
  assert.equal(new Set(records.map((record) => record.publicId)).size, annualRecordCount, 'annual public IDs are unique');
  assert.equal(new Set(records.map((record) => record.title)).size, annualRecordCount, 'annual titles are unique');
  for (const record of records) {
    assert.ok(Number.isSafeInteger(record.id) && record.id > 0, 'record ID is a positive safe integer');
    assert.match(record.year, /^20\d{2}$/, 'record year is valid');
    assert.ok(programs.includes(record.program) && record.studyProgram === record.program, 'program fields agree');
    assert.equal(record.disciplines[0], record.discipline, 'discipline fields agree');
    assert.ok(industries.includes(record.industry), 'industry is supported');
    assert.ok(record.industryPartner && record.groupName, 'partner and team fields are present');
    assert.ok(record.poster.startsWith('https://media.example.test/'));
    assert.ok(record.posterPdf.startsWith('https://media.example.test/'));
    assert.ok(record.posterText && record.accessibilityText, 'poster alternatives are present');
    assert.equal(record.snapshots.length, 2, 'each record has two snapshots');
    assert.deepEqual(record.snapshots, record.snapshotMedia.map((media) => media.url), 'snapshot pairs preserve display order');
    assert.deepEqual(record.snapshotMedia.map((media) => media.galleryPosition), [1, 2], 'snapshot positions are governed');
    assert.ok(templates.includes(record.layoutConfig.templateId), 'layout template is supported');
  }
}

assertGeneratedFixture(fixture);

function recordMatches(record, filters) {
  const search = filters.search.trim().toLowerCase();
  if (search && ![record.title, record.publicId, record.industryPartner, record.groupName]
    .some((field) => field.toLowerCase().includes(search))) return false;
  if (filters.year !== 'All' && record.year !== filters.year) return false;
  if (filters.program !== 'All' && record.program !== filters.program) return false;
  if (filters.discipline !== 'All' && !record.disciplines.includes(filters.discipline)) return false;
  if (filters.industry !== 'All' && record.industry !== filters.industry) return false;
  return true;
}

function countFixture(filters) {
  return fixture.filter((record) => recordMatches(record, filters)).length;
}

const facetExpectations = [
  ['year', years[0], countFixture({ search: '', year: years[0], program: 'All', discipline: 'All', industry: 'All' })],
  ['program', programs[1], countFixture({ search: '', year: 'All', program: programs[1], discipline: 'All', industry: 'All' })],
  ['discipline', disciplines[2], countFixture({ search: '', year: 'All', program: 'All', discipline: disciplines[2], industry: 'All' })],
  ['industry', industries[3], countFixture({ search: '', year: 'All', program: 'All', discipline: 'All', industry: industries[3] })],
];
const representativeIndexes = [0, 59, 119];

async function findBrowser() {
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      ]
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next known browser location.
    }
  }
  throw new Error('Chrome or Edge was not found in a supported local browser location.');
}

function harnessDriver() {
  const result = {
    checks: [],
    failures: [],
    searchCases: [],
    facetCases: [],
    representativeDetails: 0,
  };
  const check = (condition, label) => {
    result.checks.push(label);
    if (!condition) result.failures.push(label);
  };
  const waitFor = async (predicate, timeoutMs = 6000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  };
  const records = window.__CAPSTONE_ANNUAL_FIXTURE;
  const expectedById = new Map(records.map((record) => [record.id, record]));
  const recordMatches = (record, filters) => {
    const search = filters.search.trim().toLowerCase();
    if (search && ![record.title, record.publicId, record.industryPartner, record.groupName]
      .some((field) => field.toLowerCase().includes(search))) return false;
    if (filters.year !== 'All' && record.year !== filters.year) return false;
    if (filters.program !== 'All' && record.program !== filters.program) return false;
    if (filters.discipline !== 'All' && !record.disciplines.includes(filters.discipline)) return false;
    if (filters.industry !== 'All' && record.industry !== filters.industry) return false;
    return true;
  };
  const countFixture = (filters) => records.filter((record) => recordMatches(record, filters)).length;
  const visibleCards = () => Array.from(document.querySelectorAll('.capstone-card'));
  const visibleIds = () => visibleCards().map((card) => {
    const onclick = card.querySelector('.capstone-poster-link')?.getAttribute('onclick') || '';
    return Number(onclick.match(/handleProjectClick\((\d+)\)/)?.[1]);
  });
  const visibleTitles = () => visibleCards().map((card) => card.querySelector('.capstone-card-image')?.alt);
  const setSearch = (value) => {
    const input = document.getElementById('filter-search');
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const setFacet = (type, value) => window.handleFilterChange(type, value);
  const currentFilters = () => ({
    search: document.getElementById('filter-search')?.value || '',
    year: document.getElementById('filter-year')?.value || 'All',
    program: document.getElementById('filter-program')?.value || 'All',
    discipline: document.getElementById('filter-discipline')?.value || 'All',
    industry: document.getElementById('filter-industry')?.value || 'All',
  });
  const assertVisibleDataset = (expectedCount, label, filters = currentFilters()) => {
    check(visibleCards().length === expectedCount, `${label} renders ${expectedCount} expected cards`);
    check(visibleIds().every((id) => expectedById.has(id)), `${label} has only fixture IDs`);
    check(visibleIds().every((id) => recordMatches(expectedById.get(id), filters)), `${label} every visible record satisfies the active filters`);
  };
  const runCaptureSelfTest = async () => {
    const marker = window.__CAPSTONE_HARNESS_CONTROL_MARKER;
    console.error(`${marker}-console`);
    check(window.__CAPSTONE_HARNESS_ERRORS.some((entry) => entry.includes(`${marker}-console`)), 'console.error capture positive control passed');
    setTimeout(() => { throw new Error(`${marker}-window`); }, 0);
    check(await waitFor(() => window.__CAPSTONE_HARNESS_WINDOW_ERRORS.some((entry) => entry.includes(`${marker}-window`))), 'window-error capture positive control passed');
    Promise.reject(new Error(`${marker}-rejection`));
    check(await waitFor(() => window.__CAPSTONE_HARNESS_REJECTIONS.some((entry) => entry.includes(`${marker}-rejection`))), 'unhandled-rejection capture positive control passed');
    const stray = [...window.__CAPSTONE_HARNESS_ERRORS, ...window.__CAPSTONE_HARNESS_WINDOW_ERRORS, ...window.__CAPSTONE_HARNESS_REJECTIONS]
      .filter((entry) => !entry.includes(marker));
    check(stray.length === 0, `positive controls captured no unrelated errors (${stray.join(' | ')})`);
    window.__CAPSTONE_HARNESS_ERRORS.length = 0;
    window.__CAPSTONE_HARNESS_WINDOW_ERRORS.length = 0;
    window.__CAPSTONE_HARNESS_REJECTIONS.length = 0;
    window.__CAPSTONE_HARNESS_CONTROLS_VERIFIED = true;
  };
  const assertNoUnsafePublicMarkup = () => {
    const renderedMarkup = ['capstone-showcase-root', 'project-detail', 'capstone-lightbox']
      .map((id) => document.getElementById(id)?.innerHTML || '')
      .join('\n');
    check(!document.querySelector('[href^="javascript:"], [href^="data:"], [href^="vbscript:"], [src^="javascript:"], [src^="data:"], [src^="vbscript:"]'), 'rendered surface has no executable URL schemes');
    check(!renderedMarkup.includes('project-drafts-private'), 'rendered surface has no private bucket marker');
    check(!renderedMarkup.includes('signed'), 'rendered surface has no signed asset marker');
    check(Array.from(document.querySelectorAll('a[target="_blank"]')).every((link) => {
      const rel = new Set((link.getAttribute('rel') || '').split(/\s+/).filter(Boolean));
      return rel.has('noopener') && rel.has('noreferrer');
    }), 'all safe external actions retain noopener/noreferrer');
  };
  const finish = () => {
    check(document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1, `no horizontal document overflow at ${window.innerWidth}px`);
    check(window.__CAPSTONE_HARNESS_CONTROLS_VERIFIED === true, 'error capture controls were proven before application assertions');
    check(window.__CAPSTONE_HARNESS_ERRORS.length === 0, 'zero unexpected console.error calls');
    check(window.__CAPSTONE_HARNESS_WINDOW_ERRORS.length === 0, 'zero unexpected window errors');
    check(window.__CAPSTONE_HARNESS_REJECTIONS.length === 0, 'zero unexpected unhandled rejections');
    check(window.__CAPSTONE_ANNUAL_FETCH_CALLS.length > 0, 'an intercepted public feed fetch occurred');
    check(window.__CAPSTONE_ANNUAL_EXTERNAL_CONTACTS === 0, 'no external contact occurred');
    result.consoleErrors = window.__CAPSTONE_HARNESS_ERRORS;
    result.windowErrors = window.__CAPSTONE_HARNESS_WINDOW_ERRORS;
    result.unhandledRejections = window.__CAPSTONE_HARNESS_REJECTIONS;
    result.externalContacts = window.__CAPSTONE_ANNUAL_EXTERNAL_CONTACTS;
    result.ok = result.failures.length === 0;
    const marker = document.createElement('div');
    marker.setAttribute('data-capstone-result', btoa(unescape(encodeURIComponent(JSON.stringify(result)))));
    document.body.appendChild(marker);
  };

  const verifyListing = async () => {
    check(visibleCards().length === records.length, '120 fixture projects are accepted and rendered');
    const ids = visibleIds();
    check(ids.length === records.length, 'listing contains exactly one card per fixture record');
    const firstActionIds = visibleCards().map((card) => Number((card.querySelector('.capstone-poster-link')?.getAttribute('onclick') || '').match(/handleProjectClick\((\d+)\)/)?.[1]));
    const secondActionIds = visibleCards().map((card) => Number((card.querySelector('.capstone-card-btn')?.getAttribute('onclick') || '').match(/handleProjectClick\((\d+)\)/)?.[1]));
    check(new Set(firstActionIds).size === records.length, 'listing poster actions have 120 unique targets');
    check(new Set(secondActionIds).size === records.length, 'listing learn-more actions have 120 unique targets');
    check(JSON.stringify([...firstActionIds].sort((a, b) => a - b)) === JSON.stringify([...secondActionIds].sort((a, b) => a - b)), 'the two listing actions agree per project');
    check(new Set(firstActionIds).size === records.length && firstActionIds.every((id) => expectedById.has(id)), 'all generated detail target IDs belong to exactly one fixture record');
    check(new Set(visibleTitles()).size === records.length, 'listing has no duplicate card titles');
    check(visibleTitles().every((title) => records.some((record) => record.title === title)), 'listing has no unrelated cards');
    check(visibleCards().every((card) => card.querySelector('.capstone-poster-link')?.getAttribute('aria-label') === `View ${card.querySelector('.capstone-card-image')?.alt} project detail`), 'poster actions have project-specific accessible names');
    check(visibleCards().every((card) => card.querySelector('.capstone-card-btn')?.getAttribute('aria-label') === `Learn more about ${card.querySelector('.capstone-card-image')?.alt}`), 'learn-more actions have project-specific accessible names');

    const searchCases = [
      ['title', records[0].title, 0],
      ['case-insensitive title', records[59].title.toUpperCase(), 59],
      ['publicId', records[119].publicId, 119],
      ['industryPartner', records[2].industryPartner, 2],
      ['groupName', records[77].groupName, 77],
    ];
    for (const [kind, value, index] of searchCases) {
      setSearch(value);
      const expected = countFixture({ ...currentFilters(), search: value });
      assertVisibleDataset(expected, `search ${kind}`, { ...currentFilters(), search: value });
      check(visibleIds().includes(records[index].id), `search ${kind} returns its representative record`);
      result.searchCases.push({ kind, expected, observed: visibleCards().length });
    }
    setSearch('annual-scale-no-match-9f2e');
    assertVisibleDataset(0, 'deterministic no-match search', { ...currentFilters(), search: 'annual-scale-no-match-9f2e' });
    check(document.getElementById('capstone-project-grid')?.textContent.includes('No projects match the current search or filters.'), 'no-match search renders the bounded empty state');
    setSearch('');
    assertVisibleDataset(records.length, 'clearing search restores all records', currentFilters());

    for (const [type, value, expected] of window.__CAPSTONE_ANNUAL_FACET_EXPECTATIONS) {
      setFacet(type, value);
      const filters = { ...currentFilters(), [type]: value };
      assertVisibleDataset(expected, `${type} facet`, filters);
      result.facetCases.push({ type, value, expected, observed: visibleCards().length });
      setFacet(type, 'All');
    }
    const searchFacetRecord = records[59];
    setSearch(searchFacetRecord.title);
    setFacet('year', searchFacetRecord.year);
    assertVisibleDataset(1, 'search plus year intersection', { ...currentFilters(), search: searchFacetRecord.title, year: searchFacetRecord.year });
    check(visibleIds()[0] === searchFacetRecord.id, 'search plus facet intersection preserves the intended record');
    setSearch('');
    setFacet('year', 'All');
    setFacet('program', window.__CAPSTONE_ANNUAL_PROGRAMS[0]);
    setFacet('industry', window.__CAPSTONE_ANNUAL_INDUSTRIES[2]);
    const twoFacetFilters = { ...currentFilters(), program: window.__CAPSTONE_ANNUAL_PROGRAMS[0], industry: window.__CAPSTONE_ANNUAL_INDUSTRIES[2] };
    assertVisibleDataset(countFixture(twoFacetFilters), 'program plus industry intersection', twoFacetFilters);
    check(visibleCards().length < records.length, 'two-facet intersection materially reduces the dataset');
    setFacet('program', 'All');
    setFacet('industry', 'All');
    assertVisibleDataset(records.length, 'clearing facets restores all records', currentFilters());
    const searchInput = document.getElementById('filter-search');
    const controls = [searchInput, ...['year', 'program', 'discipline', 'industry'].map((type) => document.getElementById(`filter-${type}`))];
    check(controls.every((control) => control
      && control.getBoundingClientRect().width > 0
      && control.getBoundingClientRect().width <= window.innerWidth
      && control.offsetHeight > 0
      && getComputedStyle(control).visibility !== 'hidden'), 'listing controls are usable and visible within the viewport');
    assertNoUnsafePublicMarkup();
  };

  const verifyDetail = async () => {
    const requestedId = Number(new URLSearchParams(window.location.search).get('id'));
    const expected = expectedById.get(requestedId);
    check(Boolean(expected), 'detail route ID belongs to the generated fixture');
    check(document.querySelectorAll('h1').length === 1, 'detail has exactly one project H1');
    check(document.querySelector('h1')?.textContent === expected?.title, `detail H1 resolves ${expected?.title}`);
    check(expected?.publicId === records.find((record) => record.id === requestedId)?.publicId, 'detail route maps to the exact expected publicId');
    check(document.body.textContent.includes(expected?.program), 'detail renders the expected program field');
    check(document.body.textContent.includes(expected?.industryPartner), 'detail renders the expected industry partner field');
    check(document.body.textContent.includes(expected?.groupName), 'detail renders the expected group/team field');
    const disclosure = document.querySelector('.poster-text-disclosure');
    check(disclosure?.tagName === 'DETAILS', 'full poster text uses the current native disclosure');
    disclosure?.querySelector('summary')?.click();
    check(disclosure?.open === true && disclosure.querySelector('.poster-text-content')?.textContent === expected?.posterText, 'full poster text remains user-visible and exact');
    const accessibilityText = expected?.accessibilityText;
    check(document.body.textContent.includes(accessibilityText), 'concise accessibility text remains user-visible');
    check(disclosure?.querySelector('.poster-text-content')?.textContent !== accessibilityText, 'full poster text remains separate from concise accessibility text');
    const expectedAlts = new Map(expected.snapshotMedia.map((media) => [new URL(media.url).pathname, media.altText]));
    const snapshotImages = Array.from(document.querySelectorAll('img[src*="/snapshots/"]'));
    check(snapshotImages.length > 0, 'detail renders governed snapshot media');
    check(snapshotImages.every((image) => expectedAlts.get(new URL(image.src).pathname) === image.alt), 'governed snapshot alt text is exact for every rendered image');
    check(snapshotImages.every((image) => !/^Snapshot \d+$/i.test(image.alt)), 'snapshot alternatives are not generic numbered text');
    check(Array.from(document.querySelectorAll('.snapshot-card')).every((control) => control.tagName === 'BUTTON' && control.getAttribute('aria-label')), 'snapshot controls have native semantics and accessible names');
    assertNoUnsafePublicMarkup();
    result.representativeDetails += 1;
  };

  document.addEventListener('DOMContentLoaded', async () => {
    try {
      await runCaptureSelfTest();
      const ready = await waitFor(() => document.querySelector('.capstone-card, .cip-module, .capstone-inline-error') || document.getElementById('capstone-project-grid')?.textContent.includes('No projects'));
      check(ready, 'actual renderer reached a bounded rendered state');
      if (window.__CAPSTONE_ANNUAL_SCENARIO === 'listing') await verifyListing();
      else await verifyDetail();
    } catch (error) {
      result.failures.push(`annual driver exception: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    }
    finish();
  });
}

function buildHarnessPage(requestUrl, runtimeFixture) {
  const isDetail = requestUrl.pathname.includes('project-detail');
  const setup = `
    window.CAPSTONE_FEED_URL = ${escapeInlineJson(localFeedUrl)};
    window.__CAPSTONE_ANNUAL_SCENARIO = ${escapeInlineJson(isDetail ? 'detail' : 'listing')};
    window.__CAPSTONE_ANNUAL_FIXTURE = ${escapeInlineJson(runtimeFixture)};
    window.__CAPSTONE_ANNUAL_FACET_EXPECTATIONS = ${escapeInlineJson(facetExpectations)};
    window.__CAPSTONE_ANNUAL_PROGRAMS = ${escapeInlineJson(programs)};
    window.__CAPSTONE_ANNUAL_INDUSTRIES = ${escapeInlineJson(industries)};
    window.__CAPSTONE_HARNESS_CONTROL_MARKER = 'CAPSTONE_ANNUAL_SCALE_POSITIVE_CONTROL_4d17be';
    window.__CAPSTONE_HARNESS_ERRORS = [];
    window.__CAPSTONE_HARNESS_WINDOW_ERRORS = [];
    window.__CAPSTONE_HARNESS_REJECTIONS = [];
    window.__CAPSTONE_HARNESS_CONTROLS_VERIFIED = false;
    window.__CAPSTONE_ANNUAL_FETCH_CALLS = [];
    window.__CAPSTONE_ANNUAL_EXTERNAL_CONTACTS = 0;
    const originalConsoleError = console.error.bind(console);
    console.error = (...args) => {
      window.__CAPSTONE_HARNESS_ERRORS.push(args.map(value => value instanceof Error ? value.message : String(value)).join(' '));
      originalConsoleError(...args);
    };
    window.addEventListener('error', event => window.__CAPSTONE_HARNESS_WINDOW_ERRORS.push(event.message || 'window-error'));
    window.addEventListener('unhandledrejection', event => window.__CAPSTONE_HARNESS_REJECTIONS.push(String(event.reason instanceof Error ? event.reason.message : event.reason)));
    window.fetch = async (url) => {
      window.__CAPSTONE_ANNUAL_FETCH_CALLS.push(String(url));
      if (!String(url).startsWith(${escapeInlineJson(localFeedUrl)})) window.__CAPSTONE_ANNUAL_EXTERNAL_CONTACTS += 1;
      return { ok: true, status: 200, json: async () => structuredClone(${escapeInlineJson(runtimeFixture)}) };
    };
  `;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Duda annual 120-record local harness</title>
  <style>html, body { margin: 0; width: 100%; min-height: 100%; background: #0f172a; } ${listingCss}\n${detailCss}</style>
  <script>${setup}</script>
</head>
<body>
  ${isDetail ? detailHtml : listingHtml}
  ${bodyEndHtml}
  <script>(${harnessDriver.toString()})();</script>
</body>
</html>`;
}

const browserPath = await findBrowser();
const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
  const address = server.address();
  const localOrigin = `http://127.0.0.1:${address.port}`;
  const runtimeFixture = JSON.parse(JSON.stringify(fixture).replaceAll('https://media.example.test', localOrigin));
  if (requestUrl.pathname.startsWith('/annual-scale-')) {
    const isVideo = requestUrl.pathname.endsWith('.mp4');
    response.writeHead(200, {
      'content-type': isVideo ? 'video/mp4' : 'image/svg+xml',
      ...(isVideo ? { 'content-length': '0' } : {}),
      'cache-control': 'no-store',
    });

    response.end(isVideo ? undefined : '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="100%" height="100%" fill="#334155"/><path d="M80 300 220 150l100 100 90-80 150 130" fill="none" stroke="#f8fafc" stroke-width="20"/></svg>');
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(buildHarnessPage(requestUrl, runtimeFixture));
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

const { port } = server.address();
const scenarios = [
  ['listing', '/', 1440, 1000],
  ['listing', '/', 390, 844],
  ...representativeIndexes.map((index) => ['detail', `/project-detail?id=${fixture[index].id}`, 1440, 1000]),
];
const evidence = [];

try {
  for (const [scenario, route, width, height] of scenarios) {
    const profileDirectory = await mkdtemp(path.join(os.tmpdir(), 'capstone-duda-annual-browser-'));
    try {
      const separator = route.includes('?') ? '&' : '?';
      const url = `http://127.0.0.1:${port}${route}${separator}annualScenario=${scenario}`;
      const { stdout } = await execFileAsync(browserPath, [
        '--headless=new',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--no-first-run',
        '--no-default-browser-check',
        '--host-resolver-rules=MAP * 127.0.0.1, EXCLUDE 127.0.0.1',
        `--user-data-dir=${profileDirectory}`,
        `--window-size=${width},${height}`,
        '--virtual-time-budget=12000',
        '--dump-dom',
        url,
      ], { maxBuffer: 24 * 1024 * 1024, timeout: 45000 });
      const encodedResult = stdout.match(/data-capstone-result="([A-Za-z0-9+/=]+)"/)?.[1];
      assert.ok(encodedResult, `${scenario} at ${width}x${height} did not return browser evidence. DOM tail: ${stdout.slice(-2500)}`);
      const result = JSON.parse(Buffer.from(encodedResult, 'base64').toString('utf8'));
      assert.equal(result.ok, true, `${scenario} at ${width}x${height} failed: ${result.failures.join('; ')}`);
      evidence.push({ scenario, width, height, result });
      console.log(`PASS ${scenario} at ${width}x${height}: ${result.checks.length} browser checks`);
    } finally {
      await rm(profileDirectory, { recursive: true, force: true });
    }
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}

const listingEvidence = evidence.filter((item) => item.scenario === 'listing');
const detailEvidence = evidence.filter((item) => item.scenario === 'detail');
const searchCaseCount = listingEvidence[0]?.result.searchCases.length || 0;
const facetCaseCount = listingEvidence[0]?.result.facetCases.length || 0;
const detailCount = detailEvidence.reduce((total, item) => total + item.result.representativeDetails, 0);
const consoleErrors = evidence.reduce((total, item) => total + item.result.consoleErrors.length, 0);
const windowErrors = evidence.reduce((total, item) => total + item.result.windowErrors.length, 0);
const unhandledRejections = evidence.reduce((total, item) => total + item.result.unhandledRejections.length, 0);
const externalContacts = evidence.reduce((total, item) => total + item.result.externalContacts, 0);

console.log('DUDA_ANNUAL_SCALE_CLASSIFICATION = LOCAL_120_RECORD_RENDERING_VERIFIED');
console.log(`RECORDS = ${annualRecordCount}`);
console.log(`LISTING_CARDS = ${annualRecordCount}`);
console.log(`DETAIL_TARGETS_VALID = ${annualRecordCount}/${annualRecordCount}`);
console.log(`SEARCH_CASES = ${searchCaseCount + 2} (five representative searches, no-match, clear)`);
console.log(`FACET_CASES = ${facetCaseCount + 2} (four facets, two intersections)`);
console.log(`REPRESENTATIVE_DETAILS = ${detailCount}/${representativeIndexes.length}`);
console.log('DESKTOP_OVERFLOW = NO');
console.log('MOBILE_OVERFLOW = NO');
console.log(`CONSOLE_ERRORS = ${consoleErrors}`);
console.log(`WINDOW_ERRORS = ${windowErrors}`);
console.log(`UNHANDLED_REJECTIONS = ${unhandledRejections}`);
console.log(`EXTERNAL_CONTACT = ${externalContacts === 0 ? 'NO' : 'YES'}`);
console.log('DUDA_SITE_MUTATION = NO');
