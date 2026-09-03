import ExcelJS from 'exceljs';
import { deflateSync } from 'node:zlib';
import { COLUMN_DEFINITIONS } from '../import/projectDetailsWorkbookContract';

export async function correctionWorkbook(overrides: Record<string, unknown> = {}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Project details');
  const values: Record<string, unknown> = {
    title: 'Synthetic corrected project', summary: 'Corrected summary supplied by the project team.',
    background: 'Synthetic background.', solution: 'Synthetic solution.', year: '2026',
    program: 'Information Technology', discipline: 'Software Engineering', industry: '',
    studyProgram: 'Information Technology', groupName: 'Synthetic team', teamMembers: 'Participant One; Participant Two',
    posterText: 'Complete meaningful poster text.', accessibilityText: 'Diagram of a synthetic workflow.',
    snapshotAltText: 'Prototype on a bench.', participantContactEmail: '', academicSupervisor: '', industryPartner: '',
    videoUrl: 'https://example.com/video', demoUrl: 'https://example.com/demo', repositoryUrl: 'https://example.com/code',
    templateId: 'Poster showcase', featuredMedia: 'Poster', ...overrides,
  };
  sheet.addRow(COLUMN_DEFINITIONS.map((c) => c.canonicalName));
  sheet.addRow(COLUMN_DEFINITIONS.map((c) => values[c.internalField] ?? ''));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function syntheticPng(red: number, green: number, blue: number): Buffer<ArrayBuffer> {
  const chunk = (type: string, bytes: Buffer) => {
    const payload = Buffer.concat([Buffer.from(type), bytes]);
    let crc = 0xffffffff;
    for (const byte of payload) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, payload, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, red, green, blue]))), chunk('IEND', Buffer.alloc(0))]);
}
function syntheticPdf(label: string): Buffer<ArrayBuffer> {
  const stream = `BT /F1 20 Tf 30 150 Td (${label}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 220] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let content = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(content)); content += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(content);
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  content += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(content);
}
export const ORIGINAL_PNG = syntheticPng(40, 80, 190);
export const PNG = syntheticPng(40, 170, 100);
export const ORIGINAL_PDF = syntheticPdf('Original synthetic poster');
export const PDF = syntheticPdf('Corrected synthetic poster');

export async function correctionForm(): Promise<FormData> {
  const form = new FormData();
  form.set('workbook', new File([new Uint8Array(await correctionWorkbook())], 'project-details.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  form.set('poster', new File([PNG], 'poster.png', { type: 'image/png' }));
  form.set('pdf', new File([PDF], 'poster.pdf', { type: 'application/pdf' }));
  form.set('snapshot1', new File([PNG], 'snapshot-1.png', { type: 'image/png' }));
  return form;
}
