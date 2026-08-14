import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { escapeHtml, renderParticipantPreviewPage, renderParticipantPreviewUnavailablePage, isSafeExternalPreviewUrl } from '../previews/participantPreviewHtml';
import { hashPreviewToken } from '../previews/participantPreviewToken';
import { ParticipantPreviewSnapshot } from '../domain/participantPreview';

vi.mock('server-only', () => ({}));
vi.mock('../lib/supabase/admin', () => ({
  createSupabaseAdminClient: vi.fn(),
}));
vi.mock('../lib/supabase/adminCore', () => ({
  createSupabaseAdminClientCore: vi.fn(() => ({
    storage: {
      from: () => ({
        createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: 'https://example.test/signed/poster.png' }, error: null }),
      }),
    },
  })),
}));
vi.mock('../lib/env', () => ({
  getServerEnv: vi.fn(() => ({
    SUPABASE_DRAFT_BUCKET: 'project-drafts-private',
    SUPABASE_PUBLIC_ASSETS_BUCKET: 'project-public-assets',
    SUPABASE_PUBLIC_FEEDS_BUCKET: 'public-feeds',
    SUPABASE_PUBLIC_FEED_FILE: 'capstones-latest.json',
  })),
}));

/** Builds a same-origin urlencoded form POST body/headers pair for the participant-preview route. */
function formRequestInit(origin: string, fields: Record<string, string>): { headers: Record<string, string>; body: string } {
  const body = Object.entries(fields)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  return {
    body,
    headers: {
      origin,
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': String(Buffer.byteLength(body, 'utf8')),
    },
  };
}

describe('participantPreviewHtml escaping', () => {
  it('escapeHtml neutralizes HTML-significant characters', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escapeHtml(`"quoted" & 'single'`)).toBe('&quot;quoted&quot; &amp; &#39;single&#39;');
  });

  it('renderParticipantPreviewPage never emits an unescaped stored-XSS payload from snapshot fields', () => {
    const html = renderParticipantPreviewPage({
      snapshot: {
        title: '<img src=x onerror=alert(1)>',
        summary: '<script>evil()</script>',
        background: null,
        solution: null,
        year: 2026,
        program: null,
        studyProgram: null,
        discipline: null,
        disciplines: [],
        industry: null,
        industryPartner: null,
        academicSupervisor: null,
        groupName: null,
        teamMembers: [],
        posterText: null,
        accessibilityText: null,
        citations: [],
        externalLinks: [],
        industryCategories: [],
      },
      media: [],
      responseState: { type: 'unresponded' },
    });

    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script>evil()</script>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  /**
   * Participants confirm the exact public-facing accessible content, so both values must be
   * visible on the preview page before the confirmation controls — never confirmed sight unseen.
   */
  describe('accessible poster content rendering', () => {
    const snapshotWith = (overrides: Partial<ParticipantPreviewSnapshot>): ParticipantPreviewSnapshot => ({
      title: 'Solar Power Optimizer',
      summary: 'AI-powered solar optimizer.',
      background: null,
      solution: null,
      year: 2026,
      program: null,
      studyProgram: null,
      discipline: null,
      disciplines: [],
      industry: null,
      industryPartner: null,
      academicSupervisor: null,
      groupName: null,
      teamMembers: [],
      posterText: 'Aim: reduce distributed solar loss. Result: 12% yield improvement.',
      accessibilityText: 'Poster showing an inverter architecture diagram beside a results table.',
      citations: [],
      externalLinks: [],
      industryCategories: [],
      ...overrides,
    });

    const render = (overrides: Partial<ParticipantPreviewSnapshot> = {}) => renderParticipantPreviewPage({
      snapshot: snapshotWith(overrides),
      media: [],
      responseState: { type: 'unresponded' },
    });

    it('renders both accessible content values before the confirmation controls', () => {
      const html = render();

      expect(html).toContain('Poster Full Text');
      expect(html).toContain('Aim: reduce distributed solar loss. Result: 12% yield improvement.');
      expect(html).toContain('Accessibility Description');
      expect(html).toContain('Poster showing an inverter architecture diagram beside a results table.');

      // Anchor on the response section heading, not the button class, which also appears in the
      // stylesheet in <head>.
      const responseSection = html.indexOf('<h3>Your Response</h3>');
      expect(responseSection).toBeGreaterThan(-1);
      expect(html.indexOf('Poster Full Text')).toBeLessThan(responseSection);
      expect(html.indexOf('Accessibility Description')).toBeLessThan(responseSection);
    });

    it('escapes markup inside either accessible content value', () => {
      const html = render({
        posterText: '<script>evil()</script>',
        accessibilityText: '<img src=x onerror=alert(1)>',
      });

      expect(html).not.toContain('<script>evil()</script>');
      expect(html).not.toContain('<img src=x onerror=alert(1)>');
      expect(html).toContain('&lt;script&gt;evil()&lt;/script&gt;');
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    });

    it('renders newlines as line breaks rather than raw markup', () => {
      const html = render({ posterText: 'Aim\nMeasure wake.', accessibilityText: 'Poster.\nTwo columns.' });

      expect(html).toContain('Aim<br/>Measure wake.');
      expect(html).toContain('Poster.<br/>Two columns.');
    });

    it('never leaks internal or private project state alongside the accessible content', () => {
      const html = render();

      expect(html).not.toMatch(/poster_text_public|accessibility_text_public/);
      expect(html).not.toMatch(/import_batch|internalStaffNotes|validation_flags|admin_id/i);
      expect(html).toContain('noindex, nofollow');
    });
  });

  it('renderParticipantPreviewUnavailablePage renders a generic message with no project detail', () => {
    const html = renderParticipantPreviewUnavailablePage();
    expect(html).toContain('Preview Unavailable');
    expect(html).toContain('noindex, nofollow');
  });
});

