import { AdminRole, AdminPermission } from './authTypes';

/**
 * Canonical staff role order, declared authority-descending. This is the repository's domain
 * rule — deliberately NOT alphabetical — and is the single source of truth for the order in
 * which recognized roles are reported, so resolution never depends on database row ordering.
 */
export const CANONICAL_ROLE_ORDER: readonly AdminRole[] = ['admin', 'reviewer', 'editor'];

/**
 * Canonical permission order. Project permissions are listed workflow-ascending, and the
 * administrative staff-management capability last, so a permission union is always reported
 * in one deterministic order regardless of which roles contributed it.
 */
export const CANONICAL_PERMISSION_ORDER: readonly AdminPermission[] = [
  'projects.read',
  'projects.review',
  'projects.archive',
  'projects.edit',
  'projects.publish',
  'staff.manage',
];

const RECOGNIZED_ROLES = new Set<AdminRole>(CANONICAL_ROLE_ORDER);

const ROLE_PERMISSIONS: Record<AdminRole, AdminPermission[]> = {
  admin: ['projects.read', 'projects.review', 'projects.archive', 'projects.edit', 'projects.publish', 'staff.manage'],
  reviewer: ['projects.read', 'projects.review'],
  editor: ['projects.read', 'projects.edit'],
};

/** Narrowing guard for role values arriving from the database or an untrusted boundary. */
export function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === 'string' && RECOGNIZED_ROLES.has(value as AdminRole);
}

/**
 * Reduces arbitrary role input to the recognized, duplicate-free set in canonical order.
 * Unrecognized values are discarded rather than carried through, so an unknown role row can
 * never expand authority.
 */
export function canonicalizeRoles(roles: readonly unknown[]): AdminRole[] {
  const recognized = new Set<AdminRole>();
  roles.forEach((role) => {
    if (isAdminRole(role)) recognized.add(role);
  });
  return CANONICAL_ROLE_ORDER.filter((role) => recognized.has(role));
}

/**
 * Returns the combined permissions for the specified roles, without duplicates and in the
 * canonical permission order.
 */
export function getPermissionsForRoles(roles: readonly AdminRole[]): AdminPermission[] {
  const permissionsSet = new Set<AdminPermission>();
  roles.forEach((role) => {
    const permissions = ROLE_PERMISSIONS[role];
    if (permissions) {
      permissions.forEach((p) => permissionsSet.add(p));
    }
  });
  return CANONICAL_PERMISSION_ORDER.filter((permission) => permissionsSet.has(permission));
}

/**
 * Checks if permission list contains the required permission.
 */
export function hasPermission(userPermissions: AdminPermission[], required: AdminPermission): boolean {
  return userPermissions.includes(required);
}

/** Correction resolution requires the exact union of edit and review authority. */
export function canResolveParticipantCorrection(userPermissions: AdminPermission[]): boolean {
  return (
    hasPermission(userPermissions, 'projects.edit') &&
    hasPermission(userPermissions, 'projects.review')
  );
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

/**
 * Participant preview generation/revocation reuses the same permission as completing internal
 * review (the 'approve' action) rather than introducing a new role or permission.
 */
export function canManageParticipantPreview(userPermissions: AdminPermission[]): boolean {
  return hasPermission(userPermissions, 'projects.review');
}

/** Publication preparation has deliberately narrower, admin-only authority. */
export function canPreparePublication(userPermissions: AdminPermission[]): boolean {
  return hasPermission(userPermissions, 'projects.publish');
}

/**
 * Staff identity provisioning is a dedicated administrative capability. It is deliberately a
 * domain permission rather than a `role === 'admin'` check, so authority stays resolvable from
 * the one centralized permission model.
 */
export function canManageStaff(userPermissions: AdminPermission[]): boolean {
  return hasPermission(userPermissions, 'staff.manage');
}
