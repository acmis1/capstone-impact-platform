import type { ServerEnv } from '../lib/env';
import { classifySupabaseCredential } from '../lib/supabaseCredential';
import {
  isVerifiedStagingRuntime,
  type StagingRuntimeEnvironment,
} from '../security/stagingRuntimeIdentity';
import {
  EXPECTED_REPOSITORY_MIGRATIONS,
  EXPECTED_REPOSITORY_MIGRATION_COUNT,
} from './hostedDeploymentReadiness';

export const DEPENDENCY_READINESS_TIMEOUT_MS = 2_000;

const latestMigration = EXPECTED_REPOSITORY_MIGRATIONS[
  EXPECTED_REPOSITORY_MIGRATIONS.length - 1
].replace(/\.sql$/, '');

type CommitEvidence =
  | { state: 'valid'; value: string }
  | { state: 'missing' | 'invalid' };

export type DeploymentReadinessBody = {
  app: 'admin-cms';
  readiness: 'ready' | 'not-ready';
  classification: 'READY' | 'CONFIGURATION_NOT_READY' | 'DEPENDENCY_NOT_READY';
  configuration: 'configured' | 'not-ready';
  dependency: 'reachable' | 'not-checked' | 'not-ready';
  deploymentCommit: CommitEvidence;
  expectedMigrations: {
    count: number;
    latest: string;
  };
};

export type DeploymentReadinessResult = {
  status: 200 | 503;
  body: DeploymentReadinessBody;
};

type DeploymentReadinessOptions = {
  loadEnv: () => ServerEnv;
  renderGitCommit?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  runtimeEnv?: StagingRuntimeEnvironment;
};

function commitEvidence(value: string | undefined): CommitEvidence {
  if (!value) return { state: 'missing' };
  return /^[0-9a-f]{40}$/i.test(value)
    ? { state: 'valid', value: value.toLowerCase() }
    : { state: 'invalid' };
}

function hasValidCredentialSemantics(env: ServerEnv): boolean {
  const classifiedPublicCredential = classifySupabaseCredential(
    env.supabasePublicKey,
    false,
  );
  const publicCredentialIsValid =
    (classifiedPublicCredential === 'publishable' ||
      classifiedPublicCredential === 'legacy_anon_jwt') &&
    classifiedPublicCredential === env.publicKeyType;

  const classifiedDatabaseAdminCredential = classifySupabaseCredential(
    env.supabaseDatabaseAdminKey,
    true,
  );
  const databaseAdminCredentialIsValid =
    (classifiedDatabaseAdminCredential === 'secret' ||
      classifiedDatabaseAdminCredential === 'legacy_service_role_jwt') &&
    classifiedDatabaseAdminCredential === env.databaseAdminKeyType;

  return publicCredentialIsValid && databaseAdminCredentialIsValid;
}

function hasValidConfiguration(
  env: ServerEnv,
  runtimeEnv: StagingRuntimeEnvironment,
): boolean {
  let url: URL;
  try {
    url = new URL(env.supabaseUrl);
  } catch {
    return false;
  }

  return (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    (url.pathname === '/' || url.pathname === '') &&
    isVerifiedStagingRuntime({
      ...runtimeEnv,
      NEXT_PUBLIC_SUPABASE_URL: env.supabaseUrl,
    }) &&
    hasValidCredentialSemantics(env)
  );
}

function baseBody(renderGitCommit: string | undefined): Pick<
  DeploymentReadinessBody,
  'app' | 'deploymentCommit' | 'expectedMigrations'
> {
  return {
    app: 'admin-cms',
    deploymentCommit: commitEvidence(renderGitCommit),
    expectedMigrations: {
      count: EXPECTED_REPOSITORY_MIGRATION_COUNT,
      latest: latestMigration,
    },
  };
}

async function dependencyIsReachable(
  env: ServerEnv,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const endpoint = new URL('/rest/v1/programs', env.supabaseUrl);
    endpoint.searchParams.set('select', 'id');
    endpoint.searchParams.set('limit', '0');

    const headers: Record<string, string> = {
      Accept: 'application/json',
      apikey: env.supabaseDatabaseAdminKey,
    };
    if (!env.supabaseDatabaseAdminKey.startsWith('sb_')) {
      headers.Authorization = `Bearer ${env.supabaseDatabaseAdminKey}`;
    }

    const response = await fetchImpl(endpoint, {
      method: 'HEAD',
      headers,
      body: undefined,
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getDeploymentReadiness({
  loadEnv,
  renderGitCommit,
  fetchImpl = fetch,
  timeoutMs = DEPENDENCY_READINESS_TIMEOUT_MS,
  runtimeEnv = process.env,
}: DeploymentReadinessOptions): Promise<DeploymentReadinessResult> {
  const evidence = baseBody(renderGitCommit);

  let env: ServerEnv;
  try {
    env = loadEnv();
  } catch {
    return {
      status: 503,
      body: {
        ...evidence,
        readiness: 'not-ready',
        classification: 'CONFIGURATION_NOT_READY',
        configuration: 'not-ready',
        dependency: 'not-checked',
      },
    };
  }

  if (!hasValidConfiguration(env, runtimeEnv)) {
    return {
      status: 503,
      body: {
        ...evidence,
        readiness: 'not-ready',
        classification: 'CONFIGURATION_NOT_READY',
        configuration: 'not-ready',
        dependency: 'not-checked',
      },
    };
  }

  if (!(await dependencyIsReachable(env, fetchImpl, timeoutMs))) {
    return {
      status: 503,
      body: {
        ...evidence,
        readiness: 'not-ready',
        classification: 'DEPENDENCY_NOT_READY',
        configuration: 'configured',
        dependency: 'not-ready',
      },
    };
  }

  return {
    status: 200,
    body: {
      ...evidence,
      readiness: 'ready',
      classification: 'READY',
      configuration: 'configured',
      dependency: 'reachable',
    },
  };
}
