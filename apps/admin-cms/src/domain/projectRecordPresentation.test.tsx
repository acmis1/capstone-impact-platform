import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { layoutSectionList, layoutTemplateLabel, featuredMediaLabel } from './projectRecordPresentation';
import { createLayoutConfigFromStock } from './layoutConfig';
import { resolveEffectiveFeaturedMedia } from './layoutPresentation';
import { auditActionLabel } from '../components/admin/ProjectAuditHistory';
import { RecordTimestamp } from '../components/ui/record-timestamp';

describe('staff-facing record presentation', () => {
  it('uses friendly layout labels and explicit empty/unknown states', () => {
    expect(layoutTemplateLabel('poster_showcase')).toBe('Poster showcase');
    expect(layoutTemplateLabel('constructor')).toBe('Not recorded');
    expect(featuredMediaLabel('auto')).toBe('Automatic fallback');
    expect(layoutSectionList([])).toBe('None');
    expect(layoutSectionList(['background', 'solution'])).toBe('Project background / motivation, Solution & impact');
  });
  it('labels every currently supported audit action', () => {
    for (const action of ['approve', 'request_changes', 'archive', 'publish', 'unpublish', 'restore', 'soft_delete', 'update_metadata', 'submit_for_review', 'update_layout', 'project_recovery']) {
      const label = auditActionLabel(action);
      expect(label).not.toContain('_');
      expect(label[0]).toBe(label[0].toUpperCase());
    }
  });
  it('renders explicit UTC with exact source time retained, and no invalid time element', () => {
    const at = '2026-09-18T12:00:00.123456+00:00';
    const html = renderToStaticMarkup(<RecordTimestamp value={at} />);
    expect(html).toContain('<time');
    expect(html).toContain(' UTC</time>');
    expect(html).toContain(at);
    expect(renderToStaticMarkup(<RecordTimestamp value="invalid" />)).not.toContain('<time');
  });
  it('does not feature hidden video and keeps the public renderer poster-only fallback', () => {
    const config = createLayoutConfigFromStock('media_rich');
    config.featuredMedia = 'auto';
    config.hiddenSections = ['video'];
    expect(resolveEffectiveFeaturedMedia(config)).toBe('snapshots');
    config.featuredMedia = 'none';
    expect(resolveEffectiveFeaturedMedia(config)).toBeNull();
    expect(resolveEffectiveFeaturedMedia(config, { poster: true, video: false, snapshots: false })).toBe('poster');
    expect(resolveEffectiveFeaturedMedia(config, { poster: false, video: false, snapshots: false })).toBeNull();
  });
});
