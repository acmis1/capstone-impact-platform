import path from 'node:path';
import {
  assertDatabaseContainerOwned, createDisposableNetwork, createDisposableStackIdentity,
  inspectDisposableResidue, preflightDisposablePortBase, removeDisposableResidue,
  residueIsAbsent, startDisposableStack, stopDisposableStack,
} from '../recovery/disposableSupabaseStack';
import { verifyParticipantOwnedCorrectionsRuntime } from './verifyParticipantOwnedCorrectionsRuntime';

/** Owns the complete synthetic stack; never reads a canonical or hosted connection. */
export async function runDisposableParticipantCorrectionsRuntime(): Promise<void> {
  const repositoryRoot = path.resolve(__dirname, '../../../..');
  const startedAt = Date.now();
  const identity = createDisposableStackIdentity({
    repositoryRoot, mode: 'migrated-source', tag: 'pcorr',
    portBase: await preflightDisposablePortBase(), postgresMajorVersion: 17,
  });
  let networkId = '';
  let startAttempted = false;
  try {
    networkId = createDisposableNetwork(identity);
    startAttempted = true;
    startDisposableStack(repositoryRoot, identity, networkId);
    assertDatabaseContainerOwned(identity);
    await verifyParticipantOwnedCorrectionsRuntime(repositoryRoot, identity);
    console.log('PASS: participant-owned corrections runtime');
  } catch {
    // Never print raw errors: CLI and API failures may contain disposable credentials.
    console.error('FAIL: participant-owned corrections runtime');
    process.exitCode = 1;
  } finally {
    if (startAttempted) {
      try { stopDisposableStack(repositoryRoot, identity, networkId); }
      catch { /* Exact-identity residue cleanup below is authoritative. */ }
    }
    try {
      removeDisposableResidue(identity);
      if (!residueIsAbsent(inspectDisposableResidue(identity))) throw new Error('RESIDUE');
      console.log('PASS: disposable containers, volumes, network and workdir removed');
    } catch {
      console.error('FAIL: disposable cleanup or residue verification');
      process.exitCode = 1;
    }
    console.log(`Participant corrections elapsed seconds: ${Math.ceil((Date.now() - startedAt) / 1000)}`);
  }
}

if (require.main === module) void runDisposableParticipantCorrectionsRuntime().catch(() => {
  console.error('FAIL: participant corrections disposable preflight');
  process.exitCode = 1;
});
