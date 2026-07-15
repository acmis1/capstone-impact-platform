import { AuthErrorType } from './authTypes';

/**
 * Returns the appropriate HTTP status code for a given AuthErrorType.
 */
export function getAuthErrorHttpStatus(type: AuthErrorType | string): number {
  switch (type) {
    case 'UNAUTHENTICATED':
      return 401;
    case 'ADMIN_NOT_PROVISIONED':
    case 'PERMISSION_DENIED':
      return 403;
    case 'CONFIGURATION_FAILURE':
      return 500;
    default:
      return 500;
  }
}

/**
 * Returns a generic, production-safe public message for a given AuthErrorType.
 * Prevents internal details from being exposed to the client.
 */
export function getPublicAuthErrorMessage(type: AuthErrorType | string): string {
  switch (type) {
    case 'UNAUTHENTICATED':
      return 'Authentication required.';
    case 'ADMIN_NOT_PROVISIONED':
    case 'PERMISSION_DENIED':
      return 'Access denied.';
    case 'CONFIGURATION_FAILURE':
      return 'Authentication service unavailable.';
    default:
      return 'Internal authentication error.';
  }
}
