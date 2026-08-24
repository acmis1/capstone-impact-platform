import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  getServerEnv: vi.fn(),
}));

vi.mock('../../../lib/env', () => ({ getServerEnv: mocks.getServerEnv }));

import { GET, HEAD } from './route';

const VALID_COMMIT = 'A75F4D8861CE693DDD264F9797D8AF656911154F';
const VALID_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://synthetic-readiness.supabase.co',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_public-test-value',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'sb_publishable_public-test-value',
  supabaseUrl: 'https://synthetic-readiness.supabase.co',
  supabasePublicKey: 'sb_publishable_public-test-value',
  publicKeyType: 'publishable',
  SUPABASE_SECRET_KEY: 'sb_secret_server-test-value',
  SUPABASE_SERVICE_ROLE_KEY: '',
  supabaseDatabaseAdminKey: 'sb_secret_server-test-value',
  databaseAdminKeyType: 'secret',
  databaseAdminKeyMode: 'secret_key_preferred',
  SUPABASE_DRAFT_BUCKET: 'project-drafts-private',
  SUPABASE_PUBLIC_ASSETS_BUCKET: 'project-public-assets',
  SUPABASE_PUBLIC_FEEDS_BUCKET: 'public-feeds',
  SUPABASE_PUBLIC_FEED_FILE: 'capstones-latest.json',
};