describe('Public participant-preview route', () => {
  it('rejects a malformed token without querying the repository at all', async () => {
    const { GET } = await import('../app/participant-preview/[token]/route');
    const { SupabaseParticipantPreviewRepository } = await import('../repositories/SupabaseParticipantPreviewRepository');
    const resolveSpy = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'resolveByTokenHash');

    const req = new NextRequest('http://localhost:3000/participant-preview/not-a-valid-token');
    const res = await GET(req, { params: Promise.resolve({ token: 'not-a-valid-token' }) });
    const text = await res.text();

    expect(res.status).toBe(404);
    expect(text).toContain('Preview Unavailable');
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('X-Robots-Tag')).toContain('noindex');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');

    resolveSpy.mockRestore();
  });

  it('renders the identical generic unavailable response for unknown, expired, and revoked tokens alike', async () => {
    const { GET } = await import('../app/participant-preview/[token]/route');
    const { SupabaseParticipantPreviewRepository } = await import('../repositories/SupabaseParticipantPreviewRepository');
    const resolveSpy = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'resolveByTokenHash').mockResolvedValue(null);

    const token = 'b'.repeat(64);
    const req = new NextRequest(`http://localhost:3000/participant-preview/${token}`);
    const res = await GET(req, { params: Promise.resolve({ token }) });
    const text = await res.text();

    expect(res.status).toBe(404);
    expect(text).toContain('Preview Unavailable');
    expect(resolveSpy).toHaveBeenCalledWith(hashPreviewToken(token));

    resolveSpy.mockRestore();
  });

  it('renders the snapshot when every expected media asset signs successfully from the private draft bucket', async () => {
    const { GET } = await import('../app/participant-preview/[token]/route');
    const { SupabaseParticipantPreviewRepository } = await import('../repositories/SupabaseParticipantPreviewRepository');
    const mediaStorage = await import('../storage/mediaStorage');

    const resolveSpy = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'resolveByTokenHash').mockResolvedValue({
      previewId: 'p1',
      snapshot: {
        title: 'Accessible Robotics Kit',
        summary: 'A synthetic summary.',
        background: null,
        solution: null,
        year: 2026,
        program: 'Bachelor of IT',
        studyProgram: null,
        discipline: 'Software Engineering',
        disciplines: ['Software Engineering'],
        industry: null,
        industryPartner: null,
        academicSupervisor: null,
        groupName: null,
        teamMembers: ['Synthetic Member A'],
        posterText: null,
        accessibilityText: null,
        citations: [],
        externalLinks: [],
        industryCategories: [],
      },
      mediaSnapshot: [
        { mediaAssetId: 'm1', assetType: 'poster_image', fileName: 'poster.png', storageBucket: 'project-drafts-private', storagePath: 'drafts/2026-x/poster_image/poster.png', mimeType: 'image/png' },
      ],
      expiresAt: '2026-08-17T00:00:00.000Z',
    });

    const signSpy = vi.spyOn(mediaStorage, 'createSignedDraftMediaUrl');
    const responseStateSpy = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'getResponseState').mockResolvedValue({ type: 'unresponded' });

    const token = 'c'.repeat(64);
    const req = new NextRequest(`http://localhost:3000/participant-preview/${token}`);
    const res = await GET(req, { params: Promise.resolve({ token }) });
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('Accessible Robotics Kit');
    expect(signSpy).toHaveBeenCalledTimes(1);
    expect(responseStateSpy).toHaveBeenCalledWith('p1');

    resolveSpy.mockRestore();
    signSpy.mockRestore();
    responseStateSpy.mockRestore();
  });

  it('fails closed to the generic unavailable page when any expected media asset cannot receive a valid private signed URL', async () => {
    const { GET } = await import('../app/participant-preview/[token]/route');
    const { SupabaseParticipantPreviewRepository } = await import('../repositories/SupabaseParticipantPreviewRepository');

    const resolveSpy = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'resolveByTokenHash').mockResolvedValue({
      previewId: 'p1',
      snapshot: {
        title: 'Accessible Robotics Kit',
        summary: 'A synthetic summary.',
        background: null,
        solution: null,
        year: 2026,
        program: 'Bachelor of IT',
        studyProgram: null,
        discipline: 'Software Engineering',
        disciplines: ['Software Engineering'],
        industry: null,
        industryPartner: null,
        academicSupervisor: null,
        groupName: null,
        teamMembers: ['Synthetic Member A'],
        posterText: null,
        accessibilityText: null,
        citations: [],
        externalLinks: [],
        industryCategories: [],
      },
      mediaSnapshot: [
        { mediaAssetId: 'm1', assetType: 'poster_image', fileName: 'poster.png', storageBucket: 'project-drafts-private', storagePath: 'drafts/2026-x/poster_image/poster.png', mimeType: 'image/png' },
        // Anomalous reference pointing at the public bucket — createSignedDraftMediaUrl's own
        // bucket check refuses to sign it, and the route must fail closed rather than silently
        // omit it and still return 200.
        { mediaAssetId: 'm2', assetType: 'poster_image', fileName: 'other-project-poster.png', storageBucket: 'project-public-assets', storagePath: 'approved/other-project/poster_image/poster.png', mimeType: 'image/png' },
      ],
      expiresAt: '2026-08-17T00:00:00.000Z',
    });

    const token = 'c'.repeat(64);
    const req = new NextRequest(`http://localhost:3000/participant-preview/${token}`);
    const res = await GET(req, { params: Promise.resolve({ token }) });
    const html = await res.text();

    expect(res.status).toBe(404);
    expect(html).toContain('Preview Unavailable');
    expect(html).not.toContain('Accessible Robotics Kit');

    resolveSpy.mockRestore();
  });

  it('fails closed to the generic unavailable page when the private-bucket signing call itself errors', async () => {
    const { GET } = await import('../app/participant-preview/[token]/route');
    const { SupabaseParticipantPreviewRepository } = await import('../repositories/SupabaseParticipantPreviewRepository');
    const mediaStorage = await import('../storage/mediaStorage');

    const resolveSpy = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'resolveByTokenHash').mockResolvedValue({
      previewId: 'p1',
      snapshot: {
        title: 'Accessible Robotics Kit',
        summary: null,
        background: null,
        solution: null,
        year: 2026,
        program: null,
        studyProgram: null,
        discipline: null,
        disciplines: [],
        industry: null,
        industryPartner: null,
        academicSupervisor: null,
        groupName: null,
        teamMembers: [],
        posterText: null,
        accessibilityText: null,
        citations: [],
        externalLinks: [],
        industryCategories: [],
      },
      mediaSnapshot: [
        { mediaAssetId: 'm1', assetType: 'poster_image', fileName: 'poster.png', storageBucket: 'project-drafts-private', storagePath: 'drafts/2026-x/poster_image/poster.png', mimeType: 'image/png' },
      ],
      expiresAt: '2026-08-17T00:00:00.000Z',
    });
    const signSpy = vi.spyOn(mediaStorage, 'createSignedDraftMediaUrl').mockResolvedValue(null);

    const token = 'c'.repeat(64);
    const req = new NextRequest(`http://localhost:3000/participant-preview/${token}`);
    const res = await GET(req, { params: Promise.resolve({ token }) });
    const html = await res.text();

    expect(res.status).toBe(404);
    expect(html).toContain('Preview Unavailable');

    resolveSpy.mockRestore();
    signSpy.mockRestore();
  });

  it('renders successfully with no media when the snapshot legitimately had none at issuance', async () => {
    const { GET } = await import('../app/participant-preview/[token]/route');
    const { SupabaseParticipantPreviewRepository } = await import('../repositories/SupabaseParticipantPreviewRepository');

    const resolveSpy = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'resolveByTokenHash').mockResolvedValue({
      previewId: 'p1',
      snapshot: {
        title: 'No Media Project',
        summary: null,
        background: null,
        solution: null,
        year: 2026,
        program: null,
        studyProgram: null,
        discipline: null,
        disciplines: [],
        industry: null,
        industryPartner: null,
        academicSupervisor: null,
        groupName: null,
        teamMembers: [],
        posterText: null,
        accessibilityText: null,
        citations: [],
        externalLinks: [],
        industryCategories: [],
      },
      mediaSnapshot: [],
      expiresAt: '2026-08-17T00:00:00.000Z',
    });
    const responseStateSpy = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'getResponseState').mockResolvedValue({ type: 'unresponded' });

    const token = 'd'.repeat(64);
    const req = new NextRequest(`http://localhost:3000/participant-preview/${token}`);
    const res = await GET(req, { params: Promise.resolve({ token }) });
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('No Media Project');

    resolveSpy.mockRestore();
    responseStateSpy.mockRestore();
  });

  it('renders the unresponded state with both a confirmation form and a correction-request form when no response exists yet', async () => {
    const { GET } = await import('../app/participant-preview/[token]/route');
    const { SupabaseParticipantPreviewRepository } = await import('../repositories/SupabaseParticipantPreviewRepository');

    const resolveSpy = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'resolveByTokenHash').mockResolvedValue({
      previewId: 'p-unconfirmed',
      snapshot: {
        title: 'Unconfirmed Project', summary: null, background: null, solution: null, year: 2026,
        program: null, studyProgram: null, discipline: null, disciplines: [], industry: null,
        industryPartner: null, academicSupervisor: null, groupName: null, teamMembers: [],
        posterText: null, accessibilityText: null, citations: [], externalLinks: [], industryCategories: [],
      },
      mediaSnapshot: [],
      expiresAt: '2026-08-17T00:00:00.000Z',
    });
    const responseStateSpy = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'getResponseState').mockResolvedValue({ type: 'unresponded' });

    const token = 'e'.repeat(64);
    const req = new NextRequest(`http://localhost:3000/participant-preview/${token}`);
    const res = await GET(req, { params: Promise.resolve({ token }) });
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('Confirm project details');
    expect(html).toContain('value="confirm"');
    expect(html).toContain('value="request_correction"');
    expect(html).toContain('name="comment"');
    expect(html).toContain('<form method="POST">');
    expect(html).not.toContain('You confirmed that');
    expect(html).not.toContain('Correction request submitted');

    resolveSpy.mockRestore();
    responseStateSpy.mockRestore();
  });

  it('renders the confirmed state with the recorded timestamp and no confirmation/correction form once already confirmed', async () => {
    const { GET } = await import('../app/participant-preview/[token]/route');
    const { SupabaseParticipantPreviewRepository } = await import('../repositories/SupabaseParticipantPreviewRepository');

    const resolveSpy = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'resolveByTokenHash').mockResolvedValue({
      previewId: 'p-confirmed',
      snapshot: {
        title: 'Confirmed Project', summary: null, background: null, solution: null, year: 2026,
        program: null, studyProgram: null, discipline: null, disciplines: [], industry: null,
        industryPartner: null, academicSupervisor: null, groupName: null, teamMembers: [],
        posterText: null, accessibilityText: null, citations: [], externalLinks: [], industryCategories: [],
      },
      mediaSnapshot: [],
      expiresAt: '2026-08-17T00:00:00.000Z',
    });
    const responseStateSpy = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'getResponseState').mockResolvedValue({
      type: 'confirmed',
      confirmedAt: '2026-08-11T12:00:00.000Z',
    });

    const token = 'f'.repeat(64);
    const req = new NextRequest(`http://localhost:3000/participant-preview/${token}`);
    const res = await GET(req, { params: Promise.resolve({ token }) });
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('You confirmed that');
    expect(html).not.toContain('<form method="POST">');
    expect(html).not.toContain('Confirm project details');
    expect(html).not.toContain('Correction request submitted');

    resolveSpy.mockRestore();
    responseStateSpy.mockRestore();
  });

  it('renders the correction-requested state with the recorded timestamp and escaped comment, and no confirmation/correction form', async () => {
    const { GET } = await import('../app/participant-preview/[token]/route');
    const { SupabaseParticipantPreviewRepository } = await import('../repositories/SupabaseParticipantPreviewRepository');

    const resolveSpy = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'resolveByTokenHash').mockResolvedValue({
      previewId: 'p-correction-requested',
      snapshot: {
        title: 'Correction Requested Project', summary: null, background: null, solution: null, year: 2026,
        program: null, studyProgram: null, discipline: null, disciplines: [], industry: null,
        industryPartner: null, academicSupervisor: null, groupName: null, teamMembers: [],
        posterText: null, accessibilityText: null, citations: [], externalLinks: [], industryCategories: [],
      },
      mediaSnapshot: [],
      expiresAt: '2026-08-17T00:00:00.000Z',
    });
    const responseStateSpy = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'getResponseState').mockResolvedValue({
      type: 'correction_requested',
      requestedAt: '2026-08-11T12:00:00.000Z',
      comment: '<script>alert(1)</script> please fix the title',
    });

    const token = '3'.repeat(64);
    const req = new NextRequest(`http://localhost:3000/participant-preview/${token}`);
    const res = await GET(req, { params: Promise.resolve({ token }) });
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('Correction request submitted');
    expect(html).not.toContain('<form method="POST">');
    expect(html).not.toContain('Confirm project details');
    expect(html).not.toContain('You confirmed that');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');

    resolveSpy.mockRestore();
    responseStateSpy.mockRestore();
  });

  it('renders the generic unavailable response — never a falsely-unresponded form — when the response-state lookup fails', async () => {
    const { GET } = await import('../app/participant-preview/[token]/route');
    const { SupabaseParticipantPreviewRepository } = await import('../repositories/SupabaseParticipantPreviewRepository');
    const { ParticipantPreviewExecutionError } = await import('../repositories/ParticipantPreviewRepository');

    const resolveSpy = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'resolveByTokenHash').mockResolvedValue({
      previewId: 'p-status-failure',
      snapshot: {
        title: 'Status Lookup Failure Project', summary: null, background: null, solution: null, year: 2026,
        program: null, studyProgram: null, discipline: null, disciplines: [], industry: null,
        industryPartner: null, academicSupervisor: null, groupName: null, teamMembers: [],
        posterText: null, accessibilityText: null, citations: [], externalLinks: [], industryCategories: [],
      },
      mediaSnapshot: [],
      expiresAt: '2026-08-17T00:00:00.000Z',
    });
    const responseStateSpy = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'getResponseState').mockRejectedValue(
      new ParticipantPreviewExecutionError('INTERNAL_FAILURE')
    );

    const token = '1'.repeat(64);
    const req = new NextRequest(`http://localhost:3000/participant-preview/${token}`);
    const res = await GET(req, { params: Promise.resolve({ token }) });
    const html = await res.text();

    expect(res.status).toBe(500);
    expect(html).toContain('Preview Unavailable');
    expect(html).not.toContain('Confirm project details');
    expect(html).not.toContain('Status Lookup Failure Project');

    resolveSpy.mockRestore();
    responseStateSpy.mockRestore();
  });

  it('renders the generic unavailable response when getResponseState rejects due to a contradictory confirmed-and-correction-requested state (fail closed)', async () => {
    const { GET } = await import('../app/participant-preview/[token]/route');
    const { SupabaseParticipantPreviewRepository } = await import('../repositories/SupabaseParticipantPreviewRepository');

    const resolveSpy = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'resolveByTokenHash').mockResolvedValue({
      previewId: 'p-contradictory',
      snapshot: {
        title: 'Contradictory State Project', summary: null, background: null, solution: null, year: 2026,
        program: null, studyProgram: null, discipline: null, disciplines: [], industry: null,
        industryPartner: null, academicSupervisor: null, groupName: null, teamMembers: [],
        posterText: null, accessibilityText: null, citations: [], externalLinks: [], industryCategories: [],
      },
      mediaSnapshot: [],
      expiresAt: '2026-08-17T00:00:00.000Z',
    });
    const confirmationSpy = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'getConfirmationStatus').mockResolvedValue({
      confirmedAt: '2026-08-11T12:00:00.000Z',
    });
    const correctionSpy = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'getCorrectionRequestStatus').mockResolvedValue({
      requestedAt: '2026-08-11T12:05:00.000Z',
      comment: 'Contradictory correction request.',
    });

    const token = '2'.repeat(64);
    const req = new NextRequest(`http://localhost:3000/participant-preview/${token}`);
    const res = await GET(req, { params: Promise.resolve({ token }) });
    const html = await res.text();

    expect(res.status).toBe(500);
    expect(html).toContain('Preview Unavailable');
    expect(html).not.toContain('Contradictory State Project');

    resolveSpy.mockRestore();
    confirmationSpy.mockRestore();
    correctionSpy.mockRestore();
  });
});

