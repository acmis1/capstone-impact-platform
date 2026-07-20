import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Mock server-only to prevent test execution failure
vi.mock('server-only', () => ({}));

import {
  validateNextPath,
  validateConfirmationParams,
  validatePasswordUpdate
} from './invitationValidation';

// Mock Next.js navigation and SSR server helpers
const mockGetUser = vi.fn();
const mockUpdateUser = vi.fn();
const mockSignOut = vi.fn();
const mockVerifyOtp = vi.fn();

vi.mock('../lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn().mockImplementation(async () => ({
    auth: {
      getUser: mockGetUser,
      updateUser: mockUpdateUser,
      signOut: mockSignOut,
      verifyOtp: mockVerifyOtp
    }
  }))
}));

// Mock Next.js redirection
const mockRedirect = vi.fn();
vi.mock('next/navigation', () => ({
  redirect: (target: string) => mockRedirect(target)
}));

import { GET } from '../app/auth/confirm/route';
import { setPasswordAction } from '../app/auth/set-password/actions';
import { NextRequest } from 'next/server';

describe('Invitation Validation Module (Pure Logic)', () => {
  describe('validateNextPath', () => {
    it('should default to /auth/set-password when next path is missing', () => {
      expect(validateNextPath(null)).toBe('/auth/set-password');
      expect(validateNextPath('')).toBe('/auth/set-password');
    });

    it('should accept valid allowlisted internal paths', () => {
      expect(validateNextPath('/auth/set-password')).toBe('/auth/set-password');
      expect(validateNextPath('/admin')).toBe('/admin');
      expect(validateNextPath('/login')).toBe('/login');
    });

    it('should reject external URLs', () => {
      expect(validateNextPath('http://malicious.com')).toBe('/auth/set-password');
      expect(validateNextPath('https://malicious.com/admin')).toBe('/auth/set-password');
    });

    it('should reject protocol-relative URLs', () => {
      expect(validateNextPath('//malicious.com')).toBe('/auth/set-password');
    });

    it('should reject backslash relative paths', () => {
      expect(validateNextPath('\\admin')).toBe('/auth/set-password');
      expect(validateNextPath('/admin\\something')).toBe('/auth/set-password');
    });

    it('should reject encoded open redirects', () => {
      expect(validateNextPath('%2F%2Fmalicious.com')).toBe('/auth/set-password');
      expect(validateNextPath('%5C%5Cmalicious.com')).toBe('/auth/set-password');
    });

    it('should reject non-allowlisted internal paths', () => {
      expect(validateNextPath('/some-other-path')).toBe('/auth/set-password');
    });
  });

  describe('validateConfirmationParams', () => {
    it('should reject missing token_hash', () => {
      const res = validateConfirmationParams({ tokenHash: null, type: 'invite', next: '/admin' });
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('MISSING_TOKEN_HASH');
    });

    it('should reject missing type', () => {
      const res = validateConfirmationParams({ tokenHash: 'hash123', type: null, next: '/admin' });
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('MISSING_TYPE');
    });

    it('should reject non-invite types', () => {
      const res = validateConfirmationParams({ tokenHash: 'hash123', type: 'signup', next: '/admin' });
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('INVALID_TYPE');
    });

    it('should accept valid inputs and trim whitespace', () => {
      const res = validateConfirmationParams({ tokenHash: '  hash123  ', type: 'invite', next: '/admin' });
      expect(res.isValid).toBe(true);
      expect(res.data?.tokenHash).toBe('hash123');
      expect(res.data?.type).toBe('invite');
      expect(res.data?.next).toBe('/admin');
    });
  });

  describe('validatePasswordUpdate', () => {
    it('should reject empty passwords', () => {
      const res = validatePasswordUpdate({ password: null, confirmation: 'secret1234567' });
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('PASSWORD_EMPTY');
    });

    it('should reject short passwords', () => {
      const res = validatePasswordUpdate({ password: 'short', confirmation: 'short' });
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('PASSWORD_TOO_SHORT');
    });

    it('should reject oversized passwords', () => {
      const longPassword = 'a'.repeat(129);
      const res = validatePasswordUpdate({ password: longPassword, confirmation: longPassword });
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('PASSWORD_TOO_LONG');
    });

    it('should reject mismatched confirmations', () => {
      const res = validatePasswordUpdate({ password: 'validpassword123', confirmation: 'different123' });
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('CONFIRMATION_MISMATCH');
    });

    it('should accept valid matching passwords', () => {
      const res = validatePasswordUpdate({ password: 'validpassword123', confirmation: 'validpassword123' });
      expect(res.isValid).toBe(true);
      expect(res.data).toBe('validpassword123');
    });
  });
});

