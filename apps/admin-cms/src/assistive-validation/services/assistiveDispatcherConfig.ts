import { assertVerifiedStagingRuntime, type StagingRuntimeEnvironment } from '../../security/stagingRuntimeIdentity';

export interface AssistiveDispatcherConfig {
  readonly dispatcherInstanceId: string;
  readonly databaseUrl: string;
  readonly deploymentVersion: string;
  readonly imageDigest: string;
  readonly launcher: {
    readonly identityEndpoint: string;
    readonly identityHeader: string;
    readonly managedIdentityClientId: string;
    readonly subscriptionId: string;
    readonly resourceGroup: string;
    readonly jobName: string;
  };
}

function required(env: StagingRuntimeEnvironment, name: string): string {
  const value = env[name];
  if (!value || value !== value.trim()) {
    throw new Error(`Assistive dispatcher configuration is invalid: ${name}.`);
  }
  return value;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AZURE_NAME = /^[-\w._()]{1,90}$/;
const SUPABASE_HOST_SUFFIX = '.supabase.co';
const SUPAVISOR_POOLER_HOST_SUFFIX = '.pooler.supabase.com';

function verifiedSupabaseProjectRef(supabaseUrl: string): string {
  const hostname = new URL(supabaseUrl).hostname;
  if (!hostname.endsWith(SUPABASE_HOST_SUFFIX)) {
    throw new Error('Assistive dispatcher Supabase project identity is invalid.');
  }
  const projectRef = hostname.slice(0, -SUPABASE_HOST_SUFFIX.length);
  if (!projectRef) {
    throw new Error('Assistive dispatcher Supabase project identity is invalid.');
  }
  return projectRef;
}

function assertDispatcherDatabaseUrl(databaseUrl: string, projectRef: string): void {
  let parsedDatabaseUrl: URL;
  try {
    parsedDatabaseUrl = new URL(databaseUrl);
  } catch {
    throw new Error('Assistive dispatcher database URL is invalid.');
  }
  if (parsedDatabaseUrl.protocol !== 'postgresql:' && parsedDatabaseUrl.protocol !== 'postgres:') {
    throw new Error('Assistive dispatcher database URL is invalid.');
  }
  if (parsedDatabaseUrl.search || parsedDatabaseUrl.hash
      || parsedDatabaseUrl.hostname.endsWith('.')
      || !parsedDatabaseUrl.hostname.endsWith(SUPAVISOR_POOLER_HOST_SUFFIX)
      || parsedDatabaseUrl.port !== '5432'
      || parsedDatabaseUrl.pathname !== '/postgres') {
    throw new Error('Assistive dispatcher database URL is not the approved Supavisor session-pooler target.');
  }

  let username: string;
  let password: string;
  try {
    username = decodeURIComponent(parsedDatabaseUrl.username);
    password = decodeURIComponent(parsedDatabaseUrl.password);
  } catch {
    throw new Error('Assistive dispatcher database URL is invalid.');
  }
  if (username !== `capstone_assistive_dispatcher.${projectRef}`) {
    throw new Error('Assistive dispatcher database URL does not use the dedicated execution-control role.');
  }
  if (!password) {
    throw new Error('Assistive dispatcher database URL is missing a password.');
  }
}

/**
 * Fail-closed dispatcher configuration.
 *
 * The dispatcher holds no service-role credential: its database URL authenticates as the dedicated
 * least-privilege execution-control role, and its cloud authority comes from a managed identity
 * rather than a stored client secret.
 */
export function getAssistiveDispatcherConfig(
  env: StagingRuntimeEnvironment = process.env,
): AssistiveDispatcherConfig {
  if (env.CAPSTONE_ASSISTIVE_HOSTED_EXECUTION_ENABLED !== 'true') {
    throw new Error('Hosted assistive execution is not explicitly enabled.');
  }
  const supabaseUrl = required(env, 'CAPSTONE_ASSISTIVE_SUPABASE_URL');
  assertVerifiedStagingRuntime({ ...env, NEXT_PUBLIC_SUPABASE_URL: supabaseUrl });
  const projectRef = verifiedSupabaseProjectRef(supabaseUrl);

  const dispatcherInstanceId = required(env, 'CAPSTONE_ASSISTIVE_DISPATCHER_INSTANCE_ID');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(dispatcherInstanceId)) {
    throw new Error('Assistive dispatcher instance identity is invalid.');
  }

  const databaseUrl = required(env, 'CAPSTONE_ASSISTIVE_DISPATCHER_DB_URL');
  assertDispatcherDatabaseUrl(databaseUrl, projectRef);

  const deploymentVersion = required(env, 'CAPSTONE_DEPLOYMENT_VERSION').toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(deploymentVersion)) {
    throw new Error('Assistive dispatcher deployment identity is invalid.');
  }
  const imageDigest = required(env, 'CAPSTONE_ASSISTIVE_IMAGE_DIGEST').toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/.test(imageDigest)) {
    throw new Error('Assistive dispatcher worker image identity is invalid.');
  }

  const subscriptionId = required(env, 'AZURE_SUBSCRIPTION_ID').toLowerCase();
  const managedIdentityClientId = required(env, 'AZURE_CLIENT_ID').toLowerCase();
  if (!UUID.test(subscriptionId) || !UUID.test(managedIdentityClientId)) {
    throw new Error('Assistive dispatcher cloud identity is invalid.');
  }
  const resourceGroup = required(env, 'AZURE_RESOURCE_GROUP');
  const jobName = required(env, 'CAPSTONE_ASSISTIVE_WORKER_JOB_NAME');
  if (!AZURE_NAME.test(resourceGroup) || !AZURE_NAME.test(jobName)) {
    throw new Error('Assistive dispatcher cloud target is invalid.');
  }

  const identityEndpoint = required(env, 'IDENTITY_ENDPOINT');
  let parsedIdentityEndpoint: URL;
  try {
    parsedIdentityEndpoint = new URL(identityEndpoint);
  } catch {
    throw new Error('Assistive dispatcher managed identity endpoint is invalid.');
  }
  if (parsedIdentityEndpoint.protocol !== 'http:' && parsedIdentityEndpoint.protocol !== 'https:') {
    throw new Error('Assistive dispatcher managed identity endpoint is invalid.');
  }

  return {
    dispatcherInstanceId,
    databaseUrl,
    deploymentVersion,
    imageDigest,
    launcher: {
      identityEndpoint,
      identityHeader: required(env, 'IDENTITY_HEADER'),
      managedIdentityClientId,
      subscriptionId,
      resourceGroup,
      jobName,
    },
  };
}
