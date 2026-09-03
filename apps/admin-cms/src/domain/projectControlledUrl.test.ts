import { describe, expect, it } from 'vitest';

import {
  PROJECT_CONTROLLED_URL_MAX_LENGTH,
  validateProjectControlledUrl,
} from './projectControlledUrl';

describe('validateProjectControlledUrl', () => {
  it('accepts a valid HTTPS URL', () => {
    expect(validateProjectControlledUrl('https://example.com/demo')).toEqual({
      valid: true,
      url: 'https://example.com/demo',
    });
  });

  it('accepts a valid HTTP URL because the existing public contract allows HTTP(S)', () => {
    expect(validateProjectControlledUrl('http://example.com/demo')).toEqual({
      valid: true,
      url: 'http://example.com/demo',
    });
  });

  it('trims surrounding whitespace from a valid URL', () => {
    expect(validateProjectControlledUrl('  https://example.com/demo  ')).toEqual({
      valid: true,
      url: 'https://example.com/demo',
    });
  });

  it('reports blank input', () => {
    expect(validateProjectControlledUrl('   ')).toEqual({
      valid: false,
      reason: 'BLANK',
    });
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,test',
    'file:///tmp/demo',
  ])('rejects unsafe scheme: %s', (value) => {
    expect(validateProjectControlledUrl(value)).toEqual({
      valid: false,
      reason: 'UNSAFE_SCHEME',
    });
  });

  it('rejects a malformed or relative URL', () => {
    expect(validateProjectControlledUrl('/local/demo')).toEqual({
      valid: false,
      reason: 'MALFORMED',
    });
  });

  it('rejects embedded credentials', () => {
    expect(
      validateProjectControlledUrl('https://user:secret@example.com/demo'),
    ).toEqual({
      valid: false,
      reason: 'CREDENTIALS',
    });
  });

  it('rejects an overlong raw value before trimming', () => {
    const value =
      ' '.repeat(PROJECT_CONTROLLED_URL_MAX_LENGTH) +
      'https://example.com';

    expect(validateProjectControlledUrl(value)).toEqual({
      valid: false,
      reason: 'TOO_LONG',
    });
  });
  it.each([
    'https://example.com/a b',
    'https://example.com/a\tb',
    'https://example.com/a\nb',
    ])('rejects unsafe whitespace/control characters: %s', (value) => {
    expect(validateProjectControlledUrl(value)).toEqual({
        valid: false,
        reason: 'UNSAFE_CHARACTERS',
        });
    });
});