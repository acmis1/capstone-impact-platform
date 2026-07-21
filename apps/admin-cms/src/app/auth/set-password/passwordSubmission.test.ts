import { describe, it, expect } from 'vitest';
import { resolvePasswordInputs, isRedirectError } from './passwordSubmission';

describe('passwordSubmission helpers', () => {
  it('should prefer non-empty DOM values over state fallback', () => {
    const res = resolvePasswordInputs({
      domPassword: 'DomPassword123!',
      domConfirmation: 'DomConfirmation123!',
      statePassword: 'StatePassword123!',
      stateConfirmation: 'StateConfirmation123!',
    });

    expect(res.password).toBe('DomPassword123!');
    expect(res.confirmation).toBe('DomConfirmation123!');
  });

  it('should fall back to state when DOM values are empty or undefined', () => {
    const res = resolvePasswordInputs({
      domPassword: '',
      domConfirmation: undefined,
      statePassword: 'StatePassword123!',
      stateConfirmation: 'StateConfirmation123!',
    });

    expect(res.password).toBe('StatePassword123!');
    expect(res.confirmation).toBe('StateConfirmation123!');
  });

  it('should preserve spaces, punctuation, and Unicode without trimming or normalizing', () => {
    const rawPass = '  P@ssw0rd  🔑  ';
    const rawConf = '  P@ssw0rd  🔑  ';

    const res = resolvePasswordInputs({
      domPassword: rawPass,
      domConfirmation: rawConf,
    });

    expect(res.password).toBe(rawPass);
    expect(res.confirmation).toBe(rawConf);
  });

  it('should correctly identify Next.js redirect errors', () => {
    const redirectErr = { digest: 'NEXT_REDIRECT;replace;/login?status=PASSWORD_SET;307;' };
    const normalErr = new Error('Random failure');

    expect(isRedirectError(redirectErr)).toBe(true);
    expect(isRedirectError(normalErr)).toBe(false);
    expect(isRedirectError(null)).toBe(false);
    expect(isRedirectError('string error')).toBe(false);
  });

  it('should enforce synchronous submission lock behavior', async () => {
    let lock = false;
    let calls = 0;

    const executeSubmission = async (action: () => Promise<void>) => {
      if (lock) return;
      lock = true;
      try {
        calls++;
        await action();
      } finally {
        lock = false;
      }
    };

    const slowAction = () => new Promise<void>((resolve) => setTimeout(resolve, 50));

    // First trigger locks submission
    const p1 = executeSubmission(slowAction);
    // Second concurrent trigger should be blocked by synchronous lock
    const p2 = executeSubmission(slowAction);

    await Promise.all([p1, p2]);

    expect(calls).toBe(1);
  });
});
