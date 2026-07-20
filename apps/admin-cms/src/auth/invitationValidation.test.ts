import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Mock server-only to prevent Next.js import checks during vitest runs
vi.mock('server-only', () => ({}));

import {
  validateNextPath,
  validateConfirmationParams,
  validatePasswordUpdate,
  INVITATION_COOKIE_NAME,
  INVITATION_COOKIE_PATH,
  INVITATION_ACCEPT_PATH,
  INVITATION_PASSWORD_PATH
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
  redirect: (target: string) => mockRedirect(target),
}));

// Mock next/headers cookies store
const mockCookieMap = new Map<string, Record<string, unknown>>();
const mockCookieStore = {
  get: vi.fn().mockImplementation((name: string) => mockCookieMap.get(name)),
  has: vi.fn().mockImplementation((name: string) => mockCookieMap.has(name)),
  set: vi.fn().mockImplementation((name: string, value: string, options: Record<string, unknown>) => {
    mockCookieMap.set(name, { name, value, ...options });
  }),
  delete: vi.fn().mockImplementation((options: string | { name: string }) => {
    const name = typeof options === 'string' ? options : options.name;
    mockCookieMap.delete(name);
  }),
};

vi.mock('next/headers', () => ({
  cookies: async () => mockCookieStore,
}));

// Mock Supabase Server Client and verifyOtp/getUser calls
const mockGetUser = vi.fn();
const mockUpdateUser = vi.fn();
const mockSignOut = vi.fn();
const mockVerifyOtp = vi.fn();

const mockCreateSupabaseServerClient = vi.fn().mockImplementation(async () => ({
  auth: {
    getUser: mockGetUser,
    updateUser: mockUpdateUser,
    signOut: mockSignOut,
    verifyOtp: mockVerifyOtp
  }
}));

vi.mock('../lib/supabase/server', () => ({
  createSupabaseServerClient: () => mockCreateSupabaseServerClient(),
}));

import { GET } from '../app/auth/confirm/route';
import AcceptInvitationPage from '../app/auth/confirm/accept/page';
import { acceptInvitationAction } from '../app/auth/confirm/accept/actions';
import { setPasswordAction } from '../app/auth/set-password/actions';
import { NextRequest } from 'next/server';

