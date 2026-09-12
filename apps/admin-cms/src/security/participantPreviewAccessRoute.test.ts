import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { hashPreviewToken } from '../previews/participantPreviewToken';

const calls = vi.hoisted(() => ({ resolve: vi.fn(), state: vi.fn(), record: vi.fn(), sign: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('../lib/supabase/admin', () => ({ createSupabaseAdminClient: vi.fn() }));
vi.mock('../storage/mediaStorage', () => ({ createSignedDraftMediaUrl: calls.sign }));
vi.mock('../repositories/SupabaseParticipantPreviewRepository', () => ({
  SupabaseParticipantPreviewRepository: class {
    resolveByTokenHash = calls.resolve;
    getResponseState = calls.state;
    recordResponsePrepared = calls.record;
  },
}));
vi.mock('../previews/participantCorrectionService', () => ({
  getParticipantCorrectionContext: vi.fn(), stageParticipantCorrection: vi.fn(),
}));
import { GET, HEAD, POST } from '../app/participant-preview/[token]/route';
const token = 'a'.repeat(64);
const previewId = '12345678-1234-4234-8234-123456789012';
const params = { params: Promise.resolve({ token }) };
const request = () => new NextRequest(`http://localhost:3000/participant-preview/${token}`);
const snapshot = {
  title: 'Synthetic preview evidence', summary: 'Synthetic summary', year: 2026,
  background: null, solution: null, program: null, studyProgram: null, discipline: null,
  disciplines: [], industry: null, industryPartner: null, academicSupervisor: null,
  groupName: null, teamMembers: [], posterText: null, accessibilityText: null,
  citations: [], externalLinks: [], industryCategories: [],
};
beforeEach(() => {
  vi.resetAllMocks();
  calls.resolve.mockResolvedValue({ previewId, snapshot, mediaSnapshot: [], expiresAt: '2026-09-20T00:00:00Z' });
  calls.state.mockResolvedValue({ type: 'unresponded' });
  calls.record.mockResolvedValue(true);
});

describe('server-prepared preview access observations', () => {
  it('records only the exact resolved preview and token hash after a complete GET render', async () => {
    const response = await GET(request(), params);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(snapshot.title);
    expect(calls.record).toHaveBeenCalledExactlyOnceWith(previewId, hashPreviewToken(token));
    expect(calls.record.mock.invocationCallOrder[0]).toBeGreaterThan(calls.state.mock.invocationCallOrder[0]);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Set-Cookie')).toBeNull();
  });
  it('does not record an invalid, unknown or expired/revoked capability', async () => {
    calls.resolve.mockResolvedValue(null);
    expect((await GET(request(), params)).status).toBe(404);
    expect((await GET(request(), { params: Promise.resolve({ token: 'bad' }) })).status).toBe(404);
    expect(calls.record).not.toHaveBeenCalled();
  });
  it('does not record a failed response-state lookup', async () => {
    calls.state.mockRejectedValue(new Error('synthetic private provider error'));
    expect((await GET(request(), params)).status).toBe(500);
    expect(calls.record).not.toHaveBeenCalled();
  });
  it('does not record a page with unavailable required media', async () => {
    calls.resolve.mockResolvedValue({ previewId, snapshot, mediaSnapshot: [{
      mediaAssetId: 'synthetic-media', assetType: 'poster_image', galleryPosition: null,
      fileName: 'poster.png', storageBucket: 'project-drafts-private', storagePath: 'synthetic/poster.png',
      mimeType: 'image/png', altText: null,
    }] });
    calls.sign.mockResolvedValue(null);
    expect((await GET(request(), params)).status).toBe(404);
    expect(calls.record).not.toHaveBeenCalled();
  });
  it('rechecks capability validity before releasing prepared content', async () => {
    calls.record.mockResolvedValue(false);
    const response = await GET(request(), params);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(snapshot.title);
  });
  it('fails with a bounded unavailable response if evidence persistence is unavailable', async () => {
    calls.record.mockRejectedValue(new Error('synthetic private database detail'));
    const response = await GET(request(), params);
    expect(response.status).toBe(503);
    const html = await response.text();
    expect(html).toContain('Preview Unavailable');
    expect(html).not.toContain('database detail');
    expect(html).not.toContain(snapshot.title);
    expect(html).not.toContain(token);
  });
  it('validates HEAD without creating a GET observation or returning content', async () => {
    const response = await HEAD(request(), params);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(calls.record).not.toHaveBeenCalled();
  });
  it('does not turn a denied form submission into an access observation', async () => {
    const response = await POST(new NextRequest(request(), {
      method: 'POST', headers: { origin: 'https://other.example.test' }, body: 'action=confirm',
    }), params);
    expect(response.status).toBe(403);
    expect(calls.record).not.toHaveBeenCalled();
  });
  it('does not infer confirmation or human reading from an observation', async () => {
    const response = await GET(request(), params);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(calls.state).toHaveBeenCalledExactlyOnceWith(previewId);
    expect(calls.record).toHaveBeenCalledTimes(1);
    expect(html).not.toMatch(/confirmed at|read receipt/i);
  });
});
