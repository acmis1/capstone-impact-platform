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

const [bodyEndHtml, listingHtml, listingCss, detailHtml, detailCss, fixtureText, contractCasesText] = await Promise.all([
  readFile(path.join(dudaDirectory, 'bodyend.html'), 'utf8'),
  readFile(path.join(dudaDirectory, 'listing-page.html'), 'utf8'),
  readFile(path.join(dudaDirectory, 'listing-page.css'), 'utf8'),
  readFile(path.join(dudaDirectory, 'detail-page.html'), 'utf8'),
  readFile(path.join(dudaDirectory, 'detail-page.css'), 'utf8'),
  readFile(path.join(dudaDirectory, 'current-feed-demo-fixture.json'), 'utf8'),
  readFile(path.join(dudaDirectory, 'current-feed-contract-cases.json'), 'utf8'),
]);

const fixture = JSON.parse(fixtureText);
const contractCases = JSON.parse(contractCasesText);

/**
 * Browser scenarios that consume a paired server-validator contract case. The same JSON drives
 * `apps/admin-cms/src/feed/dudaCurrentFeedContract.test.ts`, so a record proven server-valid there
 * is proven renderable here, and a record proven unsafe there is proven inert here.
 */
const CONTRACT_SCENARIOS = {
  'contract-featured-media-auto-video': 'featured-media-auto-video',
  'contract-featured-media-auto-gallery': 'featured-media-auto-gallery',
  'contract-gallery-position-two': 'gallery-position-two',
  'contract-gallery-positions-two-and-five': 'gallery-positions-two-and-five',
  'contract-external-query-urls': 'external-query-urls',
  'contract-lightbox-listener-lifecycle': 'three-image-gallery',
  'contract-signed-supabase-video': 'signed-supabase-video',
  'contract-signed-supabase-external-link': 'signed-supabase-external-link',
  'contract-encoded-private-poster': 'encoded-private-supabase-poster',
  'contract-encoded-signed-video': 'encoded-signed-supabase-video',
  'contract-encoded-private-snapshot': 'encoded-private-supabase-snapshot',
  'contract-vbscript-external-link': 'vbscript-scheme-external-link',
};

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

/** Builds one contract-case record exactly as the paired repository test does. */
function buildContractCaseRecord(cases, caseName) {
  const entry = cases.cases.find((candidate) => candidate.name === caseName);
  if (!entry) throw new Error(`Unknown paired contract case: ${caseName}`);
  return { ...structuredClone(cases.base), ...structuredClone(entry.overrides) };
}

/**
 * URL-shaped values from a case that must never reach the rendered document: every override URL of
 * a rejected record, or the snapshot URLs of a record whose gallery must come out empty.
 */