describe('Pure Logic Parameter Validation', () => {
  describe('validateNextPath', () => {
    it('should accept null next path as valid set-password destination', () => {
      expect(validateNextPath(null)).toBe(true);
    });

    it('should accept blank next path as valid', () => {
      expect(validateNextPath('   ')).toBe(true);
    });

    it('should accept exact set-password path', () => {
      expect(validateNextPath(INVITATION_PASSWORD_PATH)).toBe(true);
    });

    it('should reject alternative internal path like /admin', () => {
      expect(validateNextPath('/admin')).toBe(false);
    });

    it('should reject alternative internal path like /login', () => {
      expect(validateNextPath('/login')).toBe(false);
    });

    it('should reject external URLs', () => {
      expect(validateNextPath('https://external.com')).toBe(false);
    });

    it('should reject protocol-relative URLs', () => {
      expect(validateNextPath('//external.com')).toBe(false);
    });

    it('should reject backslash absolute paths', () => {
      expect(validateNextPath('\\admin')).toBe(false);
    });

    it('should reject query-bearing destinations', () => {
      expect(validateNextPath('/auth/set-password?token=123')).toBe(false);
    });

    it('should reject fragment-bearing destinations', () => {
      expect(validateNextPath('/auth/set-password#anchor')).toBe(false);
    });
  });

  describe('validateConfirmationParams', () => {
    it('should reject missing token_hash', () => {
      const res = validateConfirmationParams({ tokenHash: null, type: 'invite', next: INVITATION_PASSWORD_PATH });
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('MISSING_TOKEN_HASH');
    });

    it('should reject blank token_hash', () => {
      const res = validateConfirmationParams({ tokenHash: '   ', type: 'invite', next: INVITATION_PASSWORD_PATH });
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('MISSING_TOKEN_HASH');
    });

    it('should reject oversized token_hash', () => {
      const oversizedToken = 't'.repeat(2049);
      const res = validateConfirmationParams({ tokenHash: oversizedToken, type: 'invite', next: INVITATION_PASSWORD_PATH });
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('TOKEN_TOO_LONG');
    });

    it('should reject missing type', () => {
      const res = validateConfirmationParams({ tokenHash: 'token123', type: null, next: INVITATION_PASSWORD_PATH });
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('MISSING_TYPE');
    });

    it('should reject blank type', () => {
      const res = validateConfirmationParams({ tokenHash: 'token123', type: '   ', next: INVITATION_PASSWORD_PATH });
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('MISSING_TYPE');
    });

    it('should reject non-invite type', () => {
      const res = validateConfirmationParams({ tokenHash: 'token123', type: 'recovery', next: INVITATION_PASSWORD_PATH });
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('INVALID_TYPE');
    });

    it('should accept missing next parameter and default to set-password path', () => {
      const res = validateConfirmationParams({ tokenHash: 'token123', type: 'invite', next: null });
      expect(res.isValid).toBe(true);
      expect(res.next).toBe(INVITATION_PASSWORD_PATH);
    });

    it('should reject invalid next parameter path', () => {
      const res = validateConfirmationParams({ tokenHash: 'token123', type: 'invite', next: '/admin' });
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('INVALID_NEXT_PATH');
    });

    it('should confirm validation success result does not return the secret token', () => {
      const res = validateConfirmationParams({ tokenHash: 'token123', type: 'invite', next: INVITATION_PASSWORD_PATH });
      expect(res.isValid).toBe(true);
      expect(JSON.stringify(res)).not.toContain('token123');
    });
  });

  describe('validatePasswordUpdate', () => {
    it('should reject short password less than 12 characters', () => {
      const res = validatePasswordUpdate({ password: 'short', confirmation: 'short' });
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('PASSWORD_TOO_SHORT');
    });

    it('should reject oversized password greater than 128 characters', () => {
      const longPassword = 'p'.repeat(129);
      const res = validatePasswordUpdate({ password: longPassword, confirmation: longPassword });
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('PASSWORD_TOO_LONG');
    });

    it('should reject mismatched confirmation password', () => {
      const res = validatePasswordUpdate({ password: 'validpassword123', confirmation: 'differentpassword123' });
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('CONFIRMATION_MISMATCH');
    });

    it('should accept valid inputs and return success with no password secret returned', () => {
      const res = validatePasswordUpdate({ password: 'validpassword123', confirmation: 'validpassword123' });
      expect(res.isValid).toBe(true);
      expect(JSON.stringify(res)).not.toContain('validpassword123');
    });
  });
});

