import { ImportPackageFileMetadata, ImportPackageParseResult, ImportPackageValidationResult } from './importTypes';
import { validateMediaAsset } from '../storage/mediaValidationCore';
import {ACCESSIBLE_CONTENT_LIMITS,} from '../domain/accessibleContent';
import { MAX_GALLERY_IMAGES } from './galleryConvention';

export interface ValidateImportPackageOptions {
  /**
   * Which metadata source produced the manifest. The standard `project-details.xlsx` contract
   * carries the snapshot-alt column and is held to it; legacy `project.json` packages predate the
   * field and are deliberately not blocked at import for its absence alone.
   */
  metadataSource?: 'xlsx' | 'json' | null;
}

export function validateImportPackage(
  parsed: ImportPackageParseResult<ImportPackageFileMetadata>,
  options: ValidateImportPackageOptions = {}
): ImportPackageValidationResult {
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

  // Gallery image verification.
  //
  // Gallery images are optional, but every supplied image must have:
  // - a unique deterministic position
  // - a position within the supported gallery bound
  // - a valid media type/size under the existing media validation rules

  const galleryImages = parsed.galleryImages;

  if (galleryImages.length === 0) {
    warnings.push({
      ruleCode: 'FILE_MISSING_RECOMMENDED',
      message: 'Asset recommendation: no snapshot gallery images were supplied.',
    });
  }

  if (galleryImages.length > MAX_GALLERY_IMAGES) {
    errors.push({
      ruleCode: 'FILE_GALLERY_TOO_MANY_IMAGES',
      message: `Snapshot gallery contains ${galleryImages.length} images, exceeding the maximum of ${MAX_GALLERY_IMAGES}.`,
    });
  }

  const seenGalleryPositions = new Set<number>();

  for (const galleryImage of galleryImages) {
    const { position, file } = galleryImage;

    if (position < 1 || position > MAX_GALLERY_IMAGES) {
      errors.push({
        ruleCode: 'FILE_GALLERY_POSITION_OUT_OF_RANGE',
        message: `Gallery image "${file.fileName}" uses position ${position}. Supported positions are 1-${MAX_GALLERY_IMAGES}.`,
        fieldName: 'galleryImages',
      });
    }

    if (seenGalleryPositions.has(position)) {
      errors.push({
        ruleCode: 'FILE_GALLERY_DUPLICATE_POSITION',
        message: `Multiple gallery images use position ${position}. Each gallery position must identify exactly one image.`,
        fieldName: 'galleryImages',
      });
    } else {
      seenGalleryPositions.add(position);
    }

    const vResult = validateMediaAsset({
      fileName: file.fileName,
      fileSizeBytes: file.fileSizeBytes,
      mimeType: file.mimeType,
    });

    vResult.errors.forEach((error) =>
      errors.push({
        ruleCode: 'FILE_INVALID_GALLERY_IMAGE',
        message: `${file.fileName} error: ${error}`,
        fieldName: 'galleryImages',
      }),
    );

    vResult.warnings.forEach((warning) =>
      warnings.push({
        ruleCode: 'FILE_WARNING_GALLERY_IMAGE',
        message: `${file.fileName} warning: ${warning}`,
        fieldName: 'galleryImages',
      }),
    );
  }

  // 4. Gallery image alt text.
  //
  // project-details.xlsx is authoritative for gallery accessibility metadata.
  // Every supplied gallery image must match exactly one alt-text position.
  //
  // Backwards compatibility:
  // - snapshotAltText remains the legacy position-1 representation.
  // - When galleryAltTexts does not explicitly contain position 1, a usable
  //   snapshotAltText may satisfy position 1.
  // - Existing Task 2 rule codes remain in use for position 1.
  // - Positions 2+ use the new gallery-specific rule codes.

  const explicitGalleryAltTexts = Array.isArray(manifest.galleryAltTexts)
    ? manifest.galleryAltTexts
    : [];

  const legacySnapshotAltText =
    typeof manifest.snapshotAltText === 'string'
      ? manifest.snapshotAltText
      : null;

  const hasGalleryImageAtPositionOne = parsed.galleryImages.some(
    (item) => item.position === 1,
  );

  const hasExplicitPositionOne = explicitGalleryAltTexts.some(
    (item) => item.position === 1,
  );

  const useLegacyPositionOneFallback =
    !hasExplicitPositionOne &&
    hasGalleryImageAtPositionOne &&
    legacySnapshotAltText !== null &&
    legacySnapshotAltText.trim() !== '';

  const galleryAltTexts = [
    ...explicitGalleryAltTexts,
    ...(useLegacyPositionOneFallback
      ? [
          {
            position: 1,
            altText: legacySnapshotAltText,
          },
        ]
      : []),
  ];

  const galleryImagePositions = new Set(
    parsed.galleryImages.map((item) => item.position),
  );

  const seenAltPositions = new Set<number>();

  for (const item of galleryAltTexts) {
    const position = item.position;

    if (
      !Number.isInteger(position) ||
      position < 1 ||
      position > MAX_GALLERY_IMAGES
    ) {
      errors.push({
        ruleCode: 'METADATA_GALLERY_ALT_POSITION_OUT_OF_RANGE',
        message: `Gallery alt text position ${position} is outside the supported range 1-${MAX_GALLERY_IMAGES}.`,
        fieldName: 'galleryAltTexts',
      });

      continue;
    }

    if (seenAltPositions.has(position)) {
      errors.push({
        ruleCode: 'METADATA_DUPLICATE_GALLERY_ALT_POSITION',
        message: `Multiple gallery alt text entries use position ${position}. Each gallery position must have exactly one alt text.`,
        fieldName: 'galleryAltTexts',
      });
    } else {
      seenAltPositions.add(position);
    }

    const altText =
      typeof item.altText === 'string'
        ? item.altText.trim()
        : '';

    if (altText === '') {
      errors.push({
        ruleCode: 'METADATA_EMPTY_GALLERY_ALT_TEXT',
        message: `Gallery image alt text at position ${position} is empty.`,
        fieldName: 'galleryAltTexts',
      });
    } else if (
      altText.length >
      ACCESSIBLE_CONTENT_LIMITS.snapshotAltText
    ) {
      if (position === 1) {
        // Preserve the existing Task 2 contract/rule code for snapshot 1.
        errors.push({
          ruleCode: 'METADATA_SNAPSHOT_ALT_TEXT_TOO_LONG',
          message: `Manifest field "snapshotAltText" exceeds the maximum of ${ACCESSIBLE_CONTENT_LIMITS.snapshotAltText} characters.`,
          fieldName: 'snapshotAltText',
        });
      } else {
        errors.push({
          ruleCode: 'METADATA_GALLERY_ALT_TEXT_TOO_LONG',
          message: `Gallery alt text at position ${position} exceeds the maximum of ${ACCESSIBLE_CONTENT_LIMITS.snapshotAltText} characters.`,
          fieldName: 'galleryAltTexts',
        });
      }
    }

    if (!galleryImagePositions.has(position)) {
      errors.push({
        ruleCode: 'METADATA_UNMATCHED_GALLERY_ALT_TEXT',
        message: `Gallery alt text exists for position ${position}, but no gallery image exists at that position.`,
        fieldName: 'galleryAltTexts',
      });
    }
  }

  // XLSX packages require one authoritative alt entry for every supplied image.
  if (options.metadataSource === 'xlsx') {
    for (const galleryImage of parsed.galleryImages) {
      const matchingAltTexts = galleryAltTexts.filter(
        (item) => item.position === galleryImage.position,
      );

      if (matchingAltTexts.length === 0) {
        if (galleryImage.position === 1) {
          // Preserve Task 2 compatibility.
          errors.push({
            ruleCode: 'METADATA_MISSING_SNAPSHOT_ALT_TEXT',
            message:
              'Required manifest field "snapshotAltText" is missing or empty. A package that includes snapshot-1.png must describe it.',
            fieldName: 'snapshotAltText',
          });
        } else {
          errors.push({
            ruleCode: 'METADATA_MISSING_GALLERY_ALT_TEXT',
            message: `Gallery image "${galleryImage.file.fileName}" at position ${galleryImage.position} is missing its required alt text.`,
            fieldName: 'galleryAltTexts',
          });
        }
      }
    }
  }

  // Legacy snapshotAltText was historically bounded regardless of whether
  // snapshot-1 existed. Preserve that behavior. If position 1 used the legacy
  // fallback above, the same value was already checked in the gallery loop.
  if (
    !useLegacyPositionOneFallback &&
    legacySnapshotAltText !== null &&
    legacySnapshotAltText.length >
      ACCESSIBLE_CONTENT_LIMITS.snapshotAltText
  ) {
    errors.push({
      ruleCode: 'METADATA_SNAPSHOT_ALT_TEXT_TOO_LONG',
      message: `Manifest field "snapshotAltText" exceeds the maximum of ${ACCESSIBLE_CONTENT_LIMITS.snapshotAltText} characters.`,
      fieldName: 'snapshotAltText',
    });
  }
  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}
