// @vitest-environment jsdom

import fs from 'node:fs';
import path from 'node:path';
import * as React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  responses: [] as Array<{ element: React.ReactElement; options: { width: number; height: number } }>,
}));

vi.mock('next/og', () => ({
  ImageResponse: class MockImageResponse {
    element: React.ReactElement;
    options: { width: number; height: number };

    constructor(element: React.ReactElement, options: { width: number; height: number }) {
      this.element = element;
      this.options = options;
      mocks.responses.push(this);
    }
  },
}));

import Icon, { contentType, size } from '../../app/icon';
import { AppMark } from './app-mark';
import {
  APP_MARK_ICON_COLORS,
  APP_MARK_PATHS,
  APP_MARK_VIEW_BOX,
} from './app-mark-geometry';

function luminance(hex: string): number {
  const channels = hex.slice(1).match(/.{2}/g)!.map((channel) => Number.parseInt(channel, 16) / 255);
  return channels
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
    .reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

function contrast(first: string, second: string): number {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

beforeEach(() => {
  mocks.responses.length = 0;
});

afterEach(() => cleanup());

describe('Capstone Impact application mark', () => {
  it('uses shared custom geometry without font-dependent glyphs or external assets', () => {
    const { container } = render(
      <div aria-label="Capstone Impact identity">
        <AppMark size="lg" />
        <span>Capstone Impact Platform</span>
      </div>,
    );

    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('viewBox')).toBe(APP_MARK_VIEW_BOX);
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('focusable')).toBe('false');
    expect([...container.querySelectorAll('path')].map((node) => node.getAttribute('d'))).toEqual(
      [...APP_MARK_PATHS],
    );
    expect(container.querySelector('text')).toBeNull();
    expect(container.querySelector('image')).toBeNull();
    expect(screen.getAllByText('Capstone Impact Platform')).toHaveLength(1);
  });

  it('generates the 32 by 32 browser icon from the same geometry', () => {
    Icon();
    const response = mocks.responses.at(-1)!;

    expect(size).toEqual({ width: 32, height: 32 });
    expect(contentType).toBe('image/png');
    expect(response.options).toEqual(size);

    const { container } = render(response.element);
    expect(container.querySelector('svg')?.getAttribute('viewBox')).toBe(APP_MARK_VIEW_BOX);
    expect([...container.querySelectorAll('path')].map((node) => node.getAttribute('d'))).toEqual(
      [...APP_MARK_PATHS],
    );
    expect(container.querySelector('text')).toBeNull();
    expect(container.querySelector('image')).toBeNull();
  });

  it('keeps the icon colour aligned with the primary token and above 4.5 to 1 contrast', () => {
    const globals = fs.readFileSync(path.resolve(__dirname, '../../app/globals.css'), 'utf8');
    const primary = globals.match(/--primary:\s*(#[0-9a-f]{6})/i)?.[1];
    const primaryForeground = globals.match(/--primary-foreground:\s*(#[0-9a-f]{6})/i)?.[1];

    expect(primary).toBe(APP_MARK_ICON_COLORS.background);
    expect(primaryForeground).toBe(APP_MARK_ICON_COLORS.foreground);
    expect(contrast(APP_MARK_ICON_COLORS.background, APP_MARK_ICON_COLORS.foreground)).toBeGreaterThanOrEqual(4.5);
  });
});
