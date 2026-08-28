import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export interface InteractivePsqlSession {
  child: ChildProcessWithoutNullStreams;
  stdout: string;
  stderr: string;
  backendPid?: number;
  isolation?: string;
  snapshot?: string;
  closing?: Promise<void>;
}

export interface PsqlMutationOutcome {
  marker: string;
  sqlState: string;
  failed: boolean;
  message: string;
  stdout: string;
  stderr: string;
}

export interface PsqlCloseTimeouts {
  gracefulMs?: number;
  terminateMs?: number;
  killMs?: number;
}

const trackedSessions = new Set<InteractivePsqlSession>();

function exited(session: InteractivePsqlSession): boolean {
  return session.child.exitCode !== null || session.child.signalCode !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasOutputLine(output: string, expected: string): boolean {
  return output.split(/\r?\n/).includes(expected);
}

async function waitForChildExit(
  session: InteractivePsqlSession,
  timeoutMs: number,
): Promise<boolean> {
  if (exited(session)) return true;
  return await new Promise<boolean>((resolve) => {
    const finish = (didExit: boolean) => {
      clearTimeout(timer);
      session.child.off('exit', onExit);
      resolve(didExit);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    session.child.once('exit', onExit);
    if (exited(session)) finish(true);
  });
}

export function trackInteractivePsqlSession(
  child: ChildProcessWithoutNullStreams,
): InteractivePsqlSession {
  const session: InteractivePsqlSession = { child, stdout: '', stderr: '' };
  trackedSessions.add(session);
  child.stdout.on('data', (chunk: Buffer | string) => { session.stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer | string) => { session.stderr += chunk.toString(); });
  child.once('exit', () => { trackedSessions.delete(session); });
  return session;
}

export function trackedPsqlSessionCount(): number {
  return trackedSessions.size;
}

export function sendPsql(session: InteractivePsqlSession, sql: string): void {
  assert.equal(session.child.stdin.destroyed, false, `psql stdin closed early: ${session.stderr}`);
  session.child.stdin.write(`${sql}\n`);
}

export async function waitForPsqlMarker(
  session: InteractivePsqlSession,
  marker: string,
  timeoutMs = 7_000,
): Promise<void> {
  if (hasOutputLine(session.stdout, marker)) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      session.child.stdout.off('data', inspect);
      session.child.off('exit', onExit);
      if (error) reject(error); else resolve();
    };
    const inspect = () => {
      if (hasOutputLine(session.stdout, marker)) finish();
    };
    const onExit = (code: number | null) => finish(new Error(
      `psql exited before ${marker} (code ${String(code)}): stdout=${session.stdout} stderr=${session.stderr}`,
    ));
    const timer = setTimeout(() => finish(new Error(
      `Timed out waiting for ${marker}. stdout=${session.stdout} stderr=${session.stderr}`,
    )), timeoutMs);
    session.child.stdout.on('data', inspect);
    session.child.once('exit', onExit);
    inspect();
  });
}

function mutationOutcome(
  session: InteractivePsqlSession,
  marker: string,
  outputStart: number,
): PsqlMutationOutcome {
  const prefix = `${marker}_MUTATION_RESULT`;
  const line = session.stdout.slice(outputStart).split(/\r?\n/)
    .find((candidate) => candidate.startsWith(`${prefix} `));
  assert.ok(line, `${marker}: missing same-stream mutation result. stdout=${session.stdout} stderr=${session.stderr}`);
  const match = line.match(/^\S+\s+(\S+)\s+(\S+)\s*(.*)$/);
  assert.ok(match, `${marker}: malformed mutation result ${line}`);
  return {
    marker,
    sqlState: match[1],
    failed: match[2] === 'true',
    message: match[3],
    stdout: session.stdout,
    stderr: session.stderr,
  };
}

export async function closePsqlSession(
  session: InteractivePsqlSession,
  timeouts: PsqlCloseTimeouts = {},
): Promise<void> {
  if (session.closing) return await session.closing;
  session.closing = (async () => {
    if (exited(session)) return;
    if (!session.child.stdin.destroyed) {
      session.child.stdin.write('ROLLBACK;\n\\q\n');
      session.child.stdin.end();
    }
    if (await waitForChildExit(session, timeouts.gracefulMs ?? 7_000)) return;
    session.child.kill('SIGTERM');
    if (await waitForChildExit(session, timeouts.terminateMs ?? 2_000)) return;
    session.child.kill('SIGKILL');
    if (await waitForChildExit(session, timeouts.killMs ?? 2_000)) return;
    throw new Error(`Timed out closing psql session: stdout=${session.stdout} stderr=${session.stderr}`);
  })();
  return await session.closing;
}

