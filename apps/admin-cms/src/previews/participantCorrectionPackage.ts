import { createHash } from 'node:crypto';
import { parseProjectDetailsWorkbook } from '../import/parseProjectDetailsWorkbook';
import { buildImportPackageManifestFromWorkbook } from '../import/workbookManifestAdapter';
import { validateImportPackage } from '../import/validateImportPackage';
import type { ImportPackageManifest, ImportPackageFile } from '../import/importTypes';
import { MAX_GALLERY_IMAGES } from '../import/galleryConvention';
import { validateMediaAssetBytes } from '../storage/mediaValidationCore';
import { passedPackageRules, type PassedPackageRule } from './correctionValidation';
import { assertCorrectionWorkbookBounds } from './correctionWorkbookBounds';

export const CORRECTION_PACKAGE_LIMITS = {
  bodyBytes: 33 * 1024 * 1024,
  packageBytes: 32 * 1024 * 1024,
  workbookBytes: 5 * 1024 * 1024,
  imageBytes: 5 * 1024 * 1024,
  pdfBytes: 20 * 1024 * 1024,
  files: 3 + MAX_GALLERY_IMAGES,
  readTimeoutMs: 120_000,
} as const;

export class CorrectionPackageError extends Error {
  constructor(public readonly field: string, message: string) { super(message); }
}

export interface CorrectionFileEvidence {
  role: 'workbook' | 'poster_image' | 'poster_pdf' | 'snapshot_image';
  position: number | null;
  fileName: string;
  mimeType: string;
  bytes: number;
  sha256: string;
  altText: string | null;
}
export interface CorrectionPackage {
  metadata: ImportPackageManifest;
  files: Array<CorrectionFileEvidence & { content: Buffer }>;
  warnings: string[];
  validationChecks: PassedPackageRule[];
  hash: string;
  totalBytes: number;
}

export const correctionDigest = (content: Buffer | string): string => createHash('sha256').update(content).digest('hex');

/** Read actual bytes before multipart decoding; a declared Content-Length is only an early check. */
export async function readCorrectionBody(request: Request): Promise<FormData> {
  const type = request.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data;\s*boundary=(?:[A-Za-z0-9'()+_,.\/:=?-]{1,70}|"[A-Za-z0-9'()+_,.\/:=? -]{1,70}")$/i.test(type)) {
    throw new CorrectionPackageError('package', 'Use the corrected package upload form.');
  }
  const length = request.headers.get('content-length');
  if (length !== null && (!/^(0|[1-9]\d*)$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > CORRECTION_PACKAGE_LIMITS.bodyBytes)) {
    throw new CorrectionPackageError('package', 'The complete upload must be no more than 32 MB.');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new CorrectionPackageError('package', 'Select the required package files.');
  // A tiny-chunk stream must not create millions of retained array/object entries.
  // Grow one bounded byte buffer instead of retaining every transport chunk.
  let buffer = Buffer.alloc(64 * 1024);
  let total = 0;
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); }, CORRECTION_PACKAGE_LIMITS.readTimeoutMs);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const nextTotal = total + value.byteLength;
      if (nextTotal > CORRECTION_PACKAGE_LIMITS.bodyBytes) {
        await reader.cancel();
        throw new CorrectionPackageError('package', 'The complete upload must be no more than 32 MB.');
      }
      if (nextTotal > buffer.length) {
        const expanded = Buffer.alloc(Math.min(CORRECTION_PACKAGE_LIMITS.bodyBytes, Math.max(nextTotal, buffer.length * 2)));
        buffer.copy(expanded, 0, 0, total);
        buffer = expanded;
      }
      buffer.set(value, total);
      total = nextTotal;
    }
    if (timedOut) throw new CorrectionPackageError('package', 'The upload took too long. Select your files and try again.');
    const bytes = buffer.subarray(0, total);
    // Multipart decoders may strip directory prefixes from filenames. Reject the original
    // wire filename before decoding, so slash/backslash traversal is never normalized away.
    const boundaryValue = type.slice(type.toLowerCase().indexOf('boundary=') + 9).replace(/^"|"$/g, '');
    const delimiter = Buffer.from(`--${boundaryValue}`);
    let cursor = 0;
    let parts = 0;
    while (cursor < bytes.length) {
      if (!bytes.subarray(cursor, cursor + delimiter.length).equals(delimiter)) throw new CorrectionPackageError('package', 'The upload format is invalid.');
      cursor += delimiter.length;
      if (bytes.subarray(cursor, cursor + 2).toString() === '--') break;
      if (++parts > CORRECTION_PACKAGE_LIMITS.files || bytes.subarray(cursor, cursor + 2).toString() !== '\r\n') throw new CorrectionPackageError('package', 'Use one file per listed role.');
      const headerEnd = bytes.indexOf('\r\n\r\n', cursor + 2);
      if (headerEnd < 0 || headerEnd - cursor > 8192) throw new CorrectionPackageError('package', 'The upload format is invalid.');
      const headers = bytes.subarray(cursor + 2, headerEnd).toString('utf8');
      const filenames = [...headers.matchAll(/(?:^|;)\s*filename="([^"\r\n]*)"/g)];
      if (/filename\s*\*\s*=/i.test(headers) || filenames.length !== 1 || /[/\\]/.test(filenames[0][1]) || filenames[0][1].includes('..')) throw new CorrectionPackageError('package', 'Use filenames without directories or traversal characters.');
      const next = bytes.indexOf(Buffer.from(`\r\n--${boundaryValue}`), headerEnd + 4);
      if (next < 0) throw new CorrectionPackageError('package', 'The upload format is invalid.');
      cursor = next + 2;
    }
    return await new Response(bytes, { headers: { 'Content-Type': type } }).formData();
  } catch (error) {
    if (error instanceof CorrectionPackageError) throw error;
    throw new CorrectionPackageError('package', 'The upload could not be read. Select your files again.');
  } finally { clearTimeout(deadline); reader.releaseLock(); }
}