describe('Public participant-preview confirmation POST', () => {
  it('rejects a cross-origin confirmation POST without ever calling confirmPreview', async () => {
    const { POST } = await import('../app/participant-preview/[token]/route');
    const { SupabaseParticipantPreviewRepository } = await import('../repositories/SupabaseParticipantPreviewRepository');
    const confirmSpy = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'confirmPreview');

    const token = 'a'.repeat(64);
    const req = new NextRequest(`http://localhost:3000/participant-preview/${token}`, {
      method: 'POST',
      ...formRequestInit('http://malicious.test', { action: 'confirm' }),
    });
    const res = await POST(req, { params: Promise.resolve({ token }) });
    const html = await res.text();

    expect(res.status).toBe(403);
    expect(html).toContain('Preview Unavailable');
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(res.headers.get('Cache-Control')).toBe('no-store');

    confirmSpy.mockRestore();
  });

  it('rejects a same-origin confirmation POST for a malformed token without calling confirmPreview', async () => {
    const { POST } = await import('../app/participant-preview/[token]/route');
    const { SupabaseParticipantPreviewRepository } = await import('../repositories/SupabaseParticipantPreviewRepository');
    const confirmSpy = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'confirmPreview');

    const req = new NextRequest('http://localhost:3000/participant-preview/not-a-valid-token', {
      method: 'POST',
      ...formRequestInit('http://localhost:3000', { action: 'confirm' }),
    });
    const res = await POST(req, { params: Promise.resolve({ token: 'not-a-valid-token' }) });

    expect(res.status).toBe(404);
    expect(confirmSpy).not.toHaveBeenCalled();

    confirmSpy.mockRestore();
  });

  it('accepts a same-origin confirmation POST without a Content-Length header (absence is not itself an error)', async () => {
    const { POST } = await import('../app/participant-preview/[token]/route');
    const { SupabaseParticipantPreviewRepository } = await import('../repositories/SupabaseParticipantPreviewRepository');
    const confirmSpy = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'confirmPreview').mockResolvedValue({
      confirmationId: 'c1',
      confirmedAt: '2026-08-11T00:00:00.000Z',
      alreadyConfirmed: false,
    });

    const token = 'b'.repeat(64);
    const body = 'action=confirm';
    const req = new NextRequest(`http://localhost:3000/participant-preview/${token}`, {
      method: 'POST',
      headers: { origin: 'http://localhost:3000', 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const res = await POST(req, { params: Promise.resolve({ token }) });

    expect(res.status).toBe(303);
    expect(confirmSpy).toHaveBeenCalledWith(hashPreviewToken(token));

    confirmSpy.mockRestore();
  });

  it('rejects a POST whose declared Content-Length exceeds the body-size limit before calling confirmPreview', async () => {
    const { POST } = await import('../app/participant-preview/[token]/route');
    const { SupabaseParticipantPreviewRepository } = await import('../repositories/SupabaseParticipantPreviewRepository');
    const confirmSpy = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'confirmPreview');

    const token = 'b'.repeat(64);
    const body = 'action=confirm';
    const req = new NextRequest(`http://localhost:3000/participant-preview/${token}`, {
      method: 'POST',
      headers: {
        origin: 'http://localhost:3000',
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': '9999999',
      },
      body,
    });
    const res = await POST(req, { params: Promise.resolve({ token }) });

    expect(res.status).toBe(400);
    expect(confirmSpy).not.toHaveBeenCalled();

    confirmSpy.mockRestore();
  });

  it('rejects a POST with a malformed Content-Length header', async () => {
    const { POST } = await import('../app/participant-preview/[token]/route');
    const { SupabaseParticipantPreviewRepository } = await import('../repositories/SupabaseParticipantPreviewRepository');
    const confirmSpy = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'confirmPreview');

    const token = 'b'.repeat(64);
    const body = 'action=confirm';
    const req = new NextRequest(`http://localhost:3000/participant-preview/${token}`, {
      method: 'POST',
      headers: {
        origin: 'http://localhost:3000',
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': 'not-a-number',
      },
      body,
    });
    const res = await POST(req, { params: Promise.resolve({ token }) });

    expect(res.status).toBe(400);
    expect(confirmSpy).not.toHaveBeenCalled();

    confirmSpy.mockRestore();
  });

  it('rejects a POST with no Content-Length whose actual body exceeds the size limit, without calling confirmPreview', async () => {
    const { POST } = await import('../app/participant-preview/[token]/route');
    const { SupabaseParticipantPreviewRepository } = await import('../repositories/SupabaseParticipantPreviewRepository');
    const confirmSpy = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'confirmPreview');

    const token = 'b'.repeat(64);
    const body = `action=confirm&padding=${'a'.repeat(40_000)}`;
    const req = new NextRequest(`http://localhost:3000/participant-preview/${token}`, {
      method: 'POST',
      headers: { origin: 'http://localhost:3000', 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const res = await POST(req, { params: Promise.resolve({ token }) });

    expect(res.status).toBe(400);
    expect(confirmSpy).not.toHaveBeenCalled();

    confirmSpy.mockRestore();
  });

  it('rejects a POST whose actual body exceeds the size limit even when a small Content-Length is declared, without calling confirmPreview', async () => {
    const { POST } = await import('../app/participant-preview/[token]/route');
    const { SupabaseParticipantPreviewRepository } = await import('../repositories/SupabaseParticipantPreviewRepository');
    const confirmSpy = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'confirmPreview');

    const token = 'b'.repeat(64);
    const body = `action=confirm&padding=${'a'.repeat(40_000)}`;
    const req = new NextRequest(`http://localhost:3000/participant-preview/${token}`, {
      method: 'POST',
      headers: {
        origin: 'http://localhost:3000',
        'content-type': 'application/x-www-form-urlencoded',
        // Deliberately understated relative to the actual body — the actual-bytes guard must not
        // trust this declared value.
        'content-length': '15',
      },
      body,
    });
    const res = await POST(req, { params: Promise.resolve({ token }) });

    expect(res.status).toBe(400);
    expect(confirmSpy).not.toHaveBeenCalled();

    confirmSpy.mockRestore();
  });

  it('rejects a POST with a non-form Content-Type', async () => {
    const { POST } = await import('../app/participant-preview/[token]/route');
    const { SupabaseParticipantPreviewRepository } = await import('../repositories/SupabaseParticipantPreviewRepository');
    const confirmSpy = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'confirmPreview');

    const token = 'b'.repeat(64);
    const body = JSON.stringify({ action: 'confirm' });
    const req = new NextRequest(`http://localhost:3000/participant-preview/${token}`, {
      method: 'POST',
      headers: { origin: 'http://localhost:3000', 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
      body,
    });
    const res = await POST(req, { params: Promise.resolve({ token }) });

    expect(res.status).toBe(400);
    expect(confirmSpy).not.toHaveBeenCalled();

    confirmSpy.mockRestore();
  });

  it('rejects a POST with a missing/unrecognized action field without calling confirmPreview or requestCorrection', async () => {
    const { POST } = await import('../app/participant-preview/[token]/route');
    const { SupabaseParticipantPreviewRepository } = await import('../repositories/SupabaseParticipantPreviewRepository');
    const confirmSpy = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'confirmPreview');
    const correctionSpy = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'requestCorrection');

    const token = 'b'.repeat(64);
    const req = new NextRequest(`http://localhost:3000/participant-preview/${token}`, {
      method: 'POST',
      ...formRequestInit('http://localhost:3000', { action: 'not_a_real_action' }),
    });
    const res = await POST(req, { params: Promise.resolve({ token }) });

    expect(res.status).toBe(400);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(correctionSpy).not.toHaveBeenCalled();

    confirmSpy.mockRestore();
    correctionSpy.mockRestore();
  });

  it('confirms via the token hash and redirects (303) back to the same token URL, carrying no mutable data', async () => {
    const { POST } = await import('../app/participant-preview/[token]/route');
    const { SupabaseParticipantPreviewRepository } = await import('../repositories/SupabaseParticipantPreviewRepository');
    const confirmSpy = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'confirmPreview').mockResolvedValue({
      confirmationId: 'c1',
      confirmedAt: '2026-08-11T00:00:00.000Z',
      alreadyConfirmed: false,
    });

    const token = 'b'.repeat(64);
    const req = new NextRequest(`http://localhost:3000/participant-preview/${token}`, {
      method: 'POST',
      ...formRequestInit('http://localhost:3000', { action: 'confirm' }),
    });
    const res = await POST(req, { params: Promise.resolve({ token }) });

    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(`http://localhost:3000/participant-preview/${token}`);
    expect(confirmSpy).toHaveBeenCalledWith(hashPreviewToken(token));
    expect(res.headers.get('Cache-Control')).toBe('no-store');

    confirmSpy.mockRestore();
  });

  it('renders the identical generic unavailable response (never a redirect) for a plausible but unknown/expired/revoked token', async () => {
    const { POST } = await import('../app/participant-preview/[token]/route');
    const { SupabaseParticipantPreviewRepository } = await import('../repositories/SupabaseParticipantPreviewRepository');
    const confirmSpy = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'confirmPreview').mockResolvedValue(null);

    const token = 'b'.repeat(64);
    const req = new NextRequest(`http://localhost:3000/participant-preview/${token}`, {
      method: 'POST',
      ...formRequestInit('http://localhost:3000', { action: 'confirm' }),
    });
    const res = await POST(req, { params: Promise.resolve({ token }) });
    const html = await res.text();

    // Identical status/shape to the malformed-token case, never a 303 redirect: the participant
    // must not be able to tell "unknown/expired/revoked" apart from "malformed" or from a
    // successful confirmation.
    expect(res.status).toBe(404);
    expect(res.headers.get('Location')).toBeNull();
    expect(html).toContain('Preview Unavailable');
    expect(confirmSpy).toHaveBeenCalledWith(hashPreviewToken(token));

    confirmSpy.mockRestore();
  });

  it('malformed and plausible-but-invalid confirmation tokens produce the identical response shape and status', async () => {
    const { POST } = await import('../app/participant-preview/[token]/route');
    const { SupabaseParticipantPreviewRepository } = await import('../repositories/SupabaseParticipantPreviewRepository');
    const confirmSpy = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'confirmPreview').mockResolvedValue(null);

    const malformedReq = new NextRequest('http://localhost:3000/participant-preview/not-a-valid-token', {
      method: 'POST',
      ...formRequestInit('http://localhost:3000', { action: 'confirm' }),
    });
    const malformedRes = await POST(malformedReq, { params: Promise.resolve({ token: 'not-a-valid-token' }) });
    const malformedHtml = await malformedRes.text();

    const token = 'b'.repeat(64);
    const invalidReq = new NextRequest(`http://localhost:3000/participant-preview/${token}`, {
      method: 'POST',
      ...formRequestInit('http://localhost:3000', { action: 'confirm' }),
    });
    const invalidRes = await POST(invalidReq, { params: Promise.resolve({ token }) });
    const invalidHtml = await invalidRes.text();

    expect(malformedRes.status).toBe(invalidRes.status);
    expect(malformedHtml).toBe(invalidHtml);

    confirmSpy.mockRestore();
  });

  it('an idempotent already-confirmed SUCCESS result still redirects (303), not just a first-time confirmation', async () => {
    const { POST } = await import('../app/participant-preview/[token]/route');
    const { SupabaseParticipantPreviewRepository } = await import('../repositories/SupabaseParticipantPreviewRepository');
    const confirmSpy = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'confirmPreview').mockResolvedValue({
      confirmationId: 'c1',
      confirmedAt: '2026-08-11T00:00:00.000Z',
      alreadyConfirmed: true,
    });

    const token = 'b'.repeat(64);
    const req = new NextRequest(`http://localhost:3000/participant-preview/${token}`, {
      method: 'POST',
      ...formRequestInit('http://localhost:3000', { action: 'confirm' }),
    });
    const res = await POST(req, { params: Promise.resolve({ token }) });

    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(`http://localhost:3000/participant-preview/${token}`);

    confirmSpy.mockRestore();
  });

  it('renders the generic unavailable response (never a raw backend error) when confirmPreview throws', async () => {
    const { POST } = await import('../app/participant-preview/[token]/route');
    const { SupabaseParticipantPreviewRepository } = await import('../repositories/SupabaseParticipantPreviewRepository');
    const confirmSpy = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'confirmPreview').mockRejectedValue(new Error('SECRET_SQL_DETAIL'));

    const token = 'b'.repeat(64);
    const req = new NextRequest(`http://localhost:3000/participant-preview/${token}`, {
      method: 'POST',
      ...formRequestInit('http://localhost:3000', { action: 'confirm' }),
    });
    const res = await POST(req, { params: Promise.resolve({ token }) });
    const html = await res.text();

    expect(res.status).toBe(500);
    expect(html).toContain('Preview Unavailable');
    expect(html).not.toContain('SECRET_SQL_DETAIL');

    confirmSpy.mockRestore();
  });
});