describe('GET Confirmation Route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should reject unexpected parameters, clear cookie, and set security headers', async () => {
    const req = new NextRequest('http://localhost:3000/auth/confirm?token_hash=token123&type=invite&bad_param=1');
    const response = await GET(req);

    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toContain('/login?error=INVALID_PARAMETERS');

    // Headers assertion
    expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0');
    expect(response.headers.get('Pragma')).toBe('no-cache');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow, noarchive');

    // Expired cookie validation
    const expiredCookie = response.cookies.get(INVITATION_COOKIE_NAME);
    expect(expiredCookie).toBeDefined();
    expect(expiredCookie?.value).toBe('');
    expect(expiredCookie?.maxAge).toBe(0);
  });

  it('should reject duplicate type parameters and clear stale cookie', async () => {
    const req = new NextRequest('http://localhost:3000/auth/confirm?token_hash=token123&type=invite&type=invite');
    const response = await GET(req);

    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toContain('/login?error=INVALID_PARAMETERS');

    const expiredCookie = response.cookies.get(INVITATION_COOKIE_NAME);
    expect(expiredCookie?.maxAge).toBe(0);
  });

  it('should capture valid parameters, perform zero client calls, and set lax HttpOnly cookie', async () => {
    // Check local development secure: false behavior
    const req = new NextRequest('http://localhost:3000/auth/confirm?token_hash=token123&type=invite');
    const response = await GET(req);

    expect(mockCreateSupabaseServerClient).not.toHaveBeenCalled();
    expect(mockVerifyOtp).not.toHaveBeenCalled();
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('http://localhost:3000' + INVITATION_ACCEPT_PATH);

    const cookie = response.cookies.get(INVITATION_COOKIE_NAME);
    expect(cookie?.value).toBe('token123');
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('lax');
    expect(cookie?.path).toBe(INVITATION_COOKIE_PATH);
    expect(cookie?.secure).toBe(false);

    // Headers check
    expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0');
    expect(response.headers.get('Pragma')).toBe('no-cache');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow, noarchive');
  });

  it('should verify production sets secure: true on cookie', async () => {
    const reqProd = new NextRequest('http://localhost:3000/auth/confirm?token_hash=token123&type=invite');
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    const responseProd = await GET(reqProd);
    (process.env as Record<string, string | undefined>).NODE_ENV = 'test';

    const cookie = responseProd.cookies.get(INVITATION_COOKIE_NAME);
    expect(cookie?.secure).toBe(true);
  });
});

describe('Acceptance Page Rendering', () => {
  beforeEach(() => {
    mockCookieMap.clear();
    vi.clearAllMocks();
  });

  it('should redirect if session cookie is missing', async () => {
    await expect(AcceptInvitationPage()).rejects.toThrow(RedirectError);
    expect(mockRedirect).toHaveBeenCalledWith('/login?error=INVITATION_SESSION_MISSING');
  });

  it('should render explicit form with no Supabase calls and no token rendered', async () => {
    mockCookieMap.set(INVITATION_COOKIE_NAME, { name: INVITATION_COOKIE_NAME, value: 'token123' });

    const pageElement = await AcceptInvitationPage();
    expect(pageElement).toBeDefined();
    expect(mockCreateSupabaseServerClient).not.toHaveBeenCalled();

    const serialized = JSON.stringify(pageElement);
    expect(serialized).not.toContain('token123');
  });
});

describe('Acceptance Action Verification', () => {
  beforeEach(() => {
    mockCookieMap.clear();
    vi.clearAllMocks();
  });

  it('should fail if invitation cookie is missing', async () => {
    await expect(acceptInvitationAction()).rejects.toThrow(RedirectError);
    expect(mockRedirect).toHaveBeenCalledWith('/login?error=INVITATION_SESSION_MISSING');
    expect(mockVerifyOtp).not.toHaveBeenCalled();
  });

  it('should call verifyOtp exactly once, delete cookie, and redirect to set-password on success', async () => {
    mockCookieMap.set(INVITATION_COOKIE_NAME, { name: INVITATION_COOKIE_NAME, value: 'token123' });
    mockVerifyOtp.mockResolvedValue({ error: null });

    await expect(acceptInvitationAction()).rejects.toThrow(RedirectError);
    expect(mockVerifyOtp).toHaveBeenCalledTimes(1);
    expect(mockVerifyOtp).toHaveBeenCalledWith({
      type: 'invite',
      token_hash: 'token123'
    });

    expect(mockCookieMap.has(INVITATION_COOKIE_NAME)).toBe(false);
    expect(mockRedirect).toHaveBeenCalledWith(INVITATION_PASSWORD_PATH);
  });

  it('should delete cookie and redirect to login error on OTP failure', async () => {
    mockCookieMap.set(INVITATION_COOKIE_NAME, { name: INVITATION_COOKIE_NAME, value: 'token123' });
    mockVerifyOtp.mockResolvedValue({ error: new Error('Token consumed') });

    await expect(acceptInvitationAction()).rejects.toThrow(RedirectError);
    expect(mockCookieMap.has(INVITATION_COOKIE_NAME)).toBe(false);
    expect(mockRedirect).toHaveBeenCalledWith('/login?error=VERIFICATION_FAILED');
  });

  it('should delete cookie and redirect to login error on thrown exception', async () => {
    mockCookieMap.set(INVITATION_COOKIE_NAME, { name: INVITATION_COOKIE_NAME, value: 'token123' });
    mockVerifyOtp.mockRejectedValue(new Error('Supabase unreachable'));

    await expect(acceptInvitationAction()).rejects.toThrow(RedirectError);
    expect(mockCookieMap.has(INVITATION_COOKIE_NAME)).toBe(false);
    expect(mockRedirect).toHaveBeenCalledWith('/login?error=VERIFICATION_FAILED');
  });
});

