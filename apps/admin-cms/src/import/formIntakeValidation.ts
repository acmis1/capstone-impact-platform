import { validateFolderDerivedPublicId } from './publicIdValidation';
import { validateParticipantContactEmail } from '../domain/participantContactEmail';
import { validateProjectControlledUrl } from '../domain/projectControlledUrl';
import { ACCESSIBLE_CONTENT_LIMITS } from '../domain/accessibleContent';
import { isSnapshotImageContentKind } from '../domain/galleryTextEquivalent';
import { MEDIA_VALIDATION_LIMITS } from '../storage/mediaValidationSharedContract';
import type { FormIntakeMetadata, FormIntakeMediaState } from './formIntakeContract';

export interface FormIntakeValidationResult {
  valid: boolean;
  errors: Record<string, string>;
  errorSummary: Array<{ fieldName: string; message: string }>;
}

const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/**
 * Pure client-side validation function for the project intake form.
 * Ensures field-level errors and summary messages align with server-side rules
 * and MG-05 gallery text-equivalent contracts.
 */
export function validateFormIntake(
  metadata: FormIntakeMetadata,
  media: FormIntakeMediaState
): FormIntakeValidationResult {
  const errors: Record<string, string> = {};

  // 1. Project Identifier / Public ID
  if (!metadata.publicId || metadata.publicId.trim() === '') {
    errors.publicId = 'Project identifier is required.';
  } else {
    const publicIdRes = validateFolderDerivedPublicId(metadata.publicId.trim());
    if (!publicIdRes.valid) {
      errors.publicId =
        publicIdRes.message ||
        'Project identifier must contain only lowercase alphanumeric characters and single hyphens.';
    }
  }

  // 2. Title
  if (!metadata.title || metadata.title.trim() === '') {
    errors.title = 'Project title is required.';
  }

  // 3. Short Summary
  if (!metadata.summary || metadata.summary.trim() === '') {
    errors.summary = 'Short public summary is required.';
  }

  // 4. Project Year
  if (!metadata.year || metadata.year.trim() === '') {
    errors.year = 'Project year is required.';
  } else if (!/^\d{4}$/.test(metadata.year.trim())) {
    errors.year = 'Project year must be a 4-digit year (e.g. 2026).';
  }

  // 5. Study Program
  if (!metadata.program || metadata.program.trim() === '') {
    errors.program = 'Study program is required.';
  }

  // 6. Primary Discipline
  if (!metadata.discipline || metadata.discipline.trim() === '') {
    errors.discipline = 'Primary discipline is required.';
  }

  // 7. Group Name
  if (!metadata.groupName || metadata.groupName.trim() === '') {
    errors.groupName = 'Group name is required.';
  }

  // 8. Team Members
  const memberList = (metadata.teamMembers || '')
    .split(/[\n,]/)
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
  if (memberList.length === 0) {
    errors.teamMembers = 'At least one team member is required.';
  }

  // 9. Participant Contact Email (Optional)
  if (
    metadata.participantContactEmail &&
    metadata.participantContactEmail.trim() !== ''
  ) {
    const emailRes = validateParticipantContactEmail(
      metadata.participantContactEmail.trim()
    );
    if (!emailRes.valid) {
      errors.participantContactEmail = 'Participant contact email is invalid.';
    }
  }

  // 10. Poster Full Text
  if (!metadata.posterText || metadata.posterText.trim() === '') {
    errors.posterText = 'Poster full text is required.';
  } else if (
    metadata.posterText.trim().length > ACCESSIBLE_CONTENT_LIMITS.posterText
  ) {
    errors.posterText = `Poster full text exceeds the maximum of ${ACCESSIBLE_CONTENT_LIMITS.posterText.toLocaleString()} characters.`;
  }

  // 11. Accessibility Description
  if (!metadata.accessibilityText || metadata.accessibilityText.trim() === '') {
    errors.accessibilityText = 'Accessibility description is required.';
  } else if (
    metadata.accessibilityText.trim().length >
    ACCESSIBLE_CONTENT_LIMITS.accessibilityText
  ) {
    errors.accessibilityText = `Accessibility description exceeds the maximum of ${ACCESSIBLE_CONTENT_LIMITS.accessibilityText.toLocaleString()} characters.`;
  }

  // 12. Optional URLs
  if (metadata.videoUrl && metadata.videoUrl.trim() !== '') {
    const urlRes = validateProjectControlledUrl(metadata.videoUrl.trim());
    if (!urlRes.valid) {
      errors.videoUrl =
        'Project video URL must be a valid HTTP or HTTPS address without credentials.';
    }
  }

  if (metadata.demoUrl && metadata.demoUrl.trim() !== '') {
    const urlRes = validateProjectControlledUrl(metadata.demoUrl.trim());
    if (!urlRes.valid) {
      errors.demoUrl =
        'Live demo URL must be a valid HTTP or HTTPS address without credentials.';
    }
  }

  if (metadata.repositoryUrl && metadata.repositoryUrl.trim() !== '') {
    const urlRes = validateProjectControlledUrl(metadata.repositoryUrl.trim());
    if (!urlRes.valid) {
      errors.repositoryUrl =
        'Source repository URL must be a valid HTTP or HTTPS address without credentials.';
    }
  }

  // 13. Required Poster Image
  if (!media.posterImage) {
    errors.posterImage = 'Required poster image (PNG) is missing.';
  } else {
    if (media.posterImage.size <= 0) {
      errors.posterImage = 'Poster image file is empty.';
    } else if (
      media.posterImage.size > MEDIA_VALIDATION_LIMITS.MAX_IMAGE_SIZE_BYTES
    ) {
      errors.posterImage = `Poster image size [${(media.posterImage.size / (1024 * 1024)).toFixed(2)} MB] exceeds 5 MB limit.`;
    } else if (
      (media.posterImage.type && media.posterImage.type !== 'image/png') ||
      (media.posterImage.name && !media.posterImage.name.toLowerCase().endsWith('.png'))
    ) {
      errors.posterImage = 'Poster image must be a PNG file (.png).';
    }
  }

  // 14. Required Poster PDF
  if (!media.posterPdf) {
    errors.posterPdf = 'Required poster PDF is missing.';
  } else {
    if (media.posterPdf.size <= 0) {
      errors.posterPdf = 'Poster PDF file is empty.';
    } else if (
      media.posterPdf.size > MEDIA_VALIDATION_LIMITS.MAX_PDF_SIZE_BYTES
    ) {
      errors.posterPdf = `Poster PDF size [${(media.posterPdf.size / (1024 * 1024)).toFixed(2)} MB] exceeds 20 MB limit.`;
    } else if (
      media.posterPdf.type &&
      media.posterPdf.type !== 'application/pdf'
    ) {
      errors.posterPdf = 'Poster PDF must be a PDF document.';
    }
  }

  // 15. Gallery Snapshots & MG-05 Accessibility Contracts
  for (const item of media.galleryImages) {
    const pos = item.position;
    const hasImage = Boolean(item.file);
    const hasAlt = Boolean(item.altText && item.altText.trim() !== '');
    const hasKind = Boolean(item.contentKind && item.contentKind.trim() !== '');
    const hasFullText = Boolean(item.fullText && item.fullText.trim() !== '');

    if (hasImage && item.file) {
      if (item.file.size <= 0) {
        errors[`galleryImage_${pos}`] = `Gallery image at position ${pos} is empty.`;
      } else if (
        item.file.size > MEDIA_VALIDATION_LIMITS.MAX_IMAGE_SIZE_BYTES
      ) {
        errors[`galleryImage_${pos}`] = `Gallery image at position ${pos} exceeds 5 MB limit.`;
      } else if (
        item.file.type &&
        !ALLOWED_IMAGE_TYPES.has(item.file.type)
      ) {
        errors[`galleryImage_${pos}`] = `Gallery image at position ${pos} must be PNG, JPEG, or WEBP.`;
      }

      // Alt text check
      if (!hasAlt) {
        errors[`galleryAlt_${pos}`] = `Alt text is required for gallery image at position ${pos}.`;
      } else if (
        item.altText.trim().length > ACCESSIBLE_CONTENT_LIMITS.snapshotAltText
      ) {
        errors[`galleryAlt_${pos}`] = `Alt text at position ${pos} exceeds ${ACCESSIBLE_CONTENT_LIMITS.snapshotAltText.toLocaleString()} character limit.`;
      }

      // Classification & Full-Text Text-Equivalent check
      if (!hasKind || !isSnapshotImageContentKind(item.contentKind)) {
        errors[`galleryContentKind_${pos}`] = `Content classification is required for gallery image at position ${pos}. Declare it as an ordinary image or a text-bearing image.`;
      } else if (item.contentKind === 'ordinary') {
        if (hasFullText) {
          errors[`galleryFullText_${pos}`] = `Ordinary gallery image at position ${pos} must not carry full text. Remove full text or classify as text-bearing.`;
        }
      } else if (item.contentKind === 'text_bearing') {
        if (!hasFullText) {
          errors[`galleryFullText_${pos}`] = `Full textual equivalent is required for text-bearing gallery image at position ${pos}.`;
        } else if (
          item.fullText.trim().length > ACCESSIBLE_CONTENT_LIMITS.snapshotFullText
        ) {
          errors[`galleryFullText_${pos}`] = `Full text at position ${pos} exceeds ${ACCESSIBLE_CONTENT_LIMITS.snapshotFullText.toLocaleString()} character limit.`;
        }
      }
    } else if (hasAlt || hasKind || hasFullText) {
      errors[`galleryImage_${pos}`] = `Gallery image is missing for provided accessibility metadata at position ${pos}.`;
    }
  }

  const errorSummary = Object.entries(errors).map(([fieldName, message]) => ({
    fieldName,
    message,
  }));

  return {
    valid: errorSummary.length === 0,
    errors,
    errorSummary,
  };
}
