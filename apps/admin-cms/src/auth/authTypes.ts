export type AdminRole = 'admin' | 'reviewer' | 'editor';

export type AdminPermission =
  | 'projects.read'
  | 'projects.review'
  | 'projects.archive'
  | 'projects.edit';

export interface AuthenticatedAdminContext {
  authUserId: string; // matches auth_user_id (auth.users(id))
  adminUserId: string; // matches admin_users(id)
  email: string;
  fullName: string;
  roles: AdminRole[];
  permissions: AdminPermission[];
}

export type AuthErrorType =
  | 'UNAUTHENTICATED'
  | 'ADMIN_NOT_PROVISIONED'
  | 'PERMISSION_DENIED'
  | 'CONFIGURATION_FAILURE';

export class AdminAuthError extends Error {
  constructor(public type: AuthErrorType, message: string) {
    super(message);
    this.name = 'AdminAuthError';
  }
}
