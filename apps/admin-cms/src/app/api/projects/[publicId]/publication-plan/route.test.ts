import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from './route';

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), prepare: vi.fn() }));
vi.mock('../../../../../auth/requireAdmin', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('../../../../../projects/publicationPlanService', () => ({ preparePublicationPlan: mocks.prepare }));
vi.mock('../../../../../repositories/SupabaseProjectRepository', () => ({ SupabaseProjectRepository: class {} }));
vi.mock('../../../../../repositories/SupabaseParticipantPreviewRepository', () => ({ SupabaseParticipantPreviewRepository: class {} }));
vi.mock('../../../../../lib/env', () => ({ getServerEnv: () => ({ SUPABASE_DRAFT_BUCKET: 'server-bucket' }) }));
const context = (publicId: string) => ({ params: Promise.resolve({ publicId }) });
const request = (origin = 'http://app.test') => new NextRequest('http://app.test/api/projects/abc/publication-plan', { method: 'POST', headers: { origin } });
describe('publication plan route', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.requireAdmin.mockResolvedValue({ adminUserId: 'server-admin', permissions: ['projects.publish'] }); mocks.prepare.mockResolvedValue({ resultCode: 'READY_TO_STAGE', publicId: 'abc_123', confirmedPreviewId: 'preview', confirmedAt: '2026-01-01T00:00:00Z', recordCount: 2, feedHash: 'a'.repeat(64) }); });
  it('accepts canonical underscore IDs and returns bounded no-store plan evidence', async () => { const response = await POST(request(), context('abc_123')); expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store'); expect(await response.json()).toMatchObject({ success: true, result: { publicId: 'abc_123', feedHash: 'a'.repeat(64) } }); expect(mocks.prepare).toHaveBeenCalledWith(['projects.publish'], 'abc_123', expect.any(Object)); });
  it('rejects invalid origin and over-100 IDs before planning', async () => { expect((await POST(request('http://evil.test'), context('abc'))).status).toBe(403); expect((await POST(request(), context('a'.repeat(101)))).status).toBe(400); expect(mocks.prepare).not.toHaveBeenCalled(); });
  it('maps permission and unavailable plans to bounded responses', async () => { mocks.prepare.mockResolvedValueOnce({ resultCode: 'PERMISSION_DENIED' }).mockResolvedValueOnce({ resultCode: 'NOT_READY', readinessCode: 'NO_ACTIVE_PREVIEW', blockers: ['required'] }).mockResolvedValueOnce({ resultCode: 'PLAN_UNAVAILABLE' }); expect((await POST(request(), context('abc'))).status).toBe(403); expect((await POST(request(), context('abc'))).status).toBe(409); expect((await POST(request(), context('abc'))).status).toBe(409); });
});
