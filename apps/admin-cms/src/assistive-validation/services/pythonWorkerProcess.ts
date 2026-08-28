import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import type { AssistiveDocumentType } from '../domain/inputIdentity';
import { workerTaskResultSchema, type WorkerTaskResult } from '../domain/jobContract';

const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const STAGING_PREFIX = 'capstone-assistive-';

export type WorkerPulseResult = 'CONTINUE' | 'CANCEL' | 'CLAIM_LOST';
export type AssistiveOcrProviderSelection = 'NONE' | 'TESSERACT' | 'PADDLE_TITLE';
export type WorkerProcessFailureCode =
  | 'WORKER_UNAVAILABLE'
  | 'WORKER_TIMEOUT'
  | 'WORKER_CRASHED'
  | 'EXTRACTION_CONTRACT_REJECTED'
  | 'CANCELLED'
  | 'CLAIM_LOST';

export class WorkerProcessError extends Error {
  constructor(readonly code: WorkerProcessFailureCode) {
    super(code);
  }
}

export interface PythonWorkerOptions {
  workerRoot?: string;
  pythonExecutable?: string;
  pythonPrefixArguments?: string[];
  timeoutMs?: number;
  pulseIntervalMs?: number;
  tesseractExecutable?: string;
  /** Operator-provisioned PP-OCRv6 Small model root; absent means the provider stays unavailable. */
  paddleModelsDir?: string;
}

export interface AssistiveWorkerRunInput {
  content: Buffer;
  documentType: AssistiveDocumentType;
  ocrProvider?: AssistiveOcrProviderSelection;
  rasterDpi?: number | null;
  onPulse?: () => Promise<WorkerPulseResult>;
}

export interface AssistiveWorkerRunner {
  run(input: AssistiveWorkerRunInput): Promise<WorkerTaskResult>;
}

interface CollectedProcessResult {
  stdout: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

function stagedFileName(documentType: AssistiveDocumentType): string {
  if (documentType === 'PDF') return 'document.pdf';
  if (documentType === 'PNG') return 'document.png';
  return 'document.jpg';
}

function safeEnvironment(workerRoot: string): NodeJS.ProcessEnv {
  const allowed = [
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR',
    'HOME', 'LANG', 'LC_ALL',
  ];
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV };
  for (const key of allowed) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.PYTHONPATH = resolve(workerRoot, 'src');
  env.PYTHONIOENCODING = 'utf-8';
  env.CAPSTONE_ASSISTIVE_PARENT_PID = String(process.pid);
  return env;
}

async function terminateProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise<void>((done) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('error', () => done());
      killer.once('close', () => done());
    });
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  await new Promise((done) => setTimeout(done, 2_000));
  if (child.exitCode === null) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

function assertOwnedStagingRoot(stagingRoot: string): void {
  if (resolve(dirname(stagingRoot)) !== resolve(tmpdir()) || !basename(stagingRoot).startsWith(STAGING_PREFIX)) {
    throw new WorkerProcessError('WORKER_CRASHED');
  }
}

export class PythonAssistiveWorkerProcess implements AssistiveWorkerRunner {
  private readonly workerRoot: string;
  private readonly executable: string;
  private readonly prefixArguments: string[];
  private readonly timeoutMs: number;
  private readonly pulseIntervalMs: number;

  constructor(private readonly options: PythonWorkerOptions = {}) {
    this.workerRoot = options.workerRoot ?? resolve(process.cwd(), '../assistive-worker');
    const localVenvPython = process.platform === 'win32'
      ? resolve(this.workerRoot, '.venv/Scripts/python.exe')
      : resolve(this.workerRoot, '.venv/bin/python');
    this.executable = options.pythonExecutable
      ?? (existsSync(localVenvPython) ? localVenvPython : (process.platform === 'win32' ? 'py' : 'python3'));
    this.prefixArguments = options.pythonPrefixArguments
      ?? (options.pythonExecutable || this.executable === localVenvPython
        ? []
        : (process.platform === 'win32' ? ['-3.11'] : []));
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.pulseIntervalMs = options.pulseIntervalMs ?? 10_000;
  }

