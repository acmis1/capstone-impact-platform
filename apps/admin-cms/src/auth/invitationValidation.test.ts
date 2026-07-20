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

// Custom Next.js Redirect Mock
class RedirectError extends Error {
  digest: string;
  constructor(target: string) {
    const digestStr = `NEXT_REDIRECT;307;${target};true;`;
    super(digestStr);
    this.digest = digestStr;
  }
}

const mockRedirect = vi.fn().mockImplementation((target: string) => {
  throw new RedirectError(target);
});

vi.mock('next/navigation', () => ({
  redirect: (target: string) => mockRedirect(target)
}));

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

import { GET } from '../app/auth/confirm/route';
import { setPasswordAction } from '../app/auth/set-password/actions';
import { NextRequest } from 'next/server';

describe('Invitation Validation Module (Pure Logic)', () => {
  describe('validateNextPath', () => {
    it('should return true when next path is missing/empty', () => {
      expect(validateNextPath(null)).toBe(true);
      expect(validateNextPath('')).toBe(true);
    });

    it('should accept exactly /auth/set-password', () => {
      expect(validateNextPath('/auth/set-password')).toBe(true);
    });

    it('should reject /admin', () => {
      expect(validateNextPath('/admin')).toBe(false);
    });

    it('should reject /login', () => {
      expect(validateNextPath('/login')).toBe(false);
    });

    it('should reject query-bearing paths', () => {
      expect(validateNextPath('/auth/set-password?foo=bar')).toBe(false);
    });

    it('should reject fragment-bearing paths', () => {
      expect(validateNextPath('/auth/set-password#foo')).toBe(false);
    });
  });

  describe('validateConfirmationParams', () => {
    it('should reject missing token', () => {
      const res = validateConfirmationParams({ tokenHash: null, type: 'invite', next: '/auth/set-password' });
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('MISSING_TOKEN_HASH');
    });

    it('should reject blank token', () => {
      const res = validateConfirmationParams({ tokenHash: '   ', type: 'invite', next: '/auth/set-password' });
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('MISSING_TOKEN_HASH');
    });

    it('should reject oversized token', () => {
      const oversizedToken = 'a'.repeat(2049);
      const res = validateConfirmationParams({ tokenHash: oversizedToken, type: 'invite', next: '/auth/set-password' });
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('TOKEN_TOO_LONG');
    });

    it('should reject missing type', () => {
      const res = validateConfirmationParams({ tokenHash: 'token123', type: null, next: '/auth/set-password' });
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('MISSING_TYPE');
    });

    it('should reject non-invite type', () => {
      const res = validateConfirmationParams({ tokenHash: 'token123', type: 'recovery', next: '/auth/set-password' });
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('INVALID_TYPE');
    });

    it('should accept missing next and resolve to fixed set-password path', () => {
      const res = validateConfirmationParams({ tokenHash: 'token123', type: 'invite', next: null });
      expect(res.isValid).toBe(true);
      expect(res.next).toBe('/auth/set-password');
    });

    it('should accept exact /auth/set-password next path', () => {
      const res = validateConfirmationParams({ tokenHash: 'token123', type: 'invite', next: '/auth/set-password' });
      expect(res.isValid).toBe(true);
      expect(res.next).toBe('/auth/set-password');
    });

    it('should reject external URL next path', () => {
      const res = validateConfirmationParams({ tokenHash: 'token123', type: 'invite', next: 'https://malicious.com' });
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('INVALID_NEXT_PATH');
    });

    it('should reject protocol-relative next path', () => {
      const res = validateConfirmationParams({ tokenHash: 'token123', type: 'invite', next: '//malicious.com' });
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('INVALID_NEXT_PATH');
    });

    it('should reject backslash next path', () => {
      const res = validateConfirmationParams({ tokenHash: 'token123', type: 'invite', next: '\\malicious.com' });
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('INVALID_NEXT_PATH');
    });

    it('should check that validation success contains no token', () => {
      const res = validateConfirmationParams({ tokenHash: 'sensitiveToken123', type: 'invite', next: '/auth/set-password' });
      expect(res.isValid).toBe(true);
      expect(JSON.stringify(res)).not.toContain('sensitiveToken123');
    });
  });

  describe('validatePasswordUpdate', () => {
    it('should reject empty password', () => {
      const res = validatePasswordUpdate({ password: null, confirmation: 'secret1234567' });
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('PASSWORD_EMPTY');
    });

    it('should reject short password', () => {
      const res = validatePasswordUpdate({ password: 'short', confirmation: 'short' });
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('PASSWORD_TOO_SHORT');
    });

    it('should reject oversized password', () => {
      const oversized = 'a'.repeat(129);
      const res = validatePasswordUpdate({ password: oversized, confirmation: oversized });
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('PASSWORD_TOO_LONG');
    });

    it('should reject mismatched confirmation', () => {
      const res = validatePasswordUpdate({ password: 'validpassword123', confirmation: 'different123' });
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('CONFIRMATION_MISMATCH');
    });

    it('should check that password validation success contains no password', () => {
      const res = validatePasswordUpdate({ password: 'secretPassword123', confirmation: 'secretPassword123' });
      expect(res.isValid).toBe(true);
      expect(JSON.stringify(res)).not.toContain('secretPassword123');
    });
  });
});