describe('Prefetch Flow Simulation', () => {
  beforeEach(() => {
    mockCookieMap.clear();
    vi.clearAllMocks();
  });

  it('should prove email GET capture and render call verifyOtp zero times, and verifyOtp is only triggered by Server Action', async () => {
    // 1. Scanner/Prefetcher GET link
    const req = new NextRequest('http://localhost:3000/auth/confirm?token_hash=token123&type=invite');
    const response = await GET(req);
    expect(response.status).toBe(303);
    expect(mockVerifyOtp).not.toHaveBeenCalled();

    const cookie = response.cookies.get(INVITATION_COOKIE_NAME);
    expect(cookie).toBeDefined();
    mockCookieMap.set(cookie!.name, cookie! as unknown as Record<string, unknown>);

    // 2. Browser render Acceptance page
    const page = await AcceptInvitationPage();
    expect(page).toBeDefined();
    expect(mockVerifyOtp).not.toHaveBeenCalled();

    // 3. User clicks explicit form button (Server Action)
    mockVerifyOtp.mockResolvedValue({ error: null });
    await expect(acceptInvitationAction()).rejects.toThrow(RedirectError);
    expect(mockVerifyOtp).toHaveBeenCalledTimes(1);
    expect(mockCookieMap.has(INVITATION_COOKIE_NAME)).toBe(false);
  });
});

