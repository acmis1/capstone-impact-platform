import { getStagingOperation, StagingOperationDefinition } from './stagingOperationRegistry';

export interface GuardAuthorizationResult {
  isAuthorized: boolean;
  isMutating: boolean;
  operation: StagingOperationDefinition;
  dryRunReason?: string;
}

export interface GuardOptions {
  operationId: string;
  args?: string[];
  customEnv?: Record<string, string | undefined>;
}

export const STAGING_MUTATION_CONFIRMATION_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function isValidMutationConfirmationLabel(label: string): boolean {
  if (!label || typeof label !== 'string') return false;
  if (label.length < 1 || label.length > 64) return false;
  return STAGING_MUTATION_CONFIRMATION_PATTERN.test(label);
}

function isLoopbackHost(hostname: string): boolean {
  const norm = hostname.toLowerCase().trim();
  return norm === 'localhost' || norm === '127.0.0.1' || norm === '::1' || norm === '[::1]';
}

/**
 * Shared execution guard for shared-staging administrative commands.
 * Enforces strict environment identity, hostname matching, loopback rejection,
 * environment-configured mutation confirmation label validation, and double-acknowledgement
 * CLI flags for mutating operations.
 */
export function validateStagingGuard(options: GuardOptions): GuardAuthorizationResult {
  const { operationId, args = process.argv.slice(2), customEnv = process.env } = options;

  const operation = getStagingOperation(operationId);

  // 1. Verify runtime environment identity flag
  const runtimeEnv = customEnv.CAPSTONE_RUNTIME_ENV;
  if (!runtimeEnv || runtimeEnv.trim().toLowerCase() !== 'staging') {
    throw new Error('Staging Execution Refused: Environment identity is not configured for staging operations.');
  }

  // 2. Verify expected target hostname configuration
  const expectedHost = customEnv.CAPSTONE_EXPECTED_SUPABASE_HOST;
  if (!expectedHost || !expectedHost.trim()) {
    throw new Error('Staging Execution Refused: Expected target hostname is not configured.');
  }

  // 3. Parse target Supabase URL from environment
  const supabaseUrlRaw = customEnv.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrlRaw || !supabaseUrlRaw.trim()) {
    throw new Error('Staging Execution Refused: Required Supabase URL variable is missing.');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(supabaseUrlRaw);
  } catch {
    throw new Error('Staging Execution Refused: Invalid target Supabase URL structure.');
  }

  // 4. Require secure HTTPS protocol for hosted staging
  if (parsedUrl.protocol !== 'https:') {
    throw new Error('Staging Execution Refused: Target URL must use secure HTTPS protocol.');
  }

  // 5. Reject loopback hosts for staging operations
  if (isLoopbackHost(parsedUrl.hostname)) {
    throw new Error('Staging Execution Refused: Staging operations cannot target loopback endpoints.');
  }

  // 6. Compare actual hostname with expected target identity exactly
  const actualHostNorm = parsedUrl.hostname.toLowerCase().trim();
  const expectedHostNorm = expectedHost.toLowerCase().trim();

  if (actualHostNorm !== expectedHostNorm) {
    throw new Error('Staging Execution Refused: Target hostname does not match expected staging target identity.');
  }

  // 7. Check operation type & mutation flags
  if (operation.type === 'read_only') {
    const hasApply = args.includes('--apply');
    const hasConfirm = args.some((a) => a.startsWith('--confirm-staging='));
    if (hasApply || hasConfirm) {
      throw new Error('Staging Guard Violation: Read-only staging operations cannot accept mutation flags.');
    }
    return {
      isAuthorized: true,
      isMutating: false,
      operation,
    };
  }

  // 8. Mutating operation: validate environment mutation confirmation label
  const configuredConfirmation = customEnv.CAPSTONE_STAGING_MUTATION_CONFIRMATION;
  if (!configuredConfirmation || configuredConfirmation.trim() === '') {
    throw new Error(
      'Staging Execution Refused: Staging mutation confirmation environment variable (CAPSTONE_STAGING_MUTATION_CONFIRMATION) is not configured.'
    );
  }

  if (!isValidMutationConfirmationLabel(configuredConfirmation)) {
    throw new Error(
      'Staging Execution Refused: Staging mutation confirmation environment variable (CAPSTONE_STAGING_MUTATION_CONFIRMATION) format is invalid.'
    );
  }

  // 9. Mutating operation: check CLI acknowledgment flags
  const hasApplyFlag = args.includes('--apply');
  const confirmArg = args.find((a) => a.startsWith('--confirm-staging='));
  const confirmValue = confirmArg ? confirmArg.slice('--confirm-staging='.length) : null;
  const hasValidConfirm = confirmValue === configuredConfirmation;

  if (!hasApplyFlag || !hasValidConfirm) {
    return {
      isAuthorized: false,
      isMutating: true,
      operation,
      dryRunReason: `Dry-run execution: Missing required mutation acknowledgement flags (--apply and --confirm-staging=${configuredConfirmation}).`,
    };
  }

  return {
    isAuthorized: true,
    isMutating: true,
    operation,
  };
}