describe('Confirmation Route GET Handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should reject unexpected query parameters and NOT call verifyOtp', async () => {
    const req = new NextRequest('http://localhost:3000/auth/confirm?token_hash=token123&type=invite&bad_param=1');
    await expect(GET(req)).rejects.toThrow(RedirectError);
    expect(mockVerifyOtp).not.toHaveBeenCalled();
    expect(mockRedirect).toHaveBeenCalledWith('/login?error=INVALID_PARAMETERS');
  });

  it('should reject invalid input, NOT construct Supabase and NOT call verifyOtp', async () => {
    const req = new NextRequest('http://localhost:3000/auth/confirm?type=invite');
    await expect(GET(req)).rejects.toThrow(RedirectError);
    expect(mockVerifyOtp).not.toHaveBeenCalled();
    expect(mockRedirect).toHaveBeenCalledWith('/login?error=MISSING_TOKEN_HASH');
  });

  it('should call verifyOtp exactly once and redirect to /auth/set-password on success', async () => {
    mockVerifyOtp.mockResolvedValue({ error: null });
    const req = new NextRequest('http://localhost:3000/auth/confirm?token_hash=token123&type=invite');

    await expect(GET(req)).rejects.toThrow(RedirectError);
    expect(mockVerifyOtp).toHaveBeenCalledTimes(1);
    expect(mockVerifyOtp).toHaveBeenCalledWith({
      type: 'invite',
      token_hash: 'token123'
    });
    expect(mockRedirect).toHaveBeenCalledWith('/auth/set-password');
  });

  it('should redirect exactly once to login error when verifyOtp returns an error', async () => {
    mockVerifyOtp.mockResolvedValue({ error: new Error('Invalid token') });
    const req = new NextRequest('http://localhost:3000/auth/confirm?token_hash=token123&type=invite');

    await expect(GET(req)).rejects.toThrow(RedirectError);
    expect(mockVerifyOtp).toHaveBeenCalledTimes(1);
    expect(mockRedirect).toHaveBeenCalledWith('/login?error=VERIFICATION_FAILED');
  });

  it('should redirect exactly once to login error when verifyOtp throws an error', async () => {
    mockVerifyOtp.mockRejectedValue(new Error('Network failure'));
    const req = new NextRequest('http://localhost:3000/auth/confirm?token_hash=token123&type=invite');

    await expect(GET(req)).rejects.toThrow(RedirectError);
    expect(mockVerifyOtp).toHaveBeenCalledTimes(1);
    expect(mockRedirect).toHaveBeenCalledWith('/login?error=VERIFICATION_FAILED');
  });

  it('should ensure redirect contains no token or raw error', async () => {
    mockVerifyOtp.mockResolvedValue({ error: new Error('raw_supabase_database_error_pii') });
    const req = new NextRequest('http://localhost:3000/auth/confirm?token_hash=token123_secret&type=invite');

    await expect(GET(req)).rejects.toThrow(RedirectError);
    const redirectTarget = mockRedirect.mock.calls[0][0];
    expect(redirectTarget).not.toContain('token123_secret');
    expect(redirectTarget).not.toContain('raw_supabase_database_error_pii');
  });
});

