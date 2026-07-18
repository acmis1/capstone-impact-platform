import { ImportPackageParseResult, ImportPackageValidationResult } from './importTypes';
import { validateMediaAsset } from '../storage/mediaValidation';

export function validateImportPackage(parsed: ImportPackageParseResult): ImportPackageValidationResult {
  const errors: ImportPackageValidationResult['errors'] = [];
  const warnings: ImportPackageValidationResult['warnings'] = [];

  const manifest = parsed.manifest;

  // Helper to validate a required field in the manifest
  const checkRequired = (field: keyof typeof manifest, ruleCode: string, fieldName: string) => {
    const val = manifest[field];
    if (val === undefined || val === null || (typeof val === 'string' && val.trim() === '')) {
      errors.push({
        ruleCode,
        message: `Required manifest field "${fieldName}" is missing or empty.`,
        fieldName
      });
    }
  };

  // 1. Required Metadata Fields
  checkRequired('publicId', 'METADATA_MISSING_ID', 'publicId');
  checkRequired('title', 'METADATA_MISSING_TITLE', 'title');
  checkRequired('summary', 'METADATA_MISSING_SUMMARY', 'summary');
  checkRequired('year', 'METADATA_MISSING_YEAR', 'year');
  checkRequired('program', 'METADATA_MISSING_PROGRAM', 'program');
  checkRequired('discipline', 'METADATA_MISSING_DISCIPLINE', 'discipline');
  checkRequired('groupName', 'METADATA_MISSING_GROUP', 'groupName');

  // teamMembers list check
  if (!Array.isArray(manifest.teamMembers) || manifest.teamMembers.length === 0) {
    errors.push({
      ruleCode: 'METADATA_EMPTY_ROSTER',
      message: 'Required manifest list "teamMembers" is empty or not an array.',
      fieldName: 'teamMembers'
    });
  }

  // layoutConfig check
  if (!manifest.layoutConfig || typeof manifest.layoutConfig !== 'object' || Array.isArray(manifest.layoutConfig)) {
    errors.push({
      ruleCode: 'METADATA_INVALID_LAYOUT',
      message: 'Required manifest object "layoutConfig" is missing or invalid.',
      fieldName: 'layoutConfig'
    });
  }

  // 2. Recommended fields warnings
  if (!manifest.accessibilityText || manifest.accessibilityText.trim() === '') {
    warnings.push({
      ruleCode: 'RECOMMENDED_FIELD_MISSING',
      message: 'Manifest recommendation: accessibilityText (for visual descriptions) is missing.',
      fieldName: 'accessibilityText'
    });
  }

  if (!manifest.posterText || manifest.posterText.trim() === '') {
    warnings.push({
      ruleCode: 'RECOMMENDED_FIELD_MISSING',
      message: 'Manifest recommendation: posterText (OCR indexing) is missing.',
      fieldName: 'posterText'
    });
  }

  // 3. File Verification
  // poster.png check
  if (!parsed.posterImage) {
    errors.push({
      ruleCode: 'FILE_MISSING_POSTER_IMAGE',
      message: 'Required asset file "poster.png" is missing from the package.'
    });
  } else {
    const vResult = validateMediaAsset({
      fileName: parsed.posterImage.fileName,
      fileSizeBytes: parsed.posterImage.fileSizeBytes,
      mimeType: parsed.posterImage.mimeType
    });
    vResult.errors.forEach(e => errors.push({ ruleCode: 'FILE_INVALID_POSTER_IMAGE', message: `poster.png error: ${e}` }));
    vResult.warnings.forEach(w => warnings.push({ ruleCode: 'FILE_WARNING_POSTER_IMAGE', message: `poster.png warning: ${w}` }));
  }

  // poster.pdf check
  if (!parsed.posterPdf) {
    errors.push({
      ruleCode: 'FILE_MISSING_POSTER_PDF',
      message: 'Required asset file "poster.pdf" is missing from the package.'
    });
  } else {
    const vResult = validateMediaAsset({
      fileName: parsed.posterPdf.fileName,
      fileSizeBytes: parsed.posterPdf.fileSizeBytes,
      mimeType: parsed.posterPdf.mimeType
    });
    vResult.errors.forEach(e => errors.push({ ruleCode: 'FILE_INVALID_POSTER_PDF', message: `poster.pdf error: ${e}` }));
    vResult.warnings.forEach(w => warnings.push({ ruleCode: 'FILE_WARNING_POSTER_PDF', message: `poster.pdf warning: ${w}` }));
  }

  // Recommended snapshot verification
  if (!parsed.snapshot1) {
    warnings.push({
      ruleCode: 'FILE_MISSING_RECOMMENDED',
      message: 'Asset recommendation: snapshot-1.png is missing from the package.'
    });
  } else {
    const vResult = validateMediaAsset({
      fileName: parsed.snapshot1.fileName,
      fileSizeBytes: parsed.snapshot1.fileSizeBytes,
      mimeType: parsed.snapshot1.mimeType
    });
    vResult.errors.forEach(e => errors.push({ ruleCode: 'FILE_INVALID_SNAPSHOT', message: `snapshot-1.png error: ${e}` }));
    vResult.warnings.forEach(w => warnings.push({ ruleCode: 'FILE_WARNING_SNAPSHOT', message: `snapshot-1.png warning: ${w}` }));
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}
