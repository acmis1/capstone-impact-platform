import { getStagingOperation, StagingOperationDefinition } from './stagingOperationRegistry';
import { assertVerifiedStagingRuntime } from './stagingRuntimeIdentity';

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

/**
 * Shared execution guard for shared-staging administrative commands.
 * Enforces strict environment identity, hostname matching, loopback rejection,
 * environment-configured mutation confirmation label validation, and double-acknowledgement
 * CLI flags for mutating operations.
 */
export function validateStagingGuard(options: GuardOptions): GuardAuthorizationResult {
  const { operationId, args = process.argv.slice(2), customEnv = process.env } = options;

  const operation = getStagingOperation(operationId);

  // 1-6. Reuse the environment/target identity boundary shared with web-runtime staging features.
  assertVerifiedStagingRuntime(customEnv);

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