function syntheticJwt(payload: unknown) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), 'utf8').toString(
    'base64url',
  );
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${header}.${encodedPayload}.synthetic-signature`;
}

function syntheticJwtWithPayloadSegment(payloadSegment: string) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), 'utf8').toString(
    'base64url',
  );
  return `${header}.${payloadSegment}.synthetic-signature`;
}

const LEGACY_ANON_JWT = syntheticJwt({ role: 'anon' });
const LEGACY_SERVICE_ROLE_JWT = syntheticJwt({ role: 'service_role' });

function legacyEnv(publicKey = LEGACY_ANON_JWT, databaseAdminKey = LEGACY_SERVICE_ROLE_JWT) {
  return {
    ...VALID_ENV,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publicKey,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: publicKey,
    supabasePublicKey: publicKey,
    publicKeyType: 'legacy_anon_jwt',
    SUPABASE_SECRET_KEY: '',
    SUPABASE_SERVICE_ROLE_KEY: databaseAdminKey,
    supabaseDatabaseAdminKey: databaseAdminKey,
    databaseAdminKeyType: 'legacy_service_role_jwt',
    databaseAdminKeyMode: 'legacy_service_role_jwt_fallback',
  };
}

function successfulFetch() {
  return vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
}

async function json(response: Response) {
  expect(response.headers.get('Cache-Control')).toContain('no-store');
  expect(response.headers.get('Pragma')).toBe('no-cache');
  return response.json();
}

describe('GET/HEAD /api/readiness', () => {
  const originalCommit = process.env.RENDER_GIT_COMMIT;
  const originalRuntime = process.env.CAPSTONE_RUNTIME_ENV;
  const originalExpectedHost = process.env.CAPSTONE_EXPECTED_SUPABASE_HOST;

  beforeEach(() => {
    mocks.getServerEnv.mockReset();
    mocks.getServerEnv.mockReturnValue(VALID_ENV);
    delete process.env.RENDER_GIT_COMMIT;
    process.env.CAPSTONE_RUNTIME_ENV = 'staging';
    process.env.CAPSTONE_EXPECTED_SUPABASE_HOST = 'synthetic-readiness.supabase.co';
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (originalCommit === undefined) delete process.env.RENDER_GIT_COMMIT;
    else process.env.RENDER_GIT_COMMIT = originalCommit;
    if (originalRuntime === undefined) delete process.env.CAPSTONE_RUNTIME_ENV;
    else process.env.CAPSTONE_RUNTIME_ENV = originalRuntime;
    if (originalExpectedHost === undefined) delete process.env.CAPSTONE_EXPECTED_SUPABASE_HOST;
    else process.env.CAPSTONE_EXPECTED_SUPABASE_HOST = originalExpectedHost;
  });

  async function expectConfigurationNotReadyWithoutFetch(
    env: Record<string, unknown>,
    privateValues: string[] = [],
  ) {
    const fetchMock = successfulFetch();
    vi.stubGlobal('fetch', fetchMock);
    mocks.getServerEnv.mockReturnValue(env);

    const response = await GET();
    const body = await json(response);
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      readiness: 'not-ready',
      classification: 'CONFIGURATION_NOT_READY',
      configuration: 'not-ready',
      dependency: 'not-checked',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    for (const privateValue of privateValues) {
      expect(serialized).not.toContain(privateValue);
    }
  }

  it('accepts modern publishable public and secret server credentials for the dependency probe', async () => {
    const fetchMock = successfulFetch();
    vi.stubGlobal('fetch', fetchMock);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      app: 'admin-cms',
      readiness: 'ready',
      classification: 'READY',
      configuration: 'configured',
      dependency: 'reachable',
      deploymentCommit: { state: 'missing' },
      expectedMigrations: {
        count: 35,
        latest: '20260824183000_public_feed_writer_protocol',
      },
    });
  });

  it('rejects a modern secret key in the public slot before the dependency probe', async () => {
    const misplacedSecret = 'sb_secret_misplaced-public-private-value';
    await expectConfigurationNotReadyWithoutFetch(
      {
        ...VALID_ENV,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: misplacedSecret,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: misplacedSecret,
        supabasePublicKey: misplacedSecret,
      },
      [misplacedSecret],
    );
  });

  it('rejects a modern publishable key in the database-admin slot before the dependency probe', async () => {
    const misplacedPublishable = 'sb_publishable_misplaced-server-private-value';
    await expectConfigurationNotReadyWithoutFetch(
      {
        ...VALID_ENV,
        SUPABASE_SECRET_KEY: misplacedPublishable,
        supabaseDatabaseAdminKey: misplacedPublishable,
      },
      [misplacedPublishable],
    );
  });

  it('accepts a structurally valid anon legacy JWT in the public slot', async () => {
    const fetchMock = successfulFetch();
    vi.stubGlobal('fetch', fetchMock);
    mocks.getServerEnv.mockReturnValue({
      ...VALID_ENV,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: LEGACY_ANON_JWT,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: LEGACY_ANON_JWT,
      supabasePublicKey: LEGACY_ANON_JWT,
      publicKeyType: 'legacy_anon_jwt',
    });

    expect((await GET()).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('accepts a structurally valid service_role legacy JWT in the database-admin slot', async () => {
    const fetchMock = successfulFetch();
    vi.stubGlobal('fetch', fetchMock);
    mocks.getServerEnv.mockReturnValue({
      ...VALID_ENV,
      SUPABASE_SECRET_KEY: '',
      SUPABASE_SERVICE_ROLE_KEY: LEGACY_SERVICE_ROLE_JWT,
      supabaseDatabaseAdminKey: LEGACY_SERVICE_ROLE_JWT,
      databaseAdminKeyType: 'legacy_service_role_jwt',
      databaseAdminKeyMode: 'legacy_service_role_jwt_fallback',
    });

    expect((await GET()).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('allows a correct anon and service_role legacy JWT pair to reach READY', async () => {
    const fetchMock = successfulFetch();
    vi.stubGlobal('fetch', fetchMock);
    mocks.getServerEnv.mockReturnValue(legacyEnv());

    const response = await GET();
    const body = await json(response);
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ classification: 'READY' });
    expect(serialized).not.toContain(LEGACY_ANON_JWT);
    expect(serialized).not.toContain(LEGACY_SERVICE_ROLE_JWT);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects a service_role legacy JWT in the public slot without exposing it', async () => {
    await expectConfigurationNotReadyWithoutFetch(
      legacyEnv(LEGACY_SERVICE_ROLE_JWT),
      [LEGACY_SERVICE_ROLE_JWT],
    );
  });

  it('rejects an anon legacy JWT in the database-admin slot without exposing it', async () => {
    await expectConfigurationNotReadyWithoutFetch(
      legacyEnv(LEGACY_ANON_JWT, LEGACY_ANON_JWT),
      [LEGACY_ANON_JWT],
    );
  });

  it.each([
    ['token without exactly three segments', 'only.two'],
    ['malformed three-part structure', 'synthetic-header..synthetic-signature'],
    ['invalid base64url payload', syntheticJwtWithPayloadSegment('%%%private-malformed%%%')],
    [
      'invalid JSON payload',
      syntheticJwtWithPayloadSegment(Buffer.from('private-not-json', 'utf8').toString('base64url')),
    ],
    ['payload missing role', syntheticJwt({ synthetic_private_claim: 'missing-role' })],
    ['unexpected role', syntheticJwt({ role: 'authenticated' })],
    ['non-object payload', syntheticJwt('private-non-object-payload')],
  ])('rejects a legacy JWT with %s before fetch and does not reflect it', async (_label, token) => {
    await expectConfigurationNotReadyWithoutFetch(legacyEnv(token), [token]);
  });

  it('uses one zero-row dependency HEAD and never invokes an RPC or mutation', async () => {
    const fetchMock = successfulFetch();
    vi.stubGlobal('fetch', fetchMock);

    await GET();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [input, init] = fetchMock.mock.calls[0];
    const url = String(input);
    expect(url).toBe('https://synthetic-readiness.supabase.co/rest/v1/programs?select=id&limit=0');
    expect(url).not.toContain('/rpc/');
    expect(init?.method).toBe('HEAD');
    expect(init?.body).toBeUndefined();
    expect(init?.cache).toBe('no-store');
    expect(init?.redirect).toBe('error');
  });

  it('fails closed when critical server configuration cannot be loaded', async () => {
    const fetchMock = successfulFetch();
    vi.stubGlobal('fetch', fetchMock);
    mocks.getServerEnv.mockImplementation(() => {
      throw new Error('configuration provider included a private credential');
    });

    const response = await GET();
    const body = await json(response);

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      readiness: 'not-ready',
      classification: 'CONFIGURATION_NOT_READY',
      configuration: 'not-ready',
      dependency: 'not-checked',
    });
    expect(JSON.stringify(body)).not.toContain('private credential');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed on a malformed critical URL or unrecognized key type', async () => {
    vi.stubGlobal('fetch', successfulFetch());
    mocks.getServerEnv.mockReturnValue({
      ...VALID_ENV,
      supabaseUrl: 'ftp://user:password@synthetic-readiness.supabase.co/private',
      publicKeyType: 'unknown',
    });

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await json(response)).toMatchObject({
      classification: 'CONFIGURATION_NOT_READY',
      dependency: 'not-checked',
    });
  });

  it('fails closed when the configured dependency is not the expected staging target', async () => {
    const fetchMock = successfulFetch();
    vi.stubGlobal('fetch', fetchMock);
    process.env.CAPSTONE_EXPECTED_SUPABASE_HOST = 'different-staging.supabase.co';

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await json(response)).toMatchObject({
      classification: 'CONFIGURATION_NOT_READY',
      dependency: 'not-checked',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns a sanitized 503 when the dependency is unavailable', async () => {
    const providerMessage = 'provider failed for staff@example.test and private-project-row';
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error(providerMessage);
    }));

    const response = await GET();
    const body = await json(response);
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      classification: 'DEPENDENCY_NOT_READY',
      configuration: 'configured',
      dependency: 'not-ready',
    });
    expect(serialized).not.toContain(providerMessage);
    expect(serialized).not.toContain(VALID_ENV.supabasePublicKey);
    expect(serialized).not.toContain(VALID_ENV.supabaseDatabaseAdminKey);
    expect(serialized).not.toMatch(/staff@example|private-project|service.role|credential/i);
  });

  it('aborts a dependency probe after the short readiness timeout', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('private timeout detail')), {
          once: true,
        });
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const responsePromise = GET();
    await vi.advanceTimersByTimeAsync(2_000);
    const response = await responsePromise;

    expect(response.status).toBe(503);
    expect(await json(response)).toMatchObject({ classification: 'DEPENDENCY_NOT_READY' });
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('surfaces only syntactically valid Render commit metadata', async () => {
    vi.stubGlobal('fetch', successfulFetch());
    process.env.RENDER_GIT_COMMIT = 'invalid-commit-private-value';
    let response = await GET();
    let body = await json(response);
    expect(body.deploymentCommit).toEqual({ state: 'invalid' });
    expect(JSON.stringify(body)).not.toContain('invalid-commit-private-value');

    process.env.RENDER_GIT_COMMIT = VALID_COMMIT;
    response = await GET();
    body = await json(response);
    expect(body.deploymentCommit).toEqual({ state: 'valid', value: VALID_COMMIT.toLowerCase() });
  });

  it('returns the same status and no body for HEAD', async () => {
    vi.stubGlobal('fetch', successfulFetch());

    const response = await HEAD();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
    expect(await response.text()).toBe('');
  });

  it('keeps HEAD fail-closed and bodyless when readiness fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));

    const response = await HEAD();

    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(await response.text()).toBe('');
  });
});
