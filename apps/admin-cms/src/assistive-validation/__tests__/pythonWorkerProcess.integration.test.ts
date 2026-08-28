import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PythonAssistiveWorkerProcess,
  type PythonWorkerOptions,
} from '../services/pythonWorkerProcess';

const enabled = process.env.ASSISTIVE_PROCESS_INTEGRATION === '1';
const STAGING_PREFIX = 'capstone-assistive-';
const SHIM = resolve(__dirname, 'fixtures/assistive_process_shim.py');

function stagingDirectories(): Set<string> {
  return new Set(readdirSync(tmpdir(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(STAGING_PREFIX))
    .map((entry) => entry.name));
}

async function expectStagingCleanup<T>(operation: () => Promise<T>): Promise<T> {
  const before = stagingDirectories();
  try {
    return await operation();
  } finally {
    const leaked = [...stagingDirectories()].filter((entry) => !before.has(entry));
    expect(leaked).toEqual([]);
  }
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise((done) => setTimeout(done, milliseconds));
}

describe.skipIf(!enabled)('Node-to-Python assistive task boundary', () => {
  const workerRoot = resolve(process.cwd(), '../assistive-worker');
  const localPython = process.platform === 'win32'
    ? resolve(workerRoot, '.venv/Scripts/python.exe')
    : resolve(workerRoot, '.venv/bin/python');
  const pythonExecutable = process.env.ASSISTIVE_TEST_PYTHON
    ?? (existsSync(localPython) ? localPython : (process.platform === 'win32' ? 'python' : 'python3'));
  const content = readFileSync(resolve(workerRoot, 'tests/fixtures/canonical/valid.png'));
  let spacedWorkerRoot = '';

  beforeAll(async () => {
    spacedWorkerRoot = await mkdtemp(join(tmpdir(), 'capstone worker root '));
  });

  afterAll(async () => {
    if (spacedWorkerRoot) await rm(spacedWorkerRoot, { recursive: true, force: true });
  });

  function worker(options: PythonWorkerOptions = {}): PythonAssistiveWorkerProcess {
    return new PythonAssistiveWorkerProcess({
      workerRoot,
      pythonExecutable,
      pythonPrefixArguments: [],
      timeoutMs: 20_000,
      pulseIntervalMs: 1_000,
      ...options,
    });
  }

  function shimWorker(
    scenario: string,
    extraArguments: string[] = [],
    options: PythonWorkerOptions = {},
  ): PythonAssistiveWorkerProcess {
    return worker({
      workerRoot: spacedWorkerRoot,
      pythonPrefixArguments: [SHIM, scenario, ...extraArguments],
      timeoutMs: 5_000,
      pulseIntervalMs: 25,
      ...options,
    });
  }

  it('runs the production PNG path with exit 0, strict JSON, no implicit OCR, and a path with spaces', async () => {
    const result = await expectStagingCleanup(() => worker().run({
      content,
      documentType: 'PNG',
      ocrProvider: 'NONE',
    }));
    expect(result.error).toBeNull();
    expect(result.extraction?.status).toBe('OCR_REQUIRED');
    expect(result.extraction?.ocr_state).toBe('REQUIRED_NOT_RUN');
  });

  it('passes explicit Paddle selection and models path without a shell and degrades safely', async () => {
    const result = await expectStagingCleanup(() => worker({
      paddleModelsDir: join(tmpdir(), 'capstone-unprovisioned-paddle-models'),
    }).run({
      content,
      documentType: 'PNG',
      ocrProvider: 'PADDLE_TITLE',
      rasterDpi: 180,
    }));
    expect(result.error).toBeNull();
    expect(result.extraction).toMatchObject({
      status: 'OCR_REQUIRED',
      ocr_state: 'UNAVAILABLE',
      provider: { provider_id: 'paddleocr-local' },
    });
  });

  it('accepts only the coherent structured TASK_EXECUTION_FAILED result for exit 1', async () => {
    const result = await expectStagingCleanup(() => shimWorker('execution-failed').run({
      content,
      documentType: 'PNG',
    }));
    expect(result).toMatchObject({
      extraction: null,
      error: { code: 'TASK_EXECUTION_FAILED' },
    });
  });

  it('accepts only the coherent structured TASK_CONTRACT_REJECTED result for exit 2', async () => {
    const result = await expectStagingCleanup(() => shimWorker('contract-rejected').run({
      content,
      documentType: 'PNG',
    }));
    expect(result).toMatchObject({
      task_id: null,
      extraction: null,
      error: { code: 'TASK_CONTRACT_REJECTED' },
    });
  });

  it('rejects success-shaped JSON when the process exits nonzero', async () => {
    await expect(expectStagingCleanup(() => shimWorker('success-exit-one').run({
      content,
      documentType: 'PNG',
    }))).rejects.toMatchObject({ code: 'EXTRACTION_CONTRACT_REJECTED' });
  });

  it('treats an unexpected exit code as a worker crash', async () => {
    await expect(expectStagingCleanup(() => shimWorker('unexpected-exit').run({
      content,
      documentType: 'PNG',
    }))).rejects.toMatchObject({ code: 'WORKER_CRASHED' });
  });

  it('treats signal termination as a worker crash', async () => {
    await expect(expectStagingCleanup(() => shimWorker('signal').run({
      content,
      documentType: 'PNG',
    }))).rejects.toMatchObject({ code: 'WORKER_CRASHED' });
  });

  it('rejects malformed JSON from an otherwise successful process', async () => {
    await expect(expectStagingCleanup(() => shimWorker('malformed').run({
      content,
      documentType: 'PNG',
    }))).rejects.toMatchObject({ code: 'EXTRACTION_CONTRACT_REJECTED' });
  });

  it('rejects stdout beyond the four MiB process boundary', async () => {
    await expect(expectStagingCleanup(() => shimWorker('oversized-stdout').run({
      content,
      documentType: 'PNG',
    }))).rejects.toMatchObject({ code: 'EXTRACTION_CONTRACT_REJECTED' });
  });

  it.each([
    ['timeout', 'WORKER_TIMEOUT', undefined],
    ['cancellation', 'CANCELLED', 'CANCEL'],
    ['claim loss', 'CLAIM_LOST', 'CLAIM_LOST'],
  ] as const)('terminates the process tree on %s and removes staging', async (_name, code, pulseResult) => {
    const marker = join(spacedWorkerRoot, `descendant-${code}-${Date.now()}`);
    const ready = `${marker}.ready`;
    try {
      const processWorker = shimWorker('hang', [marker], { timeoutMs: 350 });
      await expect(expectStagingCleanup(() => processWorker.run({
        content,
        documentType: 'PNG',
        onPulse: pulseResult
          ? async () => existsSync(ready) ? pulseResult : 'CONTINUE'
          : undefined,
      }))).rejects.toMatchObject({ code });
      await wait(1_500);
      expect(existsSync(marker)).toBe(false);
    } finally {
      await rm(marker, { force: true });
      await rm(ready, { force: true });
    }
  });

  it('cleans staging when writing the fixed input file fails', async () => {
    await expect(expectStagingCleanup(() => worker().run({
      content: {} as Buffer,
      documentType: 'PNG',
    }))).rejects.toThrow();
  });

  it('cleans staging when the Python executable cannot be spawned', async () => {
    await expect(expectStagingCleanup(() => worker({
      workerRoot: spacedWorkerRoot,
      pythonExecutable: join(spacedWorkerRoot, 'missing-python-executable'),
    }).run({
      content,
      documentType: 'PNG',
    }))).rejects.toMatchObject({ code: 'WORKER_UNAVAILABLE' });
  });
});
