// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createLayoutConfigFromStock } from '../../domain/layoutConfig';
import { LayoutRecipePreview } from './LayoutRecipePreview';

describe('LayoutRecipePreview', () => {
  afterEach(() => cleanup());

  it('renders three visibly distinct synthetic presets with fixed regions and no executable media', () => {
    const { rerender } = render(<LayoutRecipePreview config={createLayoutConfigFromStock('poster_showcase')} />);
    const preview = () => document.querySelector('[data-preset]') as HTMLElement;
    expect(preview().dataset.preset).toBe('poster_showcase');
    expect(preview().className.split(' ')).toContain('layout-preset-poster_showcase');

    rerender(<LayoutRecipePreview config={createLayoutConfigFromStock('technical_detail')} />);
    expect(preview().dataset.preset).toBe('technical_detail');
    expect(preview().className.split(' ')).toContain('layout-preset-technical_detail');
    rerender(<LayoutRecipePreview config={createLayoutConfigFromStock('media_rich')} />);
    expect(preview().dataset.preset).toBe('media_rich');
    expect(preview().className.split(' ')).toContain('layout-preset-media_rich');

    expect(screen.getByText(/Synthetic illustrative content only/i)).toBeTruthy();
    expect(screen.getByText(/Required summary region/i)).toBeTruthy();
    expect(screen.getByText(/Fixed poster region/i)).toBeTruthy();
    expect(screen.getAllByText(/Team & group/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Poster accessibility description/i).length).toBeGreaterThan(0);
    expect(document.querySelector('iframe')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('svg')).toBeNull();
  });

  it('applies order, hide, feature, and fallback presentation rules immediately', () => {
    const config = createLayoutConfigFromStock('poster_showcase');
    config.featuredMedia = 'snapshots';
    config.hiddenSections = ['background', 'solution', 'video', 'links', 'citations'];
    config.sectionOrder = ['citations', 'accessibilityText', 'team', 'snapshots', 'links', 'solution', 'background', 'video'];
    render(<LayoutRecipePreview config={config} />);

    expect(document.querySelector('[data-layout-region="featured"][data-featured-media="snapshots"]')).toBeTruthy();
    expect(document.querySelector('[data-layout-region="ordered"] [data-layout-section="snapshots"]')).toBeNull();
    expect(document.querySelector('[data-layout-section="background"]')).toBeNull();
    expect(document.querySelector('[data-layout-section="solution"]')).toBeNull();
    expect(document.querySelector('[data-layout-section="video"]')).toBeNull();
    expect(screen.getByText(/falls back to available video/i)).toBeTruthy();
  });
});