async function cleanupWithoutReplacingPrimary(
  session: InteractivePsqlSession,
  primaryError: unknown,
  timeouts?: PsqlCloseTimeouts,
): Promise<void> {
  try {
    await closePsqlSession(session, timeouts);
  } catch (cleanupError) {
    if (primaryError !== undefined) {
      console.error(
        `psql cleanup failed after primary error "${errorMessage(primaryError)}": ${errorMessage(cleanupError)}`,
      );
      return;
    }
    throw cleanupError;
  }
}

export async function finishRejectedMutation(
  session: InteractivePsqlSession,
  sql: string,
  marker: string,
  expectedMessage: RegExp,
  expectedSqlState: RegExp = /P0001/,
  options: { markerTimeoutMs?: number; closeTimeouts?: PsqlCloseTimeouts } = {},
): Promise<PsqlMutationOutcome> {
  let primaryError: unknown;
  try {
    const outputStart = session.stdout.length;
    sendPsql(session, sql);
    sendPsql(session, `\\echo ${marker}_MUTATION_RESULT :SQLSTATE :ERROR :LAST_ERROR_MESSAGE`);
    sendPsql(session, 'ROLLBACK;');
    sendPsql(session, `SELECT '${marker.replaceAll("'", "''")}';`);
    await waitForPsqlMarker(session, marker, options.markerTimeoutMs);
    const outcome = mutationOutcome(session, marker, outputStart);
    assert.equal(
      outcome.failed,
      true,
      `${marker}: mutation unexpectedly succeeded. stdout=${outcome.stdout} stderr=${outcome.stderr}`,
    );
    assert.match(
      outcome.sqlState,
      expectedSqlState,
      `${marker}: unexpected SQLSTATE. stdout=${outcome.stdout} stderr=${outcome.stderr}`,
    );
    assert.match(
      outcome.message,
      expectedMessage,
      `${marker}: unexpected error. stdout=${outcome.stdout} stderr=${outcome.stderr}`,
    );
    return outcome;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await cleanupWithoutReplacingPrimary(session, primaryError, options.closeTimeouts);
  }
}

export async function commitInteractiveMutation(
  session: InteractivePsqlSession,
  sql: string,
  mutationMarker: string,
  commitMarker: string,
): Promise<PsqlMutationOutcome> {
  let primaryError: unknown;
  try {
    const outputStart = session.stdout.length;
    sendPsql(session, sql);
    sendPsql(session, `\\echo ${mutationMarker}_MUTATION_RESULT :SQLSTATE :ERROR`);
    sendPsql(session, `SELECT '${mutationMarker.replaceAll("'", "''")}';`);
    await waitForPsqlMarker(session, mutationMarker);
    const outcome = mutationOutcome(session, mutationMarker, outputStart);
    assert.equal(
      outcome.sqlState,
      '00000',
      `${mutationMarker}: mutation failed. stdout=${outcome.stdout} stderr=${outcome.stderr}`,
    );
    assert.equal(outcome.failed, false, `${mutationMarker}: ${outcome.stderr}`);
    const commitOutputStart = session.stdout.length;
    sendPsql(session, 'COMMIT;');
    sendPsql(session, `\\echo ${commitMarker}_MUTATION_RESULT :SQLSTATE :ERROR :LAST_ERROR_MESSAGE`);
    sendPsql(session, `SELECT '${commitMarker.replaceAll("'", "''")}';`);
    await waitForPsqlMarker(session, commitMarker);
    const commitOutcome = mutationOutcome(session, commitMarker, commitOutputStart);
    assert.equal(
      commitOutcome.sqlState,
      '00000',
      `${commitMarker}: commit failed. stdout=${commitOutcome.stdout} stderr=${commitOutcome.stderr}`,
    );
    assert.equal(commitOutcome.failed, false, `${commitMarker}: ${commitOutcome.stderr}`);
    return outcome;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await cleanupWithoutReplacingPrimary(session, primaryError);
  }
}

export async function settlePsqlOperations<T>(operations: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(operations);
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (rejected) throw rejected.reason;
  return results.map((result) => (result as PromiseFulfilledResult<T>).value);
}

export async function closeTrackedPsqlSessions(primaryError?: unknown): Promise<void> {
  const results = await Promise.allSettled(
    [...trackedSessions].map((session) => closePsqlSession(session)),
  );
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason);
  if (failures.length === 0) return;
  if (primaryError !== undefined) {
    console.error(
      `psql cleanup failed after primary error "${errorMessage(primaryError)}": ${failures.map(errorMessage).join('; ')}`,
    );
    return;
  }
  throw new AggregateError(failures, 'Failed to close all interactive psql sessions.');
}
