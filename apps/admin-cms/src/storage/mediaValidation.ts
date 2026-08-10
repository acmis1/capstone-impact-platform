export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export const MEDIA_VALIDATION_LIMITS = {
  MAX_IMAGE_SIZE_BYTES: 5 * 1024 * 1024,  // 5 MB
  MAX_PDF_SIZE_BYTES: 20 * 1024 * 1024,   // 20 MB
  DEFAULT_MAX_SIZE_BYTES: 5 * 1024 * 1024, // 5 MB
} as const;

const ALLOWED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/pdf'
]);

/**
 * Validates a media asset file before staging upload.
 */
export function validateMediaAsset(params: {
  fileName: string;
  fileSizeBytes: number;
  mimeType: string;
}): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const { fileName, fileSizeBytes, mimeType } = params;

  // 1. Empty Check
  if (fileSizeBytes <= 0) {
    errors.push('File is empty.');
  }

  // 2. MIME Type check
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    errors.push(`MIME type [${mimeType}] is not allowed. Only PNG, JPEG, WEBP, and PDF are supported.`);
  }

  // 3. File name path traversal / safety
  if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) {
    errors.push('Unsafe file name: contains path traversal characters.');
  }

  // 4. File name validity
  if (!/^[a-zA-Z0-9_\-\.]+$/.test(fileName)) {
    warnings.push('File name contains non-standard characters. It is highly recommended to use alphanumeric characters, underscores, hyphens, and periods only.');
  }

  // 5. Size limits
  if (mimeType === 'application/pdf') {
    if (fileSizeBytes > MEDIA_VALIDATION_LIMITS.MAX_PDF_SIZE_BYTES) {
      errors.push(`PDF file size [${(fileSizeBytes / (1024 * 1024)).toFixed(2)} MB] exceeds the maximum limit of 20 MB.`);
    }
  } else if (mimeType.startsWith('image/')) {
    if (fileSizeBytes > MEDIA_VALIDATION_LIMITS.MAX_IMAGE_SIZE_BYTES) {
      errors.push(`Image file size [${(fileSizeBytes / (1024 * 1024)).toFixed(2)} MB] exceeds the maximum limit of 5 MB.`);
    }
  } else {
    if (fileSizeBytes > MEDIA_VALIDATION_LIMITS.DEFAULT_MAX_SIZE_BYTES) {
      errors.push(`File size [${(fileSizeBytes / (1024 * 1024)).toFixed(2)} MB] exceeds the maximum limit of 5 MB.`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const WEBP_RIFF_SIGNATURE = Buffer.from('RIFF', 'ascii');
const WEBP_FORMAT_SIGNATURE = Buffer.from('WEBP', 'ascii');
const PDF_SIGNATURE = Buffer.from('%PDF-', 'ascii');

/**
 * Detects the actual media type of a buffer from its magic bytes (file signature),
 * independent of any declared filename or browser-supplied MIME type.
 */
export function detectMediaSignature(content: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | 'application/pdf' | null {
  if (content.length >= PNG_SIGNATURE.length && content.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return 'image/png';
  }
  if (content.length >= JPEG_SIGNATURE.length && content.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) {
    return 'image/jpeg';
  }
  if (
    content.length >= 12 &&
    content.subarray(0, 4).equals(WEBP_RIFF_SIGNATURE) &&
    content.subarray(8, 12).equals(WEBP_FORMAT_SIGNATURE)
  ) {
    return 'image/webp';
  }
  if (content.length >= PDF_SIGNATURE.length && content.subarray(0, PDF_SIGNATURE.length).equals(PDF_SIGNATURE)) {
    return 'application/pdf';
  }
  return null;
}

/**
 * Validates a media asset's actual byte content: exact declared length, allowed MIME,
 * filename safety/size rules (via validateMediaAsset), and a real magic-byte signature
 * match against the expected canonical MIME type. The browser-supplied MIME string is
 * never treated as authoritative.
 */
export function validateMediaAssetBytes(params: {
  fileName: string;
  content: Buffer;
  expectedMimeType: string;
  expectedFileSizeBytes: number;
}): ValidationResult {
  const { fileName, content, expectedMimeType, expectedFileSizeBytes } = params;
  const errors: string[] = [];
  const warnings: string[] = [];

  if (content.length !== expectedFileSizeBytes) {
    errors.push(`Uploaded file byte length [${content.length}] does not match expected size [${expectedFileSizeBytes}].`);
  }

  const base = validateMediaAsset({
    fileName,
    fileSizeBytes: content.length,
    mimeType: expectedMimeType,
  });
  errors.push(...base.errors);
  warnings.push(...base.warnings);

  const detectedSignature = detectMediaSignature(content);
  if (!detectedSignature) {
    errors.push('File content does not match any supported file signature (PNG, JPEG, WEBP, PDF).');
  } else if (detectedSignature !== expectedMimeType) {
    errors.push(`File content signature [${detectedSignature}] does not match expected type [${expectedMimeType}].`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
