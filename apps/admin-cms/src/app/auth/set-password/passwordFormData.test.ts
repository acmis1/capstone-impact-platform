import { describe, it, expect } from 'vitest';
import { canonicalizePasswordFormData, dispatchCanonicalPasswordFormData } from './passwordFormData';

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

describe('dispatchCanonicalPasswordFormData runtime behavior', () => {
  it('should canonicalize inputs, call the dispatcher exactly once, and propagate async results', async () => {
    let callCount = 0;
    let passedData: FormData | null = null;

    const mockDispatcher = async (data: FormData) => {
      callCount++;
      passedData = data;
      return { success: true };
    };

    const form = new FormData();
    form.append('password', '  complexPassword!123 ');

    const fallback = {
      password: 'fallbackPassword',
      confirmation: 'fallbackConfirmation'
    };

    const result = await dispatchCanonicalPasswordFormData(form, fallback, mockDispatcher);

    expect(callCount).toBe(1);
    expect(result).toEqual({ success: true });
    expect(passedData).not.toBeNull();
    expect(passedData!.get('password')).toBe('  complexPassword!123 ');
    expect(passedData!.get('confirmation')).toBe('fallbackConfirmation');
    expect(passedData!.getAll('password')).toHaveLength(1);
    expect(passedData!.getAll('confirmation')).toHaveLength(1);
  });

  it('should propagate dispatcher rejections', async () => {
    const mockDispatcher = async () => {
      throw new Error('Async network failure');
    };

    const form = new FormData();
    await expect(
      dispatchCanonicalPasswordFormData(form, {}, mockDispatcher)
    ).rejects.toThrow('Async network failure');
  });
});
