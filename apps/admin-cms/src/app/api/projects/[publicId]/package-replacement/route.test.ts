// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from './route';
import { requireAdmin } from '../../../../../auth/requireAdmin';
import { correctionForm } from '../../../../../previews/participantCorrectionFixtures';
import { stagePrePreviewReplacement } from '../../../../../previews/participantCorrectionService';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('../../../../../auth/requireAdmin', () => ({ requireAdmin: vi.fn() }));
vi.mock('../../../../../lib/supabase/adminCore', () => ({ createSupabaseAdminClientCore: () => ({ rpc }) }));
vi.mock('../../../../../previews/participantCorrectionService', () => ({ stagePrePreviewReplacement: vi.fn() }));
const params = { params: Promise.resolve({ publicId: '2026-existing-project' }) };
const url = 'http://localhost:3000/api/projects/2026-existing-project/package-replacement';
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({ adminUserId: 'staff-from-session', permissions: ['projects.edit', 'projects.review'] } as never);
  rpc.mockResolvedValue({ data: { resultCode: 'SUCCESS', canSubmit: true }, error: null });
  vi.mocked(stagePrePreviewReplacement).mockResolvedValue('submitted');
});
const request = (body: FormData, origin = 'http://localhost:3000') => new NextRequest(url, { method: 'POST', headers: { origin }, body });
describe('authenticated pre-preview complete package transport', () => {
  it('binds the reparsed package to the selected existing project and session actor', async () => {
    const response = await POST(request(await correctionForm()), params);
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(stagePrePreviewReplacement).toHaveBeenCalledWith(expect.anything(), '2026-existing-project', 'staff-from-session', expect.objectContaining({ metadata: expect.objectContaining({ publicId: '2026-existing-project' }), validationChecks: expect.any(Array) }));
  });
  it('rejects cross-origin uploads before authentication or package work', async () => {
    expect((await POST(request(await correctionForm(), 'https://attacker.invalid'), params)).status).toBe(403);
    expect(requireAdmin).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled();
  });
  it('lets the reservation recognize an exact retry after the new-package allowance is exhausted', async () => {
    rpc.mockResolvedValue({ data: { resultCode: 'SUCCESS', canSubmit: false }, error: null });
    expect((await POST(request(await correctionForm()), params)).status).toBe(200);
    expect(stagePrePreviewReplacement).toHaveBeenCalledTimes(1);
  });
  it.each([['projects.edit'], ['projects.review']])('requires combined authority, not %s alone', async (...permissions) => {
    vi.mocked(requireAdmin).mockResolvedValue({ adminUserId: 'session', permissions } as never);
    expect((await POST(request(await correctionForm()), params)).status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });
  it('refuses upload for an ineligible or frozen lifecycle', async () => {
    rpc.mockResolvedValue({ data: { resultCode: 'UNAVAILABLE' }, error: null });
    expect((await POST(request(await correctionForm()), params)).status).toBe(409);
    expect(stagePrePreviewReplacement).not.toHaveBeenCalled();
  });
  it('rejects field, project and storage identity overrides', async () => {
    for (const field of ['title', 'publicId', 'projectId', 'bucket', 'path']) {
      const form = await correctionForm(); form.set(field, 'caller-supplied');
      expect((await POST(request(form), params)).status).toBe(400);
    }
    expect(stagePrePreviewReplacement).not.toHaveBeenCalled();
  });
});