function forbiddenMarkersFor(entry) {
  const markers = [];
  const collect = (value) => {
    if (typeof value === 'string') {
      if (/^[a-z][a-z0-9+.-]*:/i.test(value)) markers.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  if (!entry.dudaAccepts) {
    collect(entry.overrides);
  } else if (entry.dudaGallery === 0 && entry.overrides.snapshots) {
    collect(entry.overrides.snapshots);
    collect(entry.overrides.snapshotMedia);
  }
  return [...new Set(markers)];
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
      (Array.isArray(record.snapshotMedia) ? record.snapshotMedia : []).flatMap(media => {
        try {
          return [[new URL(media.url).pathname, media.altText]];
        } catch (e) {
          return [];
        }
      }),
    ),
  );

  /**
   * Positive controls for the error capture itself.
   *
   * An empty capture array only proves the application is clean if the capture demonstrably works,
   * so each run first triggers one genuine console.error, one genuine uncaught window error and one
   * genuine unhandled promise rejection, asserts all three were captured, then clears the arrays so
   * every later assertion still requires zero unexpected errors.
   */
  const runCaptureSelfTest = async () => {
    const marker = window.__CAPSTONE_HARNESS_CONTROL_MARKER;

    console.error(`${marker}-console`);
    check(
      window.__CAPSTONE_HARNESS_ERRORS.some(entry => entry.includes(`${marker}-console`)),
      'harness positive control proves console.error capture works',
    );

    setTimeout(() => { throw new Error(`${marker}-window`); }, 0);
    check(
      await waitFor(() => window.__CAPSTONE_HARNESS_WINDOW_ERRORS.some(entry => entry.includes(`${marker}-window`)), 2000),
      'harness positive control proves window error capture works',
    );

    Promise.reject(new Error(`${marker}-rejection`));
    check(
      await waitFor(() => window.__CAPSTONE_HARNESS_REJECTIONS.some(entry => entry.includes(`${marker}-rejection`)), 2000),
      'harness positive control proves unhandled rejection capture works',
    );

    const strays = [
      ...window.__CAPSTONE_HARNESS_ERRORS,
      ...window.__CAPSTONE_HARNESS_WINDOW_ERRORS,
      ...window.__CAPSTONE_HARNESS_REJECTIONS,
    ].filter(entry => !entry.includes(marker));
    check(strays.length === 0, `harness positive controls captured no other errors (${strays.join(' | ')})`);

    window.__CAPSTONE_HARNESS_ERRORS.length = 0;
    window.__CAPSTONE_HARNESS_WINDOW_ERRORS.length = 0;
    window.__CAPSTONE_HARNESS_REJECTIONS.length = 0;
    window.__CAPSTONE_HARNESS_CONTROLS_VERIFIED = true;
  };

  /**
   * Counts how many times an attribute is actually written while `action` runs. A duplicated
   * keyboard listener writes the lightbox alternative twice for one key press, so the count - not
   * only the final value - distinguishes one active navigation effect from several.
   */
  const countAttributeWrites = (element, attributeName, action) => {
    const observer = new MutationObserver(() => {});
    observer.observe(element, { attributes: true, attributeFilter: [attributeName], attributeOldValue: true });
    action();
    const records = observer.takeRecords().filter(record => record.attributeName === attributeName);
    observer.disconnect();
    return records.map(record => record.oldValue);
  };

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
  const renderedShowcaseHtml = () => ['capstone-showcase-root', 'project-detail', 'capstone-lightbox']
    .map(id => document.getElementById(id))
    .filter(Boolean)
    .map(root => root.innerHTML)
    .join('\n');
  const verifyNoOverflow = () => {
    check(
      document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      `page has no horizontal overflow at ${window.innerWidth}px`,
    );
  };
  const finish = () => {
    verifyNoOverflow();
    check(window.__CAPSTONE_HARNESS_CONTROLS_VERIFIED === true, 'error capture was proven by positive controls before these assertions');
    check(window.__CAPSTONE_HARNESS_ERRORS.length === 0, 'application emitted no unexpected console.error calls');
    check(window.__CAPSTONE_HARNESS_WINDOW_ERRORS.length === 0, 'application emitted no window error events');
    check(window.__CAPSTONE_HARNESS_REJECTIONS.length === 0, 'application emitted no unhandled promise rejections');
    results.consoleErrors = window.__CAPSTONE_HARNESS_ERRORS;
    results.windowErrors = window.__CAPSTONE_HARNESS_WINDOW_ERRORS;
    results.unhandledRejections = window.__CAPSTONE_HARNESS_REJECTIONS;
    results.ok = results.failures.length === 0;
    const marker = document.createElement('div');
    marker.id = 'capstone-harness-result';
    marker.setAttribute('data-capstone-result', btoa(unescape(encodeURIComponent(JSON.stringify(results)))));
    document.body.appendChild(marker);
  };

  document.addEventListener('DOMContentLoaded', async () => {
    const scenario = window.__CAPSTONE_HARNESS_SCENARIO;
    // The navigation scenario asserts only after it reaches the detail route; the first hop just
    // triggers the click, so the controls run on the page that actually asserts.
    const assertsOnThisPage = !(scenario === 'navigation' && !window.location.pathname.includes('project-detail'));
    if (assertsOnThisPage) await runCaptureSelfTest();
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
        window.handleProjectClick(202502);
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

    if (scenario === 'lightbox-lifecycle') {
      const expectedFirstAlt = window.__CAPSTONE_HARNESS_FIXTURE[0].snapshotMedia[0].altText;
      const expectedSecondAlt = window.__CAPSTONE_HARNESS_FIXTURE[0].snapshotMedia[1].altText;
      for (let cycle = 1; cycle <= 3; cycle += 1) {
        window.openLightbox(0);
        await waitFor(() => document.getElementById('capstone-lightbox')?.style.display === 'flex');
        check(document.getElementById('capstone-lightbox-img')?.alt === expectedFirstAlt, `lightbox cycle ${cycle} opens at the requested image`);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
        check(document.getElementById('capstone-lightbox-img')?.alt === expectedSecondAlt, `lightbox cycle ${cycle} handles one keyboard action exactly once`);
        window.closeLightbox();
        check(document.getElementById('capstone-lightbox')?.style.display === 'none', `lightbox cycle ${cycle} closes cleanly`);
      }
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

    if (['malformed-feed', 'failed-feed', 'parse-failed-feed'].includes(scenario)) {
      const expectedReason = scenario === 'failed-feed'
        ? 'FEED_REQUEST_FAILED'
        : scenario === 'parse-failed-feed'
          ? 'FEED_PARSE_FAILED'
          : 'FEED_RESPONSE_INVALID';
      check(Boolean(document.querySelector('.capstone-inline-error')), `${scenario} renders a bounded unavailable state`);
      check(document.body.textContent.includes('Projects could not be loaded'), `${scenario} exposes a safe public error message`);
      check(document.body.textContent.includes(expectedReason), `${scenario} exposes only its bounded public reason code`);
      check(!document.body.textContent.includes(window.__CAPSTONE_HARNESS_SECRET), `${scenario} does not disclose synthetic exception text`);
      check(!document.documentElement.innerHTML.includes(window.__CAPSTONE_HARNESS_SECRET), `${scenario} does not disclose malformed response excerpts in HTML`);
      finish();
      return;
    }

    if (scenario === 'malformed-snapshots') {
      const renderedSnapshots = Array.from(document.querySelectorAll('img[src*="/snapshots/"]'));
      check(renderedSnapshots.length === 2, 'malformed snapshot pairs are omitted while two exact pairs survive');
      check(renderedSnapshots[0]?.src.endsWith('/snapshots/flood-map.jpg'), 'the first exact URL-bound snapshot remains');
      check(renderedSnapshots[1]?.src.endsWith('/snapshots/flood-alerts.jpg'), 'the second exact URL-bound snapshot remains after filtered entries');
      check(renderedSnapshots[0]?.alt === window.__CAPSTONE_HARNESS_FIXTURE[0].snapshotMedia[0].altText, 'the first surviving snapshot keeps its URL-matched governed alt text');
      check(renderedSnapshots[1]?.alt === window.__CAPSTONE_HARNESS_FIXTURE[0].snapshotMedia[1].altText, 'the second surviving snapshot keeps its URL-matched governed alt text');
      check(
        renderedSnapshots.every(image => !/project-drafts-private|\/object\/(?:sign|authenticated)\//.test(image.src)),
        'private, signed, and authenticated snapshot paths are not rendered',
      );
      window.openLightbox(0);
      await waitFor(() => document.getElementById('capstone-lightbox')?.style.display === 'flex');
      check(document.getElementById('capstone-lightbox-img')?.src.endsWith('/snapshots/flood-map.jpg'), 'filtered gallery opens the first surviving image');
      check(document.getElementById('capstone-lightbox-img')?.alt === window.__CAPSTONE_HARNESS_FIXTURE[0].snapshotMedia[0].altText, 'filtered gallery opens the exact governed first alt text');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
      check(document.getElementById('capstone-lightbox-img')?.src.endsWith('/snapshots/flood-alerts.jpg'), 'filtered gallery next navigation stays synchronized');
      check(document.getElementById('capstone-lightbox-img')?.alt === window.__CAPSTONE_HARNESS_FIXTURE[0].snapshotMedia[1].altText, 'filtered gallery next navigation keeps the exact governed alt text');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
      check(document.getElementById('capstone-lightbox-img')?.src.endsWith('/snapshots/flood-map.jpg'), 'filtered gallery previous navigation stays synchronized');
      window.closeLightbox();
      finish();
      return;
    }

    if (scenario === 'detail-featured-gallery') {
      const heroGallery = document.querySelector('.media-hero-shell .snapshot-hero-grid');
      check(Boolean(heroGallery), 'media-rich layout executes the featured snapshot hero branch');
      verifyRenderedSnapshotAlts(2);
      const secondMedia = window.__CAPSTONE_HARNESS_FIXTURE[2].snapshotMedia[1];
      window.openLightbox(1);
      await waitFor(() => document.getElementById('capstone-lightbox')?.style.display === 'flex');
      check(document.getElementById('capstone-lightbox-img')?.src.endsWith(new URL(secondMedia.url).pathname), 'featured hero opens the selected governed image');
      check(document.getElementById('capstone-lightbox-img')?.alt === secondMedia.altText, 'featured hero lightbox uses exact governed alt text');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
      check(document.getElementById('capstone-lightbox-img')?.alt === window.__CAPSTONE_HARNESS_FIXTURE[2].snapshotMedia[0].altText, 'featured hero lightbox navigation stays synchronized');
      window.closeLightbox();
      finish();
      return;
    }

    if (scenario === 'unsafe-record') {
      check(Boolean(document.querySelector('.capstone-inline-error')), 'unsafe record rejects the whole feed before rendering');
      check(document.body.textContent.includes('FEED_RECORD_INVALID'), 'unsafe record exposes the bounded record-invalid reason');
      check(!document.documentElement.innerHTML.includes(window.__CAPSTONE_HARNESS_SECRET), 'unsafe record marker never reaches generated HTML');
      check(!document.querySelector('[href^="javascript:"], [href^="data:"], [href^="vbscript:"], [src^="javascript:"], [src^="data:"]'), 'unsafe record creates no active unsafe URL');
      check(window.location.pathname === '/', 'unsafe record cannot trigger detail navigation');
      finish();
      return;
    }

    if (scenario === 'escaped-text-record') {
      const maliciousTitle = window.__CAPSTONE_HARNESS_FIXTURE[0].title;
      const cardImage = document.querySelector('.capstone-card-image');
      const cardButton = document.querySelector('.capstone-poster-link');
      check(document.querySelectorAll('.capstone-card').length === 1, 'quote-bearing valid record still renders');
      check(cardImage?.alt === maliciousTitle, 'quote-bearing title is preserved as inert attribute text');
      check(!document.getElementById('unsafe-active-node'), 'quote-breaking markup creates no active element');
      check(cardButton?.getAttribute('onclick') === 'handleProjectClick(202601)', 'detail handler contains only the normalized numeric id');
      check(window.location.pathname === '/', 'quote-bearing text cannot trigger navigation');
      finish();
      return;
    }

    if (scenario.startsWith('contract-')) {
      const contractCase = window.__CAPSTONE_HARNESS_CONTRACT_CASE;
      check(Boolean(contractCase), `${scenario} received its paired server-validator contract case`);

      const renderedHtml = renderedShowcaseHtml();
      contractCase.forbiddenMarkers.forEach(marker => {
        check(
          !renderedHtml.includes(marker),
          `${scenario} never renders the rejected URL "${marker}"`,
        );
      });
      check(
        !document.querySelector('[href^="javascript:"], [href^="data:"], [href^="vbscript:"], [src^="javascript:"], [src^="data:"], [src^="vbscript:"]'),
        `${scenario} creates no active unsafe URL`,
      );

      if (!contractCase.dudaAccepts) {
        check(Boolean(document.querySelector('.capstone-inline-error')), `${scenario} rejects the record before rendering`);
        check(document.body.textContent.includes('FEED_RECORD_INVALID'), `${scenario} exposes only the bounded record-invalid reason`);
        check(!document.querySelector('.capstone-card, .cip-module'), `${scenario} renders no project content`);
        finish();
        return;
      }

      check(!document.querySelector('.capstone-inline-error'), `${scenario} accepts the server-valid record`);
      check(Boolean(document.querySelector('.cip-module')), `${scenario} renders the project detail module`);
      check(document.querySelector('h1')?.textContent === contractCase.record.title, `${scenario} renders the governed record title`);

      const galleryCards = Array.from(document.querySelectorAll('.snapshot-card'));
      check(
        galleryCards.length === contractCase.dudaGallery,
        `${scenario} renders exactly ${contractCase.dudaGallery} governed gallery image(s), saw ${galleryCards.length}`,
      );
      galleryCards.forEach(card => {
        const image = card.querySelector('img');
        const expected = expectedAltByPath.get(new URL(image.src).pathname);
        check(Boolean(expected), `${scenario} gallery image ${new URL(image.src).pathname} belongs to the paired case`);
        check(image.alt === expected, `${scenario} gallery image ${new URL(image.src).pathname} keeps its exact governed alternative`);
      });
      if (contractCase.dudaGallery > 0) verifyRenderedSnapshotAlts(contractCase.dudaGallery);
      verifyExternalLinkSecurity();

      if (scenario === 'contract-featured-media-auto-video') {
        check(
          document.querySelector('.media-hero-shell iframe')?.src === 'https://player.vimeo.com/video/987654321',
          'automatic featured media elevates the video first',
        );
      }

      if (scenario === 'contract-featured-media-auto-gallery') {
        check(
          Boolean(document.querySelector('.media-hero-shell .snapshot-hero-grid')),
          'automatic featured media falls back to the governed gallery when no video is published',
        );
      }

      if (scenario === 'contract-gallery-position-two') {
        const governed = contractCase.record.snapshotMedia[0];
        check(governed.galleryPosition === 2, 'paired case publishes its sole image at governed position two');
        window.openLightbox(0);
        await waitFor(() => document.getElementById('capstone-lightbox')?.style.display === 'flex');
        check(document.getElementById('capstone-lightbox-img')?.alt === governed.altText, 'non-contiguous position 2 opens with its exact governed alternative');
        window.closeLightbox();
      }

      if (scenario === 'contract-gallery-positions-two-and-five') {
        const governed = contractCase.record.snapshotMedia;
        check(
          JSON.stringify(governed.map(media => media.galleryPosition)) === JSON.stringify([2, 5]),
          'paired case publishes non-contiguous governed positions 2 and 5',
        );
        check(
          JSON.stringify(galleryCards.map(card => card.querySelector('img').alt)) === JSON.stringify(governed.map(media => media.altText)),
          'both non-contiguous positions render in snapshots display order with exact alternatives',
        );
        window.openLightbox(0);
        await waitFor(() => document.getElementById('capstone-lightbox')?.style.display === 'flex');
        check(document.getElementById('capstone-lightbox-img')?.alt === governed[0].altText, 'sparse gallery opens at the first governed image');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
        check(document.getElementById('capstone-lightbox-img')?.alt === governed[1].altText, 'sparse gallery advances to the second governed image');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
        check(document.getElementById('capstone-lightbox-img')?.alt === governed[0].altText, 'sparse gallery returns to the first governed image');
        window.closeLightbox();
      }

      if (scenario === 'contract-external-query-urls') {
        check(
          document.querySelector('iframe')?.src === 'https://www.youtube.com/embed/AbCdEfGhI12',
          'a YouTube watch URL with a query string still renders as the expected embed',
        );
        const hrefs = Array.from(document.querySelectorAll('a[target="_blank"]')).map(link => link.getAttribute('href'));
        ['demoUrl', 'repositoryUrl'].forEach(field => {
          check(hrefs.includes(contractCase.record[field]), `${field} keeps its legitimate query string in the rendered link`);
        });
        check(
          hrefs.includes(contractCase.record.externalLinks[0].url),
          'an external link keeps its legitimate query string in the rendered link',
        );
      }

      if (scenario === 'contract-lightbox-listener-lifecycle') {
        const governedAlts = contractCase.record.snapshotMedia.map(media => media.altText);
        check(governedAlts.length === 3, 'listener lifecycle case uses a three image gallery so duplicates are distinguishable');
        for (let cycle = 1; cycle <= 3; cycle += 1) {
          window.openLightbox(0);
          await waitFor(() => document.getElementById('capstone-lightbox')?.style.display === 'flex');
          const image = document.getElementById('capstone-lightbox-img');
          check(image?.alt === governedAlts[0], `lifecycle cycle ${cycle} opens at the first governed image`);

          const forward = countAttributeWrites(image, 'alt', () =>
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' })));
          check(forward.length === 1, `lifecycle cycle ${cycle} performs exactly one navigation transition per key press, saw ${forward.length}`);
          check(image.alt === governedAlts[1], `lifecycle cycle ${cycle} advances exactly one image`);

          const backward = countAttributeWrites(image, 'alt', () =>
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' })));
          check(backward.length === 1, `lifecycle cycle ${cycle} reverses with exactly one transition, saw ${backward.length}`);
          check(image.alt === governedAlts[0], `lifecycle cycle ${cycle} returns to the first governed image`);

          window.closeLightbox();
          check(document.getElementById('capstone-lightbox')?.style.display === 'none', `lifecycle cycle ${cycle} closes cleanly`);
          const afterClose = countAttributeWrites(image, 'alt', () =>
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' })));
          check(afterClose.length === 0, `lifecycle cycle ${cycle} leaves no active navigation effect after closing`);
        }
      }

      if (scenario === 'contract-encoded-private-snapshot') {
        check(galleryCards.length === 0, 'an encoded private-bucket snapshot is removed from the gallery');
        check(
          !/drafts|%2d|%25/i.test(renderedShowcaseHtml()),
          'no encoded private-bucket fragment reaches the rendered showcase markup',
        );
      }

      finish();
      return;
    }

    check(false, `unknown harness scenario ${scenario}`);
    finish();
  });
}

function buildHarnessPage(requestUrl, runtimeFixture, runtimeContractCases) {
  const pathIsDetail = requestUrl.pathname.includes('project-detail');
  const requestedScenario = requestUrl.searchParams.get('scenario');
  const scenario = requestedScenario || (pathIsDetail && requestUrl.searchParams.get('id') === '202502' ? 'navigation' : 'listing');
  const fixtureCopy = structuredClone(runtimeFixture);
  let payload = fixtureCopy;
  let harnessContractCase = null;

  if (scenario === 'empty-feed') payload = [];
  if (scenario === 'malformed-feed') payload = { records: fixtureCopy };
  if (scenario === 'malformed-snapshots') {
    payload = [structuredClone(fixtureCopy[0])];
    const firstSurvivingUrl = payload[0].snapshots[0];
    const secondSurvivingUrl = payload[0].snapshots[1];
    const duplicateUrl = 'https://media.example.test/snapshots/duplicate.jpg';
    const signedUrl = 'https://private.example.test/storage/v1/object/sign/project-public-assets/signed.jpg?token=secret';
    const authenticatedUrl = 'https://private.example.test/storage/v1/object/authenticated/project-public-assets/authenticated.jpg';
    const privateDraftUrl = 'https://private.example.test/storage/v1/object/public/project-drafts-private/secret.jpg';
    payload[0].snapshots = [
      firstSurvivingUrl,
      signedUrl,
      secondSurvivingUrl,
      duplicateUrl,
      duplicateUrl,
      authenticatedUrl,
      privateDraftUrl,
      'javascript:alert(1)',
      'https://media.example.test/snapshots/unpaired.jpg',
    ];
    payload[0].snapshotMedia = [
      { url: firstSurvivingUrl, altText: fixtureCopy[0].snapshotMedia[0].altText, galleryPosition: 1 },
      { url: signedUrl, altText: 'Signed image must not render.', galleryPosition: 2 },
      { url: secondSurvivingUrl, altText: fixtureCopy[0].snapshotMedia[1].altText, galleryPosition: 3 },
      { url: duplicateUrl, altText: 'First contradictory alternative.', galleryPosition: 1 },
      { url: duplicateUrl, altText: 'Second contradictory alternative.', galleryPosition: 5 },
      { url: authenticatedUrl, altText: 'Authenticated image must not render.', galleryPosition: 6 },
      {
        url: privateDraftUrl,
        altText: 'Private draft image must not render.',
        galleryPosition: 7,
      },
      { url: 'javascript:alert(1)', altText: 'Script URL must not render.', galleryPosition: 8 },
    ];
  }
  if (scenario === 'detail-generic-video') {
    payload[0].videoUrl = 'https://videos.example.test/presentation';
  }
  if (scenario === 'detail-featured-gallery') {
    payload[2].layoutConfig.featuredMedia = 'snapshots';
  }
  if (scenario === 'unsafe-record') {
    const unsafe = structuredClone(fixtureCopy[0]);
    unsafe.id = "202601');window.location='https://attacker.example.test/?quote-break-marker";
    unsafe.title = `\"><img id="unsafe-active-node" src=x onerror="window.location='https://attacker.example.test'">`;
    unsafe.poster = 'javascript:alert(1)';
    unsafe.posterPdf = 'data:text/html,<script>alert(1)</script>';
    unsafe.videoUrl = 'vbscript:msgbox(1)';
    unsafe.demoUrl = 'https://user:password@demo.example.test/private';
    unsafe.repositoryUrl = 'not-an-absolute-url';
    unsafe.snapshots = ['javascript:alert(1)', 'data:image/svg+xml,<svg onload=alert(1)>'];
    unsafe.snapshotMedia = [{ url: 'javascript:alert(1)', altText: 'Unsafe snapshot.', galleryPosition: 1 }];
    unsafe.externalLinks = [{ label: 'Unsafe link', url: 'javascript:alert(1)' }, 'malformed-link'];
    payload = [unsafe];
  }
  if (scenario === 'escaped-text-record') {
    payload = [structuredClone(fixtureCopy[0])];
    payload[0].title = '\"><img id="unsafe-active-node" src=x onerror="window.location=\'https://attacker.example.test\'">';
    fixtureCopy[0].title = payload[0].title;
  }
  if (CONTRACT_SCENARIOS[scenario]) {
    const caseName = CONTRACT_SCENARIOS[scenario];
    const entry = runtimeContractCases.cases.find((candidate) => candidate.name === caseName);
    const record = buildContractCaseRecord(runtimeContractCases, caseName);
    payload = [record];
    fixtureCopy.length = 0;
    fixtureCopy.push(structuredClone(record));
    harnessContractCase = {
      name: caseName,
      serverValid: entry.serverValid,
      dudaAccepts: entry.dudaAccepts,
      dudaGallery: entry.dudaGallery,
      forbiddenMarkers: forbiddenMarkersFor(entry),
      record,
    };
  }

  const harnessSetup = `
    window.CAPSTONE_FEED_URL = 'https://demofixture.supabase.co/storage/v1/object/public/public-feeds/capstones-latest.json';
    window.__CAPSTONE_HARNESS_SCENARIO = ${escapeInlineJson(scenario)};
    window.__CAPSTONE_HARNESS_FIXTURE = ${escapeInlineJson(fixtureCopy)};
    window.__CAPSTONE_HARNESS_CONTRACT_CASE = ${escapeInlineJson(harnessContractCase)};
    window.__CAPSTONE_HARNESS_SECRET = ['DISTINCTIVE', 'SECRET', 'LIKE', 'MARKER', '91f2c7'].join('_');
    window.__CAPSTONE_HARNESS_CONTROL_MARKER = ['CAPSTONE', 'HARNESS', 'POSITIVE', 'CONTROL', '4d17be'].join('_');
    window.__CAPSTONE_HARNESS_CONTROLS_VERIFIED = false;
    window.__CAPSTONE_HARNESS_ERRORS = [];
    window.__CAPSTONE_HARNESS_WINDOW_ERRORS = [];
    window.__CAPSTONE_HARNESS_REJECTIONS = [];
    const originalConsoleError = console.error.bind(console);
    console.error = (...args) => {
      window.__CAPSTONE_HARNESS_ERRORS.push(args.map(value => value instanceof Error ? value.message : String(value)).join(' '));
      originalConsoleError(...args);
    };
    window.addEventListener('error', event => {
      window.__CAPSTONE_HARNESS_WINDOW_ERRORS.push(event.message || 'window-error');
    });
    window.addEventListener('unhandledrejection', event => {
      window.__CAPSTONE_HARNESS_REJECTIONS.push(String(event.reason instanceof Error ? event.reason.message : event.reason));
    });
    window.fetch = async () => {
      if (window.__CAPSTONE_HARNESS_SCENARIO === 'failed-feed') throw new Error(window.__CAPSTONE_HARNESS_SECRET);
      if (window.__CAPSTONE_HARNESS_SCENARIO === 'parse-failed-feed') {
        return { ok: true, status: 200, json: async () => { throw new Error(window.__CAPSTONE_HARNESS_SECRET + ' malformed JSON excerpt'); } };
      }
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
  const runtimeContractCases = JSON.parse(JSON.stringify(contractCases).replaceAll('https://media.example.test', localOrigin));

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
  response.end(buildHarnessPage(requestUrl, runtimeFixture, runtimeContractCases));
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

const { port } = server.address();
const requestedScenarios = new Set(process.argv.slice(2));
const contractDetailRoute = '/project-detail?id=203101';
const scenarios = [
  ['listing', '/', 1440, 1000],
  ['listing', '/', 390, 844],
  ['navigation', '/', 1440, 1000],
  ['detail-poster', '/project-detail?id=202601', 1440, 1000],
  ['detail-poster', '/project-detail?id=202601', 390, 844],
  ['lightbox-lifecycle', '/project-detail?id=202601', 1440, 1000],
  ['detail-technical', '/project-detail?id=202502', 1440, 1000],
  ['detail-technical', '/project-detail?id=202502', 390, 844],
  ['detail-media', '/project-detail?id=202403', 1440, 1000],
  ['detail-media', '/project-detail?id=202403', 390, 844],
  ['detail-featured-gallery', '/project-detail?id=202403', 1440, 1000],
  ['detail-generic-video', '/project-detail?id=202601', 1440, 1000],
  ['empty-feed', '/', 390, 844],
  ['malformed-feed', '/', 1440, 1000],
  ['parse-failed-feed', '/', 1440, 1000],
  ['failed-feed', '/', 1440, 1000],
  ['malformed-snapshots', '/project-detail?id=202601', 1440, 1000],
  ['unsafe-record', '/', 1440, 1000],
  ['escaped-text-record', '/', 1440, 1000],
  ['contract-featured-media-auto-video', contractDetailRoute, 1440, 1000],
  ['contract-featured-media-auto-gallery', contractDetailRoute, 1440, 1000],
  ['contract-gallery-position-two', contractDetailRoute, 1440, 1000],
  ['contract-gallery-positions-two-and-five', contractDetailRoute, 1440, 1000],
  ['contract-gallery-positions-two-and-five', contractDetailRoute, 390, 844],
  ['contract-external-query-urls', contractDetailRoute, 1440, 1000],
  ['contract-lightbox-listener-lifecycle', contractDetailRoute, 1440, 1000],
  ['contract-encoded-private-snapshot', contractDetailRoute, 1440, 1000],
  ['contract-signed-supabase-video', '/', 1440, 1000],
  ['contract-signed-supabase-external-link', '/', 1440, 1000],
  ['contract-encoded-private-poster', '/', 1440, 1000],
  ['contract-encoded-signed-video', '/', 1440, 1000],
  ['contract-vbscript-external-link', '/', 1440, 1000],
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
