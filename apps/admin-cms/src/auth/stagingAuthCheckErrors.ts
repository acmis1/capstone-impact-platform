/**
 * Pure offline helper to determine if a database error indicates a missing auth_user_id column.
 * 
 * Rules:
 * - Return true only for trusted missing-column evidence.
 * - postgres code 42703 is the PostgreSQL standard for undefined_column.
 * - Narrowly match column not found error messages.
 * - Avoid false positives (e.g. permission-denied or connection failures).
 */
export function isMissingAuthUserIdColumnError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const err = error as Record<string, unknown>;

  // 1. PostgreSQL undefined_column code
  if (err.code === '42703') {
    return true;
  }

  // 2. Strict message matching
  const message = typeof err.message === 'string' ? err.message : '';
  
  // Normalized exact checks
  const exactPatterns = [
    'column "admin_users.auth_user_id" does not exist',
    'column "auth_user_id" does not exist',
    'column admin_users.auth_user_id does not exist',
    'column auth_user_id does not exist'
  ];

  const normalized = message.toLowerCase().trim();
  const matchedExact = exactPatterns.some(
    pattern => normalized.includes(pattern) && !normalized.includes('permission denied') && !normalized.includes('connection')
  );

  if (matchedExact) {
    return true;
  }

  return false;
}
