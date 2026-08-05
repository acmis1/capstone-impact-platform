import { describe, it, expect, vi } from 'vitest';
import { runDiffCheck } from './checkDiffWhitespace';

describe('checkDiffWhitespace Unit Tests', () => {
  it('1. Executes PR diff check when eventName is pull_request and SHAs are present', () => {
    const mockExec = vi.fn().mockReturnValue('');
    const res = runDiffCheck({
      eventName: 'pull_request',
      baseSha: 'sha-base',
      headSha: 'sha-head',
      execRunner: mockExec,
    });

    expect(res.success).toBe(true);
    expect(res.mode).toContain('pr_diff (sha-base...sha-head)');
    expect(mockExec).toHaveBeenCalledWith('git diff --check "sha-base"..."sha-head"');
  });

  it('2. Executes push diff check when beforeSha is valid and currentSha is present', () => {
    const mockExec = vi.fn().mockReturnValue('');
    const res = runDiffCheck({
      eventName: 'push',
      beforeSha: 'sha-before',
      currentSha: 'sha-current',
      execRunner: mockExec,
    });

    expect(res.success).toBe(true);
    expect(res.mode).toContain('push_diff (sha-before...sha-current)');
    expect(mockExec).toHaveBeenCalledWith('git diff --check "sha-before"..."sha-current"');
  });

  it('3. Falls back to working tree diff check when push beforeSha is empty or zero', () => {
    const mockExec = vi.fn().mockReturnValue('');
    const res = runDiffCheck({
      eventName: 'push',
      beforeSha: '0000000000000000000000000000000000000000',
      currentSha: 'sha-current',
      execRunner: mockExec,
    });

    expect(res.success).toBe(true);
    expect(res.mode).toBe('working_tree');
    expect(mockExec).toHaveBeenCalledWith('git diff --check');
  });

  it('4. Returns failure when git diff --check throws', () => {
    const mockExec = vi.fn().mockImplementation(() => {
      throw new Error('Trailing whitespace detected');
    });

    const res = runDiffCheck({
      execRunner: mockExec,
    });

    expect(res.success).toBe(false);
    expect(res.detail).toContain('Trailing whitespace detected');
  });
});
