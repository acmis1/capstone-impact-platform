import { describe, expect, it } from 'vitest';

import {
  PARTICIPANT_PREVIEW_COLORS,
  renderParticipantPreviewPage,
} from './participantPreviewHtml';

type Rgb = { red: number; green: number; blue: number };

function hexToRgb(value: string): Rgb {
  const normalized = value.replace('#', '');
  return {
    red: Number.parseInt(normalized.slice(0, 2), 16),
    green: Number.parseInt(normalized.slice(2, 4), 16),
    blue: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

function relativeLuminance(value: string): number {
  const { red, green, blue } = hexToRgb(value);
  const linearize = (channel: number) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linearize(red) + 0.7152 * linearize(green) + 0.0722 * linearize(blue);
}

function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('participant preview rendered color contrast', () => {
  it('meets normal-text contrast for every important static text/background combination', () => {
    const textPairs = [
      ['primary text on page', PARTICIPANT_PREVIEW_COLORS['text-primary'], PARTICIPANT_PREVIEW_COLORS['page-background']],
      ['primary text on surface', PARTICIPANT_PREVIEW_COLORS['text-primary'], PARTICIPANT_PREVIEW_COLORS.surface],
      ['secondary text on page', PARTICIPANT_PREVIEW_COLORS['text-secondary'], PARTICIPANT_PREVIEW_COLORS['page-background']],
      ['secondary text on surface', PARTICIPANT_PREVIEW_COLORS['text-secondary'], PARTICIPANT_PREVIEW_COLORS.surface],
      ['muted text on page', PARTICIPANT_PREVIEW_COLORS['text-muted'], PARTICIPANT_PREVIEW_COLORS['page-background']],
      ['muted text on surface', PARTICIPANT_PREVIEW_COLORS['text-muted'], PARTICIPANT_PREVIEW_COLORS.surface],
      ['private-preview label', PARTICIPANT_PREVIEW_COLORS['private-text'], PARTICIPANT_PREVIEW_COLORS['brand-soft']],
      ['private-preview notice', PARTICIPANT_PREVIEW_COLORS['notice-text'], PARTICIPANT_PREVIEW_COLORS['notice-background']],
      ['confirmation button', PARTICIPANT_PREVIEW_COLORS.white, PARTICIPANT_PREVIEW_COLORS.brand],
      ['confirmation button hover', PARTICIPANT_PREVIEW_COLORS.white, PARTICIPANT_PREVIEW_COLORS['brand-hover']],
      ['correction action and external link', PARTICIPANT_PREVIEW_COLORS.link, PARTICIPANT_PREVIEW_COLORS.surface],
      ['confirmed outcome', PARTICIPANT_PREVIEW_COLORS['success-text'], PARTICIPANT_PREVIEW_COLORS['success-background']],
      ['correction-request outcome', PARTICIPANT_PREVIEW_COLORS['warning-text'], PARTICIPANT_PREVIEW_COLORS['warning-background']],
      ['unavailable-page text', PARTICIPANT_PREVIEW_COLORS['text-secondary'], PARTICIPANT_PREVIEW_COLORS.surface],
    ] as const;

    for (const [name, foreground, background] of textPairs) {
      expect(contrastRatio(foreground, background), name).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('meets non-text contrast for focus and meaningful control boundaries', () => {
    const uiPairs = [
      ['focus ring on page', PARTICIPANT_PREVIEW_COLORS.focus, PARTICIPANT_PREVIEW_COLORS['page-background']],
      ['focus ring on surface', PARTICIPANT_PREVIEW_COLORS.focus, PARTICIPANT_PREVIEW_COLORS.surface],
      ['focus ring beside primary action', PARTICIPANT_PREVIEW_COLORS.focus, PARTICIPANT_PREVIEW_COLORS['brand-soft']],
      ['strong control border on surface', PARTICIPANT_PREVIEW_COLORS['border-strong'], PARTICIPANT_PREVIEW_COLORS.surface],
      ['primary action boundary on surface', PARTICIPANT_PREVIEW_COLORS.brand, PARTICIPANT_PREVIEW_COLORS.surface],
    ] as const;

    for (const [name, foreground, background] of uiPairs) {
      expect(contrastRatio(foreground, background), name).toBeGreaterThanOrEqual(3);
    }
  });

  it('renders the tested palette through participant-page CSS custom properties', () => {
    const html = renderParticipantPreviewPage({
      snapshot: {
        title: 'Contrast fixture', summary: null, background: null, solution: null, year: 2026,
        program: null, studyProgram: null, discipline: null, disciplines: [], industry: null,
        industryPartner: null, academicSupervisor: null, groupName: null, teamMembers: [],
        posterText: null, accessibilityText: null, citations: [], externalLinks: [], industryCategories: [],
      },
      media: [],
      responseState: { type: 'unresponded' },
    });

    for (const [name, value] of Object.entries(PARTICIPANT_PREVIEW_COLORS)) {
      expect(html).toContain(`--color-${name}: ${value};`);
    }
  });
});
