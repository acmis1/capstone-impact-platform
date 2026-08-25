import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

import type {
  ParticipantPreviewMediaViewRef,
  ParticipantPreviewSnapshot,
} from '../domain/participantPreview';
import {
  ParticipantPreviewMediaAccessibilityError,
  renderParticipantPreviewPage,
} from './participantPreviewHtml';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom') as {
  JSDOM: new (html: string) => { window: { document: Document } };
};

const POSTER_ALT = 'Poster showing a synthetic system architecture diagram beside a results table.';
const SNAPSHOT_ALT = 'Screenshot of the mock operator console with three active sensor feeds.';

const snapshot = (overrides: Partial<ParticipantPreviewSnapshot> = {}): ParticipantPreviewSnapshot => ({
  title: 'Synthetic Project', summary: null, background: null, solution: null, year: 2026,
  program: null, studyProgram: null, discipline: null, disciplines: [], industry: null,
  industryPartner: null, academicSupervisor: null, groupName: null, teamMembers: [],
  posterText: 'Poster full text.', accessibilityText: POSTER_ALT,
  citations: [], externalLinks: [], industryCategories: [],
  ...overrides,
});

const media = (overrides: Partial<ParticipantPreviewMediaViewRef> = {}): ParticipantPreviewMediaViewRef => ({
  mediaAssetId: 'm1', assetType: 'poster_image', galleryPosition: null, fileName: 'poster.png', mimeType: 'image/png',
  altText: null, signedUrl: 'https://signed.invalid/poster.png',
  ...overrides,
});

const render = (
  mediaRefs: ParticipantPreviewMediaViewRef[],
  snapshotOverrides: Partial<ParticipantPreviewSnapshot> = {},
) => renderParticipantPreviewPage({
  snapshot: snapshot(snapshotOverrides),
  media: mediaRefs,
  responseState: { type: 'unresponded' },
});

const altAttributes = (html: string) => [...html.matchAll(/<img[^>]*\balt="([^"]*)"/g)].map((m) => m[1]);

describe('participant-facing image alt attributes', () => {
  it('uses the snapshotted project accessibility text for the poster image', () => {
    const html = render([media()]);
    expect(altAttributes(html)).toEqual([POSTER_ALT]);
  });

  it('uses the snapshotted media alt text for the snapshot image', () => {
    const html = render([media({
      mediaAssetId: 'm2', assetType: 'snapshot_image', fileName: 'snapshot-1.png',
      altText: SNAPSHOT_ALT, signedUrl: 'https://signed.invalid/snapshot-1.png',
    })]);
    expect(altAttributes(html)).toEqual([SNAPSHOT_ALT]);
  });

  it('gives each image its own description when both are present', () => {
    const html = render([
      media(),
      media({
        mediaAssetId: 'm2', assetType: 'snapshot_image', fileName: 'snapshot-1.png',
        altText: SNAPSHOT_ALT, signedUrl: 'https://signed.invalid/snapshot-1.png',
      }),
    ]);
    expect(altAttributes(html)).toEqual([POSTER_ALT, SNAPSHOT_ALT]);
  });

  it('assigns poster and snapshot images to distinct semantic presentation groups', () => {
    const html = render([
      media(),
      media({
        mediaAssetId: 'm2', assetType: 'snapshot_image', fileName: 'snapshot-1.png',
        altText: SNAPSHOT_ALT, signedUrl: 'https://signed.invalid/snapshot-1.png',
      }),
    ]);
    const document = new JSDOM(html).window.document;

    expect(document.querySelector('[data-media-kind="poster"] figcaption')?.textContent).toBe('Project poster');
    expect(document.querySelector('[data-media-kind="snapshot"] figcaption')?.textContent).toBe('Supporting project image 1');
    expect(document.querySelector('[data-media-kind="poster"] img')?.getAttribute('alt')).toBe(POSTER_ALT);
    expect(document.querySelector('[data-media-kind="snapshot"] img')?.getAttribute('alt')).toBe(SNAPSHOT_ALT);
  });

  it('never falls back to the filename', () => {
    const html = render([media({
      mediaAssetId: 'm2', assetType: 'snapshot_image', fileName: 'snapshot-1.png',
      altText: SNAPSHOT_ALT, signedUrl: 'https://signed.invalid/snapshot-1.png',
    })]);
    expect(altAttributes(html)).not.toContain('snapshot-1.png');
    expect(html).not.toContain('alt="Preview of snapshot-1.png"');
    // The filename may still appear as ordinary file information, just never as the alt attribute.
  });

  it('never falls back to the project title', () => {
    const html = render([media({
      mediaAssetId: 'm2', assetType: 'snapshot_image', fileName: 'snapshot-1.png',
      altText: SNAPSHOT_ALT, signedUrl: 'https://signed.invalid/snapshot-1.png',
    })]);
    expect(altAttributes(html)).not.toContain('Synthetic Project');
  });

  it('fails closed when a snapshot image carries no stored alt text', () => {
    expect(() => render([media({
      mediaAssetId: 'm2', assetType: 'snapshot_image', fileName: 'snapshot-1.png',
      altText: null, signedUrl: 'https://signed.invalid/snapshot-1.png',
    })])).toThrow(ParticipantPreviewMediaAccessibilityError);
  });

  it('fails closed when a snapshot image carries a blank alt text', () => {
    expect(() => render([media({
      mediaAssetId: 'm2', assetType: 'snapshot_image', fileName: 'snapshot-1.png',
      altText: '   ', signedUrl: 'https://signed.invalid/snapshot-1.png',
    })])).toThrow(ParticipantPreviewMediaAccessibilityError);
  });

  it('fails closed when the poster has no snapshotted accessibility text', () => {
    expect(() => render([media()], { accessibilityText: null }))
      .toThrow(ParticipantPreviewMediaAccessibilityError);
  });

  it('does not require alt text for a non-image asset', () => {
    const html = render([media({
      mediaAssetId: 'm3', assetType: 'poster_pdf', fileName: 'poster.pdf',
      mimeType: 'application/pdf', altText: null, signedUrl: 'https://signed.invalid/poster.pdf',
    })]);
    expect(altAttributes(html)).toEqual([]);
    expect(html).toContain('poster.pdf');
  });

  it('renders a document as an accessible secured media asset rather than a loose URL', () => {
    const html = render([media({
      mediaAssetId: 'm3', assetType: 'poster_pdf', fileName: 'poster.pdf',
      mimeType: 'application/pdf', altText: null, signedUrl: 'https://signed.invalid/poster.pdf?private=value',
    })]);
    const document = new JSDOM(html).window.document;
    const link = document.querySelector('a[data-media-kind="document"]');

    expect(link?.textContent).toContain('poster.pdf');
    expect(link?.textContent).toContain('Open document in a new tab');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    expect(document.body.textContent).not.toContain('private=value');
  });

  it('escapes markup in a snapshot alt text so it cannot inject into the page', () => {
    const html = render([media({
      mediaAssetId: 'm2', assetType: 'snapshot_image', fileName: 'snapshot-1.png',
      altText: '"><script>alert(1)</script>', signedUrl: 'https://signed.invalid/snapshot-1.png',
    })]);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('escapes markup in the poster accessibility text as well', () => {
    const html = render([media()], { accessibilityText: '<img src=x onerror=alert(1)>' });
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});
