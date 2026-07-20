import { describe, it, expect } from 'vitest';
import { canonicalizePasswordFormData } from './passwordFormData';

describe('canonicalizePasswordFormData runtime behavior', () => {
  it('should retain native non-empty string values and give them precedence', () => {
    const form = new FormData();
    form.append('password', 'NativePass123!');
    form.append('confirmation', 'NativePass123!');

    const result = canonicalizePasswordFormData(form, {
      password: 'FallbackPass',
      confirmation: 'FallbackPass'
    });

    expect(result.get('password')).toBe('NativePass123!');
    expect(result.get('confirmation')).toBe('NativePass123!');
    expect(result.getAll('password')).toHaveLength(1);
    expect(result.getAll('confirmation')).toHaveLength(1);
  });

  it('should fall back to controlled state when native keys are absent', () => {
    const form = new FormData();
    const result = canonicalizePasswordFormData(form, {
      password: 'FallbackPass',
      confirmation: 'FallbackPass'
    });

    expect(result.get('password')).toBe('FallbackPass');
    expect(result.get('confirmation')).toBe('FallbackPass');
  });

  it('should fall back to controlled state when native keys are empty strings', () => {
    const form = new FormData();
    form.append('password', '');
    form.append('confirmation', '');

    const result = canonicalizePasswordFormData(form, {
      password: 'FallbackPass',
      confirmation: 'FallbackPass'
    });

    expect(result.get('password')).toBe('FallbackPass');
    expect(result.get('confirmation')).toBe('FallbackPass');
  });

  it('should fall back safely when native entries are File objects', () => {
    const form = new FormData();
    form.append('password', new File([], 'passwd.txt'));
    form.append('confirmation', new File([], 'passwd.txt'));

    const result = canonicalizePasswordFormData(form, {
      password: 'FallbackPass',
      confirmation: 'FallbackPass'
    });

    expect(result.get('password')).toBe('FallbackPass');
    expect(result.get('confirmation')).toBe('FallbackPass');
  });

  it('should preserve spaces, casing, punctuation, and Unicode exactly', () => {
    const form = new FormData();
    const complexFallback = {
      password: '  Complex Casing! 🌟 ',
      confirmation: '  Complex Casing! 🌟 '
    };

    const result = canonicalizePasswordFormData(form, complexFallback);

    expect(result.get('password')).toBe('  Complex Casing! 🌟 ');
    expect(result.get('confirmation')).toBe('  Complex Casing! 🌟 ');
  });

  it('should result in empty strings when both native and fallback are missing', () => {
    const form = new FormData();
    const result = canonicalizePasswordFormData(form, {});

    expect(result.get('password')).toBe('');
    expect(result.get('confirmation')).toBe('');
  });

  it('should preserve other non-password fields from the original FormData', () => {
    const form = new FormData();
    form.append('other_field', 'someValue');

    const result = canonicalizePasswordFormData(form, {
      password: 'pass',
      confirmation: 'pass'
    });

    expect(result.get('other_field')).toBe('someValue');
    expect(result.get('password')).toBe('pass');
  });
});
