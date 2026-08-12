import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(), execute: vi.fn(), createDeps: vi.fn(), createClient: vi.fn(),
  env: { supabaseUrl: 'http://127.0.0.1:54321', SUPABASE_PUBLIC_FEEDS_BUCKET: 'server-feed-bucket', SUPABASE_PUBLIC_FEED_FILE: 'server-feed.json' },
}));
vi.mock('../../../../../auth/requireAdmin', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('../../../../../projects/controlledPublicRemovalService', () => ({ executeControlledPublicRemoval: mocks.execute }));
vi.mock('../../../../../projects/createControlledPublicRemovalDependencies', () => ({ createControlledPublicRemovalDependencies: mocks.createDeps }));
vi.mock('../../../../../lib/supabase/admin', () => ({ createSupabaseAdminClient: mocks.createClient }));
vi.mock('../../../../../lib/env', () => ({ getServerEnv: () => mocks.env }));
import { NextRequest } from 'next/server';
import { AdminAuthError } from '../../../../../auth/authTypes';
import { POST } from './route';

const admin = { adminUserId: 'server-admin', permissions: ['projects.archive'] };
const deps = { server: true };
const completed = { resultCode: 'COMPLETED', attemptId: 'internal', auditRecordId: 'internal-audit', recordCount: 0, feedHash: 'a'.repeat(64), content: '[]' };
function request(body: unknown = { archiveReason: '  Retired showcase entry  ' }, origin = 'http://app.test') { return new NextRequest('http://app.test/api/projects/x/local-archive', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
const context = (publicId: string) => ({ params: Promise.resolve({ publicId }) });
async function post(publicId = 'project_2026', body?: unknown, origin?: string) { return POST(request(body, origin), context(publicId)); }
async function read(response: Response) { expect(response.headers.get('Cache-Control')).toBe('no-store'); return response.json(); }

describe('POST /api/projects/[publicId]/local-archive', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.env.supabaseUrl = 'http://127.0.0.1:54321'; mocks.requireAdmin.mockResolvedValue(admin); mocks.createClient.mockReturnValue({ client: true }); mocks.createDeps.mockReturnValue(deps); mocks.execute.mockResolvedValue(completed); });
  it('invokes the coordinator with only server authority and the trimmed reason', async () => {
    const response = await post(); expect(response.status).toBe(200); expect(await read(response)).toEqual({ success: true, result: { resultCode: 'COMPLETED', publicId: 'project_2026', recordCount: 0, feedHash: 'a'.repeat(64) } });
    expect(mocks.createDeps).toHaveBeenCalledWith({ supabase: { client: true }, supabaseUrl: 'http://127.0.0.1:54321', publicId: 'project_2026', adminId: 'server-admin', feedBucket: 'server-feed-bucket', feedPath: 'server-feed.json' });
    expect(mocks.execute).toHaveBeenCalledWith({ permissions: ['projects.archive'], publicId: 'project_2026', archiveReason: 'Retired showcase entry', dependencies: deps });
  });
  it('rejects invalid Origin before execution', async () => { const r = await post('project_2026', undefined, 'http://evil.test'); expect(r.status).toBe(403); await read(r); expect(mocks.execute).not.toHaveBeenCalled(); });
  it('maps unauthenticated access safely', async () => { mocks.requireAdmin.mockRejectedValue(new AdminAuthError('UNAUTHENTICATED', 'raw')); const r = await post(); expect(r.status).toBe(401); expect(await read(r)).toEqual({ success: false, error: 'Authentication required.' }); expect(mocks.execute).not.toHaveBeenCalled(); });
  it.each([['reviewer', ['projects.read', 'projects.review']], ['editor', ['projects.read', 'projects.edit']]])('rejects %s', async (_role, permissions) => { mocks.requireAdmin.mockResolvedValue({ adminUserId: 'staff', permissions }); const r = await post(); expect(r.status).toBe(403); await read(r); expect(mocks.execute).not.toHaveBeenCalled(); });
  it.each([['bad/id', { archiveReason: 'Reason' }], ['project', {}], ['project', { archiveReason: ' ' }], ['project', { archiveReason: 'x'.repeat(4001) }]])('rejects invalid ID/reason %#', async (publicId, body) => { const r = await post(publicId, body); expect(r.status).toBe(400); await read(r); expect(mocks.execute).not.toHaveBeenCalled(); });
  it('accepts underscore and 100-character IDs', async () => { expect((await post('project_2026')).status).toBe(200); const id = `project_${'a'.repeat(92)}`; expect(id).toHaveLength(100); expect((await post(id)).status).toBe(200); });
  it('rejects a 101-character ID', async () => { const id = `project_${'a'.repeat(93)}`; const r = await post(id); expect(r.status).toBe(400); await read(r); });
  it('fails closed off-loopback before coordinator creation', async () => { mocks.env.supabaseUrl = 'https://hosted.supabase.co'; const r = await post(); expect(r.status).toBe(404); expect(await read(r)).toMatchObject({ code: 'LOCAL_ARCHIVE_UNAVAILABLE' }); expect(mocks.createDeps).not.toHaveBeenCalled(); });
  it.each(['ALREADY_COMPLETED'] as const)('maps %s to HTTP 200', async (resultCode) => { mocks.execute.mockResolvedValue({ ...completed, resultCode }); const r = await post(); expect(r.status).toBe(200); expect(await read(r)).toMatchObject({ success: true, result: { resultCode } }); });
  it.each([['PUBLICATION_IN_PROGRESS', 'Another public-feed operation is already in progress.'], ['COMPENSATION_INCOMPLETE', 'Public-feed recovery is incomplete and requires attention.'], ['ATTEMPT_OWNER_MISMATCH', 'Public-feed recovery is incomplete and requires attention.'], ['ARCHIVE_REASON_MISMATCH', 'Retry must use the archive reason bound to the existing attempt.'], ['NOT_PUBLISHED', 'The project is not currently published.']])('maps %s to bounded HTTP 409', async (resultCode, error) => { mocks.execute.mockResolvedValue({ resultCode }); const r = await post(); expect(r.status).toBe(409); expect(await read(r)).toMatchObject({ success: false, error }); });
  it('maps feed divergence to bounded HTTP 409', async () => { mocks.execute.mockResolvedValue({ resultCode: 'EXECUTION_FAILED', failureCode: 'CURRENT_FEED_DIVERGED' }); const r = await post(); expect(r.status).toBe(409); expect(await read(r)).toMatchObject({ code: 'CURRENT_FEED_DIVERGED' }); });
  it('returns bounded 500 for unexpected exceptions', async () => { const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined); mocks.execute.mockRejectedValue(new Error('raw storage detail')); const r = await post(); expect(r.status).toBe(500); const json = await read(r); expect(JSON.stringify(json)).not.toContain('raw storage'); spy.mockRestore(); });
  it('ignores malicious authority fields except the validated archive reason', async () => { const body = { archiveReason: 'Server-bound reason', adminUserId: 'attacker', permissions: ['projects.archive'], supabaseUrl: 'https://evil', feedBucket: 'attacker', feedPath: 'evil.json', candidateFeedHash: 'attacker', executionToken: 'attacker' }; const r = await post('route_project', body); expect(r.status).toBe(200); await read(r); expect(JSON.stringify(mocks.createDeps.mock.calls[0])).not.toContain('attacker'); expect(mocks.execute).toHaveBeenCalledWith({ permissions: ['projects.archive'], publicId: 'route_project', archiveReason: 'Server-bound reason', dependencies: deps }); });
});
