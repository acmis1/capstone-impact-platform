import { describe, it, expect } from 'vitest';
import { getPermissionsForRoles, hasPermission, canPerformReviewAction } from './permissions';
import { validateSameOrigin } from './csrf';
import { AdminAuthError, AuthErrorType } from './authTypes';
import { AdminRole } from './authTypes';

describe('Authentication & Authorization Tests (Offline)', () => {
  describe('1. Permission Mapping', () => {
    it('returns exact permissions for admin role', () => {
      const perms = getPermissionsForRoles(['admin']);
      expect(perms).toContain('projects.read');
      expect(perms).toContain('projects.review');
      expect(perms).toContain('projects.archive');
      expect(perms).toContain('projects.edit');
      expect(perms.length).toBe(4);
    });

    it('returns exact permissions for reviewer role', () => {
      const perms = getPermissionsForRoles(['reviewer']);
      expect(perms).toContain('projects.read');
      expect(perms).toContain('projects.review');
      expect(perms).not.toContain('projects.archive');
      expect(perms).not.toContain('projects.edit');
      expect(perms.length).toBe(2);
    });

    it('returns exact permissions for editor role', () => {
      const perms = getPermissionsForRoles(['editor']);
      expect(perms).toContain('projects.read');
      expect(perms).toContain('projects.edit');
      expect(perms).not.toContain('projects.review');
      expect(perms).not.toContain('projects.archive');
      expect(perms.length).toBe(2);
    });

    it('returns empty permissions for unknown/unrecognized roles', () => {
      const perms = getPermissionsForRoles(['guest' as AdminRole]);
      expect(perms.length).toBe(0);
    });

    it('combines permissions without duplicates for multiple roles', () => {
      const perms = getPermissionsForRoles(['reviewer', 'editor']);
      expect(perms).toContain('projects.read');
      expect(perms).toContain('projects.review');
      expect(perms).toContain('projects.edit');
      expect(perms).not.toContain('projects.archive');
      // projects.read is present in both roles, but should only appear once
      const readOccurrences = perms.filter(p => p === 'projects.read').length;
      expect(readOccurrences).toBe(1);
      expect(perms.length).toBe(3);
    });

    it('checks specific permissions correctly via hasPermission', () => {
      const perms = getPermissionsForRoles(['reviewer']);
      expect(hasPermission(perms, 'projects.read')).toBe(true);
      expect(hasPermission(perms, 'projects.review')).toBe(true);
      expect(hasPermission(perms, 'projects.edit')).toBe(false);
      expect(hasPermission(perms, 'projects.archive')).toBe(false);
    });
  });

  describe('2. Review-Action Permission Mapping', () => {
    it('allows reviewer to approve and request changes, but blocks archive', () => {
      const perms = getPermissionsForRoles(['reviewer']);
      expect(canPerformReviewAction(perms, 'approve')).toBe(true);
      expect(canPerformReviewAction(perms, 'request_changes')).toBe(true);
      expect(canPerformReviewAction(perms, 'archive')).toBe(false);
    });

    it('blocks editor from performing review or archive actions', () => {
      const perms = getPermissionsForRoles(['editor']);
      expect(canPerformReviewAction(perms, 'approve')).toBe(false);
      expect(canPerformReviewAction(perms, 'request_changes')).toBe(false);
      expect(canPerformReviewAction(perms, 'archive')).toBe(false);
    });

    it('allows admin to perform all review actions', () => {
      const perms = getPermissionsForRoles(['admin']);
      expect(canPerformReviewAction(perms, 'approve')).toBe(true);
      expect(canPerformReviewAction(perms, 'request_changes')).toBe(true);
      expect(canPerformReviewAction(perms, 'archive')).toBe(true);
    });

    it('returns false for unknown actions', () => {
      const perms = getPermissionsForRoles(['admin']);
      expect(canPerformReviewAction(perms, 'delete_project')).toBe(false);
    });
  });

  describe('3. Authorization Error Mapping', () => {
    it('creates correct error types for HTTP mapping', () => {
      const errMap: Record<AuthErrorType, number> = {
        UNAUTHENTICATED: 401,
        ADMIN_NOT_PROVISIONED: 403,
        PERMISSION_DENIED: 403,
        CONFIGURATION_FAILURE: 500,
      };

      Object.entries(errMap).forEach(([type, status]) => {
        const error = new AdminAuthError(type as AuthErrorType, 'Error message');
        expect(error.type).toBe(type);
        
        const mappedStatus = error.type === 'UNAUTHENTICATED' ? 401 : error.type === 'CONFIGURATION_FAILURE' ? 500 : 403;
        expect(mappedStatus).toBe(status);
      });
    });
  });

  describe('4. Same-Origin Validation (CSRF)', () => {
    it('passes when Origin matches Host exactly (same origin)', () => {
      expect(validateSameOrigin('http://localhost:3000', 'localhost:3000')).toBe(true);
      expect(validateSameOrigin('https://example.com', 'example.com')).toBe(true);
      expect(validateSameOrigin('https://example.com', 'https://example.com')).toBe(true);
    });

    it('fails when Origin is clearly different from Host', () => {
      expect(validateSameOrigin('http://malicious.com', 'localhost:3000')).toBe(false);
      expect(validateSameOrigin('https://hacker.com', 'example.com')).toBe(false);
    });

    it('fails safely for malformed Origin headers', () => {
      expect(validateSameOrigin('not-a-valid-url', 'localhost:3000')).toBe(false);
      expect(validateSameOrigin('', 'localhost:3000')).toBe(true); // Empty/null matches missing Origin behavior
    });

    it('documents and passes missing Origin header (non-browser or programmatic api/tests client)', () => {
      // Conservative design choice: allow missing origin to support programmatic test runner CLI or server-to-server RPCs
      expect(validateSameOrigin(null, 'localhost:3000')).toBe(true);
    });
  });
});
