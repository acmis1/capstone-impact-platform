import { describe, expect, it } from 'vitest';
import { safeProcessResult } from './safeSupabaseCli';

const sensitiveFixtures = [
  'C:\\Users\\Example\\project', '/tmp/acceptance', '\\\\server\\share\\project',
  'postgresql://fake:password@localhost/db', 'fake-token', 'file:///home/example/project',
];

describe('safe local process results', () => {
  it('keeps successful public results free of child buffers', () => {
    const result = safeProcessResult({ ok: true });
    expect(JSON.stringify(result)).not.toContain('stdout');
    expect(JSON.stringify(result)).not.toContain('stderr');
    sensitiveFixtures.forEach((value) => expect(JSON.stringify(result)).not.toContain(value));
  });

  it('keeps non-zero public results free of raw diagnostics', () => {
    const result = safeProcessResult({ ok: false, exitCode: 1 });
    expect(result).toEqual({ ok: false, exitCode: 1, signal: null, failureCategory: 'COMMAND_FAILED' });
    sensitiveFixtures.forEach((value) => expect(JSON.stringify(result)).not.toContain(value));
  });

  it('keeps signal and spawn failures category-only', () => {
    expect(safeProcessResult({ ok: false, signal: 'SIGTERM' })).toEqual({ ok: false, exitCode: null, signal: 'SIGTERM', failureCategory: 'SPAWN_FAILED' });
    expect(safeProcessResult({ ok: false })).toEqual({ ok: false, exitCode: null, signal: null, failureCategory: 'SPAWN_FAILED' });
  });
});

const operations = ['start', 'reset', 'environment', 'accounts', 'fixtures', 'verifier', 'stop', 'observer'] as const;
const noisyFixture = [
  'C:\\Users\\Example\\project', '/home/example/project', '\\\\server\\share\\project',
  'D:\\Repo With Spaces\\clone', 'postgresql://fake:password@localhost/db',
  'fake-password', 'fake-token', 'eyJhbGciOiJfake.payload.signature',
  'anon_fake_key', 'http://fake:password@127.0.0.1:54321', 'SERVICE_KEY=fake-value',
].join('\n');

const prohibitedPublicOutput = [...noisyFixture.split('\n'), '.env.local', '.local-users.json', 'apps/admin-cms/.env.local', 'apps/admin-cms/.local-users.json', 'output/credentials.json'];
function expectSafePublicOutput(value: unknown) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  prohibitedPublicOutput.forEach((fixture) => expect(serialized).not.toContain(fixture));
}

describe('table-driven local helper privacy contract', () => {
  it.each(operations)('%s noisy success exposes only a safe result', (operation) => {
    const internalAdapter = () => ({ stdout: noisyFixture, stderr: noisyFixture });
    const internal = internalAdapter();
    expect(internal.stdout).toContain('fake-token');
    const result = safeProcessResult({ ok: true });
    const publicValue = JSON.stringify({ operation, result });
    expect(publicValue).toContain(operation);
    expect(publicValue).not.toContain(noisyFixture);
    sensitiveFixtures.concat(noisyFixture.split('\n')).forEach((value) => expect(publicValue).not.toContain(value));
  });

  it.each(operations)('%s noisy failure exposes only a safe category', (operation) => {
    const internalAdapter = () => ({ stdout: noisyFixture, stderr: noisyFixture, status: 1 });
    const internal = internalAdapter();
    expect(internal.stderr).toContain('SERVICE_KEY');
    const result = safeProcessResult({ ok: false, exitCode: internal.status });
    const publicValue = JSON.stringify({ operation, result });
    expect(result.failureCategory).toBe('COMMAND_FAILED');
    expect(publicValue).not.toContain(noisyFixture);
    noisyFixture.split('\n').forEach((value) => expect(publicValue).not.toContain(value));
  });

  it.each([
    ['spawn failure', safeProcessResult({ ok: false })],
    ['timeout', safeProcessResult({ ok: false, signal: 'SIGTERM' })],
    ['signal termination', safeProcessResult({ ok: false, signal: 'SIGKILL' })],
  ])('%s serializes without raw child output', (_name, result) => {
    const serialized = JSON.stringify(result);
    expect(String(serialized)).not.toContain(noisyFixture);
    expect(serialized).not.toContain('cwd');
    expect(serialized).not.toContain('stdout');
    expect(serialized).not.toContain('stderr');
  });
});

describe('bounded setup privacy regressions', () => {
  it('destination helper success and failure messages are generic', () => {
    ['Local environment configuration completed.', 'Local environment configuration failed.', 'Local development accounts provisioned.', 'Local account provisioning failed.']
      .forEach((message) => expectSafePublicOutput(message));
  });

  it('logger-facing noisy helper results retain only safe messages', () => {
    const logs = ['Local Supabase start completed.', 'Local Supabase command failed during reset.'];
    logs.forEach(expectSafePublicOutput);
    expect(logs.join('\n')).toContain('start completed');
  });

  it('diagnostic persistence boundary does not expose the marker', () => {
    const publicReport = safeProcessResult({ ok: false, exitCode: 1 });
    expectSafePublicOutput(publicReport);
    expect(JSON.stringify(publicReport)).not.toContain('diagnostic-marker');
  });

  it('successful setup-facing messages do not include noisy helper data', () => {
    const messages = ['[PASS] Step 7 (supabase:verify:local) completed cleanly.', 'Start UI server with: npm run dev:admin'];
    messages.forEach(expectSafePublicOutput);
  });

  it.each(['cleanup succeeded', 'cleanup failed'])('setup failure cleanup message is generic: %s', (message) => {
    expectSafePublicOutput(message);
    expect(message).toContain('cleanup');
  });

  it('windows wrapper public result has no path, arguments, or streams', () => {
    const publicResult = safeProcessResult({ ok: false, exitCode: 1 });
    expectSafePublicOutput(publicResult);
    expect(JSON.stringify(publicResult)).not.toMatch(/cwd|args|stdout|stderr/i);
  });

  it.each(['RUNNING', 'STOPPED', 'DEGRADED', 'UNKNOWN'])('state observer result is category-only: %s', (state) => {
    expectSafePublicOutput({ state });
    expect(['RUNNING', 'STOPPED', 'DEGRADED', 'UNKNOWN']).toContain(state);
  });
});
