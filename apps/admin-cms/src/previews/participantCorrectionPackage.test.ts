// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { correctionWorkbook, correctionForm, PNG, PDF } from './participantCorrectionFixtures';
import { parseParticipantCorrectionPackage, readCorrectionBody, CORRECTION_PACKAGE_LIMITS } from './participantCorrectionPackage';
import { assertCorrectionWorkbookBounds } from './correctionWorkbookBounds';

describe('participant correction package boundary', () => {
  it('reparses workbook and media, binds only the server project, and hashes exact bytes', async () => {
    const form = await correctionForm();
    const first = await parseParticipantCorrectionPackage(form, '2026-bound-project');
    const replay = await parseParticipantCorrectionPackage(form, '2026-bound-project');
    expect(first.metadata.publicId).toBe('2026-bound-project');
    expect(first.metadata.title).toBe('Synthetic corrected project');
    expect(first.metadata.demoUrl).toBe('https://example.com/demo');
    expect(first.files.map((f) => f.role)).toEqual(['workbook', 'poster_image', 'poster_pdf', 'snapshot_image']);
    expect(first.files[3].altText).toBe('Prototype on a bench.');
    expect(first.hash).toBe(replay.hash);
    form.set('pdf', new File([Buffer.concat([PDF, Buffer.from('\n% corrected')])], 'poster.pdf', { type: 'application/pdf' }));
    expect((await parseParticipantCorrectionPackage(form, '2026-bound-project')).hash).not.toBe(first.hash);
  });

  it.each(['workbook', 'poster', 'pdf'])('rejects missing required %s', async (field) => {
    const form = await correctionForm(); form.delete(field);
    await expect(parseParticipantCorrectionPackage(form, '2026-bound-project')).rejects.toMatchObject({ field });
  });
  it.each(['projectId', 'candidate', 'bucket', 'storagePath', 'snapshot11'])('rejects unknown identity/override field %s', async (field) => {
    const form = await correctionForm(); form.set(field, 'override');
    await expect(parseParticipantCorrectionPackage(form, '2026-bound-project')).rejects.toMatchObject({ field: 'package' });
  });
  it.each(['../poster.png', '..\\poster.png', 'poster.svg', 'bad\u0000.png'])('rejects unsafe filename %s', async (name) => {
    const form = await correctionForm(); form.set('poster', new File([PNG], name, { type: 'image/png' }));
    await expect(parseParticipantCorrectionPackage(form, '2026-bound-project')).rejects.toMatchObject({ field: 'poster' });
  });
  it('rejects duplicate roles, mismatched MIME, invalid PDF signature and oversized files', async () => {
    const duplicate = await correctionForm(); duplicate.append('poster', duplicate.get('poster')!);
    await expect(parseParticipantCorrectionPackage(duplicate, '2026-bound-project')).rejects.toThrow();
    for (const file of [new File([PNG], 'poster.pdf', { type: 'application/pdf' }), new File([PDF], 'poster.pdf', { type: 'image/png' }), new File([new Uint8Array(CORRECTION_PACKAGE_LIMITS.pdfBytes + 1)], 'poster.pdf', { type: 'application/pdf' })]) {
      const form = await correctionForm(); form.set('pdf', file);
      await expect(parseParticipantCorrectionPackage(form, '2026-bound-project')).rejects.toMatchObject({ field: 'pdf' });
    }
  });
  it('bounds actual body bytes when Content-Length is absent or false', async () => {
    for (const length of [undefined, '1']) {
      const headers: Record<string, string> = { 'Content-Type': 'multipart/form-data; boundary=test' };
      if (length) headers['Content-Length'] = length;
      let cancelled = false;
      const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(CORRECTION_PACKAGE_LIMITS.bodyBytes + 1)); }, cancel() { cancelled = true; } });
      const request = new Request('http://localhost/upload', { method: 'POST', headers, body, duplex: 'half' } as RequestInit);
      await expect(readCorrectionBody(request)).rejects.toThrow('32 MB');
      expect(cancelled).toBe(true);
    }
  });
  it('accepts a normal multipart request with no declared length', async () => {
    const request = new Request('http://localhost/upload', { method: 'POST', body: await correctionForm() });
    expect((await readCorrectionBody(request)).has('workbook')).toBe(true);
  });
  it('rejects wire traversal before the multipart decoder can strip directories', async () => {
    for (const name of ['../poster.png', '..\\poster.png']) {
      const form = await correctionForm(); form.set('poster', new File([PNG], name, { type: 'image/png' }));
      const request = new Request('http://localhost/upload', { method: 'POST', body: form });
      await expect(readCorrectionBody(request)).rejects.toThrow('traversal');
    }
  });
  it('rejects unsupported content types before reading bytes', async () => {
    for (const type of ['application/json', 'multipart/form-data', 'text/plain']) {
      await expect(readCorrectionBody(new Request('http://localhost/upload', { method: 'POST', headers: { 'Content-Type': type }, body: '{}' }))).rejects.toThrow('upload form');
    }
  });
  it('rejects dangerous worksheet indices and expanded workbooks before ExcelJS parsing', async () => {
    const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('Project details');
    sheet.getCell('A999').value = 'far outside the bounded workbook';
    expect(() => assertCorrectionWorkbookBounds(Buffer.from([]))).toThrow();
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    expect(() => assertCorrectionWorkbookBounds(bytes)).toThrow('WORKBOOK_LIMIT');
  });
  it('bounds fragmented transport chunks without changing multipart decoding', async () => {
    const normal = new Request('http://localhost/upload', { method: 'POST', body: await correctionForm() });
    const bytes = new Uint8Array(await normal.arrayBuffer()); let offset = 0;
    const body = new ReadableStream({ pull(controller) { if (offset === bytes.length) controller.close(); else { controller.enqueue(bytes.slice(offset, offset + 17)); offset = Math.min(offset + 17, bytes.length); } } });
    const request = new Request('http://localhost/upload', { method: 'POST', headers: normal.headers, body, duplex: 'half' } as RequestInit);
    expect((await readCorrectionBody(request)).has('workbook')).toBe(true);
  });
  it('cancels a stalled body at the fixed read deadline', async () => {
    vi.useFakeTimers();
    try {
      let cancelled = false;
      const body = new ReadableStream({ cancel() { cancelled = true; } });
      const request = new Request('http://localhost/upload', { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=test' }, body, duplex: 'half' } as RequestInit);
      const outcome = readCorrectionBody(request).catch((error: Error) => error.message);
      await vi.advanceTimersByTimeAsync(CORRECTION_PACKAGE_LIMITS.readTimeoutMs);
      expect(await outcome).toContain('took too long'); expect(cancelled).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it.each(['<mergeCells><mergeCell ref="A1:XFD1048576"/></mergeCells>', '<dataValidations><dataValidation sqref="A1:XFD1048576"/></dataValidations>'])('rejects XML expansion range %s before ExcelJS', async (addition) => {
    const zip = await JSZip.loadAsync(await correctionWorkbook());
    const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
    zip.file('xl/worksheets/sheet1.xml', xml.replace('</worksheet>', addition + '</worksheet>'));
    expect(() => assertCorrectionWorkbookBounds(Buffer.from([]))).toThrow();
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    expect(() => assertCorrectionWorkbookBounds(bytes)).toThrow('WORKBOOK_LIMIT');
  });
  it('rejects excessive ZIP entries, external relationships, and dishonest expansion sizes', async () => {
    const many = await JSZip.loadAsync(await correctionWorkbook());
    for (let i = 0; i < 130; i++) many.file('extra-' + i + '.xml', '<root/>');
    const manyBytes = await many.generateAsync({ type: 'nodebuffer' });
    expect(() => assertCorrectionWorkbookBounds(manyBytes)).toThrow();
    const external = await JSZip.loadAsync(await correctionWorkbook());
    external.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship TargetMode="External" Target="https://example.invalid"/></Relationships>');
    const externalBytes = await external.generateAsync({ type: 'nodebuffer' });
    expect(() => assertCorrectionWorkbookBounds(externalBytes)).toThrow();
    const bomb = await JSZip.loadAsync(await correctionWorkbook());
    bomb.file('extra.xml', 'x'.repeat(9 * 1024 * 1024));
    const bombBytes = await bomb.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    expect(() => assertCorrectionWorkbookBounds(bombBytes)).toThrow();
    for (let offset = 0; offset < bombBytes.length - 46; offset++) if (bombBytes.readUInt32LE(offset) === 0x02014b50 && bombBytes.subarray(offset + 46, offset + 55).toString() === 'extra.xml') bombBytes.writeUInt32LE(10, offset + 24);
    expect(() => assertCorrectionWorkbookBounds(bombBytes)).toThrow();
  });

  it('accepts ordinary Excel web hyperlinks and finite named ranges', async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(new Uint8Array(await correctionWorkbook()) as never);
    workbook.worksheets[0].getCell('C2').value = { text: 'Synthetic background.', hyperlink: 'https://example.com/background' };
    workbook.definedNames.add("'Project details'!$A$1:$C$2", 'FiniteRange');
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    expect(() => assertCorrectionWorkbookBounds(bytes)).not.toThrow();
  });

  it('rejects named range expansion before workbook allocation', async () => {
    const zip = await JSZip.loadAsync(await correctionWorkbook());
    const xml = await zip.file('xl/workbook.xml')!.async('string');
    zip.file('xl/workbook.xml', xml.replace('</workbook>', '<definedNames><definedName name="Huge">Sheet1!$A$1:$XFD$1048576</definedName></definedNames></workbook>'));
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    expect(() => assertCorrectionWorkbookBounds(bytes)).toThrow('WORKBOOK_LIMIT');
  });

});
