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

describe('representative preview ordering and content availability', () => {
  afterEach(cleanup);
  it('keeps gallery/video at their exact configured positions when not featured', () => {
    const config = createLayoutConfigFromStock('poster_showcase');
    config.featuredMedia = 'none';
    config.sectionOrder = ['video', 'snapshots', 'team', 'background', 'solution', 'links', 'citations', 'accessibilityText'];
    render(<LayoutRecipePreview config={config} />);
    expect(Array.from(document.querySelectorAll('[data-layout-region="ordered"] > [data-layout-section]')).map(e => e.getAttribute('data-layout-section'))).toEqual(config.sectionOrder);
  });
  it('shows absent-content fallback and keeps required text when using a poster-only example', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const config = createLayoutConfigFromStock('media_rich');
    config.featuredMedia = 'video';
    render(<LayoutRecipePreview config={config} />);
    fireEvent.change(screen.getByLabelText('Example content'), { target: { value: 'poster-only' } });
    expect(document.querySelector('[data-featured-media="poster"]')).toBeTruthy();
    expect(document.querySelector('[data-layout-section="background"]')).toBeNull();
    expect(document.querySelector('[data-layout-section="snapshots"]')).toBeNull();
    expect(document.querySelector('[data-layout-section="team"]')).toBeTruthy();
    expect(document.querySelector('[data-layout-section="accessibilityText"]')).toBeTruthy();
    expect(screen.getByText(/Required summary region/)).toBeTruthy();
  });
});
