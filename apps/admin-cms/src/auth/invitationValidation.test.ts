import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Mock server-only to prevent Next.js import validation checks
vi.mock('server-only', () => ({}));

import {
  validateNextPath,
  validateConfirmationParams,
  validatePasswordUpdate
} from './invitationValidation';

// Redirect Mock throwing RedirectError
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
  redirect: (target: string) => mockRedirect(target),
}));

// Mock next/headers cookies store
const mockCookieMap = new Map<string, any>();
const mockCookieStore = {
  get: vi.fn().mockImplementation((name: string) => mockCookieMap.get(name)),
  has: vi.fn().mockImplementation((name: string) => mockCookieMap.has(name)),
  set: vi.fn().mockImplementation((name: string, value: string, options: any) => {
    mockCookieMap.set(name, { name, value, ...options });
  }),
  delete: vi.fn().mockImplementation((options: any) => {
    const name = typeof options === 'string' ? options : options.name;
    mockCookieMap.delete(name);
  }),
};

vi.mock('next/headers', () => ({
  cookies: async () => mockCookieStore,
}));

// Mock Supabase Server client and auth helpers
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
import AcceptInvitationPage from '../app/auth/confirm/accept/page';
import { acceptInvitationAction } from '../app/auth/confirm/accept/actions';
import { setPasswordAction } from '../app/auth/set-password/actions';
import { NextRequest, NextResponse } from 'next/server';

describe('Pure Invitation Logic', () => {
  describe('validateNextPath', () => {
    it('should return true for empty or set-password destination', () => {
      expect(validateNextPath(null)).toBe(true);
      expect(validateNextPath('')).toBe(true);
      expect(validateNextPath('/auth/set-password')).toBe(true);
    });

    it('should reject alternative paths like /admin or /login', () => {
      expect(validateNextPath('/admin')).toBe(false);
      expect(validateNextPath('/login')).toBe(false);
    });
  });

  describe('validateConfirmationParams', () => {
    it('should fail on oversized token hash', () => {
      const oversized = 't'.repeat(2049);
      const res = validateConfirmationParams({ tokenHash: oversized, type: 'invite', next: '/auth/set-password' });
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('TOKEN_TOO_LONG');
    });

    it('should reject invalid types', () => {
      const res = validateConfirmationParams({ tokenHash: 'token123', type: 'signup', next: '/auth/set-password' });
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('INVALID_TYPE');
    });

    it('should check that validation success contains no token', () => {
      const res = validateConfirmationParams({ tokenHash: 'secretTokenHash123', type: 'invite', next: '/auth/set-password' });
      expect(res.isValid).toBe(true);
      expect(JSON.stringify(res)).not.toContain('secretTokenHash123');
    });
  });
});

describe('GET Confirmation Route Handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should reject unexpected parameters', async () => {
    const req = new NextRequest('http://localhost:3000/auth/confirm?token_hash=token123&type=invite&bad_param=val');
    const response = await GET(req);
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toContain('/login?error=INVALID_PARAMETERS');
  });

  it('should reject duplicate parameters', async () => {
    const req = new NextRequest('http://localhost:3000/auth/confirm?token_hash=token1&token_hash=token2&type=invite');
    const response = await GET(req);
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toContain('/login?error=INVALID_PARAMETERS');
  });

  it('should perform no Supabase client construction or OTP calls and set HttpOnly cookie', async () => {
    const req = new NextRequest('http://localhost:3000/auth/confirm?token_hash=token123&type=invite');
    const response = await GET(req);

    expect(mockVerifyOtp).not.toHaveBeenCalled();
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('http://localhost:3000/auth/confirm/accept');

    // Inspect cookie parameters
    const cookie = response.cookies.get('capstone_invitation_token_hash');
    expect(cookie).toBeDefined();
    expect(cookie?.value).toBe('token123');
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('lax');
    expect(cookie?.path).toBe('/auth/confirm');
    expect(cookie?.maxAge).toBeLessThanOrEqual(600);

    // Verify headers
    expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0');
    expect(response.headers.get('Pragma')).toBe('no-cache');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow, noarchive');
  });
});

describe('Acceptance Page Render Logic', () => {
  beforeEach(() => {
    mockCookieMap.clear();
    vi.clearAllMocks();
  });

  it('should redirect to sanitized login error if invitation cookie is missing', async () => {
    await expect(AcceptInvitationPage()).rejects.toThrow(RedirectError);
    expect(mockRedirect).toHaveBeenCalledWith('/login?error=INVITATION_SESSION_MISSING');
  });

  it('should render page form and Accept button if cookie is present, making no Supabase queries', async () => {
    mockCookieMap.set('capstone_invitation_token_hash', { name: 'capstone_invitation_token_hash', value: 'token123' });
    
    const pageHtmlElement = await AcceptInvitationPage();
    expect(pageHtmlElement).toBeDefined();
    expect(mockVerifyOtp).not.toHaveBeenCalled();

    // Verify that the token value is not exposed in the serialized output
    const serialized = JSON.stringify(pageHtmlElement);
    expect(serialized).not.toContain('token123');
  });
});