describe('Confirmation Route GET Handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should redirect to login on validation failure and NOT call verifyOtp', async () => {
    const req = new NextRequest('http://localhost:3000/auth/confirm?type=invite');
    try {
      await GET(req);
    } catch {
      // Catch Next.js redirect throw
    }

    expect(mockVerifyOtp).not.toHaveBeenCalled();
    expect(mockRedirect).toHaveBeenCalledWith('/login?error=MISSING_TOKEN_HASH');
  });

  it('should call verifyOtp and redirect on success', async () => {
    mockVerifyOtp.mockResolvedValue({ error: null });
    const req = new NextRequest('http://localhost:3000/auth/confirm?token_hash=token123&type=invite&next=/admin');
    
    try {
      await GET(req);
    } catch {
      // Catch Next.js redirect throw
    }

    expect(mockVerifyOtp).toHaveBeenCalledTimes(1);
    expect(mockVerifyOtp).toHaveBeenCalledWith({
      type: 'invite',
      token_hash: 'token123'
    });
    expect(mockRedirect).toHaveBeenCalledWith('/admin');
  });

  it('should redirect to login on verifyOtp failure', async () => {
    mockVerifyOtp.mockResolvedValue({ error: new Error('Invalid token') });
    const req = new NextRequest('http://localhost:3000/auth/confirm?token_hash=badtoken&type=invite');

    try {
      await GET(req);
    } catch {
      // Catch Next.js redirect throw
    }

    expect(mockVerifyOtp).toHaveBeenCalledTimes(1);
    expect(mockRedirect).toHaveBeenCalledWith('/login?error=VERIFICATION_FAILED');
    
    // Check that raw error and token are not exposed
    const redirectUrl = mockRedirect.mock.calls[0][0];
    expect(redirectUrl).not.toContain('badtoken');
    expect(redirectUrl).not.toContain('Invalid token');
  });
});

describe('Password Setup Server Action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should reject unauthenticated updates and NOT call updateUser', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: new Error('No user') });
    const formData = new FormData();
    formData.append('password', 'newpassword123');
    formData.append('confirmation', 'newpassword123');

    const res = await setPasswordAction(null, formData);
    expect(res.error).toBe('UNAUTHENTICATED');
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('should reject invalid password inputs and NOT call updateUser', async () => {
    const formData = new FormData();
    formData.append('password', 'short');
    formData.append('confirmation', 'short');

    const res = await setPasswordAction(null, formData);
    expect(res.error).toBe('PASSWORD_TOO_SHORT');
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('should call updateUser, signOut and return success on valid input', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-123' } }, error: null });
    mockUpdateUser.mockResolvedValue({ error: null });
    mockSignOut.mockResolvedValue({});

    const formData = new FormData();
    formData.append('password', 'newpassword123');
    formData.append('confirmation', 'newpassword123');

    const res = await setPasswordAction(null, formData);
    expect(res.success).toBe(true);
    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    expect(mockUpdateUser).toHaveBeenCalledWith({ password: 'newpassword123' });
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });
});

describe('Static/Contract Safety Assertions', () => {
  it('should confirm that access_token and refresh_token are never handled in URL params or redirect', () => {
    // Read the implementation file contents as text
    const routeCode = fs.readFileSync(path.resolve(__dirname, '../app/auth/confirm/route.ts'), 'utf8');
    const actionsCode = fs.readFileSync(path.resolve(__dirname, '../app/auth/set-password/actions.ts'), 'utf8');

    expect(routeCode).not.toContain('access_token');
    expect(routeCode).not.toContain('refresh_token');
    expect(actionsCode).not.toContain('access_token');
    expect(actionsCode).not.toContain('refresh_token');
  });

  it('should confirm that password is never logged or returned in plain text in result', async () => {
    const actionsCode = fs.readFileSync(path.resolve(__dirname, '../app/auth/set-password/actions.ts'), 'utf8');

    // Ensure no console.log of passwords or returns containing plain password values
    expect(actionsCode).not.toMatch(/console\.log\(.*password.*\)/);
    
    const formData = new FormData();
    formData.append('password', 'my-secret-password-123');
    formData.append('confirmation', 'my-secret-password-123');

    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-123' } }, error: null });
    mockUpdateUser.mockResolvedValue({ error: null });
    mockSignOut.mockResolvedValue({});

    const res = await setPasswordAction(null, formData);
    const serializedResult = JSON.stringify(res);
    expect(serializedResult).not.toContain('my-secret-password-123');
  });

  it('should confirm that bootstrap RPC and database writes are never called', () => {
    const routeCode = fs.readFileSync(path.resolve(__dirname, '../app/auth/confirm/route.ts'), 'utf8');
    const actionsCode = fs.readFileSync(path.resolve(__dirname, '../app/auth/set-password/actions.ts'), 'utf8');

    expect(routeCode).not.toContain('bootstrap_initial_admin');
    expect(actionsCode).not.toContain('bootstrap_initial_admin');
    expect(routeCode).not.toContain('insert');
    expect(actionsCode).not.toContain('insert');
  });
});
