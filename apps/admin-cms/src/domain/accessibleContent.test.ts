import { describe, expect, it } from 'vitest';
import {
  ACCESSIBLE_CONTENT_LIMITS,
  describeAccessibleContentProblem,
  getAccessibleContentProblem,
  isAccessibleContentPresent,
  isAccessibleContentWithinLimit,
} from './accessibleContent';

/**
 * This helper is the single source of accessible-content validity for the import staging boundary,
 * review readiness, approval validation and public-feed validation, and its limits are mirrored by
 * Migration 0025. If it drifts, those boundaries drift apart silently.
 */
describe('accessible content validity', () => {
  it('treats absent, blank and whitespace-only values as missing', () => {
    for (const value of [undefined, null, '', '   ', '\n\t ']) {
      expect(isAccessibleContentPresent(value)).toBe(false);
      expect(getAccessibleContentProblem(value, 'posterText')).toBe('MISSING');
    }
  });

  it('permits absence only when the value is explicitly optional', () => {
    expect(getAccessibleContentProblem(null, 'posterText', { required: false })).toBeNull();
    expect(getAccessibleContentProblem(null, 'posterText')).toBe('MISSING');
  });

  it('measures the bound against the trimmed value that would actually be persisted', () => {
    const atLimit = 'x'.repeat(ACCESSIBLE_CONTENT_LIMITS.posterText);
    expect(isAccessibleContentWithinLimit(`   ${atLimit}   `, 'posterText')).toBe(true);
    expect(getAccessibleContentProblem(`   ${atLimit}   `, 'posterText')).toBeNull();
    expect(getAccessibleContentProblem(`   ${atLimit}x   `, 'posterText')).toBe('TOO_LONG');
  });

  it.each([
    ['posterText' as const, ACCESSIBLE_CONTENT_LIMITS.posterText],
    ['accessibilityText' as const, ACCESSIBLE_CONTENT_LIMITS.accessibilityText],
  ])('accepts %s exactly at the ceiling and rejects one more character', (field, limit) => {
    expect(getAccessibleContentProblem('x'.repeat(limit), field)).toBeNull();
    expect(getAccessibleContentProblem('x'.repeat(limit + 1), field)).toBe('TOO_LONG');
  });

  it('keeps the two ceilings independent of one another', () => {
    const overAccessibility = 'x'.repeat(ACCESSIBLE_CONTENT_LIMITS.accessibilityText + 1);
    expect(getAccessibleContentProblem(overAccessibility, 'accessibilityText')).toBe('TOO_LONG');
    // The same string is comfortably within the much larger poster-text ceiling.
    expect(getAccessibleContentProblem(overAccessibility, 'posterText')).toBeNull();
  });

  it('reports absence and oversize as distinct, bounded staff-facing reasons', () => {
    expect(describeAccessibleContentProblem('MISSING', 'posterText')).toBe('Poster full text is missing.');
    expect(describeAccessibleContentProblem('TOO_LONG', 'posterText'))
      .toBe('Poster full text exceeds the 20,000 character safety limit.');
    expect(describeAccessibleContentProblem('MISSING', 'accessibilityText')).toBe('Accessibility text is missing.');
    expect(describeAccessibleContentProblem('TOO_LONG', 'accessibilityText'))
      .toBe('Accessibility text exceeds the 2,000 character safety limit.');
  });

  it('applies no content-quality judgement of any kind', () => {
    // A single character, a repeated word, and prose unrelated to any other field are all valid.
    // Presence and bounds are the only rules; staff own whether the text is any good.
    expect(getAccessibleContentProblem('x', 'posterText')).toBeNull();
    expect(getAccessibleContentProblem('the the the the', 'accessibilityText')).toBeNull();
    expect(getAccessibleContentProblem('完全に無関係なテキスト', 'posterText')).toBeNull();
  });

  it('ignores non-string values rather than guessing at them', () => {
    expect(isAccessibleContentWithinLimit(undefined, 'posterText')).toBe(true);
    expect(isAccessibleContentPresent(undefined)).toBe(false);
  });
});
