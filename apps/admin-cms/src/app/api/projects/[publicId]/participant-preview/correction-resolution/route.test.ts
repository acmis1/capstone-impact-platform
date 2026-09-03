import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from './route';
import { requireAdmin } from '../../../../../../auth/requireAdmin';
import { AdminAuthError } from '../../../../../../auth/authTypes';
import { decideParticipantCorrection } from '../../../../../../previews/participantCorrectionReview';
vi.mock('../../../../../../auth/requireAdmin');
vi.mock('../../../../../../lib/supabase/adminCore', () => ({ createSupabaseAdminClientCore: () => ({}) }));
vi.mock('../../../../../../previews/participantCorrectionReview', async (importOriginal) => ({ ...await importOriginal<typeof import('../../../../../../previews/participantCorrectionReview')>(), decideParticipantCorrection: vi.fn() }));
const payload = { action: 'accept', submissionId: '22222222-2222-4222-8222-222222222222', packageHash: 'a'.repeat(64), expectedVersion: 'b'.repeat(64) };
const params = { params: Promise.resolve({ publicId: '2026-synthetic' }) };
function request(body: unknown = payload, origin: string | null = 'http://localhost:3000') {
  const headers: Record<string,string> = { 'Content-Type': 'application/json' };
  if (origin !== null) headers.origin = origin;
  return new NextRequest('http://localhost:3000/api/projects/2026-synthetic/participant-preview/correction-resolution', { method: 'POST', headers, body: JSON.stringify(body) });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({ adminUserId: 'actor-from-session', permissions: ['projects.edit', 'projects.review'] } as never);
  vi.mocked(decideParticipantCorrection).mockResolvedValue({ success: true, code: 'SUCCESS' });
});
describe('participant correction decision boundary', () => {
  it.each([null, 'null', 'http://attacker.invalid', 'http://localhost:3001'])('rejects invalid Origin %s before auth or parsing', async (origin) => {
    expect((await POST(request(payload, origin), params)).status).toBe(403);
    expect(requireAdmin).not.toHaveBeenCalled(); expect(decideParticipantCorrection).not.toHaveBeenCalled();
  });
  it('requires authentication', async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new AdminAuthError('UNAUTHENTICATED', 'Authentication required.'));
    expect((await POST(request(), params)).status).toBe(401);
    expect(decideParticipantCorrection).not.toHaveBeenCalled();
  });
  it.each([['projects.edit'], ['projects.review'], []])('requires combined review authority: %s', async (...permissions) => {
    vi.mocked(requireAdmin).mockResolvedValue({ adminUserId: 'actor', permissions } as never);
    expect((await POST(request(), params)).status).toBe(403); expect(decideParticipantCorrection).not.toHaveBeenCalled();
  });
  it.each(['begin', 'accept', 'return'])('sends only exact identity and the authenticated actor for %s', async (action) => {
    const response = await POST(request({ ...payload, action }), params);
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(decideParticipantCorrection).toHaveBeenCalledWith({}, '2026-synthetic', 'actor-from-session', { ...payload, action });
  });
  it.each(['title', 'metadata', 'files', 'storagePath', 'bucket', 'actor', 'projectId', 'status'])('rejects replacement/override field %s', async (field) => {
    expect((await POST(request({ ...payload, [field]: 'staff override' }), params)).status).toBe(400);
    expect(decideParticipantCorrection).not.toHaveBeenCalled();
  });
  it('rejects the old empty payload and invalid revision hashes', async () => {
    for (const body of [{}, { ...payload, packageHash: 'invalid' }, { ...payload, submissionId: 'other-project' }]) expect((await POST(request(body), params)).status).toBe(400);
    expect(decideParticipantCorrection).not.toHaveBeenCalled();
  });
  it('bounds actual bytes without relying on Content-Length', async () => {
    expect((await POST(request({ ...payload, excess: 'x'.repeat(3000) }), params)).status).toBe(413);
    expect(decideParticipantCorrection).not.toHaveBeenCalled();
  });
  it('maps stale/unavailable decisions to bounded errors', async () => {
    vi.mocked(decideParticipantCorrection).mockResolvedValue({ success: false, code: 'STALE_REVISION' });
    const response = await POST(request(), params); expect(response.status).toBe(409); expect((await response.json()).error).toMatch(/Reload/);
  });
});
