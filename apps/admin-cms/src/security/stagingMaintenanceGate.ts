import { NextResponse } from 'next/server';

export type StagingMaintenanceEnvironment = Record<string, string | undefined>;

export const STAGING_MAINTENANCE_MODE_VAR = 'CAPSTONE_STAGING_MAINTENANCE_MODE';

/**
 * Only an exact server-side `true` enables the rollout maintenance gate. Permissive truthy
 * parsing is deliberately absent: an operator must not be able to half-enable a control whose
 * whole purpose is to deny traffic, and an unrelated value must never enable it by accident.
 */
export function isStagingMaintenanceModeEnabledValue(value: string | null | undefined): boolean {
  return value === 'true';
}

/**
 * Read at request time rather than module scope so the flag is never captured by a stale
 * process snapshot. The value is still fixed for the life of a server process, so a change
 * requires a restart or redeployment and must be verified by observation, never assumed.
 *
 * The gate is intentionally NOT conditional on `CAPSTONE_RUNTIME_ENV`. A deny control that a
 * second variable can silently switch off is not fail-closed; if an operator sets this flag,
 * traffic is blocked wherever it is set. `CAPSTONE_EXPECTED_SUPABASE_HOST`,
 * `CAPSTONE_STAGING_MUTATION_CONFIRMATION` and `CAPSTONE_STAGING_PUBLICATION_ENABLED` keep
 * their own separate responsibilities and are neither read nor weakened here.
 */
export function isStagingMaintenanceModeEnabled(
  env: StagingMaintenanceEnvironment = process.env,
): boolean {
  return isStagingMaintenanceModeEnabledValue(env[STAGING_MAINTENANCE_MODE_VAR]);
}

/**
 * The only application surfaces the controlled rollout window needs: the read-only H2 probes.
 * Matched exactly and case-sensitively — no prefix, casing, trailing-slash or sub-path variant
 * widens this set.
 */
export const STAGING_MAINTENANCE_ALLOWED_PATHNAMES: readonly string[] = [
  '/api/health',
  '/api/readiness',
  '/login',
];

/** An allowed pathname reached with any other method is still blocked. */
export const STAGING_MAINTENANCE_ALLOWED_METHODS: readonly string[] = ['GET', 'HEAD'];

export const STAGING_MAINTENANCE_MARKER_HEADER = 'X-Capstone-Maintenance';
export const STAGING_MAINTENANCE_MARKER_VALUE = 'staging-rollout';
export const STAGING_MAINTENANCE_RETRY_AFTER_SECONDS = 300;

/**
 * Fixed, privacy-safe body. It derives nothing from the request, the environment, the database,
 * the deployment target or the provider, and it carries no stack trace.
 */
export const STAGING_MAINTENANCE_RESPONSE_BODY =
  'Service Unavailable. This environment is closed for scheduled maintenance.\n';

export type StagingMaintenanceDecision = 'DISABLED' | 'ALLOWED' | 'BLOCKED';

/**
 * Decides a single request against the gate using only its method and its pathname. The query
 * string is deliberately not part of the input, so no query can broaden the allowlist.
 */
export function evaluateStagingMaintenanceGate(params: {
  method: string;
  pathname: string;
  env?: StagingMaintenanceEnvironment;
}): StagingMaintenanceDecision {
  if (!isStagingMaintenanceModeEnabled(params.env ?? process.env)) return 'DISABLED';

  const methodAllowed = STAGING_MAINTENANCE_ALLOWED_METHODS.includes(params.method);
  const pathnameAllowed = STAGING_MAINTENANCE_ALLOWED_PATHNAMES.includes(params.pathname);

  return methodAllowed && pathnameAllowed ? 'ALLOWED' : 'BLOCKED';
}

/** The single fixed blocked response. Never carries request-derived or environment content. */
export function stagingMaintenanceUnavailableResponse(): NextResponse {
  return new NextResponse(STAGING_MAINTENANCE_RESPONSE_BODY, {
    status: 503,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      Pragma: 'no-cache',
      'Retry-After': String(STAGING_MAINTENANCE_RETRY_AFTER_SECONDS),
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      [STAGING_MAINTENANCE_MARKER_HEADER]: STAGING_MAINTENANCE_MARKER_VALUE,
    },
  });
}
