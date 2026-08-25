import { describe, expect, it, vi } from 'vitest';
import {
  cleanupDisposableLedgerRuntime,
  type DisposableLedgerCleanupDependencies,
} from './disposableLedgerCleanup';

const PROJECT = 'capstone-pp1-ledger-1234abcd';
const NETWORK = `${PROJECT}-loopback`;

function harness(options: {
  stopFails?: boolean;
  networkRemovalFails?: boolean;
  startAttempted?: boolean;
} = {}) {
  const calls: string[][] = [];
  const containers = new Set(['task-container']);
  const volumes = new Set(['task-volume']);
  let networkPresent = true;
  let workdirPresent = true;
  const docker = vi.fn((args: string[]) => {
    calls.push(args);
    if (args[0] === 'ps') return [...containers].join('\n');
    if (args[0] === 'rm') {
      args.slice(2).forEach((id) => containers.delete(id));
      return '';
    }
    if (args[0] === 'volume' && args[1] === 'ls') return [...volumes].join('\n');
    if (args[0] === 'volume' && args[1] === 'rm') {
      args.slice(2).forEach((name) => volumes.delete(name));
      return '';
    }
    if (args[0] === 'network' && args[1] === 'ls') {
      return networkPresent ? `${NETWORK}\nunrelated-network` : 'unrelated-network';
    }
    if (args[0] === 'network' && args[1] === 'rm') {
      if (options.networkRemovalFails) throw new Error('NETWORK_REMOVE_FAILED');
      networkPresent = false;
      return '';
    }
    throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
  });
  const stopSupabase = vi.fn(() => {
    if (options.stopFails) throw new Error('SUPABASE_STOP_FAILED');
    containers.clear();
    volumes.clear();
  });
  const dependencies: DisposableLedgerCleanupDependencies = {
    projectId: PROJECT,
    networkName: NETWORK,
    startAttempted: options.startAttempted ?? true,
    networkCreateAttempted: true,
    docker,
    stopSupabase,
    removeWorkdir: vi.fn(() => { workdirPresent = false; }),
    workdirExists: vi.fn(() => workdirPresent),
  };
  return { dependencies, calls, stopSupabase };
}

describe('disposable ledger cleanup', () => {
  it('reports a normal cleanup as residue-free', () => {
    const fixture = harness();
    const result = cleanupDisposableLedgerRuntime(fixture.dependencies);

    expect(result).toEqual({
      clean: true, errors: [],
      residue: { containers: [], volumes: [], networkPresent: false, workdirPresent: false },
    });
  });

  it('continues exact fallback cleanup after a Supabase stop failure and fails the report', () => {
    const fixture = harness({ stopFails: true });
    const result = cleanupDisposableLedgerRuntime(fixture.dependencies);

    expect(result.clean).toBe(false);
    expect(result.errors).toContain('Supabase stop failed: SUPABASE_STOP_FAILED');
    expect(result.residue).toEqual({
      containers: [], volumes: [], networkPresent: false, workdirPresent: false,
    });
    expect(fixture.calls).toContainEqual(['rm', '-f', 'task-container']);
    expect(fixture.calls).toContainEqual(['volume', 'rm', 'task-volume']);
    expect(fixture.calls).toContainEqual(['network', 'rm', NETWORK]);
  });

  it('detects network residue and still removes the temporary workdir', () => {
    const fixture = harness({ networkRemovalFails: true });
    const result = cleanupDisposableLedgerRuntime(fixture.dependencies);

    expect(result.clean).toBe(false);
    expect(result.errors).toContain('verifier network cleanup failed: NETWORK_REMOVE_FAILED');
    expect(result.residue.networkPresent).toBe(true);
    expect(fixture.dependencies.removeWorkdir).toHaveBeenCalledOnce();
  });

  it('attempts cleanup after a partial start and never targets unrelated identities', () => {
    const fixture = harness({ stopFails: true, startAttempted: true });
    cleanupDisposableLedgerRuntime(fixture.dependencies);

    expect(fixture.stopSupabase).toHaveBeenCalledOnce();
    const flattened = fixture.calls.flat().join(' ');
    expect(flattened).toContain(`label=com.supabase.cli.project=${PROJECT}`);
    expect(fixture.calls).not.toContainEqual(expect.arrayContaining(['unrelated-network']));
    expect(fixture.calls).not.toContainEqual(expect.arrayContaining(['unrelated-container']));
  });

  it('does not run Supabase stop when startup was never attempted but still cleans created resources', () => {
    const fixture = harness({ startAttempted: false });
    const result = cleanupDisposableLedgerRuntime(fixture.dependencies);

    expect(fixture.stopSupabase).not.toHaveBeenCalled();
    expect(result.clean).toBe(true);
  });
});
