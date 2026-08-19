import { describe, expect, it } from 'vitest';
import { rewriteDockerCreateBody } from './dockerLoopbackProxy';
import {
  classifyDockerNetworkInspection,
  classifyDockerPortBindings,
  DOCKER_HOST_BINDING_OPTION,
  dockerProxyCustomHeaders,
  ensureLocalDockerNetwork,
  EXPECTED_LOCAL_PUBLISHED_PORTS,
  LOCAL_DOCKER_NETWORK_NAME,
  revalidateLocalDockerNetwork,
  safeProcessResult,
  supabaseCommandArguments,
} from './safeSupabaseCli';

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
    expect(safeProcessResult({ ok: false, signal: 'SIGTERM' })).toEqual({ ok: false, exitCode: null, signal: 'SIGTERM', failureCategory: 'COMMAND_TERMINATED' });
    expect(safeProcessResult({ ok: false })).toEqual({ ok: false, exitCode: null, signal: null, failureCategory: 'SPAWN_FAILED' });
  });
});

const expectedNetworkId = 'sha256:synthetic-safe-network-id';

function dockerNetworkInspection(
  networkId = expectedNetworkId,
  name = LOCAL_DOCKER_NETWORK_NAME,
  driver = 'bridge',
  hostBinding = '127.0.0.1',
): string {
  return [networkId, name, driver, { [DOCKER_HOST_BINDING_OPTION]: hostBinding }]
    .map((value) => JSON.stringify(value))
    .join('|');
}

function dockerBindingInspection(hostIps: string[] = ['127.0.0.1'], networkId = expectedNetworkId): string {
  const ports = Object.fromEntries(EXPECTED_LOCAL_PUBLISHED_PORTS.map((hostPort, index) => [
    `${8000 + index}/tcp`,
    [{ HostIp: hostIps[index % hostIps.length], HostPort: String(hostPort) }],
  ]));
  return `${JSON.stringify(ports)}|${JSON.stringify({ [LOCAL_DOCKER_NETWORK_NAME]: { NetworkID: networkId } })}`;
}

describe('project Docker network contract', () => {
  const validInspection = dockerNetworkInspection();

  it('recognizes only the required bridge driver option as safe', () => {
    expect(classifyDockerNetworkInspection(validInspection)).toEqual({
      ok: true,
      category: 'NETWORK_REUSED',
      networkId: expectedNetworkId,
    });
    expect(classifyDockerNetworkInspection(dockerNetworkInspection(expectedNetworkId, LOCAL_DOCKER_NETWORK_NAME, 'bridge', '0.0.0.0')))
      .toEqual({ ok: false, category: 'NETWORK_INCOMPATIBLE' });
    expect(classifyDockerNetworkInspection(dockerNetworkInspection(expectedNetworkId, LOCAL_DOCKER_NETWORK_NAME, 'overlay')))
      .toEqual({ ok: false, category: 'NETWORK_INCOMPATIBLE' });
    expect(classifyDockerNetworkInspection(dockerNetworkInspection(expectedNetworkId, 'replacement-network')))
      .toEqual({ ok: false, category: 'NETWORK_INCOMPATIBLE' });
    expect(classifyDockerNetworkInspection('ambiguous')).toEqual({ ok: false, category: 'NETWORK_INSPECTION_FAILED' });
  });

  it('reuses an existing valid network without creating it again', () => {
    const calls: string[][] = [];
    const result = ensureLocalDockerNetwork((args) => {
      calls.push(args);
      return args[1] === 'ls' ? `${LOCAL_DOCKER_NETWORK_NAME}\n` : validInspection;
    });

    expect(result).toEqual({ ok: true, category: 'NETWORK_REUSED', networkId: expectedNetworkId });
    expect(calls.some((args) => args.includes('create'))).toBe(false);
  });

  it('creates a missing network once and validates it before use', () => {
    const calls: string[][] = [];
    const result = ensureLocalDockerNetwork((args) => {
      calls.push(args);
      if (args[1] === 'ls') return '';
      if (args[1] === 'create') return 'opaque-network-id';
      return validInspection;
    });

    expect(result).toEqual({ ok: true, category: 'NETWORK_CREATED', networkId: expectedNetworkId });
    expect(calls.filter((args) => args[1] === 'create')).toHaveLength(1);
  });

  it('fails closed for an incompatible existing same-named network', () => {
    const calls: string[][] = [];
    const result = ensureLocalDockerNetwork((args) => {
      calls.push(args);
      if (args[1] === 'ls') return `${LOCAL_DOCKER_NETWORK_NAME}\n`;
      return dockerNetworkInspection(expectedNetworkId, LOCAL_DOCKER_NETWORK_NAME, 'bridge', '0.0.0.0');
    });

    expect(result).toEqual({ ok: false, category: 'NETWORK_INCOMPATIBLE' });
    expect(calls.some((args) => args.includes('create'))).toBe(false);
  });

  it('fails closed when post-start inspection returns a replacement network identity', () => {
    const replacementId = 'sha256:synthetic-replacement-network-id';
    const calls: string[][] = [];
    const result = revalidateLocalDockerNetwork(expectedNetworkId, (args) => {
      calls.push(args);
      return dockerNetworkInspection(replacementId);
    });

    expect(result).toEqual({ ok: false, category: 'NETWORK_INCOMPATIBLE' });
    expect(calls[0]).toContain(expectedNetworkId);
  });
});

