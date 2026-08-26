import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const prototypeDirectory = path.resolve(scriptDirectory, '..');
const dudaDirectory = path.join(prototypeDirectory, 'duda');

const [bodyEndHtml, listingHtml, listingCss, detailHtml, detailCss, fixtureText] = await Promise.all([
  readFile(path.join(dudaDirectory, 'bodyend.html'), 'utf8'),
  readFile(path.join(dudaDirectory, 'listing-page.html'), 'utf8'),
  readFile(path.join(dudaDirectory, 'listing-page.css'), 'utf8'),
  readFile(path.join(dudaDirectory, 'detail-page.html'), 'utf8'),
  readFile(path.join(dudaDirectory, 'detail-page.css'), 'utf8'),
  readFile(path.join(dudaDirectory, 'current-feed-demo-fixture.json'), 'utf8'),
]);

const fixture = JSON.parse(fixtureText);
const chromeCandidates = process.platform === 'win32'
  ? [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ]
  : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];

async function findBrowser() {
  for (const candidate of chromeCandidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next known browser location.
    }
  }
  throw new Error('Chrome or Edge was not found in a supported local browser location.');
}

function escapeInlineJson(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}

function harnessDriver() {
  const results = { checks: [], failures: [] };
  const check = (condition, label) => {
    results.checks.push(label);
    if (!condition) results.failures.push(label);
  };
  const waitFor = async (predicate, timeoutMs = 4500) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (predicate()) return true;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return false;
  };
  const visibleCardTitles = () => Array.from(document.querySelectorAll('.capstone-card-image')).map(img => img.alt);
  const expectedAltByPath = new Map(
    window.__CAPSTONE_HARNESS_FIXTURE.flatMap(record =>
      record.snapshotMedia.map(media => [new URL(media.url).pathname, media.altText]),
    ),
  );
  const verifyRenderedSnapshotAlts = (minimumCount = 1) => {
    const images = Array.from(document.querySelectorAll('img[src*="/snapshots/"]'));
    check(images.length >= minimumCount, `rendered at least ${minimumCount} governed snapshot image(s)`);
    images.forEach(image => {
      const expected = expectedAltByPath.get(new URL(image.src).pathname);
      check(Boolean(expected), `snapshot URL ${new URL(image.src).pathname} belongs to the fixture`);
      check(image.alt === expected, `snapshot ${new URL(image.src).pathname} uses its exact governed alt text`);
      check(!/^Snapshot \d+$/i.test(image.alt), `snapshot ${new URL(image.src).pathname} has no generic numbered alt text`);
    });
    const snapshotControls = Array.from(document.querySelectorAll('.snapshot-card'));
    check(snapshotControls.every(control => control.tagName === 'BUTTON'), 'snapshot gallery controls use native button semantics');
    check(snapshotControls.every(control => Boolean(control.getAttribute('aria-label'))), 'snapshot gallery controls have accessible names');
  };
  const verifyExternalLinkSecurity = () => {
    const links = Array.from(document.querySelectorAll('a[target="_blank"]'));
    check(links.length > 0, 'detail renders external resource links');
    links.forEach(link => {
      const rel = new Set((link.getAttribute('rel') || '').split(/\s+/).filter(Boolean));
      check(rel.has('noopener') && rel.has('noreferrer'), `external link ${link.textContent.trim()} retains noopener/noreferrer`);
    });
  };
  const verifyNoOverflow = () => {
    check(
      document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      `page has no horizontal overflow at ${window.innerWidth}px`,
    );
  };
  const finish = () => {
    verifyNoOverflow();
    const expectedErrorScenario = ['failed-feed', 'malformed-feed'].includes(window.__CAPSTONE_HARNESS_SCENARIO);
    if (!expectedErrorScenario) {
      check(window.__CAPSTONE_HARNESS_ERRORS.length === 0, 'application emitted no browser console errors');
    }
    results.consoleErrors = window.__CAPSTONE_HARNESS_ERRORS;
    results.ok = results.failures.length === 0;
    const marker = document.createElement('div');
    marker.id = 'capstone-harness-result';
    marker.setAttribute('data-capstone-result', btoa(unescape(encodeURIComponent(JSON.stringify(results)))));
    document.body.appendChild(marker);
  };

  document.addEventListener('DOMContentLoaded', async () => {
    const scenario = window.__CAPSTONE_HARNESS_SCENARIO;
    const ready = await waitFor(() =>
      document.querySelector('.capstone-card, .cip-module, .capstone-inline-error') ||
      document.getElementById('capstone-project-grid')?.textContent.includes('No projects'),
    );
    check(ready, `${scenario} reached a bounded rendered state`);

    if (scenario === 'listing') {
      check(document.querySelectorAll('.capstone-card').length === 3, 'listing renders all fixture cards');
      const filterCases = [
        ['year', '2026', 'Accessible Flood Response Dashboard'],
        ['program', 'Master of Cyber Security', 'Zero Trust Learning Lab'],
        ['discipline', 'User Experience Design', 'Inclusive Clinic Wayfinding'],
        ['industry', 'Healthcare', 'Inclusive Clinic Wayfinding'],
      ];
      for (const [type, value, title] of filterCases) {
        window.handleFilterChange(type, value);
        check(JSON.stringify(visibleCardTitles()) === JSON.stringify([title]), `${type} filter selects the expected project`);
        window.handleFilterChange(type, 'All');
      }
      check(document.querySelectorAll('.capstone-card-image').length === 3, 'listing renders poster images');
      finish();
      return;
    }

    if (scenario === 'navigation') {
      if (!window.location.pathname.includes('project-detail')) {
        sessionStorage.setItem('capstone-navigation-test', 'active');
        window.handleProjectClick('202502');
        return;
      }
      check(new URLSearchParams(window.location.search).get('id') === '202502', 'card navigation preserves the selected numeric id');
      check(document.querySelector('h1')?.textContent === 'Zero Trust Learning Lab', 'reusable detail route resolves the selected record');
      check(Boolean(document.querySelector('.layout-preset-technical_detail')), 'navigated record renders its configured detail preset');
      finish();
      return;
    }

    if (scenario === 'detail-poster') {
      check(Boolean(document.querySelector('.layout-preset-poster_showcase')), 'poster_showcase preset renders');
      check(Boolean(document.querySelector('video[src$="/videos/flood-response.mp4"]')), 'MP4 renders in the native video player');
      check(Boolean(document.querySelector('a[href$="/posters/flood-response.pdf"]')), 'poster PDF link renders');
      verifyRenderedSnapshotAlts(2);
      window.openLightbox(0);
      await waitFor(() => document.getElementById('capstone-lightbox')?.style.display === 'flex');
      check(document.getElementById('capstone-lightbox-img')?.alt === window.__CAPSTONE_HARNESS_FIXTURE[0].snapshotMedia[0].altText, 'lightbox uses the first governed alt text');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
      check(document.getElementById('capstone-lightbox-img')?.alt === window.__CAPSTONE_HARNESS_FIXTURE[0].snapshotMedia[1].altText, 'lightbox navigation updates to the second governed alt text');
      check(document.querySelector('.capstone-lightbox-prev')?.getAttribute('aria-label') === 'Previous snapshot', 'lightbox previous control has an accessible name');
      check(document.querySelector('.capstone-lightbox-next')?.getAttribute('aria-label') === 'Next snapshot', 'lightbox next control has an accessible name');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      check(document.getElementById('capstone-lightbox')?.style.display === 'none', 'gallery lightbox closes cleanly');
      verifyExternalLinkSecurity();
      finish();
      return;
    }

    if (scenario === 'detail-technical') {
      check(Boolean(document.querySelector('.layout-preset-technical_detail')), 'technical_detail preset renders');
      check(
        document.querySelector('iframe')?.src === 'https://www.youtube.com/embed/AbCdEfGhI12',
        'YouTube URL renders as the expected embed',
      );
      check(Boolean(document.querySelector('a[href$="/posters/zero-trust.pdf"]')), 'technical detail exposes the poster PDF');
      verifyRenderedSnapshotAlts(2);
      verifyExternalLinkSecurity();
      finish();
      return;
    }

    if (scenario === 'detail-media') {
      check(Boolean(document.querySelector('.layout-preset-media_rich')), 'media_rich preset renders');
      check(
        document.querySelector('iframe')?.src === 'https://player.vimeo.com/video/123456789',
        'Vimeo URL renders as the expected embed',
      );
      check(Boolean(document.querySelector('img[src$="/posters/clinic-wayfinding.jpg"]')), 'media-rich detail renders its poster');
      verifyRenderedSnapshotAlts(2);
      verifyExternalLinkSecurity();
      finish();
      return;
    }

    if (scenario === 'detail-generic-video') {
      const fallback = document.querySelector('a.btn-cta-link[href="https://videos.example.test/presentation"]');
      check(Boolean(fallback), 'generic video URL renders the external presentation fallback');
      check(fallback?.target === '_blank', 'generic video fallback opens in a new tab');
      const rel = new Set((fallback?.getAttribute('rel') || '').split(/\s+/).filter(Boolean));
      check(rel.has('noopener') && rel.has('noreferrer'), 'generic video fallback retains noopener/noreferrer');
      finish();
      return;
    }

    if (scenario === 'empty-feed') {
      check(document.getElementById('capstone-project-grid')?.textContent.includes('No projects match'), 'empty feed renders a bounded empty state');
      finish();
      return;
    }

    if (scenario === 'malformed-feed' || scenario === 'failed-feed') {
      check(Boolean(document.querySelector('.capstone-inline-error')), `${scenario} renders a bounded unavailable state`);
      check(document.body.textContent.includes('Projects could not be loaded'), `${scenario} exposes a safe public error message`);
      finish();
      return;
    }

    if (scenario === 'malformed-snapshots') {
      const renderedSnapshots = Array.from(document.querySelectorAll('img[src*="/snapshots/"]'));
      check(renderedSnapshots.length === 1, 'malformed snapshot pairs are omitted instead of guessed');
      check(renderedSnapshots[0]?.src.endsWith('/snapshots/flood-alerts.jpg'), 'the one exact URL-bound snapshot remains');
      check(renderedSnapshots[0]?.alt === window.__CAPSTONE_HARNESS_FIXTURE[0].snapshotMedia[1].altText, 'the surviving snapshot keeps its URL-matched governed alt text');
      check(
        renderedSnapshots.every(image => !/project-drafts-private|\/object\/(?:sign|authenticated)\//.test(image.src)),
        'private, signed, and authenticated snapshot paths are not rendered',
      );
      finish();
      return;
    }

    check(false, `unknown harness scenario ${scenario}`);
    finish();
  });
}

