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