/** Roles and project identity come from the server, never an uploaded descriptor or form field. */
export async function parseParticipantCorrectionPackage(form: FormData, publicId: string): Promise<CorrectionPackage> {
  const fields = ['workbook', 'poster', 'pdf', ...Array.from({ length: MAX_GALLERY_IMAGES }, (_, i) => `snapshot${i + 1}`)];
  const entries = [...form.entries()];
  if (entries.length > fields.length || entries.some(([key]) => !fields.includes(key))) {
    throw new CorrectionPackageError('package', 'Use only the listed package file inputs.');
  }
  const files: CorrectionPackage['files'] = [];
  let totalBytes = 0;
  for (const field of fields) {
    const values = form.getAll(field);
    const value = values[0];
    if (values.length > 1 || (value !== undefined && typeof value === 'string')) throw new CorrectionPackageError(field, 'Choose one file for this role.');
    if (!value || value.size === 0) {
      if (['workbook', 'poster', 'pdf'].includes(field)) throw new CorrectionPackageError(field, 'This file is required.');
      continue;
    }
    if (value.name.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9_ .-]*$/.test(value.name) || value.name.includes('..') || /[/\\]/.test(value.name)) throw new CorrectionPackageError(field, 'Start the filename with a letter or number; use up to 100 letters, numbers, spaces, dots, hyphens or underscores.');
    const extension = value.name.split('.').pop()?.toLowerCase();
    const types: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    const mimeType = types[extension ?? ''];
    const isWorkbook = field === 'workbook';
    const isPdf = field === 'pdf';
    if (!mimeType || (isWorkbook ? extension !== 'xlsx' : isPdf ? extension !== 'pdf' : !mimeType.startsWith('image/')) || (value.type && value.type !== mimeType)) throw new CorrectionPackageError(field, 'The file extension and type must match the listed requirements.');
    const max = isWorkbook ? CORRECTION_PACKAGE_LIMITS.workbookBytes : isPdf ? CORRECTION_PACKAGE_LIMITS.pdfBytes : CORRECTION_PACKAGE_LIMITS.imageBytes;
    if (value.size > max || (totalBytes += value.size) > CORRECTION_PACKAGE_LIMITS.packageBytes) throw new CorrectionPackageError(field, `File exceeds its ${max / 1024 / 1024} MB limit or the 32 MB package limit.`);
    const content = Buffer.from(await value.arrayBuffer());
    if (content.length !== value.size) throw new CorrectionPackageError(field, 'The file could not be read completely.');
    if (isWorkbook) {
      try { assertCorrectionWorkbookBounds(content); } catch { throw new CorrectionPackageError(field, 'Use a standard project-details.xlsx workbook with at most 128 rows and 128 columns per sheet.'); }
    } else if (!validateMediaAssetBytes({ fileName: value.name, content, expectedMimeType: mimeType, expectedFileSizeBytes: value.size }).valid) {
      throw new CorrectionPackageError(field, 'The file content does not match a supported image or PDF.');
    }
    const position = field.startsWith('snapshot') ? Number(field.slice(8)) : null;
    files.push({ role: isWorkbook ? 'workbook' : isPdf ? 'poster_pdf' : field === 'poster' ? 'poster_image' : 'snapshot_image', position, fileName: value.name, mimeType, bytes: content.length, sha256: correctionDigest(content), altText: null, content });
  }
  let parsed;
  try { parsed = await parseProjectDetailsWorkbook(files[0].content); } catch { throw new CorrectionPackageError('workbook', 'The workbook must contain one complete project row, including the required poster text and accessibility description.'); }
  const metadata = buildImportPackageManifestFromWorkbook({ parsedWorkbook: parsed, publicId });
  const asPackageFile = (file: CorrectionPackage['files'][number]): ImportPackageFile => ({ fileName: file.fileName, fileSizeBytes: file.bytes, mimeType: file.mimeType, content: file.content });
  const gallery = files.filter((f) => f.role === 'snapshot_image').map((f) => ({ position: f.position!, file: asPackageFile(f) }));
  const validation = validateImportPackage({ manifest: metadata, posterImage: asPackageFile(files[1]), posterPdf: asPackageFile(files[2]), galleryImages: gallery, snapshot1: gallery.find((f) => f.position === 1)?.file ?? null }, { metadataSource: 'xlsx' });
  if (!validation.valid) throw new CorrectionPackageError('workbook', 'Check all required project fields and the description for each supporting image in your workbook.');
  for (const file of files) {
    if (file.role === 'snapshot_image') file.altText = metadata.galleryAltTexts?.find((a) => a.position === file.position)?.altText ?? (file.position === 1 ? metadata.snapshotAltText ?? null : null);
  }
  const evidence = files.map(({ role, position, fileName, mimeType, bytes, sha256, altText }) => ({ role, position, fileName, mimeType, bytes, sha256, altText }));
  const validationChecks = passedPackageRules(validation);
  return { metadata, files, validationChecks, warnings: [...parsed.warnings.map((w) => w.message), ...validation.warnings.map((w) => w.message)], hash: correctionDigest(JSON.stringify({ metadata, files: evidence, validationChecks })), totalBytes };
}