function buildHarnessPage(requestUrl, runtimeFixture) {
  const pathIsDetail = requestUrl.pathname.includes('project-detail');
  const requestedScenario = requestUrl.searchParams.get('scenario');
  const scenario = requestedScenario || (pathIsDetail && requestUrl.searchParams.get('id') === '202502' ? 'navigation' : 'listing');
  const fixtureCopy = structuredClone(runtimeFixture);
  let payload = fixtureCopy;

  if (scenario === 'empty-feed') payload = [];
  if (scenario === 'malformed-feed') payload = { records: fixtureCopy };
  if (scenario === 'malformed-snapshots') {
    payload = [structuredClone(fixtureCopy[0])];
    const duplicateUrl = payload[0].snapshots[0];
    const survivingUrl = payload[0].snapshots[1];
    const signedUrl = 'https://private.example.test/storage/v1/object/sign/project-public-assets/signed.jpg?token=secret';
    const authenticatedUrl = 'https://private.example.test/storage/v1/object/authenticated/project-public-assets/authenticated.jpg';
    const privateDraftUrl = 'https://private.example.test/storage/v1/object/public/project-drafts-private/secret.jpg';
    payload[0].snapshots = [
      duplicateUrl,
      duplicateUrl,
      survivingUrl,
      signedUrl,
      authenticatedUrl,
      privateDraftUrl,
      'not-an-absolute-url',
      'https://media.example.test/snapshots/unpaired.jpg',
    ];
    payload[0].snapshotMedia = [
      { url: duplicateUrl, altText: 'First contradictory alternative.', galleryPosition: 1 },
      { url: duplicateUrl, altText: 'Second contradictory alternative.', galleryPosition: 2 },
      { url: survivingUrl, altText: fixtureCopy[0].snapshotMedia[1].altText, galleryPosition: 3 },
      { url: signedUrl, altText: 'Signed image must not render.', galleryPosition: 4 },
      { url: authenticatedUrl, altText: 'Authenticated image must not render.', galleryPosition: 5 },
      {
        url: privateDraftUrl,
        altText: 'Private draft image must not render.',
        galleryPosition: 6,
      },
      { url: 'not-an-absolute-url', altText: '', galleryPosition: 7 },
    ];
  }
  if (scenario === 'detail-generic-video') {
    payload[0].videoUrl = 'https://videos.example.test/presentation';
  }

  const harnessSetup = `
    window.CAPSTONE_FEED_URL = 'https://demofixture.supabase.co/storage/v1/object/public/public-feeds/capstones-latest.json';
    window.__CAPSTONE_HARNESS_SCENARIO = ${escapeInlineJson(scenario)};
    window.__CAPSTONE_HARNESS_FIXTURE = ${escapeInlineJson(fixtureCopy)};
    window.__CAPSTONE_HARNESS_ERRORS = [];
    const originalConsoleError = console.error.bind(console);
    console.error = (...args) => {
      window.__CAPSTONE_HARNESS_ERRORS.push(args.map(value => value instanceof Error ? value.message : String(value)).join(' '));
      originalConsoleError(...args);
    };
    window.fetch = async () => {
      if (window.__CAPSTONE_HARNESS_SCENARIO === 'failed-feed') throw new Error('Synthetic local feed failure.');
      return { ok: true, status: 200, json: async () => structuredClone(${escapeInlineJson(payload)}) };
    };
  `;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Duda current-feed local harness</title>
  <style>html, body { margin: 0; width: 100%; min-height: 100%; background: #0f172a; } ${listingCss}\n${detailCss}</style>
  <script>${harnessSetup}</script>
</head>
<body>
  ${pathIsDetail ? detailHtml : listingHtml}
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

  if (requestUrl.pathname.startsWith('/posters/') || requestUrl.pathname.startsWith('/snapshots/')) {
    response.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
    response.end('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="100%" height="100%" fill="#334155"/><path d="M80 300 220 150l100 100 90-80 150 130" fill="none" stroke="#f8fafc" stroke-width="20"/></svg>');
    return;
  }
  if (requestUrl.pathname.startsWith('/videos/')) {
    response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '0', 'cache-control': 'no-store' });
    response.end();
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
const requestedScenarios = new Set(process.argv.slice(2));
const scenarios = [
  ['listing', '/', 1440, 1000],
  ['listing', '/', 390, 844],
  ['navigation', '/', 1440, 1000],
  ['detail-poster', '/project-detail?id=202601', 1440, 1000],
  ['detail-poster', '/project-detail?id=202601', 390, 844],
  ['detail-technical', '/project-detail?id=202502', 1440, 1000],
  ['detail-technical', '/project-detail?id=202502', 390, 844],
  ['detail-media', '/project-detail?id=202403', 1440, 1000],
  ['detail-media', '/project-detail?id=202403', 390, 844],
  ['detail-generic-video', '/project-detail?id=202601', 1440, 1000],
  ['empty-feed', '/', 390, 844],
  ['malformed-feed', '/', 1440, 1000],
  ['failed-feed', '/', 1440, 1000],
  ['malformed-snapshots', '/project-detail?id=202601', 1440, 1000],
].filter(([scenario]) => requestedScenarios.size === 0 || requestedScenarios.has(scenario));

assert.ok(scenarios.length > 0, 'No matching Duda browser scenarios were requested.');

try {
  for (const [scenario, route, width, height] of scenarios) {
    const profileDirectory = await mkdtemp(path.join(os.tmpdir(), 'capstone-duda-browser-'));
    try {
      const separator = route.includes('?') ? '&' : '?';
      const url = `http://127.0.0.1:${port}${route}${separator}scenario=${scenario}`;
      const { stdout } = await execFileAsync(
        browserPath,
        [
          '--headless=new',
          '--disable-gpu',
          '--disable-extensions',
          '--disable-background-networking',
          '--no-first-run',
          '--no-default-browser-check',
          '--host-resolver-rules=MAP * 127.0.0.1, EXCLUDE 127.0.0.1',
          `--user-data-dir=${profileDirectory}`,
          `--window-size=${width},${height}`,
          '--virtual-time-budget=9000',
          '--dump-dom',
          url,
        ],
        { maxBuffer: 16 * 1024 * 1024, timeout: 35000 },
      );
      const encodedResult = stdout.match(/data-capstone-result="([A-Za-z0-9+/=]+)"/)?.[1];
      assert.ok(
        encodedResult,
        `${scenario} at ${width}px did not return browser evidence. DOM tail: ${stdout.slice(-2000)}`,
      );
      const result = JSON.parse(Buffer.from(encodedResult, 'base64').toString('utf8'));
      assert.equal(result.ok, true, `${scenario} at ${width}px failed: ${result.failures.join('; ')}`);
      console.log(`PASS ${scenario} at ${width}x${height}: ${result.checks.length} browser checks`);
    } finally {
      await rm(profileDirectory, { recursive: true, force: true });
    }
  }
} finally {
  await new Promise(resolve => server.close(resolve));
}

console.log(`Duda current-feed browser harness: ${scenarios.length} Chrome scenarios passed.`);
