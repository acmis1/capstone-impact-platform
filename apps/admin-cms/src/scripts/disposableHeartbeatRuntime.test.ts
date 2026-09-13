import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../../..');

describe('heartbeat runtime ownership boundary', () => {
  it('routes the supported command through the owned disposable provisioner', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'apps/admin-cms/package.json'), 'utf8'));
    expect(manifest.scripts['verify:assistive-worker-heartbeat-runtime'])
      .toBe('tsx src/scripts/runDisposableLedgerRuntime.ts worker-heartbeat');
  });

  it('refuses direct execution without disposable acknowledgement before inspecting a stack', () => {
    const result = spawnSync(process.execPath, [
      path.join(root, 'node_modules/tsx/dist/cli.mjs'),
      path.join(root, 'apps/admin-cms/src/scripts/verifyAssistiveWorkerHeartbeatRuntime.ts'),
    ], { cwd: root, encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, CAPSTONE_VERIFY_DISPOSABLE: '0' } });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Disposable verifier acknowledgement is required.');
  });
});
