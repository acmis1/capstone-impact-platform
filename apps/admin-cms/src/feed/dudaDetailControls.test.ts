// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const bodyPath = resolve(__dirname, '../../../../apps/public-layer/duda/bodyend.html');
const source = readFileSync(bodyPath, 'utf8');
function region(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end <= start) throw new Error(`Missing shipped-renderer region: ${startMarker}`);
  return source.slice(start, end);
}
const context: Record<string, unknown> = { document, URL, decodeURIComponent, console };
// Execute the actual shipped pure renderer and its helpers, not a copied implementation.
// No bootstrap, fetch, navigation, Storage or external browser resource is invoked.
vm.runInNewContext([
  region('    // --- UTILS ---', '    const getFilterOptions ='),
  region('    const renderProjectDetail =', '    // --- LIGHTBOX LOGIC ---'),
  'globalThis.renderDetail = renderProjectDetail;',
].join('\n'), context, { filename: bodyPath, timeout: 1000 });
const renderDetail = context.renderDetail as (project: Record<string, unknown>) => string;
const POSTER = 'https://media.example.test/poster.jpg';
const PDF = 'https://media.example.test/poster.pdf';
const DEMO = 'https://demo.example.test/project';
const REPO = 'https://code.example.test/project';
const EXTERNAL = 'https://external.example.test/project';

function project(templateId: string, layout: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return {
    id: 1, publicId: 'synthetic-controls', title: 'Synthetic controls', summary: 'Synthetic only.',
    poster: POSTER, posterPdf: PDF, accessibilityText: 'Synthetic diagram.', posterText: 'Full poster text.',
    background: 'Background.', solution: 'Solution.', snapshots: [], snapshotMedia: [],
    demoUrl: DEMO, repositoryUrl: REPO, externalLinks: [{ label: 'Project report', url: EXTERNAL }],
    layoutConfig: { templateId, featuredMedia: 'poster', hiddenSections: [],
      sectionOrder: ['background', 'solution', 'links'], ...layout }, ...overrides,
  };
}
function rendered(record: Record<string, unknown>): HTMLElement {
  const root = document.createElement('section');
  root.innerHTML = renderDetail(record);
  return root;
}
function linksTo(root: HTMLElement, href: string): HTMLAnchorElement[] {
  return [...root.querySelectorAll<HTMLAnchorElement>('a')].filter(link => link.getAttribute('href') === href);
}
function expectOneExternalSet(root: HTMLElement): void {
  for (const href of [DEMO, REPO, EXTERNAL]) expect(linksTo(root, href)).toHaveLength(1);
}

for (const template of ['poster_showcase', 'technical_detail', 'media_rich']) {
  describe(`${template} resource controls`, () => {
    it('renders one primary PDF action and one copy of each external action', () => {
      const root = rendered(project(template));
      expect(linksTo(root, PDF)).toHaveLength(1);
      expect(linksTo(root, POSTER)).toHaveLength(0);
      expectOneExternalSet(root);
      expect(root.querySelectorAll('.poster-text-disclosure')).toHaveLength(1);
    });
    it('renders one image action when no PDF exists', () => {
      const root = rendered(project(template, {}, { posterPdf: '' }));
      expect(linksTo(root, PDF)).toHaveLength(0);
      expect(linksTo(root, POSTER)).toHaveLength(1);
      expectOneExternalSet(root);
    });
    it('honors hidden PDF and retains one allowed image action', () => {
      const root = rendered(project(template, { hiddenSections: ['posterPdf'] }));
      expect(linksTo(root, PDF)).toHaveLength(0);
      expect(linksTo(root, POSTER)).toHaveLength(1);
      expectOneExternalSet(root);
    });
    it('does not resurrect either explicitly hidden poster field', () => {
      const root = rendered(project(template, { hiddenSections: ['posterPdf', 'poster'] }));
      expect(linksTo(root, PDF)).toHaveLength(0);
      expect(linksTo(root, POSTER)).toHaveLength(0);
      expectOneExternalSet(root);
    });
    it.each(['links', 'externalLinks'])('honors hidden %s without suppressing a primary poster action', (hidden) => {
      const root = rendered(project(template, { hiddenSections: [hidden] }));
      for (const href of [DEMO, REPO, EXTERNAL]) expect(linksTo(root, href)).toHaveLength(0);
      expect(linksTo(root, PDF)).toHaveLength(1);
    });
    it.each([
      ['links', 'externalLinks'], ['externalLinks', 'links'], ['links', 'links'],
    ])('does not duplicate equivalent resource sections in supplied order %j', (...sections) => {
      const root = rendered(project(template, { sectionOrder: ['background', ...sections, 'solution'] }));
      expect(linksTo(root, PDF)).toHaveLength(1);
      expectOneExternalSet(root);
      const resourceHeadings = [...root.querySelectorAll('h2')].filter(h => h.textContent === 'Resources');
      expect(resourceHeadings.length).toBeLessThanOrEqual(1);
    });
    it('keeps rendering pure across section probes and repeated calls', () => {
      const record = project(template);
      const before = JSON.stringify(record);
      expect(renderDetail(record)).toBe(renderDetail(record));
      expect(JSON.stringify(record)).toBe(before);
      expect(linksTo(rendered(record), PDF)).toHaveLength(1);
    });
  });
}

