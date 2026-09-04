import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

import type {
  ParticipantPreviewMediaViewRef,
  ParticipantPreviewSnapshot,
} from '../domain/participantPreview';
import {
  ParticipantPreviewEvidenceError,
  renderParticipantPreviewPage,
} from './participantPreviewHtml';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom') as {
  JSDOM: new (html: string) => { window: { document: Document } };
};

const VIDEO = 'https://video.example.com/watch?v=synthetic';
const DEMO = 'https://demo.example.com/prototype';
const REPOSITORY = 'https://code.example.com/team/synthetic-project';

const snapshot = (overrides: Partial<ParticipantPreviewSnapshot> = {}): ParticipantPreviewSnapshot => ({
  title: 'Synthetic Project', summary: null, background: null, solution: null, year: 2026,
  program: null, studyProgram: null, discipline: null, disciplines: [], industry: null,
  industryPartner: null, academicSupervisor: null, groupName: null, teamMembers: [],
  posterText: 'Poster full text.', accessibilityText: 'Poster description.',
  citations: [], externalLinks: [], industryCategories: [],
  videoUrl: null, demoUrl: null, repositoryUrl: null,
  ...overrides,
});

const media: ParticipantPreviewMediaViewRef[] = [];

const render = (overrides: Partial<ParticipantPreviewSnapshot> = {}) => renderParticipantPreviewPage({
  snapshot: snapshot(overrides),
  media,
  responseState: { type: 'unresponded' },
});

const documentOf = (html: string) => new JSDOM(html).window.document;

const populated = { videoUrl: VIDEO, demoUrl: DEMO, repositoryUrl: REPOSITORY };

describe('controlled project links as participant evidence', () => {
  it('renders every populated controlled link', () => {
    const document = documentOf(render(populated));

    const hrefs = [...document.querySelectorAll('.project-links-section a')]
      .map((anchor) => anchor.getAttribute('href'));

    expect(hrefs).toEqual([VIDEO, DEMO, REPOSITORY]);
  });

  it('gives each link a distinct accessible name that states its purpose', () => {
    const document = documentOf(render(populated));

    const names = [...document.querySelectorAll('.project-links-section a')]
      .map((anchor) => anchor.textContent?.replace(/\s+/g, ' ').trim());

    expect(names).toEqual([
      'Open video (opens in a new tab)',
      'Open live demo / prototype (opens in a new tab)',
      'Open repository (opens in a new tab)',
    ]);
    expect(new Set(names).size).toBe(3);
  });

  it('uses the existing safe target/rel pattern on every controlled link', () => {
    const document = documentOf(render(populated));

    for (const anchor of document.querySelectorAll('.project-links-section a')) {
      expect(anchor.getAttribute('target')).toBe('_blank');
      expect(anchor.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    }
  });

  it('places the links before the response controls in DOM order', () => {
    const html = render(populated);
    const document = documentOf(html);

    const links = document.querySelector('.project-links-section');
    const response = document.querySelector('.response-column');

    expect(links).not.toBeNull();
    expect(response).not.toBeNull();
    // Node.DOCUMENT_POSITION_FOLLOWING === 4: the response column follows the evidence.
    expect(links!.compareDocumentPosition(response!) & 4).toBe(4);

    expect(html.indexOf('id="project-links-heading"')).toBeLessThan(html.indexOf('Your Response'));
  });

  it('never embeds a video or introduces an iframe for a controlled link', () => {
    const document = documentOf(render(populated));

    expect(document.querySelectorAll('iframe')).toHaveLength(0);
    expect(document.querySelectorAll('video')).toHaveLength(0);
    expect(document.querySelectorAll('[autoplay]')).toHaveLength(0);
  });

  it('omits the whole section, with no empty anchors, when no controlled link exists', () => {
    const document = documentOf(render());

    expect(document.querySelector('.project-links-section')).toBeNull();
    expect(document.querySelector('#project-links-heading')).toBeNull();

    for (const anchor of document.querySelectorAll('a')) {
      expect(anchor.textContent?.trim()).not.toBe('');
    }
  });

  it('renders only the links that exist', () => {
    const document = documentOf(render({ demoUrl: DEMO }));

    const anchors = [...document.querySelectorAll('.project-links-section a')];

    expect(anchors).toHaveLength(1);
    expect(anchors[0].getAttribute('href')).toBe(DEMO);
    expect(document.querySelector('.project-links-section')!.textContent).toContain('Live demo / prototype');
    expect(document.querySelector('.project-links-section')!.textContent).not.toContain('Repository');
  });

  it('reads a historical snapshot that has none of the three keys', () => {
    const historical = snapshot();
    delete historical.videoUrl;
    delete historical.demoUrl;
    delete historical.repositoryUrl;

    const html = renderParticipantPreviewPage({
      snapshot: historical,
      media,
      responseState: { type: 'unresponded' },
    });

    expect(documentOf(html).querySelector('.project-links-section')).toBeNull();
    expect(html).toContain('Your Response');
  });
});

describe('fail-closed rendering of tampered controlled-link evidence', () => {
  it.each([
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['credentials', 'https://user:secret@evil.example.com/x'],
    ['WHATWG-repairable empty authority', 'https:///evil.example.com'],
    ['backslash authority', 'https:\\evil.example.com/x'],
    ['whitespace', 'https://example.com/a b'],
    ['empty string', ''],
    ['relative', '/local/demo'],
  ])('refuses to render a %s value rather than dropping it', (_label, value) => {
    expect(() => render({ videoUrl: value })).toThrow(ParticipantPreviewEvidenceError);
    expect(() => render({ demoUrl: value })).toThrow(ParticipantPreviewEvidenceError);
    expect(() => render({ repositoryUrl: value })).toThrow(ParticipantPreviewEvidenceError);
  });

  it('never produces an unsafe href for a tampered value', () => {
    let html = '';

    try {
      html = render({ videoUrl: 'javascript:alert(1)' });
    } catch {
      html = '';
    }

    expect(html).toBe('');
  });

  it('does not let a participant confirm evidence with one field silently removed', () => {
    // The whole page fails rather than rendering two of three links plus confirm controls.
    expect(() => render({ ...populated, demoUrl: 'javascript:alert(1)' }))
      .toThrow(ParticipantPreviewEvidenceError);
  });

  it('leaves the unrelated generic external-links behaviour untouched', () => {
    // A generic external link that is not a controlled project link keeps its existing
    // degrade-to-text handling and must not start throwing.
    const document = documentOf(render({
      externalLinks: [{ label: 'Unsafe', url: 'javascript:alert(1)' }],
    }));

    expect(document.querySelector('.unsafe-link-text')?.textContent).toBe('Unsafe');
    expect(document.querySelector('.response-column')).not.toBeNull();
  });
});
