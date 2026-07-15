import { describe, it, expect } from 'vitest';
import { getPermissionsForRoles, hasPermission, canPerformReviewAction } from './permissions';
import { validateSameOrigin } from './csrf';
import { AdminAuthError, AdminRole } from './authTypes';
import { extractSubClaim } from './claims';
import { parseClaimsResult } from './claimsResult';
import { getAuthErrorHttpStatus, getPublicAuthErrorMessage } from './authHttp';
import { validateReviewActionInput } from './reviewActionInput';
import { sanitizeRedirectPath } from './redirect';

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

  describe('3. Claims Extraction & Envelope Verification (A)', () => {
    const validUuid = 'd7170068-bc23-4554-ba5e-f00de7a7872d';

    it('accepts valid subject UUID claim', () => {
      expect(extractSubClaim({ sub: validUuid })).toBe(validUuid);
    });

    it('rejects missing or malformed claims objects', () => {
      expect(() => extractSubClaim(null)).toThrow(AdminAuthError);
      expect(() => extractSubClaim(undefined)).toThrow(AdminAuthError);
      expect(() => extractSubClaim({})).toThrow(AdminAuthError);
      expect(() => extractSubClaim({ sub: '' })).toThrow(AdminAuthError);
      expect(() => extractSubClaim({ sub: 'invalid-uuid' })).toThrow(AdminAuthError);
    });

    it('parses valid getClaims response envelope correctly', () => {
      const envelope = {
        data: {
          claims: {
            sub: validUuid,
          },
        },
        error: null,
      };
      expect(parseClaimsResult(envelope)).toBe(validUuid);
    });

    it('rejects envelope with returned Auth error', () => {
      const envelope = {
        data: null,
        error: new Error('synthetic auth error'),
      };
      expect(() => parseClaimsResult(envelope)).toThrow(AdminAuthError);
    });

    it('rejects envelope with missing data field', () => {
      const envelope = {
        data: null,
        error: null,
      };
      expect(() => parseClaimsResult(envelope)).toThrow(AdminAuthError);
    });

    it('rejects envelope with missing claims field', () => {
      const envelope = {
        data: {},
        error: null,
      };
      expect(() => parseClaimsResult(envelope)).toThrow(AdminAuthError);
    });

    it('rejects envelope with claims missing sub', () => {
      const envelope = {
        data: { claims: { email: 'admin@test.local' } },
        error: null,
      };
      expect(() => parseClaimsResult(envelope)).toThrow(AdminAuthError);
    });

    it('rejects envelope with empty sub', () => {
      const envelope = {
        data: { claims: { sub: '   ' } },
        error: null,
      };
      expect(() => parseClaimsResult(envelope)).toThrow(AdminAuthError);
    });

    it('rejects envelope with malformed sub', () => {
      const envelope = {
        data: { claims: { sub: 'malformed-uuid' } },
        error: null,
      };
      expect(() => parseClaimsResult(envelope)).toThrow(AdminAuthError);
    });

    it('rejects raw top-level object treated as complete response envelope', () => {
      const rawPayload = { sub: validUuid };
      expect(() => parseClaimsResult(rawPayload)).toThrow(AdminAuthError);
    });
  });

  describe('4. Auth HTTP Mapper & Layout Messages (B)', () => {
    it('maps unauthenticated error correctly', () => {
      expect(getAuthErrorHttpStatus('UNAUTHENTICATED')).toBe(401);
      expect(getPublicAuthErrorMessage('UNAUTHENTICATED')).toBe('Authentication required.');
    });

    it('maps admin not provisioned error correctly', () => {
      expect(getAuthErrorHttpStatus('ADMIN_NOT_PROVISIONED')).toBe(403);
      expect(getPublicAuthErrorMessage('ADMIN_NOT_PROVISIONED')).toBe('Access denied.');
    });

    it('maps permission denied error correctly', () => {
      expect(getAuthErrorHttpStatus('PERMISSION_DENIED')).toBe(403);
      expect(getPublicAuthErrorMessage('PERMISSION_DENIED')).toBe('Access denied.');
    });

    it('maps configuration failure error correctly', () => {
      expect(getAuthErrorHttpStatus('CONFIGURATION_FAILURE')).toBe(500);
      expect(getPublicAuthErrorMessage('CONFIGURATION_FAILURE')).toBe('Authentication service unavailable.');
    });

    it('maps unknown errors to internal authentication failure', () => {
      expect(getAuthErrorHttpStatus('SOME_UNKNOWN_ERROR')).toBe(500);
      expect(getPublicAuthErrorMessage('SOME_UNKNOWN_ERROR')).toBe('Internal authentication error.');
    });
  });

  describe('5. Hardened CSRF Validation (C)', () => {
    const authorative = 'http://localhost:3000';

    it('passes for exact same origin', () => {
      expect(validateSameOrigin('http://localhost:3000', authorative)).toBe(true);
    });

    it('fails for different scheme', () => {
      expect(validateSameOrigin('https://localhost:3000', authorative)).toBe(false);
    });

    it('fails for different hostname', () => {
      expect(validateSameOrigin('http://differenthost:3000', authorative)).toBe(false);
    });

    it('fails for different port', () => {
      expect(validateSameOrigin('http://localhost:8080', authorative)).toBe(false);
    });

    it('fails for malformed origins', () => {
      expect(validateSameOrigin('not-a-valid-origin-url', authorative)).toBe(false);
    });

    it('fails for missing or empty origin', () => {
      expect(validateSameOrigin(null, authorative)).toBe(false);
      expect(validateSameOrigin('', authorative)).toBe(false);
      expect(validateSameOrigin('   ', authorative)).toBe(false);
    });
  });

  describe('6. Review Action Input Validation (D)', () => {
    it('passes for valid body and parameters', () => {
      const result = validateReviewActionInput(
        { action: 'approve', comments: 'Looks great!' },
        '2026-showcase-project'
      );
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.data.action).toBe('approve');
        expect(result.data.comments).toBe('Looks great!');
        expect(result.data.publicId).toBe('2026-showcase-project');
      }
    });

    it('rejects null, array, and primitive bodies', () => {
      expect(validateReviewActionInput(null, 'id').valid).toBe(false);
      expect(validateReviewActionInput([], 'id').valid).toBe(false);
      expect(validateReviewActionInput('string-body', 'id').valid).toBe(false);
      expect(validateReviewActionInput(12345, 'id').valid).toBe(false);
    });

    it('rejects invalid action options', () => {
      expect(validateReviewActionInput({ action: 'delete' }, 'id').valid).toBe(false);
      expect(validateReviewActionInput({ action: '' }, 'id').valid).toBe(false);
    });

    it('passes for optional or empty comments, trimming spaces and converting to undefined', () => {
      const noComment = validateReviewActionInput({ action: 'archive' }, 'id');
      expect(noComment.valid).toBe(true);
      if (noComment.valid) {
        expect(noComment.data.comments).toBeUndefined();
      }

      const emptyComment = validateReviewActionInput({ action: 'archive', comments: '   ' }, 'id');
      expect(emptyComment.valid).toBe(true);
      if (emptyComment.valid) {
        expect(emptyComment.data.comments).toBeUndefined();
      }
    });

    it('rejects null comments parameter explicitly', () => {
      const result = validateReviewActionInput({ action: 'approve', comments: null }, 'id');
      expect(result.valid).toBe(false);
    });

    it('rejects malformed comments (objects, numbers, arrays, booleans, or too long)', () => {
      expect(validateReviewActionInput({ action: 'approve', comments: 123 }, 'id').valid).toBe(false);
      expect(validateReviewActionInput({ action: 'approve', comments: {} }, 'id').valid).toBe(false);
      expect(validateReviewActionInput({ action: 'approve', comments: [] }, 'id').valid).toBe(false);
      expect(validateReviewActionInput({ action: 'approve', comments: true }, 'id').valid).toBe(false);
      
      const hugeComment = 'a'.repeat(4001);
      expect(validateReviewActionInput({ action: 'approve', comments: hugeComment }, 'id').valid).toBe(false);
    });

    it('rejects empty or malformed public IDs to prevent injection', () => {
      expect(validateReviewActionInput({ action: 'approve' }, '   ').valid).toBe(false);
      expect(validateReviewActionInput({ action: 'approve' }, 'id; DROP TABLE projects;').valid).toBe(false);
      expect(validateReviewActionInput({ action: 'approve' }, 'id/../traversal').valid).toBe(false);
      expect(validateReviewActionInput({ action: 'approve' }, 'a'.repeat(101)).valid).toBe(false);
    });
  });

  describe('7. Open Redirect Sanitizer', () => {
    it('allows safe relative redirect paths', () => {
      expect(sanitizeRedirectPath('/admin')).toBe('/admin');
      expect(sanitizeRedirectPath('/admin/projects/123')).toBe('/admin/projects/123');
    });

    it('falls back to default path for absolute or external redirect targets', () => {
      expect(sanitizeRedirectPath('https://evil.example')).toBe('/admin');
      expect(sanitizeRedirectPath('http://evil.example/admin')).toBe('/admin');
      expect(sanitizeRedirectPath('//evil.example')).toBe('/admin');
      expect(sanitizeRedirectPath('\\\\evil.example')).toBe('/admin');
    });

    it('handles encoded external URLs safely', () => {
      expect(sanitizeRedirectPath(encodeURIComponent('https://evil.example'))).toBe('/admin');
      expect(sanitizeRedirectPath('%2F%2Fevil.example')).toBe('/admin');
    });
  });
});
