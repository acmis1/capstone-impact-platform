import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { PythonAssistiveWorkerProcess } from '../services/pythonWorkerProcess';

const enabled = process.env.ASSISTIVE_PROCESS_INTEGRATION === '1';

describe.skipIf(!enabled)('Node-to-Python assistive task boundary', () => {
  it('runs the production PNG path with strict JSON and no implicit OCR', async () => {
    const workerRoot = resolve(process.cwd(), '../assistive-worker');
    const localPython = process.platform === 'win32'
      ? resolve(workerRoot, '.venv/Scripts/python.exe')
      : resolve(workerRoot, '.venv/bin/python');
    const pythonExecutable = process.env.ASSISTIVE_TEST_PYTHON
      ?? (existsSync(localPython) ? localPython : (process.platform === 'win32' ? 'python' : 'python3'));
    const worker = new PythonAssistiveWorkerProcess({
      workerRoot,
      pythonExecutable,
      pythonPrefixArguments: [],
      timeoutMs: 20_000,
      pulseIntervalMs: 1_000,
    });
    const content = readFileSync(resolve(workerRoot, 'tests/fixtures/canonical/valid.png'));
    const result = await worker.run({ content, documentType: 'PNG', ocrProvider: 'NONE' });
    expect(result.error).toBeNull();
    expect(result.extraction?.status).toBe('OCR_REQUIRED');
    expect(result.extraction?.ocr_state).toBe('REQUIRED_NOT_RUN');
  });
});
