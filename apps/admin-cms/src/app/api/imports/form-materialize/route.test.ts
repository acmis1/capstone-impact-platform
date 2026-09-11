import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from './route';
import { requireAdmin } from '../../../../auth/requireAdmin';
import { validateSameOrigin } from '../../../../auth/csrf';
import { AdminAuthError, AdminPermission } from '../../../../auth/authTypes';
import { parseProjectDetailsWorkbook } from '../../../../import/parseProjectDetailsWorkbook';

vi.mock('server-only', () => ({}));
vi.mock('../../../../auth/requireAdmin', () => ({ requireAdmin: vi.fn() }));
vi.mock('../../../../auth/csrf', () => ({
  validateSameOrigin: vi.fn((origin, reqOrigin) => origin === reqOrigin),
}));

const ORIGIN = 'http://localhost:3000';
const URL = `${ORIGIN}/api/imports/form-materialize`;

function mockAdmin(permissions: AdminPermission[] = ['projects.edit']) {
  vi.mocked(requireAdmin).mockResolvedValue({
    authUserId: 'user-1',
    adminUserId: '11111111-2222-3333-4444-555555555555',
    email: 'admin@capstone.test',
    fullName: 'Admin User',
    roles: ['admin'],
    permissions,
  });
}

const VALID_FORM_DATA = {
  publicId: 'safety-platform-2026',
  title: 'AI Safety Verification Platform',
  summary: 'A standardized system for evaluating AI safety and alignment.',
  background: 'Autonomous systems require rigorous verification boundaries.',
  solution: 'Developed an automated evaluation and testing harness.',
  teamMembers: 'Alice Smith\nBob Jones',
  groupName: 'Safety Systems Lab',
  participantContactEmail: 'safety@example.com',
  academicSupervisor: 'Dr. Evelyn Reed',
  industryPartner: 'Safety Corp',
  industry: 'Artificial Intelligence',
  program: 'Bachelor of Software Engineering',
  discipline: 'Computer Science',
  year: '2026',
  templateId: 'poster_showcase',
  featuredMedia: 'poster',
  posterText: 'AI Safety Verification Platform Poster Detailed Text',
  accessibilityText: 'Poster illustrating the architecture of the safety harness',
  videoUrl: 'https://example.com/video',
  demoUrl: 'https://example.com/demo',
  repositoryUrl: 'https://github.com/example/repo',
  snapshotAltText: 'Screenshot of dashboard',
  snapshot1ContentKind: 'ordinary',
  snapshot1FullText: '',
  snapshot2AltText: 'Benchmark chart',
  snapshot2ContentKind: 'text_bearing',
  snapshot2FullText: 'Benchmark chart comparing baseline and fine-tuned models.',
};

describe('POST /api/imports/form-materialize route', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects cross-origin requests before authorization or parsing', async () => {
    vi.mocked(validateSameOrigin).mockReturnValue(false);

    const req = new NextRequest(URL, {
      method: 'POST',
      headers: { origin: 'http://malicious.example.com' },
    });

    const res = await POST(req);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.code).toBe('CROSS_ORIGIN_REJECTED');
  });

  it('rejects unauthenticated requests', async () => {
    vi.mocked(validateSameOrigin).mockReturnValue(true);
    vi.mocked(requireAdmin).mockRejectedValue(
      new AdminAuthError('UNAUTHENTICATED', 'Authentication required.')
    );

    const req = new NextRequest(URL, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-length': '100' },
      body: JSON.stringify(VALID_FORM_DATA),
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.code).toBe('UNAUTHENTICATED');
  });

  it('rejects users lacking projects.edit permission', async () => {
    vi.mocked(validateSameOrigin).mockReturnValue(true);
    mockAdmin(['projects.read']);

    const req = new NextRequest(URL, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-length': '100' },
      body: JSON.stringify(VALID_FORM_DATA),
    });

    const res = await POST(req);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.code).toBe('PERMISSION_DENIED');
  });

  it('rejects requests missing content-length header', async () => {
    vi.mocked(validateSameOrigin).mockReturnValue(true);
    mockAdmin();

    const req = new NextRequest(URL, {
      method: 'POST',
      headers: { origin: ORIGIN },
      body: JSON.stringify(VALID_FORM_DATA),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe('MISSING_CONTENT_LENGTH');
  });

  it('rejects malformed json body', async () => {
    vi.mocked(validateSameOrigin).mockReturnValue(true);
    mockAdmin();

    const req = new NextRequest(URL, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-length': '15' },
      body: 'invalid-json{',
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe('INVALID_JSON');
  });

  it('rejects invalid metadata payload failing schema validation', async () => {
    vi.mocked(validateSameOrigin).mockReturnValue(true);
    mockAdmin();

    const invalidData = { ...VALID_FORM_DATA, publicId: '' };

    const req = new NextRequest(URL, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-length': '100' },
      body: JSON.stringify(invalidData),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe('VALIDATION_ERROR');
  });

  it('materializes canonical workbook and returns spreadsheet buffer on valid authorized request', async () => {
    vi.mocked(validateSameOrigin).mockReturnValue(true);
    mockAdmin();

    const bodyStr = JSON.stringify(VALID_FORM_DATA);
    const req = new NextRequest(URL, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        'content-length': String(Buffer.byteLength(bodyStr)),
        'content-type': 'application/json',
      },
      body: bodyStr,
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    expect(res.headers.get('content-disposition')).toContain('project-details.xlsx');
    expect(res.headers.get('cache-control')).toBe('no-store');

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    expect(buffer.length).toBeGreaterThan(0);

    // Verify workbook parses with current production parser including MG-05 gallery fields
    const parsed = await parseProjectDetailsWorkbook(buffer);
    expect(parsed.metadata.title).toBe(VALID_FORM_DATA.title);
    expect(parsed.metadata.galleryAltTexts).toHaveLength(2);
    expect(parsed.metadata.galleryAltTexts[0].contentKind).toBe('ordinary');
    expect(parsed.metadata.galleryAltTexts[1].contentKind).toBe('text_bearing');
    expect(parsed.metadata.galleryAltTexts[1].fullText).toBe(
      VALID_FORM_DATA.snapshot2FullText
    );
  });
});
