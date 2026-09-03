import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, POST } from '../app/participant-preview/[token]/route';
import { correctionForm, PNG } from '../previews/participantCorrectionFixtures';
import { getParticipantCorrectionContext, stageParticipantCorrection } from '../previews/participantCorrectionService';
import { hashPreviewToken } from '../previews/participantPreviewToken';
import { createSupabaseAdminClient } from '../lib/supabase/admin';

vi.mock('../lib/supabase/admin', () => ({ createSupabaseAdminClient: vi.fn(() => ({})) }));
vi.mock('../previews/participantCorrectionService', () => ({ getParticipantCorrectionContext: vi.fn(), stageParticipantCorrection: vi.fn() }));
vi.mock('../storage/mediaStorage', () => ({ createSignedDraftMediaUrl: vi.fn() }));
vi.mock('../repositories/SupabaseParticipantPreviewRepository', () => ({ SupabaseParticipantPreviewRepository: class {
  async resolveByTokenHash() { return { previewId: 'preview', mediaSnapshot: [], snapshot: {
    title: 'Current confirmed evidence', summary: 'Synthetic summary', background: null, solution: null, year: 2026, program: null, studyProgram: null, discipline: null, disciplines: [],
    industry: null, industryPartner: null, academicSupervisor: null, groupName: null, teamMembers: [], posterText: 'Full text', accessibilityText: 'Description', citations: [], externalLinks: [], industryCategories: [],
  } }; }
  async getResponseState() { return { type: 'correction_requested', requestedAt: '2026-09-03T00:00:00Z', comment: 'Synthetic correction comment' }; }
} }));
const token = 'a'.repeat(64);
const url = `http://localhost:3000/participant-preview/${token}`;
const params = { params: Promise.resolve({ token }) };
const context = { resultCode: 'SUCCESS' as const, projectId: '33333333-3333-4333-8333-333333333333', publicId: '2026-bound-by-server', previewId: '44444444-4444-4444-8444-444444444444', correctionId: '55555555-5555-4555-8555-555555555555', submitted: false, canSubmit: true };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getParticipantCorrectionContext).mockResolvedValue(context);
  vi.mocked(stageParticipantCorrection).mockResolvedValue('submitted');
  vi.mocked(createSupabaseAdminClient).mockReturnValue({} as never);
});
function request(form: FormData, origin: string | null = 'http://localhost:3000') {
  return new NextRequest(url, { method: 'POST', body: form, headers: origin === null ? {} : { origin } });
}
describe('participant complete-package route', () => {
  it.each([
    ['development', 'http://127.0.0.1:41209', true],
    ['production', 'http://127.0.0.1:41209', false],
    ['development', 'http://untrusted.example', false],
    ['development', 'http://user:password@localhost:41209', false],
  ] as const)('limits HTTP image CSP to configured loopback in %s', async (environment, storageUrl, allowed) => {
    vi.stubEnv('NODE_ENV', environment); vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', storageUrl); vi.resetModules();
    try {
      const fresh = await import('../app/participant-preview/[token]/route');
      const policy = (await fresh.GET(new NextRequest(url), params)).headers.get('content-security-policy')!;
      expect(policy.includes('img-src https: http:')).toBe(allowed);
      expect(policy).toContain("default-src 'none'"); expect(policy).toContain("form-action 'self'");
    } finally { vi.unstubAllEnvs(); vi.resetModules(); }
  });
  it('renders a labelled multipart form with original evidence and no token fields or scripts', async () => {
    const response = await GET(new NextRequest(url), params); const html = await response.text();
    expect(response.status).toBe(200); expect(html).toContain('Current confirmed evidence');
    expect(html).toContain('enctype="multipart/form-data"'); expect(html).not.toContain(token); expect(html).not.toMatch(/<script|name="projectId"|name="token"/);
    expect(response.headers.get('cache-control')).toBe('no-store'); expect(response.headers.get('referrer-policy')).toBe('strict-origin');
  });
  it.each([null, 'null', 'http://attacker.invalid', 'http://localhost:3001'])('rejects Origin %s before reading participant authority', async (origin) => {
    expect((await POST(request(await correctionForm(), origin), params)).status).toBe(403);
    expect(getParticipantCorrectionContext).not.toHaveBeenCalled(); expect(stageParticipantCorrection).not.toHaveBeenCalled();
  });
  it('parses real source files and binds the project and token hash exclusively on the server', async () => {
    const response = await POST(request(await correctionForm()), params);
    expect(response.status).toBe(303); expect(response.headers.get('location')).toBe(url);
    expect(getParticipantCorrectionContext).toHaveBeenCalledWith({}, hashPreviewToken(token));
    expect(stageParticipantCorrection).toHaveBeenCalledWith({}, hashPreviewToken(token), expect.objectContaining({ metadata: expect.objectContaining({ publicId: context.publicId, title: 'Synthetic corrected project' }), hash: expect.stringMatching(/^[a-f0-9]{64}$/) }));
  });
  it('rejects a missing, revoked, confirmed, frozen or expired capability through the same unavailable result', async () => {
    vi.mocked(getParticipantCorrectionContext).mockResolvedValue(null);
    const response = await POST(request(await correctionForm()), params);
    expect(response.status).toBe(404); expect(await response.text()).toContain('Preview Unavailable'); expect(stageParticipantCorrection).not.toHaveBeenCalled();
  });
  it.each(['projectId', 'title', 'bucket', 'storagePath'])('rejects participant override field %s', async (field) => {
    const form = await correctionForm(); form.set(field, 'override');
    const response = await POST(request(form), params);
    expect(response.status).toBe(400); expect(await response.text()).toContain('role="alert"'); expect(stageParticipantCorrection).not.toHaveBeenCalled();
  });
  it('preserves current evidence and provides a focused, field-associated error for invalid PDF bytes', async () => {
    const form = await correctionForm(); form.set('pdf', new File([PNG], 'poster.pdf', { type: 'application/pdf' }));
    const response = await POST(request(form), params); const html = await response.text();
    expect(response.status).toBe(400); expect(html).toContain('Current confirmed evidence'); expect(html).toContain('role="alert" tabindex="-1" autofocus');
    expect(html).toContain('aria-describedby="pdf-hint package-error"'); expect(stageParticipantCorrection).not.toHaveBeenCalled();
  });
  it.each(['limit', 'lookup', 'failed'] as const)('renders bounded %s submission feedback without accepting content', async (result) => {
    vi.mocked(stageParticipantCorrection).mockResolvedValue(result);
    const response = await POST(request(await correctionForm()), params); const html = await response.text();
    expect(response.status).toBe(400); expect(html).toContain('role="alert"'); expect(html).not.toMatch(/service_role|storage_path|token_hash/);
  });
  it('contains configuration/client failures without emitting framework error details', async () => {
    vi.mocked(createSupabaseAdminClient).mockImplementation(() => { throw new Error('sensitive configuration'); });
    const response = await POST(request(await correctionForm()), params);
    expect(response.status).toBe(404); expect(await response.text()).not.toContain('sensitive configuration');
  });
  it('bounds concurrent parser work and releases the guard after an upload failure', async () => {
    let release!: (result: 'failed') => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    vi.mocked(stageParticipantCorrection).mockImplementationOnce(() => { started(); return new Promise((resolve) => { release = resolve; }); });
    const first = POST(request(await correctionForm()), params);
    await ready;
    try { expect((await POST(request(await correctionForm()), params)).status).toBe(429); }
    finally { release('failed'); await first; }
    expect((await POST(request(await correctionForm()), params)).status).toBe(303);
  });
});
