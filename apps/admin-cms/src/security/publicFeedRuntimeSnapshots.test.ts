import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { assertPublicFeedRollbackEnvironmentAvailable } from '../projects/publicFeedRollbackPolicy';
vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ auth: vi.fn(), env: vi.fn(), client: vi.fn(), dependencies: vi.fn(), activate: vi.fn(), recover: vi.fn() }));
vi.mock('../auth/requireAdmin', () => ({ requireAdmin: mocks.auth }));
vi.mock('../lib/env', () => ({ getServerEnv: mocks.env }));
vi.mock('../lib/supabase/admin', () => ({ createSupabaseAdminClientForServerEnv: mocks.client }));
vi.mock('../projects/createPublicFeedHistoryDependencies', () => ({ createPublicFeedHistoryDependencies: mocks.dependencies }));
vi.mock('../projects/publicFeedHistoryService', () => ({ activatePublicFeedHistory: mocks.activate, recoverPublicFeedOperation: mocks.recover }));
import { POST as activation } from '../app/api/public-feed/activation/route';
import { POST as recovery } from '../app/api/public-feed/recovery/route';
const request = (name: string) => new NextRequest(`http://localhost:3000/api/public-feed/${name}`, { method: 'POST', headers: { origin: 'http://localhost:3000' } });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ adminUserId: 'synthetic-admin', permissions: ['projects.publish'] });
  mocks.dependencies.mockImplementation(parameters => parameters);
  mocks.client.mockReturnValue({});
  mocks.activate.mockResolvedValue({ resultCode: 'COMPLETED', versionNumber: 1, recordCount: 0, feedHash: 'a'.repeat(64) });
  mocks.recover.mockResolvedValue({ resultCode: 'NO_RECOVERY_REQUIRED' });
});
afterEach(() => vi.unstubAllEnvs());
function configure(target: 'local' | 'staging' | 'production', publication = true) {
  const host = `synthetic-${target}.supabase.co`;
  const url = target === 'local' ? 'http://127.0.0.1:54321' : `https://${host}`;
  vi.stubEnv('CAPSTONE_RUNTIME_ENV', target); vi.stubEnv('CAPSTONE_EXPECTED_SUPABASE_HOST', host);
  for (const flag of ['CAPSTONE_LOCAL_PUBLIC_FEED_ROLLBACK_ENABLED', 'CAPSTONE_STAGING_PUBLIC_FEED_ROLLBACK_ENABLED']) vi.stubEnv(flag, 'true');
  for (const flag of ['CAPSTONE_STAGING_PUBLICATION_ENABLED', 'CAPSTONE_PRODUCTION_PUBLICATION_ENABLED']) vi.stubEnv(flag, String(publication));
  mocks.env.mockReturnValue({ supabaseUrl: url, SUPABASE_PUBLIC_FEEDS_BUCKET: 'public-feeds', SUPABASE_PUBLIC_FEED_FILE: 'capstones-latest.json' });
  return url;
}
describe('real runtime policies applied to frozen route snapshots', () => {
  for (const [name, route] of [['activation', activation], ['recovery', recovery]] as const) {
    it.each(['local', 'staging', 'production'] as const)(`${name} preserves independent rollback policy for %s`, async target => {
      const url = configure(target);
      expect((await route(request(name))).status).toBe(200);
      const parameters = mocks.dependencies.mock.calls[0][0];
      expect(Object.isFrozen(parameters.environment)).toBe(true);
      expect(parameters.environment.CAPSTONE_LOCAL_PUBLIC_FEED_ROLLBACK_ENABLED).toBe('true');
      expect(parameters.environment.CAPSTONE_STAGING_PUBLIC_FEED_ROLLBACK_ENABLED).toBe('true');
      vi.stubEnv('CAPSTONE_STAGING_PUBLIC_FEED_ROLLBACK_ENABLED', 'false');
      vi.stubEnv('CAPSTONE_LOCAL_PUBLIC_FEED_ROLLBACK_ENABLED', 'false');
      if (target === 'production') expect(() => assertPublicFeedRollbackEnvironmentAvailable(url, parameters.environment)).toThrow();
      else expect(assertPublicFeedRollbackEnvironmentAvailable(url, parameters.environment)).toBe(target);
    });
  }
  it('permits rollback-only staging recovery inspection without enabling new publication', async () => {
    configure('staging', false);
    expect((await recovery(request('recovery'))).status).toBe(200);
    const parameters = mocks.dependencies.mock.calls[0][0];
    expect(parameters.executionTarget).toBeUndefined();
    expect(assertPublicFeedRollbackEnvironmentAvailable(parameters.supabaseUrl, parameters.environment)).toBe('staging');
  });
  it('refuses every production action before privileged access when publication is disabled', async () => {
    configure('production', false);
    expect((await recovery(request('recovery'))).status).toBe(500);
    expect(mocks.client).not.toHaveBeenCalled(); expect(mocks.recover).not.toHaveBeenCalled();
  });
});
