import type { ImportPackageValidationResult } from '../import/importTypes';

// Only these deterministic package rules are revalidated by validateImportPackage.
// Unknown rules, staff findings and rules with a different field retain their disposition.
const PACKAGE_RULE_FIELDS: Record<string, string | null> = {
  METADATA_MISSING_ID: 'publicId', METADATA_MISSING_TITLE: 'title',
  METADATA_MISSING_SUMMARY: 'summary', METADATA_MISSING_YEAR: 'year',
  METADATA_MISSING_PROGRAM: 'program', METADATA_MISSING_DISCIPLINE: 'discipline',
  METADATA_MISSING_GROUP: 'groupName', METADATA_EMPTY_ROSTER: 'teamMembers',
  METADATA_INVALID_LAYOUT: 'layoutConfig',
  FILE_MISSING_POSTER_IMAGE: null, FILE_INVALID_POSTER_IMAGE: null, FILE_WARNING_POSTER_IMAGE: null,
  FILE_MISSING_POSTER_PDF: null, FILE_INVALID_POSTER_PDF: null, FILE_WARNING_POSTER_PDF: null,
  FILE_MISSING_RECOMMENDED: null, FILE_GALLERY_TOO_MANY_IMAGES: null,
  FILE_GALLERY_POSITION_OUT_OF_RANGE: 'galleryImages', FILE_GALLERY_DUPLICATE_POSITION: 'galleryImages',
  FILE_INVALID_GALLERY_IMAGE: 'galleryImages', FILE_WARNING_GALLERY_IMAGE: 'galleryImages',
  METADATA_GALLERY_ALT_POSITION_OUT_OF_RANGE: 'galleryAltTexts', METADATA_DUPLICATE_GALLERY_ALT_POSITION: 'galleryAltTexts',
  METADATA_EMPTY_GALLERY_ALT_TEXT: 'galleryAltTexts', METADATA_GALLERY_ALT_TEXT_TOO_LONG: 'galleryAltTexts',
  METADATA_UNMATCHED_GALLERY_ALT_TEXT: 'galleryAltTexts', METADATA_MISSING_GALLERY_ALT_TEXT: 'galleryAltTexts',
  METADATA_MISSING_SNAPSHOT_ALT_TEXT: 'snapshotAltText', METADATA_SNAPSHOT_ALT_TEXT_TOO_LONG: 'snapshotAltText',
};

export interface PassedPackageRule { ruleCode: string; fieldName: string | null }

export function passedPackageRules(result: ImportPackageValidationResult): PassedPackageRule[] {
  if (!result.valid || result.errors.length) return [];
  const checks = [
    ...Object.entries(PACKAGE_RULE_FIELDS).map(([ruleCode, fieldName]) => ({ ruleCode, fieldName })),
    { ruleCode: 'RECOMMENDED_FIELD_MISSING', fieldName: 'posterText' },
    { ruleCode: 'RECOMMENDED_FIELD_MISSING', fieldName: 'accessibilityText' },
  ];
  return checks.filter((check) => !result.warnings.some((finding) =>
    finding.ruleCode === check.ruleCode && (finding.fieldName ?? null) === check.fieldName));
}
