import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import ExcelJS from 'exceljs';
import { POST } from './route';
import { requireAdmin } from '../../../../../auth/requireAdmin';
import { validateSameOrigin } from '../../../../../auth/csrf';
import { AdminAuthError, AdminPermission } from '../../../../../auth/authTypes';

vi.mock('server-only', () => ({}));
vi.mock('../../../../../auth/requireAdmin', () => ({ requireAdmin: vi.fn() }));
vi.mock('../../../../../auth/csrf', () => ({
  validateSameOrigin: vi.fn((origin, reqOrigin) => origin === reqOrigin),
}));

const ORIGIN = 'http://localhost:3000';
const URL = `${ORIGIN}/api/imports/admin-reference/inspect`;

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

async function createXlsxFile(headers: string[] = ['Group Name', 'Title']): Promise<File> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(headers);
  ws.addRow(['Group A', 'Title A']);
  const buf = await wb.xlsx.writeBuffer();
  return new File([buf], 'reference.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

describe('POST /api/imports/admin-reference/inspect route security & contract', () => {
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
      headers: { origin: 'http://attacker.com' },
    });

    const res = await POST(req);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.code).toBe('CROSS_ORIGIN_REJECTED');
  });

  it('rejects unauthenticated requests', async () => {
    vi.mocked(validateSameOrigin).mockReturnValue(true);
    vi.mocked(requireAdmin).mockRejectedValue(new AdminAuthError('UNAUTHENTICATED', 'Authentication required.'));

    const req = new NextRequest(URL, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-length': '100' },
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
    });

    const res = await POST(req);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.code).toBe('PERMISSION_DENIED');
  });

  it('inspects a valid reference workbook and returns structural summary only', async () => {
    vi.mocked(validateSameOrigin).mockReturnValue(true);
    mockAdmin(['projects.edit']);

    const file = await createXlsxFile(['Group Name', 'Project Title', 'Program']);
    const formData = new FormData();
    formData.append('referenceFile', file);

    const req = new NextRequest(URL, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-length': String(file.size + 200) },
      body: formData,
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.referenceWorkbookFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(json.worksheets).toHaveLength(1);
    expect(json.worksheets[0].name).toBe('Sheet1');
    expect(json.worksheets[0].headers).toEqual(['Group Name', 'Project Title', 'Program']);

    // Assert privacy: raw student cell values are not in structural summary
    expect(JSON.stringify(json)).not.toContain('Group A');
    expect(JSON.stringify(json)).not.toContain('Title A');
  });

  it('rejects invalid file extension (non-.xlsx)', async () => {
    vi.mocked(validateSameOrigin).mockReturnValue(true);
    mockAdmin(['projects.edit']);

    const file = new File(['text content'], 'reference.csv', { type: 'text/csv' });
    const formData = new FormData();
    formData.append('referenceFile', file);

    const req = new NextRequest(URL, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-length': String(file.size + 200) },
      body: formData,
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe('INVALID_FILE_TYPE');
  });
});
