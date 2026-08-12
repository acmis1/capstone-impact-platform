import { describe, expect, it } from 'vitest';
import { canExecuteLocalArchive, initialLocalArchiveState, localArchiveReducer } from './localArchiveState';

describe('local archive state', () => {
  it('requires reason and acknowledgement', () => {
    expect(canExecuteLocalArchive(initialLocalArchiveState)).toBe(false);
    const reason = localArchiveReducer(initialLocalArchiveState, { type: 'REASON', reason: 'Retired showcase entry' });
    expect(canExecuteLocalArchive(reason)).toBe(false);
    expect(canExecuteLocalArchive(localArchiveReducer(reason, { type: 'ACK', value: true }))).toBe(true);
  });
  it('blocks blank and overlong reasons', () => {
    expect(canExecuteLocalArchive({ ...initialLocalArchiveState, reason: '  ', acknowledged: true })).toBe(false);
    expect(canExecuteLocalArchive({ ...initialLocalArchiveState, reason: 'x'.repeat(4001), acknowledged: true })).toBe(false);
  });
  it('blocks duplicate execution while pending', () => {
    const state = { ...initialLocalArchiveState, reason: 'Reason', acknowledged: true };
    expect(canExecuteLocalArchive(localArchiveReducer(state, { type: 'START' }))).toBe(false);
  });
  it.each(['COMPLETED', 'ALREADY_COMPLETED'] as const)('records %s as success', (resultCode) => {
    const result = localArchiveReducer({ ...initialLocalArchiveState, pending: true }, { type: 'SUCCESS', resultCode });
    expect(result).toMatchObject({ pending: false, success: resultCode, acknowledged: false });
    expect(canExecuteLocalArchive(result)).toBe(false);
  });
  it('shows bounded failure while retaining the reason for correction or retry', () => {
    expect(localArchiveReducer({ ...initialLocalArchiveState, reason: 'Reason', pending: true }, { type: 'FAIL', error: 'Bounded error' })).toMatchObject({ reason: 'Reason', pending: false, error: 'Bounded error' });
  });
});