describe('Password Setup Regression Safety', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should call updateUser and local signOut on successful password actions', async () => {
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

  it('should return error and not call signOut when updateUser fails', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-123' } }, error: null });
    mockUpdateUser.mockResolvedValue({ error: new Error('DB write failed') });

    const formData = new FormData();
    formData.append('password', 'validpassword123');
    formData.append('confirmation', 'validpassword123');

    const res = await setPasswordAction(null, formData);
    expect(res.error).toBe('PASSWORD_UPDATE_FAILED');
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it('should return SESSION_TERMINATION_FAILED when local signOut fails', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-123' } }, error: null });
    mockUpdateUser.mockResolvedValue({ error: null });
    mockSignOut.mockResolvedValue({ error: new Error('SignOut lock') });

    const formData = new FormData();
    formData.append('password', 'validpassword123');
    formData.append('confirmation', 'validpassword123');

    const res = await setPasswordAction(null, formData);
    expect(res.error).toBe('SESSION_TERMINATION_FAILED');
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});

describe('Static Safety Assurances', () => {
  const routeCode = fs.readFileSync(path.resolve(__dirname, '../app/auth/confirm/route.ts'), 'utf8');
  const acceptActionCode = fs.readFileSync(path.resolve(__dirname, '../app/auth/confirm/accept/actions.ts'), 'utf8');
  const acceptPageCode = fs.readFileSync(path.resolve(__dirname, '../app/auth/confirm/accept/page.tsx'), 'utf8');
  const passwordActionCode = fs.readFileSync(path.resolve(__dirname, '../app/auth/set-password/actions.ts'), 'utf8');
  const passwordPageCode = fs.readFileSync(path.resolve(__dirname, '../app/auth/set-password/page.tsx'), 'utf8');

  it('should assert no access_token or refresh_token references exist in the flow files', () => {
    expect(routeCode).not.toContain('access_token');
    expect(routeCode).not.toContain('refresh_token');
    expect(acceptActionCode).not.toContain('access_token');
    expect(acceptActionCode).not.toContain('refresh_token');
    expect(acceptPageCode).not.toContain('access_token');
    expect(acceptPageCode).not.toContain('refresh_token');
    expect(passwordActionCode).not.toContain('access_token');
    expect(passwordActionCode).not.toContain('refresh_token');
  });

  it('should assert no bootstrap_initial_admin calls or database relational writes exist in invitation files', () => {
    expect(routeCode).not.toContain('bootstrap_initial_admin');
    expect(acceptActionCode).not.toContain('bootstrap_initial_admin');
    expect(acceptPageCode).not.toContain('bootstrap_initial_admin');

    expect(routeCode).not.toContain('insert');
    expect(acceptActionCode).not.toContain('insert');
  });

  it('should assert no user.email rendered in the set-password page HTML', () => {
    expect(passwordPageCode).not.toContain('user.email');
    expect(passwordPageCode).not.toContain('email');
  });

  it('should assert no machine-specific file:/// links exist in the manual apply guide or instructions', () => {
    const guideCode = fs.readFileSync(path.resolve(__dirname, '../../../../infra/supabase/manual-apply-guide.md'), 'utf8');
    expect(guideCode).not.toContain('file:///D:');
    expect(guideCode).not.toContain('file:///C:');
  });

  it('should assert that the SetPasswordForm source code contains controlled visible inputs, named visible fields, wrapper handling, and no dot placeholders', () => {
    const formCode = fs.readFileSync(path.resolve(__dirname, '../app/auth/set-password/SetPasswordForm.tsx'), 'utf8');

    // Check that there are no dot placeholders
    expect(formCode).not.toContain('••••••••••••');

    // Check for controlled React state
    expect(formCode).toContain('const [password, setPassword] = React.useState');
    expect(formCode).toContain('const [confirmation, setConfirmation] = React.useState');

    // Check for named visible inputs
    expect(formCode).toContain('name="password"');
    expect(formCode).toContain('name="confirmation"');

    // Check no hidden inputs
    expect(formCode).not.toContain('type="hidden"');

    // Check for local action wrapper and helper use
    expect(formCode).toContain('const handleSubmit = (formData: FormData) =>');
    expect(formCode).toContain('canonicalizePasswordFormData(formData, { password, confirmation })');
    expect(formCode).toContain('formAction(canonicalData)');
  });

  it('should prove server-side value preservation, defensive type checks, and raw password safety', async () => {
    // 1. Missing fields return empty error
    const emptyForm = new FormData();
    const resEmpty = await setPasswordAction(null, emptyForm);
    expect(resEmpty.error).toBe('PASSWORD_EMPTY');

    // 2. Non-string FormData entry safety
    const badForm = new FormData();
    badForm.append('password', new File([], 'p.txt'));
    badForm.append('confirmation', 'validpassword123');
    const resBad = await setPasswordAction(null, badForm);
    expect(resBad.error).toBe('PASSWORD_EMPTY');

    // 3. Preservation of spacing, punctuation, and casing
    const complexForm = new FormData();
    complexForm.append('password', ' Complex Pass! 123 ');
    complexForm.append('confirmation', ' Complex Pass! 123 ');

    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-123' } }, error: null });
    mockUpdateUser.mockResolvedValue({ error: null });
    mockSignOut.mockResolvedValue({ error: null });

    await expect(setPasswordAction(null, complexForm)).rejects.toThrow(RedirectError);
    // Raw password should reach updateUser exactly as entered without trimming
    expect(mockUpdateUser).toHaveBeenCalledWith({ password: ' Complex Pass! 123 ' });

    // Assert no password logs or references in action code
    expect(passwordActionCode).not.toContain('console.log(password)');
    expect(passwordActionCode).not.toContain('console.log(rawPassword)');
  });
});
