import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { escapeHtml, renderParticipantPreviewPage, renderParticipantPreviewUnavailablePage, isSafeExternalPreviewUrl } from '../previews/participantPreviewHtml';
import { hashPreviewToken } from '../previews/participantPreviewToken';

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
    });

    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script>evil()</script>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
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

    const token = 'c'.repeat(64);
    const req = new NextRequest(`http://localhost:3000/participant-preview/${token}`);
    const res = await GET(req, { params: Promise.resolve({ token }) });
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('Accessible Robotics Kit');
    expect(signSpy).toHaveBeenCalledTimes(1);

    resolveSpy.mockRestore();
    signSpy.mockRestore();
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

    const token = 'd'.repeat(64);
    const req = new NextRequest(`http://localhost:3000/participant-preview/${token}`);
    const res = await GET(req, { params: Promise.resolve({ token }) });
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('No Media Project');

    resolveSpy.mockRestore();
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