describe('Public participant-preview correction-request POST', () => {
  it('rejects a cross-origin correction-request POST without ever calling requestCorrection', async () => {
    const { POST } = await import('../app/participant-preview/[token]/route');
    const { SupabaseParticipantPreviewRepository } = await import('../repositories/SupabaseParticipantPreviewRepository');
    const correctionSpy = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'requestCorrection');

    const token = 'a'.repeat(64);
    const req = new NextRequest(`http://localhost:3000/participant-preview/${token}`, {
      method: 'POST',
      ...formRequestInit('http://malicious.test', { action: 'request_correction', comment: 'Please fix the title.' }),
    });
    const res = await POST(req, { params: Promise.resolve({ token }) });

    expect(res.status).toBe(403);
    expect(correctionSpy).not.toHaveBeenCalled();

    correctionSpy.mockRestore();
  });

  it('submits a correction request via the token hash and the trimmed comment, then redirects (303)', async () => {
    const { POST } = await import('../app/participant-preview/[token]/route');
    const { SupabaseParticipantPreviewRepository } = await import('../repositories/SupabaseParticipantPreviewRepository');
    const correctionSpy = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'requestCorrection').mockResolvedValue({
      correctionRequestId: 'cr1',
      requestedAt: '2026-08-11T00:00:00.000Z',
      comment: 'Please fix the title.',
      alreadyRequested: false,
    });

    const token = 'b'.repeat(64);
    const req = new NextRequest(`http://localhost:3000/participant-preview/${token}`, {
      method: 'POST',
      ...formRequestInit('http://localhost:3000', { action: 'request_correction', comment: '  Please fix the title.  ' }),
    });
    const res = await POST(req, { params: Promise.resolve({ token }) });

    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(`http://localhost:3000/participant-preview/${token}`);
    expect(correctionSpy).toHaveBeenCalledWith(hashPreviewToken(token), 'Please fix the title.');
    expect(res.headers.get('Cache-Control')).toBe('no-store');

    correctionSpy.mockRestore();
  });

  it('redirects without calling requestCorrection when the comment is empty, whitespace-only, or over the length bound', async () => {
    const { POST } = await import('../app/participant-preview/[token]/route');
    const { SupabaseParticipantPreviewRepository } = await import('../repositories/SupabaseParticipantPreviewRepository');
    const correctionSpy = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'requestCorrection');

    const token = 'b'.repeat(64);
    const invalidComments = ['', '   \n\t  ', 'a'.repeat(2001)];

    for (const comment of invalidComments) {
      const req = new NextRequest(`http://localhost:3000/participant-preview/${token}`, {
        method: 'POST',
        ...formRequestInit('http://localhost:3000', { action: 'request_correction', comment }),
      });
      const res = await POST(req, { params: Promise.resolve({ token }) });

      expect(res.status).toBe(303);
      expect(res.headers.get('Location')).toBe(`http://localhost:3000/participant-preview/${token}`);
    }

    expect(correctionSpy).not.toHaveBeenCalled();
    correctionSpy.mockRestore();
  });

  it('renders the generic unavailable response for a plausible but unknown/expired/revoked/already-confirmed token', async () => {
    const { POST } = await import('../app/participant-preview/[token]/route');
    const { SupabaseParticipantPreviewRepository } = await import('../repositories/SupabaseParticipantPreviewRepository');
    const correctionSpy = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'requestCorrection').mockResolvedValue(null);

    const token = 'b'.repeat(64);
    const req = new NextRequest(`http://localhost:3000/participant-preview/${token}`, {
      method: 'POST',
      ...formRequestInit('http://localhost:3000', { action: 'request_correction', comment: 'Please fix the title.' }),
    });
    const res = await POST(req, { params: Promise.resolve({ token }) });
    const html = await res.text();

    expect(res.status).toBe(404);
    expect(res.headers.get('Location')).toBeNull();
    expect(html).toContain('Preview Unavailable');
    expect(correctionSpy).toHaveBeenCalledWith(hashPreviewToken(token), 'Please fix the title.');

    correctionSpy.mockRestore();
  });

  it('renders the generic unavailable response (never a raw backend error) when requestCorrection throws', async () => {
    const { POST } = await import('../app/participant-preview/[token]/route');
    const { SupabaseParticipantPreviewRepository } = await import('../repositories/SupabaseParticipantPreviewRepository');
    const correctionSpy = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'requestCorrection').mockRejectedValue(new Error('SECRET_SQL_DETAIL'));

    const token = 'b'.repeat(64);
    const req = new NextRequest(`http://localhost:3000/participant-preview/${token}`, {
      method: 'POST',
      ...formRequestInit('http://localhost:3000', { action: 'request_correction', comment: 'Please fix the title.' }),
    });
    const res = await POST(req, { params: Promise.resolve({ token }) });
    const html = await res.text();

    expect(res.status).toBe(500);
    expect(html).toContain('Preview Unavailable');
    expect(html).not.toContain('SECRET_SQL_DETAIL');

    correctionSpy.mockRestore();
  });

  it('an idempotent already-requested SUCCESS result still redirects (303), not just a first-time submission', async () => {
    const { POST } = await import('../app/participant-preview/[token]/route');
    const { SupabaseParticipantPreviewRepository } = await import('../repositories/SupabaseParticipantPreviewRepository');
    const correctionSpy = vi.spyOn(SupabaseParticipantPreviewRepository.prototype, 'requestCorrection').mockResolvedValue({
      correctionRequestId: 'cr1',
      requestedAt: '2026-08-11T00:00:00.000Z',
      comment: 'Please fix the title.',
      alreadyRequested: true,
    });

    const token = 'b'.repeat(64);
    const req = new NextRequest(`http://localhost:3000/participant-preview/${token}`, {
      method: 'POST',
      ...formRequestInit('http://localhost:3000', { action: 'request_correction', comment: 'A different resubmitted comment.' }),
    });
    const res = await POST(req, { params: Promise.resolve({ token }) });

    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(`http://localhost:3000/participant-preview/${token}`);

    correctionSpy.mockRestore();
  });
});

