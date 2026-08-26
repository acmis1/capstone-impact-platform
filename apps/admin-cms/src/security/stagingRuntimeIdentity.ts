export type StagingRuntimeEnvironment = Record<string, string | undefined>;

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().trim();
  return (
    normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '[::1]'
  );
}

/**
 * Verifies the shared staging runtime and Supabase target identity without applying any
 * CLI-specific mutation acknowledgement semantics.
 */
export function assertVerifiedStagingRuntime(
  env: StagingRuntimeEnvironment = process.env,
): void {
  const runtimeEnv = env.CAPSTONE_RUNTIME_ENV;
  if (runtimeEnv !== 'staging') {
    throw new Error(
      'Staging Execution Refused: Environment identity is not configured for staging operations.',
    );
  }

  const expectedHost = env.CAPSTONE_EXPECTED_SUPABASE_HOST;
  if (!expectedHost || !expectedHost.trim()) {
    throw new Error('Staging Execution Refused: Expected target hostname is not configured.');
  }

  const supabaseUrlRaw = env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrlRaw || !supabaseUrlRaw.trim()) {
    throw new Error('Staging Execution Refused: Required Supabase URL variable is missing.');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(supabaseUrlRaw);
  } catch {
    throw new Error('Staging Execution Refused: Invalid target Supabase URL structure.');
  }

  if (parsedUrl.protocol !== 'https:') {
    throw new Error('Staging Execution Refused: Target URL must use secure HTTPS protocol.');
  }

  if (isLoopbackHost(parsedUrl.hostname)) {
    throw new Error('Staging Execution Refused: Staging operations cannot target loopback endpoints.');
  }

  if (parsedUrl.hostname.toLowerCase().trim() !== expectedHost.toLowerCase().trim()) {
    throw new Error(
      'Staging Execution Refused: Target hostname does not match expected staging target identity.',
    );
  }
}

/** Fail-closed boolean form for server-rendered and route-handler eligibility checks. */
export function isVerifiedStagingRuntime(
  env: StagingRuntimeEnvironment = process.env,
): boolean {
  try {
    assertVerifiedStagingRuntime(env);
    return true;
  } catch {
    return false;
  }
}
