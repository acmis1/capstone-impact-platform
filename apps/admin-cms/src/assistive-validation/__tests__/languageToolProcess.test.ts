import { EventEmitter } from 'node:events';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

import { spawn } from 'node:child_process';

import {
  LanguageProviderControlError,
  LocalLanguageToolProcess,
} from '../services/languageToolProcess';

const input = {
  project: { publicId: 'P-1', title: 'Title', summary: 'Summary', background: '', solution: '' },
  inputHash: 'a'.repeat(64),
};

class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(): boolean {
    if (this.exitCode === null && this.signalCode === null) {
      this.exitCode = 0;
      this.emit('exit', 0, null);
    }
    return true;
  }
}

const response = (version = '6.6', matches: unknown[] = []) => new Response(JSON.stringify({
  software: { version }, matches,
}), { headers: { 'content-type': 'application/json' } });

const runnableProvider = (requestTimeoutMs = 100) => {
  const provider = new LocalLanguageToolProcess({
    archivePath: 'LanguageTool-stable.zip', jarPath: 'languagetool-server.jar', requestTimeoutMs,
  });
  vi.spyOn(provider, 'health').mockResolvedValue(true);
  vi.mocked(spawn).mockReturnValue(new FakeChildProcess() as unknown as ChildProcess);
  return provider;
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('local LanguageTool process boundary', () => {
  it('degrades cleanly before process launch when qualified artifacts are absent', async () => {
    const provider = new LocalLanguageToolProcess({
      archivePath: 'Z:\\missing\\LanguageTool-stable.zip',
      jarPath: 'Z:\\missing\\languagetool-server.jar',
    });
    const onPulse = vi.fn().mockResolvedValue('CONTINUE' as const);
    await expect(provider.health()).resolves.toBe(false);
    await expect(provider.check({ ...input, onPulse })).resolves.toEqual({ status: 'UNAVAILABLE' });
    expect(onPulse).toHaveBeenCalledOnce();
  });

  it('honours cancellation before reading artifacts or launching Java', async () => {
    const provider = new LocalLanguageToolProcess({ archivePath: 'missing.zip', jarPath: 'missing.jar' });
    await expect(provider.check({
      ...input,
      onPulse: vi.fn().mockResolvedValue('CANCEL'),
    })).rejects.toEqual(new LanguageProviderControlError('CANCELLED'));
  });

  it('fails closed on an unexpected provider version and uses only the loopback endpoint', async () => {
    const provider = runnableProvider();
    const fetchMock = vi.fn().mockResolvedValue(response('6.5'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(provider.check({ ...input, onPulse: vi.fn().mockResolvedValue('CONTINUE') }))
      .resolves.toEqual({ status: 'UNAVAILABLE' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v2\/check$/);
  });

  it('does not pass service credentials to the Java child process', async () => {
    vi.stubEnv('SUPABASE_SECRET_KEY', 'sb_secret_must-not-reach-java');
    const provider = runnableProvider();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response()));

    await provider.check({ ...input, onPulse: vi.fn().mockResolvedValue('CONTINUE') });

    const options = vi.mocked(spawn).mock.calls[0][2];
    expect(options?.env?.SUPABASE_SECRET_KEY).toBeUndefined();
  });

  it('fails closed when the provider process has crashed', async () => {
    const provider = runnableProvider();
    const child = new FakeChildProcess();
    child.exitCode = 1;
    vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(provider.check({ ...input, onPulse: vi.fn().mockResolvedValue('CONTINUE') }))
      .resolves.toEqual({ status: 'UNAVAILABLE' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed on malformed provider JSON', async () => {
    const provider = runnableProvider();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(new Response('{malformed'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(provider.check({ ...input, onPulse: vi.fn().mockResolvedValue('CONTINUE') }))
      .resolves.toEqual({ status: 'UNAVAILABLE' });
  });

  it('fails closed before reading an oversized provider response', async () => {
    const provider = runnableProvider();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(new Response('x'.repeat(256_001), {
        headers: { 'content-length': '256001' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(provider.check({ ...input, onPulse: vi.fn().mockResolvedValue('CONTINUE') }))
      .resolves.toEqual({ status: 'UNAVAILABLE' });
  });

  it('fails closed when a field request times out', async () => {
    const provider = runnableProvider(5);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response())
      .mockImplementationOnce((_endpoint: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(provider.check({ ...input, onPulse: vi.fn().mockResolvedValue('CONTINUE') }))
      .resolves.toEqual({ status: 'UNAVAILABLE' });
  });

  it('removes its private temporary directory when launch throws', async () => {
    const provider = runnableProvider();
    vi.mocked(spawn).mockImplementationOnce(() => { throw new Error('spawn failed'); });
    const before = new Set((await readdir(tmpdir())).filter((entry) => entry.startsWith('pp1-language-tool-')));

    await expect(provider.check({ ...input, onPulse: vi.fn().mockResolvedValue('CONTINUE') }))
      .resolves.toEqual({ status: 'UNAVAILABLE' });

    const after = (await readdir(tmpdir())).filter((entry) => entry.startsWith('pp1-language-tool-'));
    expect(after.filter((entry) => !before.has(entry))).toEqual([]);
  });
});
