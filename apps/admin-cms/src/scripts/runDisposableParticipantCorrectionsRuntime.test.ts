// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as stack from '../recovery/disposableSupabaseStack';
import { verifyParticipantOwnedCorrectionsRuntime } from './verifyParticipantOwnedCorrectionsRuntime';
import { runDisposableParticipantCorrectionsRuntime } from './runDisposableParticipantCorrectionsRuntime';

vi.mock('../recovery/disposableSupabaseStack', () => ({
  preflightDisposablePortBase: vi.fn(), createDisposableStackIdentity: vi.fn(),
  createDisposableNetwork: vi.fn(), startDisposableStack: vi.fn(), assertDatabaseContainerOwned: vi.fn(),
  stopDisposableStack: vi.fn(), removeDisposableResidue: vi.fn(),
  inspectDisposableResidue: vi.fn(), residueIsAbsent: vi.fn(),
}));
vi.mock('./verifyParticipantOwnedCorrectionsRuntime', () => ({ verifyParticipantOwnedCorrectionsRuntime: vi.fn() }));
const originalExitCode = process.exitCode;
beforeEach(() => {
  vi.resetAllMocks(); process.exitCode = 0;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(stack.preflightDisposablePortBase).mockResolvedValue(24000);
  vi.mocked(stack.createDisposableStackIdentity).mockReturnValue({
    projectId: 'capstone-pp1-recovery-pcorr-12345678', networkName: 'owned-loopback',
    portBase: 24000, workdir: '/owned-temp', databaseContainer: 'owned-db',
  });
  vi.mocked(stack.createDisposableNetwork).mockReturnValue('owned-network');
  vi.mocked(stack.residueIsAbsent).mockReturnValue(true);
});
afterEach(() => { vi.restoreAllMocks(); process.exitCode = originalExitCode; });
describe('disposable participant corrections runner', () => {
  it('runs the complete verifier with an owned identity and confirms cleanup', async () => {
    await runDisposableParticipantCorrectionsRuntime();
    expect(verifyParticipantOwnedCorrectionsRuntime).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ databaseContainer: 'owned-db' }));
    expect(stack.removeDisposableResidue).toHaveBeenCalledTimes(1);
    expect(stack.inspectDisposableResidue).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(0);
  });
  it('fails before mutation when container ownership is unproven and still cleans up', async () => {
    vi.mocked(stack.assertDatabaseContainerOwned).mockImplementation(() => { throw new Error('UNPROVEN'); });
    await runDisposableParticipantCorrectionsRuntime();
    expect(verifyParticipantOwnedCorrectionsRuntime).not.toHaveBeenCalled();
    expect(stack.removeDisposableResidue).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });
  it('cleans up after verifier failure without exposing its raw error', async () => {
    vi.mocked(verifyParticipantOwnedCorrectionsRuntime).mockRejectedValue(new Error('synthetic-secret-sentinel'));
    await runDisposableParticipantCorrectionsRuntime();
    expect(stack.stopDisposableStack).toHaveBeenCalledTimes(1);
    expect(stack.removeDisposableResidue).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('synthetic-secret-sentinel');
    expect(process.exitCode).toBe(1);
  });
  it('cannot report success when residue remains', async () => {
    vi.mocked(stack.residueIsAbsent).mockReturnValue(false);
    await runDisposableParticipantCorrectionsRuntime();
    expect(process.exitCode).toBe(1);
  });
});