describe('Acceptance Server Action', () => {
  beforeEach(() => {
    mockCookieMap.clear();
    vi.clearAllMocks();
  });

  it('should fail and redirect if cookie is missing', async () => {
    await expect(acceptInvitationAction()).rejects.toThrow(RedirectError);
    expect(mockRedirect).toHaveBeenCalledWith('/login?error=INVITATION_SESSION_MISSING');
    expect(mockVerifyOtp).not.toHaveBeenCalled();
  });

  it('should call verifyOtp exactly once, delete cookie, and redirect to set-password on success', async () => {
    mockCookieMap.set('capstone_invitation_token_hash', { name: 'capstone_invitation_token_hash', value: 'token123' });
    mockVerifyOtp.mockResolvedValue({ error: null });

    await expect(acceptInvitationAction()).rejects.toThrow(RedirectError);
    expect(mockVerifyOtp).toHaveBeenCalledTimes(1);
    expect(mockVerifyOtp).toHaveBeenCalledWith({
      type: 'invite',
      token_hash: 'token123'
    });

    // Cookie must be deleted after the attempt
    expect(mockCookieMap.has('capstone_invitation_token_hash')).toBe(false);
    expect(mockRedirect).toHaveBeenCalledWith('/auth/set-password');
  });

  it('should delete cookie and redirect to login error when verifyOtp fails', async () => {
    mockCookieMap.set('capstone_invitation_token_hash', { name: 'capstone_invitation_token_hash', value: 'token123' });
    mockVerifyOtp.mockResolvedValue({ error: new Error('Invalid OTP') });

    await expect(acceptInvitationAction()).rejects.toThrow(RedirectError);
    expect(mockCookieMap.has('capstone_invitation_token_hash')).toBe(false);
    expect(mockRedirect).toHaveBeenCalledWith('/login?error=VERIFICATION_FAILED');
  });

  it('should delete cookie and redirect to login error when verifyOtp throws an exception', async () => {
    mockCookieMap.set('capstone_invitation_token_hash', { name: 'capstone_invitation_token_hash', value: 'token123' });
    mockVerifyOtp.mockRejectedValue(new Error('Network loss'));

    await expect(acceptInvitationAction()).rejects.toThrow(RedirectError);
    expect(mockCookieMap.has('capstone_invitation_token_hash')).toBe(false);
    expect(mockRedirect).toHaveBeenCalledWith('/login?error=VERIFICATION_FAILED');
  });
});

describe('Prefetch Protection Simulation', () => {
  beforeEach(() => {
    mockCookieMap.clear();
    vi.clearAllMocks();
  });

  it('should confirm that GET link and acceptance page rendering perform no verification, and verification only triggers via Server Action', async () => {
    // 1. User clicks email link -> GET handler resolves parameter verification and returns 303 redirect
    const req = new NextRequest('http://localhost:3000/auth/confirm?token_hash=token123&type=invite');
    const response = await GET(req);
    expect(response.status).toBe(303);
    expect(mockVerifyOtp).not.toHaveBeenCalled();

    // Simulating browser cookie storage from response
    const cookie = response.cookies.get('capstone_invitation_token_hash');
    expect(cookie).toBeDefined();
    mockCookieMap.set(cookie!.name, cookie!);

    // 2. Acceptance Page renders from the redirected clean URL
    const pageElement = await AcceptInvitationPage();
    expect(pageElement).toBeDefined();
    expect(mockVerifyOtp).not.toHaveBeenCalled(); // verification not called during render

    // 3. Explicit Acceptance form submission (Server Action)
    mockVerifyOtp.mockResolvedValue({ error: null });
    await expect(acceptInvitationAction()).rejects.toThrow(RedirectError);

    // Verify OTP called exactly once at this step
    expect(mockVerifyOtp).toHaveBeenCalledTimes(1);
    expect(mockCookieMap.has('capstone_invitation_token_hash')).toBe(false); // Cookie deleted
  });
});

describe('Existing Password Actions and Safety Assurances', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should call updateUser and local signOut on valid setup inputs', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-123' } }, error: null });
    mockUpdateUser.mockResolvedValue({ error: null });
    mockSignOut.mockResolvedValue({ error: null });

    const formData = new FormData();
    formData.append('password', 'validpassword123');
    formData.append('confirmation', 'validpassword123');

    await expect(setPasswordAction(null, formData)).rejects.toThrow(RedirectError);
    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(mockRedirect).toHaveBeenCalledWith('/login?status=PASSWORD_SET');
  });

  it('should fail and not call signOut when updateUser fails', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-123' } }, error: null });
    mockUpdateUser.mockResolvedValue({ error: new Error('DB error') });

    const formData = new FormData();
    formData.append('password', 'validpassword123');
    formData.append('confirmation', 'validpassword123');

    const res = await setPasswordAction(null, formData);
    expect(res.error).toBe('PASSWORD_UPDATE_FAILED');
    expect(mockSignOut).not.toHaveBeenCalled();
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
    const guideCode = fs.readFileSync(path.resolve(__dirname, '../../../../infra/supabase/manual-apply-guide.md'), 'utf8');
    expect(guideCode).not.toContain('file:///D:');
    expect(guideCode).not.toContain('file:///C:');
  });

  it('should assert no bootstrap RPC calls are present in route or action files', () => {
    expect(routeCode).not.toContain('bootstrap_initial_admin');
    expect(actionsCode).not.toContain('bootstrap_initial_admin');
  });
});