describe('Password Setup Server Action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should validate input and NOT call Supabase or getUser if inputs are invalid', async () => {
    const formData = new FormData();
    formData.append('password', 'short');
    formData.append('confirmation', 'short');

    const res = await setPasswordAction(null, formData);
    expect(res.error).toBe('PASSWORD_TOO_SHORT');
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('should reject unauthenticated updates and NOT call updateUser', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: new Error('No user') });
    const formData = new FormData();
    formData.append('password', 'validpassword123');
    formData.append('confirmation', 'validpassword123');

    const res = await setPasswordAction(null, formData);
    expect(res.error).toBe('UNAUTHENTICATED');
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('should call updateUser exactly once on valid authenticated input', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'uuid-123' } }, error: null });
    mockUpdateUser.mockResolvedValue({ error: null });
    mockSignOut.mockResolvedValue({ error: null });

    const formData = new FormData();
    formData.append('password', 'validpassword123');
    formData.append('confirmation', 'validpassword123');

    await expect(setPasswordAction(null, formData)).rejects.toThrow(RedirectError);
    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    expect(mockUpdateUser).toHaveBeenCalledWith({ password: 'validpassword123' });
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(mockRedirect).toHaveBeenCalledWith('/login?status=PASSWORD_SET');
  });

  it('should not call signOut when updateUser fails', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'uuid-123' } }, error: null });
    mockUpdateUser.mockResolvedValue({ error: new Error('Database down') });

    const formData = new FormData();
    formData.append('password', 'validpassword123');
    formData.append('confirmation', 'validpassword123');

    const res = await setPasswordAction(null, formData);
    expect(res.error).toBe('PASSWORD_UPDATE_FAILED');
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it('should return SESSION_TERMINATION_FAILED when local signOut fails', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'uuid-123' } }, error: null });
    mockUpdateUser.mockResolvedValue({ error: null });
    mockSignOut.mockResolvedValue({ error: new Error('Cookie lock') });

    const formData = new FormData();
    formData.append('password', 'validpassword123');
    formData.append('confirmation', 'validpassword123');

    const res = await setPasswordAction(null, formData);
    expect(res.error).toBe('SESSION_TERMINATION_FAILED');
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it('should ensure action outputs and redirects contain no secrets or PII', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'uuid-123', email: 'admin@capstone.net' } }, error: null });
    mockUpdateUser.mockResolvedValue({ error: null });
    mockSignOut.mockResolvedValue({ error: null });

    const formData = new FormData();
    formData.append('password', 'secretPass123_xyz');
    formData.append('confirmation', 'secretPass123_xyz');

    await expect(setPasswordAction(null, formData)).rejects.toThrow(RedirectError);
    const redirectUrl = mockRedirect.mock.calls[0][0];
    expect(redirectUrl).not.toContain('secretPass123_xyz');
    expect(redirectUrl).not.toContain('uuid-123');
    expect(redirectUrl).not.toContain('admin@capstone.net');
  });
});

describe('Static Safety Assertions', () => {
  const routeCode = fs.readFileSync(path.resolve(__dirname, '../app/auth/confirm/route.ts'), 'utf8');
  const actionsCode = fs.readFileSync(path.resolve(__dirname, '../app/auth/set-password/actions.ts'), 'utf8');
  const pageCode = fs.readFileSync(path.resolve(__dirname, '../app/auth/set-password/page.tsx'), 'utf8');

  it('should assert no access_token references in routes and actions', () => {
    expect(routeCode).not.toContain('access_token');
    expect(actionsCode).not.toContain('access_token');
  });

  it('should assert no refresh_token references in routes and actions', () => {
    expect(routeCode).not.toContain('refresh_token');
    expect(actionsCode).not.toContain('refresh_token');
  });

  it('should assert no user.email rendered in the set-password page HTML', () => {
    expect(pageCode).not.toContain('user.email');
    expect(pageCode).not.toContain('email');
  });

  it('should assert no machine-specific file:/// links exist in the manual apply guide or instructions', () => {
    const guideCode = fs.readFileSync(path.resolve(__dirname, '../../../infra/supabase/manual-apply-guide.md'), 'utf8');
    expect(guideCode).not.toContain('file:///D:');
    expect(guideCode).not.toContain('file:///C:');
  });

  it('should assert no bootstrap RPC calls are present in route or action files', () => {
    expect(routeCode).not.toContain('bootstrap_initial_admin');
    expect(actionsCode).not.toContain('bootstrap_initial_admin');
  });
});