describe('structured Docker binding classification', () => {
  it('accepts IPv4 and supported IPv6 loopback representations', () => {
    expect(classifyDockerPortBindings(dockerBindingInspection(['127.0.0.1']), expectedNetworkId)).toEqual({
      ok: true,
      category: 'SAFE',
      publishedPorts: [...EXPECTED_LOCAL_PUBLISHED_PORTS],
    });
    expect(classifyDockerPortBindings(dockerBindingInspection(['::1', '[::1]']), expectedNetworkId).ok).toBe(true);
  });

  it.each(['0.0.0.0', '::', '[::]', '', '192.168.1.20'])('rejects unsafe or ambiguous HostIp %j', (hostIp) => {
    expect(classifyDockerPortBindings(dockerBindingInspection([hostIp]), expectedNetworkId).category).toBe('UNSAFE_PORT_BINDING');
  });

  it('rejects missing ports, malformed inspection, and the wrong immutable network identity', () => {
    expect(classifyDockerPortBindings('', expectedNetworkId).category).toBe('MISSING_PORT_BINDING');
    expect(classifyDockerPortBindings('not-json|{}', expectedNetworkId).category).toBe('DOCKER_INSPECTION_FAILED');
    expect(classifyDockerPortBindings(dockerBindingInspection(['127.0.0.1'], 'sha256:wrong-network'), expectedNetworkId).category)
      .toBe('WRONG_DOCKER_NETWORK');
  });
});

describe('Supabase Docker API compatibility boundary', () => {
  it('sets every published container binding to explicit IPv4 loopback without changing its port', () => {
    const raw = Buffer.from(JSON.stringify({
      Image: 'synthetic-image',
      HostConfig: {
        PortBindings: {
          '8000/tcp': [{ HostIp: '', HostPort: '54321' }],
          '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '54322' }],
        },
      },
    }));
    const rewritten = JSON.parse(rewriteDockerCreateBody(raw).toString('utf8'));
    expect(rewritten.HostConfig.PortBindings).toEqual({
      '8000/tcp': [{ HostIp: '127.0.0.1', HostPort: '54321' }],
      '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '54322' }],
    });
    expect(rewritten.Image).toBe('synthetic-image');
  });

  it('normalizes empty and null explicit bindings without inventing a HostPort', () => {
    const raw = Buffer.from(JSON.stringify({
      HostConfig: {
        PortBindings: {
          '8000/tcp': [],
          '5432/tcp': null,
        },
      },
    }));
    const rewritten = JSON.parse(rewriteDockerCreateBody(raw).toString('utf8'));
    expect(rewritten.HostConfig.PortBindings).toEqual({
      '8000/tcp': [{ HostIp: '127.0.0.1' }],
      '5432/tcp': [{ HostIp: '127.0.0.1' }],
    });
  });

  it('fails closed for PublishAllPorts and leaves absent publication configuration untouched', () => {
    const publishAll = Buffer.from(JSON.stringify({
      Image: 'synthetic-image',
      HostConfig: { PublishAllPorts: true },
    }));
    expect(() => rewriteDockerCreateBody(publishAll)).toThrow('UNSAFE_DOCKER_AUTO_PUBLISH');

    const absent = Buffer.from(JSON.stringify({ Image: 'synthetic-image', HostConfig: { Memory: 1024 } }));
    expect(rewriteDockerCreateBody(absent)).toBe(absent);
  });

  it('passes the deterministic network to start, stop, status, and reset', () => {
    expect(supabaseCommandArguments('start')).toEqual([
      'start', '--exclude', 'vector', '--workdir', 'infra', '--network-id', LOCAL_DOCKER_NETWORK_NAME,
    ]);
    expect(supabaseCommandArguments('stop')).toEqual(['stop', '--workdir', 'infra', '--network-id', LOCAL_DOCKER_NETWORK_NAME]);
    expect(supabaseCommandArguments('status')).toEqual(['status', '--workdir', 'infra', '--network-id', LOCAL_DOCKER_NETWORK_NAME]);
    expect(supabaseCommandArguments('reset')).toEqual(['db', 'reset', '--local', '--workdir', 'infra', '--network-id', LOCAL_DOCKER_NETWORK_NAME]);
    expect(supabaseCommandArguments('start', expectedNetworkId)).toEqual([
      'start', '--exclude', 'vector', '--workdir', 'infra', '--network-id', expectedNetworkId,
    ]);
  });

  it('injects one proxy authorization header while preserving unrelated Docker headers', () => {
    const headers = dockerProxyCustomHeaders(
      'X-Synthetic-Existing=kept,x-capstone-docker-proxy-auth=obsolete',
      'synthetic-current-auth-value',
    );
    expect(headers).toBe('X-Synthetic-Existing=kept,x-capstone-docker-proxy-auth=synthetic-current-auth-value');
    expect(headers.match(/x-capstone-docker-proxy-auth/gi)).toHaveLength(1);
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