  async run(input: AssistiveWorkerRunInput): Promise<WorkerTaskResult> {
    const stagingRoot = await mkdtemp(join(tmpdir(), STAGING_PREFIX));
    try {
      assertOwnedStagingRoot(stagingRoot);
      const taskId = randomUUID();
      const relativePath = stagedFileName(input.documentType);
      await writeFile(join(stagingRoot, relativePath), input.content, { mode: 0o600 });
      const args = [
        ...this.prefixArguments,
        '-m', 'capstone_assistive_worker.task_cli',
        '--staging-root', stagingRoot,
      ];
      if (input.ocrProvider === 'TESSERACT' && this.options.tesseractExecutable) {
        args.push('--tesseract-executable', this.options.tesseractExecutable);
      }
      if (input.ocrProvider === 'PADDLE_TITLE' && this.options.paddleModelsDir) {
        args.push('--paddle-models-dir', this.options.paddleModelsDir);
      }
      const child = spawn(this.executable, args, {
        cwd: this.workerRoot,
        env: safeEnvironment(this.workerRoot),
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const task = JSON.stringify({
        schema_version: 'assistive-worker-task/v1',
        task_id: taskId,
        relative_path: relativePath,
        document_type: input.documentType,
        ocr_provider: input.ocrProvider ?? 'NONE',
        raster_dpi: input.rasterDpi ?? null,
      });
      const collected = await this.collect(child, task, input.onPulse);
      if (collected.signal !== null || collected.exitCode === null
          || ![0, 1, 2].includes(collected.exitCode)) {
        throw new WorkerProcessError('WORKER_CRASHED');
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(collected.stdout);
      } catch {
        throw new WorkerProcessError(
          collected.exitCode === 0 ? 'EXTRACTION_CONTRACT_REJECTED' : 'WORKER_CRASHED',
        );
      }
      const parsed = workerTaskResultSchema.safeParse(decoded);
      if (!parsed.success) {
        throw new WorkerProcessError(
          collected.exitCode === 0 ? 'EXTRACTION_CONTRACT_REJECTED' : 'WORKER_CRASHED',
        );
      }
      const result = parsed.data;
      const coherent = collected.exitCode === 0
        ? result.task_id === taskId && result.extraction !== null && result.error === null
        : collected.exitCode === 1
          ? result.task_id === taskId && result.extraction === null
            && result.error?.code === 'TASK_EXECUTION_FAILED'
          : (result.task_id === null || result.task_id === taskId) && result.extraction === null
            && result.error?.code === 'TASK_CONTRACT_REJECTED';
      if (!coherent) {
        throw new WorkerProcessError('EXTRACTION_CONTRACT_REJECTED');
      }
      return result;
    } finally {
      assertOwnedStagingRoot(stagingRoot);
      await rm(stagingRoot, { recursive: true, force: true });
    }
  }

  async health(): Promise<boolean> {
    const args = [
      ...this.prefixArguments,
      '-m', 'capstone_assistive_worker.task_cli',
      '--health',
    ];
    if (this.options.paddleModelsDir) {
      args.push('--paddle-models-dir', this.options.paddleModelsDir);
    }
    const child = spawn(this.executable, args, {
      cwd: this.workerRoot,
      env: safeEnvironment(this.workerRoot),
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      const collected = await this.collect(child, '');
      if (collected.exitCode !== 0 || collected.signal !== null) return false;
      const decoded = JSON.parse(collected.stdout) as unknown;
      return typeof decoded === 'object' && decoded !== null
        && Object.keys(decoded).sort().join(',') === 'schema_version,status'
        && (decoded as { schema_version?: unknown }).schema_version === 'assistive-worker-health/v1'
        && (decoded as { status?: unknown }).status === 'OK';
    } catch {
      return false;
    }
  }

  private collect(
    child: ChildProcessWithoutNullStreams,
    task: string,
    onPulse?: () => Promise<WorkerPulseResult>,
  ): Promise<CollectedProcessResult> {
    return new Promise((resolveResult, rejectResult) => {
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let forcedError: WorkerProcessError | null = null;
      let pulsePending = false;
      let settled = false;

      const cleanup = () => {
        clearTimeout(timeout);
        if (pulse) clearInterval(pulse);
      };

      const stop = (error: WorkerProcessError) => {
        if (forcedError) return;
        forcedError = error;
        void terminateProcessTree(child).finally(() => {
          cleanup();
          if (!settled) {
            settled = true;
            rejectResult(error);
          }
        });
      };
      const timeout = setTimeout(() => stop(new WorkerProcessError('WORKER_TIMEOUT')), this.timeoutMs);
      const pulse = onPulse ? setInterval(async () => {
        if (pulsePending || forcedError) return;
        pulsePending = true;
        try {
          const result = await onPulse();
          if (result !== 'CONTINUE') stop(new WorkerProcessError(result === 'CANCEL' ? 'CANCELLED' : result));
        } catch {
          stop(new WorkerProcessError('CLAIM_LOST'));
        } finally {
          pulsePending = false;
        }
      }, this.pulseIntervalMs) : null;

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_STDOUT_BYTES) stop(new WorkerProcessError('EXTRACTION_CONTRACT_REJECTED'));
        else stdout.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_STDERR_BYTES) stop(new WorkerProcessError('WORKER_CRASHED'));
      });
      child.once('error', () => stop(new WorkerProcessError('WORKER_UNAVAILABLE')));
      child.once('close', (exitCode, signal) => {
        if (forcedError || settled) return;
        settled = true;
        cleanup();
        resolveResult({ stdout: Buffer.concat(stdout).toString('utf8'), exitCode, signal });
      });
      child.stdin.once('error', () => stop(new WorkerProcessError('WORKER_CRASHED')));
      child.stdin.end(task, 'utf8');
    });
  }
}
