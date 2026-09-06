import { NextRequest, NextResponse } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STAGING_MAINTENANCE_MARKER_HEADER,
  STAGING_MAINTENANCE_MARKER_VALUE,
  STAGING_MAINTENANCE_MODE_VAR,
  STAGING_MAINTENANCE_RESPONSE_BODY,
  STAGING_MAINTENANCE_RETRY_AFTER_SECONDS,
  evaluateStagingMaintenanceGate,
  isStagingMaintenanceModeEnabled,
  isStagingMaintenanceModeEnabledValue,
  stagingMaintenanceUnavailableResponse,
} from './stagingMaintenanceGate';

const session = vi.hoisted(() => ({ updateSession: vi.fn() }));

vi.mock('../lib/supabase/proxy', () => ({ updateSession: session.updateSession }));

import { config, proxy } from '../../proxy';
import { config as executedConfig, proxy as executedProxy } from '../proxy';

const SESSION_RESPONSE_MARKER = 'x-test-session-response';
const SYNTHETIC_PREVIEW_TOKEN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function request(pathname: string, method = 'GET'): NextRequest {
  return new NextRequest(`http://localhost${pathname}`, { method });
}

function enableMaintenance(): void {
  vi.stubEnv(STAGING_MAINTENANCE_MODE_VAR, 'true');
}

