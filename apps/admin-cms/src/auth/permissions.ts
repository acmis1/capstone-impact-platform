import { AdminRole, AdminPermission } from './authTypes';

const ROLE_PERMISSIONS: Record<AdminRole, AdminPermission[]> = {
  admin: ['projects.read', 'projects.review', 'projects.archive', 'projects.edit'],
  reviewer: ['projects.read', 'projects.review'],
  editor: ['projects.read', 'projects.edit'],
};

/**
 * Returns combined list of permissions for specified roles, without duplicates.
 */
export function getPermissionsForRoles(roles: AdminRole[]): AdminPermission[] {
  const permissionsSet = new Set<AdminPermission>();
  roles.forEach((role) => {
    const permissions = ROLE_PERMISSIONS[role];
    if (permissions) {
      permissions.forEach((p) => permissionsSet.add(p));
    }
  });
  return Array.from(permissionsSet);
}

/**
 * Checks if permission list contains the required permission.
 */
export function hasPermission(userPermissions: AdminPermission[], required: AdminPermission): boolean {
  return userPermissions.includes(required);
}

/**
 * Maps review actions to permissions and validates.
 */
export function canPerformReviewAction(userPermissions: AdminPermission[], action: string): boolean {
  switch (action) {
    case 'request_changes':
    case 'approve':
      return hasPermission(userPermissions, 'projects.review');
    case 'archive':
      return hasPermission(userPermissions, 'projects.archive');
    default:
      return false;
  }
}
