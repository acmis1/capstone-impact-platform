import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import ExcelJS from 'exceljs';
import { POST } from './route';
import { requireAdmin } from '../../../../../auth/requireAdmin';
import { validateSameOrigin } from '../../../../../auth/csrf';
import { AdminAuthError, AdminPermission } from '../../../../../auth/authTypes';
import { ADMIN_REFERENCE_LIMITS } from '../../../../../import/adminReferenceReconciliation';

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

async function createXlsxFile(
  headers: string[] = ['Group Name', 'Title'],
  rows: string[][] = [['Group A', 'Title A']],
  sheetName = 'Sheet1',
): Promise<File> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  ws.addRow(headers);
  for (const row of rows) ws.addRow(row);
  const buf = await wb.xlsx.writeBuffer();
  return new File([buf], 'reference.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

function createRawMultipartRequest(body: ArrayBuffer, declaredBoundary: string): NextRequest {
  return new NextRequest(URL, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'content-type': `multipart/form-data; boundary=${declaredBoundary}`,
      'content-length': String(body.byteLength),
    },
    body,
  });
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

    const file = await createXlsxFile(
      ['Group Name', 'Project Title', 'Program'],
      [
        ['Group A', 'Project A', 'Program A'],
        ['Group B', 'Project B', 'Program B'],
        ['Group C', 'Project C', 'Program C'],
      ],
      'School Reference',
    );
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
    expect(json.worksheets[0].name).toBe('School Reference');
    expect(json.worksheets[0].rowCount).toBe(3);
    expect(json.worksheets[0].headers).toEqual(['Group Name', 'Project Title', 'Program']);

    // Assert privacy: raw participant cell values are not in structural summary
    const responseText = JSON.stringify(json);
    for (const value of [
      'Group A', 'Project A', 'Program A',
      'Group B', 'Project B', 'Program B',
      'Group C', 'Project C', 'Program C',
    ]) {
      expect(responseText).not.toContain(value);
    }
  });

  it('rejects a missing referenceFile field', async () => {
    vi.mocked(validateSameOrigin).mockReturnValue(true);
    mockAdmin(['projects.edit']);

    const formData = new FormData();
    const req = new NextRequest(URL, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-length': '36' },
      body: formData,
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('MISSING_REFERENCE_FILE');
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

  it('rejects duplicate referenceFile fields', async () => {
    vi.mocked(validateSameOrigin).mockReturnValue(true);
    mockAdmin(['projects.edit']);

    const file = await createXlsxFile();
    const formData = new FormData();
    formData.append('referenceFile', file);
    formData.append('referenceFile', file);
    const req = new NextRequest(URL, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-length': String(file.size * 2 + 500) },
      body: formData,
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('DUPLICATE_REFERENCE_FILE');
  });

  it('rejects unexpected multipart fields', async () => {
    vi.mocked(validateSameOrigin).mockReturnValue(true);
    mockAdmin(['projects.edit']);

    const file = await createXlsxFile();
    const formData = new FormData();
    formData.append('referenceFile', file);
    formData.append('unexpected', 'value');
    const req = new NextRequest(URL, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-length': String(file.size + 500) },
      body: formData,
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('UNEXPECTED_UPLOAD_FIELD');
  });

  it('rejects a malformed .xlsx workbook', async () => {
    vi.mocked(validateSameOrigin).mockReturnValue(true);
    mockAdmin(['projects.edit']);

    const file = new File(['not an xlsx archive'], 'reference.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const formData = new FormData();
    formData.append('referenceFile', file);
    const req = new NextRequest(URL, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-length': String(file.size + 200) },
      body: formData,
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('INVALID_WORKBOOK');
  });

  it.each([
    {
      name: 'truncated multipart body',
      bodyBoundary: 'lane-b',
      declaredBoundary: 'lane-b',
      closingBoundary: false,
    },
    {
      name: 'mismatched multipart boundary',
      bodyBoundary: 'different-boundary',
      declaredBoundary: 'lane-b',
      closingBoundary: true,
    },
  ])('rejects a $name as INVALID_WORKBOOK', async ({ bodyBoundary, declaredBoundary, closingBoundary }) => {
    vi.mocked(validateSameOrigin).mockReturnValue(true);
    mockAdmin(['projects.edit']);

    const suffix = closingBoundary ? `\r\n--${bodyBoundary}--\r\n` : '';
    const body = new TextEncoder().encode(
      `--${bodyBoundary}\r\n` +
      'Content-Disposition: form-data; name="referenceFile"; filename="reference.xlsx"\r\n' +
      'Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n' +
      `PK${suffix}`,
    );

    const res = await POST(createRawMultipartRequest(body.buffer, declaredBoundary));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('INVALID_WORKBOOK');
  });

  it('rejects a missing Content-Length before multipart parsing', async () => {
    vi.mocked(validateSameOrigin).mockReturnValue(true);
    mockAdmin(['projects.edit']);

    const req = new NextRequest(URL, {
      method: 'POST',
      headers: { origin: ORIGIN },
      body: new FormData(),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('MISSING_CONTENT_LENGTH');
  });

  it('rejects an oversized declared Content-Length before multipart parsing', async () => {
    vi.mocked(validateSameOrigin).mockReturnValue(true);
    mockAdmin(['projects.edit']);

    const req = new NextRequest(URL, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        'content-length': String(27 * 1024 * 1024 + 1),
      },
    });

    const res = await POST(req);
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe('REQUEST_TOO_LARGE');
  });

  it('rejects an oversized reference workbook before parsing', async () => {
    vi.mocked(validateSameOrigin).mockReturnValue(true);
    mockAdmin(['projects.edit']);

    const file = new File(
      [new Uint8Array(ADMIN_REFERENCE_LIMITS.MAX_WORKBOOK_BYTES + 1)],
      'reference.xlsx',
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
    );
    const formData = new FormData();
    formData.append('referenceFile', file);
    const req = new NextRequest(URL, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-length': String(file.size + 200) },
      body: formData,
    });

    const res = await POST(req);
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe('REQUEST_TOO_LARGE');
  });
});