describe('staging rollout maintenance gate contract', () => {
  beforeEach(() => {
    session.updateSession.mockReset();
    session.updateSession.mockImplementation(async () => {
      const response = NextResponse.next();
      response.headers.set(SESSION_RESPONSE_MARKER, 'yes');
      return response;
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('activation semantics', () => {
    it('activates only on the exact literal true', () => {
      expect(isStagingMaintenanceModeEnabledValue('true')).toBe(true);
      const rejected = [
        'TRUE', 'True', '1', 'yes', 'on', 'enabled', ' true', 'true ', 'true\n', '', 'false',
        null, undefined,
      ];
      for (const value of rejected) {
        expect(isStagingMaintenanceModeEnabledValue(value)).toBe(false);
      }
    });

    it('reads only its own variable and is not conditional on the runtime identity variables', () => {
      expect(isStagingMaintenanceModeEnabled({})).toBe(false);

      expect(isStagingMaintenanceModeEnabled({ [STAGING_MAINTENANCE_MODE_VAR]: 'true' })).toBe(true);
      expect(isStagingMaintenanceModeEnabled({
        [STAGING_MAINTENANCE_MODE_VAR]: 'true',
        CAPSTONE_RUNTIME_ENV: 'staging',
      })).toBe(true);
      expect(isStagingMaintenanceModeEnabled({
        [STAGING_MAINTENANCE_MODE_VAR]: 'true',
        CAPSTONE_RUNTIME_ENV: 'local',
      })).toBe(true);

      expect(isStagingMaintenanceModeEnabled({
        CAPSTONE_RUNTIME_ENV: 'staging',
        CAPSTONE_EXPECTED_SUPABASE_HOST: 'example.supabase.co',
        CAPSTONE_STAGING_MUTATION_CONFIRMATION: 'example-label',
        CAPSTONE_STAGING_PUBLICATION_ENABLED: 'true',
      })).toBe(false);
    });

    it('reports DISABLED for every request shape when the flag is absent or not exactly true', () => {
      const environments = [
        {},
        { [STAGING_MAINTENANCE_MODE_VAR]: 'TRUE' },
        { [STAGING_MAINTENANCE_MODE_VAR]: '1' },
      ];
      for (const env of environments) {
        expect(evaluateStagingMaintenanceGate({ method: 'POST', pathname: '/admin', env }))
          .toBe('DISABLED');
      }
    });
  });

  describe('disabled mode preserves existing proxy behaviour', () => {
    it('delegates every request to updateSession and returns its response unchanged', async () => {
      const cases: Array<[string, string]> = [
        ['/admin', 'GET'],
        ['/api/projects', 'GET'],
        ['/api/projects/synthetic-2026-0001/review-action', 'POST'],
        [`/participant-preview/${SYNTHETIC_PREVIEW_TOKEN}`, 'POST'],
        ['/login', 'POST'],
      ];

      for (const [pathname, method] of cases) {
        const response = await proxy(request(pathname, method));
        expect(response.headers.get(SESSION_RESPONSE_MARKER)).toBe('yes');
        expect(response.status).toBe(200);
        expect(response.headers.get(STAGING_MAINTENANCE_MARKER_HEADER)).toBeNull();
        expect(response.headers.get('Retry-After')).toBeNull();
      }

      expect(session.updateSession).toHaveBeenCalledTimes(cases.length);
    });
  });

  describe('enabled mode allows only the read-only H2 probe surfaces', () => {
    beforeEach(enableMaintenance);

    it.each([
      ['GET', '/api/health'],
      ['HEAD', '/api/health'],
      ['GET', '/api/readiness'],
      ['HEAD', '/api/readiness'],
      ['GET', '/login'],
      ['HEAD', '/login'],
    ])('%s %s continues through the normal handler', async (method, pathname) => {
      expect(evaluateStagingMaintenanceGate({ method, pathname })).toBe('ALLOWED');

      const response = await proxy(request(pathname, method));
      expect(response.headers.get(SESSION_RESPONSE_MARKER)).toBe('yes');
      expect(response.status).toBe(200);
      expect(session.updateSession).toHaveBeenCalledTimes(1);
    });

    it('ignores the query string when matching an allowed path', async () => {
      const allowed = await proxy(request('/login?next=/admin&error=RECOVERY_LINK_INVALID'));
      expect(allowed.status).toBe(200);
      expect(session.updateSession).toHaveBeenCalledTimes(1);
    });

    it('does not let a query string smuggle an allowed path onto a blocked one', async () => {
      const smuggled = [
        '/admin?next=/login',
        '/admin?redirect=/api/health',
        '/api/projects?path=/api/readiness',
      ];
      for (const pathname of smuggled) {
        const response = await proxy(request(pathname));
        expect(response.status).toBe(503);
      }
      expect(session.updateSession).not.toHaveBeenCalled();
    });
  });

  describe('enabled mode blocks every other application surface', () => {
    beforeEach(enableMaintenance);

    it.each([
      ['GET', '/'],
      ['GET', '/admin'],
      ['GET', '/admin/imports'],
      ['GET', '/admin/imports/new'],
      ['GET', '/admin/imports/synthetic-batch'],
      ['GET', '/admin/projects/synthetic-2026-0001'],
      ['GET', '/admin/staff'],
      ['GET', '/admin/public-feed'],
      ['GET', '/api/projects'],
      ['GET', '/api/projects/synthetic-2026-0001/participant-preview'],
      ['GET', '/api/projects/synthetic-2026-0001/publication-plan'],
      ['POST', '/api/projects/synthetic-2026-0001/review-action'],
      ['POST', '/api/projects/bulk-review/execute'],
      ['POST', '/api/projects/bulk-review/preflight'],
      ['POST', '/api/imports/preview'],
      ['POST', '/api/imports/stage-metadata'],
      ['POST', '/api/imports/stage-media'],
      ['POST', '/api/imports/synthetic-batch/submit-for-review'],
      ['POST', '/api/staff/invitations'],
      ['POST', '/api/staff/test-accounts'],
      ['POST', '/api/public-feed/activation'],
      ['POST', '/api/public-feed/rollback'],
      ['POST', '/api/projects/synthetic-2026-0001/staging-publication'],
      ['POST', '/api/projects/synthetic-2026-0001/deployment-reconciliation'],
      ['GET', `/participant-preview/${SYNTHETIC_PREVIEW_TOKEN}`],
      ['POST', `/participant-preview/${SYNTHETIC_PREVIEW_TOKEN}`],
      ['POST', '/api/projects/synthetic-2026-0001/participant-preview/correction-resolution'],
      ['POST', '/api/projects/synthetic-2026-0001/participant-preview/reminders'],
      ['GET', '/auth/forgot-password'],
      ['POST', '/auth/forgot-password'],
      ['GET', '/auth/recovery/callback'],
      ['GET', '/auth/recovery/invalid'],
      ['GET', '/auth/confirm'],
      ['GET', '/auth/reset-password'],
      ['POST', '/auth/reset-password'],
      ['POST', '/auth/set-password'],
      ['POST', '/auth/recovery/accept'],
      ['POST', '/auth/confirm/accept'],
      ['POST', '/admin/projects/synthetic-2026-0001'],
      ['POST', '/admin/staff'],
    ])('%s %s returns 503 without reaching the session layer', async (method, pathname) => {
      expect(evaluateStagingMaintenanceGate({ method, pathname })).toBe('BLOCKED');

      const response = await proxy(request(pathname, method));
      expect(response.status).toBe(503);
      expect(session.updateSession).not.toHaveBeenCalled();
    });

    it('blocks unsafe methods on an otherwise allowed pathname', async () => {
      for (const pathname of ['/login', '/api/health', '/api/readiness']) {
        for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
          expect(evaluateStagingMaintenanceGate({ method, pathname })).toBe('BLOCKED');
          const response = await proxy(request(pathname, method));
          expect(response.status).toBe(503);
        }
      }
      expect(session.updateSession).not.toHaveBeenCalled();
    });

    it('blocks unknown and non-canonical method spellings', () => {
      for (const method of ['BREW', 'PROPFIND', 'TRACE', 'get', 'head', 'Get']) {
        expect(evaluateStagingMaintenanceGate({ method, pathname: '/api/health' })).toBe('BLOCKED');
      }
    });

    it('does not allow similarly prefixed or suffixed pathnames', async () => {
      const lookalikes = [
        '/login-foo',
        '/logins',
        '/loginx',
        '/xlogin',
        '/api/healthz',
        '/api/health-check',
        '/api/readiness-probe',
        '/admin/login',
      ];
      for (const pathname of lookalikes) {
        expect(evaluateStagingMaintenanceGate({ method: 'GET', pathname })).toBe('BLOCKED');
        const response = await proxy(request(pathname));
        expect(response.status).toBe(503);
      }
      expect(session.updateSession).not.toHaveBeenCalled();
    });

    it('does not allow casing or trailing-path variants of an allowed pathname', () => {
      const variants = [
        '/LOGIN',
        '/Login',
        '/API/health',
        '/api/Health',
        '/api/HEALTH',
        '/api/READINESS',
        '/login/',
        '/api/health/',
        '/api/readiness/',
        '/login/extra',
        '/api/health/sub',
      ];
      for (const pathname of variants) {
        expect(evaluateStagingMaintenanceGate({ method: 'GET', pathname })).toBe('BLOCKED');
      }
    });
  });

  describe('blocked response contract', () => {
    beforeEach(enableMaintenance);

    it('is fixed, privacy-safe and identical for every blocked request', async () => {
      const first = await proxy(request('/admin/projects/synthetic-2026-0001?operator=example'));
      const second = await proxy(request('/api/imports/stage-metadata', 'POST'));

      for (const response of [first, second]) {
        expect(response.status).toBe(503);
        expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0');
        expect(response.headers.get('Retry-After'))
          .toBe(String(STAGING_MAINTENANCE_RETRY_AFTER_SECONDS));
        expect(response.headers.get(STAGING_MAINTENANCE_MARKER_HEADER))
          .toBe(STAGING_MAINTENANCE_MARKER_VALUE);
        expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
        expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow, noarchive');
        expect(response.headers.get('Set-Cookie')).toBeNull();
      }

      const firstBody = await first.text();
      const secondBody = await second.text();
      expect(firstBody).toBe(STAGING_MAINTENANCE_RESPONSE_BODY);
      expect(secondBody).toBe(firstBody);
    });

    it('leaks no request, route-parameter, environment or provider value', async () => {
      vi.stubEnv('CAPSTONE_EXPECTED_SUPABASE_HOST', 'sqkpceeltukbzxpsvinb.supabase.co');
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://sqkpceeltukbzxpsvinb.supabase.co');

      const response = await proxy(
        request('/admin/projects/synthetic-2026-0001?operator=example.person'),
      );
      const body = await response.text();
      const headers = [...response.headers.entries()]
        .map(([name, value]) => `${name}: ${value}`)
        .join('\n');
      const serialized = `${body}\n${headers}`.toLowerCase();

      const forbidden = [
        'synthetic-2026-0001',
        'example.person',
        'operator',
        'admin',
        'sqkpceeltukbzxpsvinb',
        'supabase',
        'localhost',
        'postgres',
        'render',
        'capstone_staging_maintenance_mode',
      ];
      for (const value of forbidden) {
        expect(serialized).not.toContain(value.toLowerCase());
      }
    });

    it('exposes a standalone fixed response builder with the same contract', async () => {
      const response = stagingMaintenanceUnavailableResponse();
      expect(response.status).toBe(503);
      expect(await response.text()).toBe(STAGING_MAINTENANCE_RESPONSE_BODY);
    });
  });

  describe('gate placement', () => {
    it('keeps the existing proxy matcher so static assets stay excluded', () => {
      expect(config.matcher).toEqual([
        '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
      ]);
    });

    it('applies the identical matcher at the proxy location Next actually executes', () => {
      expect(executedConfig.matcher).toEqual(config.matcher);
    });
  });

  describe('executed proxy entry point (src/proxy.ts)', () => {
    it('passes every request through unchanged while maintenance is disabled', async () => {
      const cases: Array<[string, string]> = [
        ['/admin', 'GET'],
        ['/api/projects/synthetic-2026-0001/review-action', 'POST'],
        [`/participant-preview/${SYNTHETIC_PREVIEW_TOKEN}`, 'POST'],
        ['/login', 'POST'],
        ['/auth/reset-password', 'POST'],
      ];

      for (const [pathname, method] of cases) {
        const response = await executedProxy(request(pathname, method));
        expect(response.status).toBe(200);
        expect(response.headers.get(STAGING_MAINTENANCE_MARKER_HEADER)).toBeNull();
        expect(response.headers.get('Retry-After')).toBeNull();
      }
    });

    it('allows only the read-only H2 probe surfaces while maintenance is enabled', async () => {
      enableMaintenance();

      const allowed: Array<[string, string]> = [
        ['GET', '/api/health'],
        ['HEAD', '/api/health'],
        ['GET', '/api/readiness'],
        ['HEAD', '/api/readiness'],
        ['GET', '/login'],
        ['HEAD', '/login'],
      ];
      for (const [method, pathname] of allowed) {
        const response = await executedProxy(request(pathname, method));
        expect(response.status).toBe(200);
        expect(response.headers.get(STAGING_MAINTENANCE_MARKER_HEADER)).toBeNull();
      }
    });

    it('returns the fixed 503 for admin, API, participant and auth mutation surfaces', async () => {
      enableMaintenance();

      const blocked: Array<[string, string]> = [
        ['GET', '/'],
        ['GET', '/admin'],
        ['GET', '/admin/projects/synthetic-2026-0001'],
        ['GET', '/api/projects'],
        ['POST', '/api/projects/synthetic-2026-0001/review-action'],
        ['POST', '/api/imports/stage-metadata'],
        ['POST', '/api/staff/invitations'],
        ['GET', `/participant-preview/${SYNTHETIC_PREVIEW_TOKEN}`],
        ['POST', `/participant-preview/${SYNTHETIC_PREVIEW_TOKEN}`],
        ['POST', '/auth/reset-password'],
        ['GET', '/auth/forgot-password'],
        ['POST', '/login'],
        ['POST', '/api/health'],
        ['GET', '/login-foo'],
        ['GET', '/LOGIN'],
      ];
      for (const [method, pathname] of blocked) {
        const response = await executedProxy(request(pathname, method));
        expect(response.status).toBe(503);
        expect(response.headers.get(STAGING_MAINTENANCE_MARKER_HEADER))
          .toBe(STAGING_MAINTENANCE_MARKER_VALUE);
        expect(await response.text()).toBe(STAGING_MAINTENANCE_RESPONSE_BODY);
      }
    });

    it('never constructs a Supabase session client on any path', async () => {
      enableMaintenance();
      await executedProxy(request('/admin'));
      await executedProxy(request('/api/health'));
      vi.unstubAllEnvs();
      await executedProxy(request('/admin'));

      expect(session.updateSession).not.toHaveBeenCalled();
    });
  });
});
