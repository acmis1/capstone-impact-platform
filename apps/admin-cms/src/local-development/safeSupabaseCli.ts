import { execSync } from 'node:child_process';
import path from 'node:path';

export type LocalSupabaseCommand = 'start' | 'stop' | 'reset' | 'status';

export interface LocalSupabaseResult {
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  failureCategory?: 'COMMAND_FAILED' | 'SPAWN_FAILED' | 'COMMAND_TIMED_OUT' | 'COMMAND_TERMINATED';
}

export function safeProcessResult(input: { ok: boolean; exitCode?: number | null; signal?: string | null; timedOut?: boolean }): LocalSupabaseResult {
  return input.ok
    ? { ok: true, exitCode: 0, signal: null }
    : {
        ok: false,
        exitCode: typeof input.exitCode === 'number' ? input.exitCode : null,
        signal: input.signal ?? null,
        failureCategory: input.timedOut ? 'COMMAND_TIMED_OUT' : input.signal ? 'COMMAND_TERMINATED' : typeof input.exitCode === 'number' ? 'COMMAND_FAILED' : 'SPAWN_FAILED',
      };
}

const commandArguments: Record<LocalSupabaseCommand, string[]> = {
  start: ['start', '--workdir', 'infra'],
  stop: ['stop', '--workdir', 'infra'],
  reset: ['db', 'reset', '--local', '--workdir', 'infra'],
  status: ['status', '--workdir', 'infra'],
};

export const commandTimeoutMs: Record<LocalSupabaseCommand, number> = { start: 120_000, stop: 60_000, reset: 180_000, status: 15_000 };

export function runLocalSupabaseCli(command: LocalSupabaseCommand, repoRoot: string): LocalSupabaseResult {
  try {
    const cli = path.join(repoRoot, 'node_modules', '.bin', 'supabase');
    const output = execSync(`"${cli}" ${commandArguments[command].map((arg) => `"${arg}"`).join(' ')}`, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: commandTimeoutMs[command],
      killSignal: 'SIGTERM',
    });
    void output;
    return safeProcessResult({ ok: true });
  } catch (error: unknown) {
    const child = error as { status?: number | null; signal?: string | null; stdout?: unknown; stderr?: unknown };
    return safeProcessResult({ ok: false, exitCode: child.status, signal: child.signal, timedOut: Boolean((child as { killed?: boolean }).killed) });
  }
}