describe('participantPreviewHtml external link URL scheme safety', () => {
  it('isSafeExternalPreviewUrl accepts only absolute http(s) URLs', () => {
    expect(isSafeExternalPreviewUrl('https://example.test/page')).toBe(true);
    expect(isSafeExternalPreviewUrl('http://example.test/page')).toBe(true);
    expect(isSafeExternalPreviewUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeExternalPreviewUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isSafeExternalPreviewUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeExternalPreviewUrl('not-a-url')).toBe(false);
    expect(isSafeExternalPreviewUrl('/relative/path')).toBe(false);
    expect(isSafeExternalPreviewUrl('')).toBe(false);
  });

  it('renderParticipantPreviewPage never emits a javascript: or data: href, even when escaped', () => {
    const html = renderParticipantPreviewPage({
      snapshot: {
        title: 'Link Safety Test',
        summary: null,
        background: null,
        solution: null,
        year: 2026,
        program: null,
        studyProgram: null,
        discipline: null,
        disciplines: [],
        industry: null,
        industryPartner: null,
        academicSupervisor: null,
        groupName: null,
        teamMembers: [],
        posterText: null,
        accessibilityText: null,
        citations: [],
        externalLinks: [
          { label: 'Safe HTTPS', url: 'https://example.test/safe' },
          { label: 'Safe HTTP', url: 'http://example.test/safe' },
          { label: 'Malicious JS', url: 'javascript:alert(1)' },
          { label: 'Malicious Data', url: 'data:text/html,<script>alert(1)</script>' },
          { label: 'Malformed', url: 'not-a-real-url' },
        ],
        industryCategories: [],
      },
      media: [],
      responseState: { type: 'unresponded' },
    });

    expect(html).toContain('href="https://example.test/safe"');
    expect(html).toContain('href="http://example.test/safe"');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('href="data:');
    expect(html).not.toContain('javascript:alert');
    expect(html).toContain('Malicious JS');
    expect(html).toContain('Malformed');
  });
});
