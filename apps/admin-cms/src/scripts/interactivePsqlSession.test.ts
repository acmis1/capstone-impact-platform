import { spawn } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  finishRejectedMutation,
  trackInteractivePsqlSession,
  trackedPsqlSessionCount,
} from './interactivePsqlSession';

function mismatchChild() {
  const source = String.raw`
    const readline = require('node:readline');
    const input = readline.createInterface({ input: process.stdin });
    input.on('line', (line) => {
      if (line.startsWith('\\echo HARNESS_MISMATCH_MUTATION_RESULT')) {
        process.stdout.write('HARNESS_MISMATCH_MUTATION_RESULT 00000 false\n');
      }
      if (line.includes("SELECT 'HARNESS_MISMATCH'")) {
        process.stdout.write('HARNESS_MISMATCH\n');
      }
      if (line === '\\q') process.exit(0);
    });
    setInterval(() => {}, 1000);
  `;
  return spawn(process.execPath, ['-e', source], { stdio: ['pipe', 'pipe', 'pipe'] });
}

describe('interactive psql session cleanup', () => {
  it('preserves an expected-error mismatch and promptly closes the real child process', async () => {
    const session = trackInteractivePsqlSession(mismatchChild());
    const startedAt = Date.now();

    await expect(finishRejectedMutation(
      session,
      'SELECT 1;',
      'HARNESS_MISMATCH',
      /could not serialize access/i,
      /40001/,
      {
        markerTimeoutMs: 500,
        closeTimeouts: { gracefulMs: 500, terminateMs: 500, killMs: 500 },
      },
    )).rejects.toThrow(/HARNESS_MISMATCH: mutation unexpectedly succeeded/);

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(session.child.exitCode).not.toBeNull();
    expect(trackedPsqlSessionCount()).toBe(0);
  });

  it('lets a verifier process exit nonzero without an orphan after the same mismatch', async () => {
    const startedAt = Date.now();
    const fixture = spawn(process.execPath, [
      '--import', 'tsx', path.join(__dirname, 'interactivePsqlSessionFailure.fixture.ts'),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    fixture.stderr.on('data', (chunk: Buffer | string) => { stderr += chunk.toString(); });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        fixture.kill('SIGKILL');
        reject(new Error(`Intentional verifier failure hung. stderr=${stderr}`));
      }, 5_000);
      fixture.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    expect(exitCode).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(stderr).toContain('HARNESS_PROCESS_MISMATCH: mutation unexpectedly succeeded');
    expect(stderr).toContain('TRACKED_PSQL_SESSIONS=0');
  });
});
