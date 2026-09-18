import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { waitForDisposableRpcReadiness, type DisposableRpcReadinessProbe } from './disposableRpcReadiness';

const runtimeSource = readFileSync(new URL('./runDisposableStagingMigrationUpgrade.ts', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n');

function probe(
  name: string,
  responses: Array<{ data: unknown; error: { code: string } | null }>,
  events: string[],
  isExpected: (data: unknown) => boolean,
): DisposableRpcReadinessProbe {
  return {
    name,
    invoke: vi.fn(async () => {
      events.push(name);
      return responses.shift() ?? { data: null, error: null };
    }),
    isExpected,
  };
}

describe('disposable RPC schema-cache readiness', () => {
  it('waits for a delayed PGRST202 and completes both no-op probes before returning', async () => {
    const events: string[] = [];
    const publication = probe(
      'begin_synthetic_publication',
      [
        { data: null, error: { code: 'PGRST202' } },
        { data: null, error: null },
      ],
      events,
      (data) => data === null,
    );
    const deletion = probe(
      'soft_delete_then_pause',
      [{ data: { resultCode: 'PROJECT_NOT_FOUND' }, error: null }],
      events,
      (data) => JSON.stringify(data) === JSON.stringify({ resultCode: 'PROJECT_NOT_FOUND' }),
    );

    await waitForDisposableRpcReadiness([publication, deletion], {
      maxAttempts: 3,
      deadlineMs: 1_000,
      requestTimeoutMs: 100,
      retryDelayMs: 0,
    });

    expect(events).toEqual([
      'begin_synthetic_publication',
      'begin_synthetic_publication',
      'soft_delete_then_pause',
    ]);
  });

  it('does not retry an error other than PGRST202', async () => {
    const invoke = vi.fn(async () => ({
      data: null,
      error: { code: '42501' },
    }));
    const readinessProbe: DisposableRpcReadinessProbe = {
      name: 'begin_synthetic_publication', invoke, isExpected: (data) => data === null,
    };

    await expect(waitForDisposableRpcReadiness([readinessProbe, readinessProbe], {
      retryDelayMs: 0,
    })).rejects.toThrow('DISPOSABLE_RPC_READINESS_ERROR:begin_synthetic_publication');
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('fails when the retry attempt bound is exhausted', async () => {
    const invoke = vi.fn(async () => ({
      data: null,
      error: { code: 'PGRST202' },
    }));
    const readinessProbe: DisposableRpcReadinessProbe = {
      name: 'begin_synthetic_publication', invoke, isExpected: (data) => data === null,
    };

    await expect(waitForDisposableRpcReadiness([readinessProbe, readinessProbe], {
      maxAttempts: 2,
      deadlineMs: 1_000,
      retryDelayMs: 0,
    })).rejects.toThrow('DISPOSABLE_RPC_READINESS_EXHAUSTED:begin_synthetic_publication');
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('aborts and fails a stalled per-request probe at its timeout', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const readinessProbe: DisposableRpcReadinessProbe = {
        name: 'begin_synthetic_publication',
        invoke: vi.fn((_signal: AbortSignal) => {
          signal = _signal;
          return new Promise<Awaited<ReturnType<DisposableRpcReadinessProbe['invoke']>>>(() => undefined);
        }),
        isExpected: (data) => data === null,
      };
      const outcome = waitForDisposableRpcReadiness([readinessProbe, readinessProbe], {
        maxAttempts: 2,
        deadlineMs: 100,
        requestTimeoutMs: 25,
        retryDelayMs: 0,
      });
      const rejection = expect(outcome).rejects.toThrow(
        'DISPOSABLE_RPC_READINESS_REQUEST_TIMEOUT:begin_synthetic_publication',
      );

      await vi.advanceTimersByTimeAsync(25);
      await rejection;
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails immediately on an unexpected successful result', async () => {
    const invoke = vi.fn(async () => ({
      data: { resultCode: 'DELETED' },
      error: null,
    }));
    const readinessProbe: DisposableRpcReadinessProbe = {
      name: 'soft_delete_then_pause', invoke,
      isExpected: (data) => JSON.stringify(data) === JSON.stringify({ resultCode: 'PROJECT_NOT_FOUND' }),
    };

    await expect(waitForDisposableRpcReadiness([readinessProbe, readinessProbe], {
      retryDelayMs: 0,
    })).rejects.toThrow('DISPOSABLE_RPC_READINESS_UNEXPECTED_RESULT:soft_delete_then_pause');
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('reloads the schema cache and awaits both probes before either actual race starts', () => {
    const reload = runtimeSource.indexOf("psql(\"NOTIFY pgrst, 'reload schema';\");");
    const readiness = runtimeSource.indexOf('await waitForDisposableRpcReadiness([', reload);
    const firstRace = runtimeSource.indexOf("const publicationPromise = Promise.resolve(client.rpc('begin_synthetic_publication'", readiness);
    const secondRace = runtimeSource.indexOf("const deleteFirstPromise = Promise.resolve(client.rpc('soft_delete_then_pause'", readiness);

    expect(reload).toBeGreaterThan(-1);
    expect(readiness).toBeGreaterThan(reload);
    expect(firstRace).toBeGreaterThan(readiness);
    expect(secondRace).toBeGreaterThan(readiness);
    expect(runtimeSource.slice(readiness, firstRace)).toContain("name: 'begin_synthetic_publication'");
    expect(runtimeSource.slice(readiness, firstRace)).toContain("name: 'soft_delete_then_pause'");
  });
});