describe('technical sidebar alternate media', () => {
  it('retains one PDF resource when the sidebar features video rather than a poster', () => {
    const root = rendered(project('technical_detail', { featuredMedia: 'video' }, {
      videoUrl: 'https://media.example.test/demo.mp4',
    }));
    expect(linksTo(root, PDF)).toHaveLength(1);
    expectOneExternalSet(root);
  });
  it('retains a visible PDF even when the poster image itself is hidden', () => {
    const root = rendered(project('technical_detail', { hiddenSections: ['poster'] }));
    expect(linksTo(root, PDF)).toHaveLength(1);
    expect(linksTo(root, POSTER)).toHaveLength(0);
    expectOneExternalSet(root);
  });
  it('keeps generated action labels and href attributes escaped', () => {
    const specialPdf = 'https://media.example.test/poster.pdf?caption="quoted"&mode=print';
    const root = rendered(project('technical_detail', {}, { posterPdf: specialPdf }));
    const links = linksTo(root, specialPdf);
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('target')).toBe('_blank');
    expect(links[0].getAttribute('rel')).toBe('noopener noreferrer');
    expect(links[0].textContent).toBe('Download Poster PDF');
    expect(root.querySelector('script')).toBeNull();
  });
});

describe('governed gallery visibility across templates', () => {
  const galleryUrl = 'https://media.example.test/snapshot.png';
  const media = { snapshots: [galleryUrl], snapshotMedia: [{ url: galleryUrl, altText: 'Synthetic diagram detail', galleryPosition: 1 }] };
  for (const template of ['poster_showcase', 'technical_detail', 'media_rich']) {
    it.each(['poster', 'gallery', 'auto'])(`${template} keeps a hidden gallery out of hero, strip and body with featured %s`, featuredMedia => {
      const visible = rendered(project(template, { featuredMedia }, media));
      expect([...visible.querySelectorAll('img')].filter(image => image.getAttribute('src') === galleryUrl).length).toBeGreaterThan(0);
      const hidden = rendered(project(template, { featuredMedia, hiddenSections: ['snapshots'] }, media));
      expect([...hidden.querySelectorAll('img')].filter(image => image.getAttribute('src') === galleryUrl)).toHaveLength(0);
      expect(hidden.querySelector('.exhibition-strip')).toBeNull();
      expect(linksTo(hidden, PDF)).toHaveLength(1);
      expect(hidden.querySelectorAll('.poster-text-disclosure')).toHaveLength(1);
    });
  }
});

describe('resource visibility with a non-poster technical sidebar', () => {
  for (const hidden of ['links', 'externalLinks']) {
    it(`keeps a separately allowed poster PDF when ${hidden} is hidden and video is featured`, () => {
      const root = rendered(project('technical_detail', { featuredMedia: 'video', hiddenSections: [hidden] }, {
        videoUrl: 'https://media.example.test/demo.mp4',
      }));
      expect(linksTo(root, PDF)).toHaveLength(1);
      for (const href of [DEMO, REPO, EXTERNAL]) expect(linksTo(root, href)).toHaveLength(0);
    });
  }
});
