import { describe, it, expect } from 'vitest';
import { validateFormIntake } from '../formIntakeValidation';
import {
  createInitialFormIntakeMetadata,
  createInitialFormIntakeMediaState,
  FormIntakeMetadata,
  FormIntakeMediaState,
} from '../formIntakeContract';
import { ACCESSIBLE_CONTENT_LIMITS } from '../../domain/accessibleContent';

function createValidMetadata(): FormIntakeMetadata {
  return {
    ...createInitialFormIntakeMetadata(),
    publicId: 'autonomous-rover-2026',
    title: 'Autonomous Rover Navigation',
    summary: 'A project that explores rover traversal.',
    program: 'Bachelor of Engineering',
    discipline: 'Robotics',
    year: '2026',
    groupName: 'Rover Dynamics',
    teamMembers: 'Alice Smith\nBob Jones',
    posterText: 'Full transcription of rover research findings.',
    accessibilityText: 'Poster showcasing rover schematics.',
  };
}

function createValidMediaState(): FormIntakeMediaState {
  const media = createInitialFormIntakeMediaState();
  media.posterImage = new File(['fake-png-content'], 'poster.png', { type: 'image/png' });
  media.posterPdf = new File(['fake-pdf-content'], 'poster.pdf', { type: 'application/pdf' });
  return media;
}

describe('formIntakeValidation', () => {
  it('passes when all required metadata and media are valid (no gallery images)', () => {
    const metadata = createValidMetadata();
    const media = createValidMediaState();

    const result = validateFormIntake(metadata, media);
    expect(result.valid).toBe(true);
    expect(result.errorSummary).toHaveLength(0);
    expect(result.errors).toEqual({});
  });

  it('fails when mandatory text fields are missing', () => {
    const metadata = createInitialFormIntakeMetadata();
    const media = createValidMediaState();

    const result = validateFormIntake(metadata, media);
    expect(result.valid).toBe(false);
    expect(result.errors.publicId).toBeDefined();
    expect(result.errors.title).toBeDefined();
    expect(result.errors.summary).toBeDefined();
    expect(result.errors.program).toBeDefined();
    expect(result.errors.discipline).toBeDefined();
    expect(result.errors.groupName).toBeDefined();
    expect(result.errors.teamMembers).toBeDefined();
    expect(result.errors.posterText).toBeDefined();
    expect(result.errors.accessibilityText).toBeDefined();
  });

  it('fails when publicId has invalid format', () => {
    const metadata = createValidMetadata();
    metadata.publicId = 'Invalid Public ID with Spaces!';
    const media = createValidMediaState();

    const result = validateFormIntake(metadata, media);
    expect(result.valid).toBe(false);
    expect(result.errors.publicId).toContain('lowercase alphanumeric');
  });

  it('fails when year is not a 4-digit number', () => {
    const metadata = createValidMetadata();
    metadata.year = '26';
    const media = createValidMediaState();

    const result = validateFormIntake(metadata, media);
    expect(result.valid).toBe(false);
    expect(result.errors.year).toContain('4-digit year');
  });

  it('fails when required poster image or poster PDF is missing', () => {
    const metadata = createValidMetadata();
    const media = createInitialFormIntakeMediaState();

    const result = validateFormIntake(metadata, media);
    expect(result.valid).toBe(false);
    expect(result.errors.posterImage).toBeDefined();
    expect(result.errors.posterPdf).toBeDefined();
  });

  it('validates URLs and participant email when supplied', () => {
    const metadata = createValidMetadata();
    metadata.videoUrl = 'javascript:alert(1)';
    metadata.participantContactEmail = 'invalid-email';
    const media = createValidMediaState();

    const result = validateFormIntake(metadata, media);
    expect(result.valid).toBe(false);
    expect(result.errors.videoUrl).toBeDefined();
    expect(result.errors.participantContactEmail).toBeDefined();
  });

  describe('MG-05 Gallery Text-Equivalent Contracts', () => {
    it('passes for a valid ordinary gallery image (alt text present, ordinary classification, no full text)', () => {
      const metadata = createValidMetadata();
      const media = createValidMediaState();
      media.galleryImages[0].file = new File(['fake-img'], 'snapshot-1.png', { type: 'image/png' });
      media.galleryImages[0].altText = 'A team photo in the robotics lab';
      media.galleryImages[0].contentKind = 'ordinary';
      media.galleryImages[0].fullText = '';

      const result = validateFormIntake(metadata, media);
      expect(result.valid).toBe(true);
      expect(result.errors[`galleryImage_1`]).toBeUndefined();
      expect(result.errors[`galleryAlt_1`]).toBeUndefined();
      expect(result.errors[`galleryContentKind_1`]).toBeUndefined();
      expect(result.errors[`galleryFullText_1`]).toBeUndefined();
    });

    it('rejects an ordinary gallery image that carries unexpected full text', () => {
      const metadata = createValidMetadata();
      const media = createValidMediaState();
      media.galleryImages[0].file = new File(['fake-img'], 'snapshot-1.png', { type: 'image/png' });
      media.galleryImages[0].altText = 'A team photo in the robotics lab';
      media.galleryImages[0].contentKind = 'ordinary';
      media.galleryImages[0].fullText = 'Unexpected full transcription text here';

      const result = validateFormIntake(metadata, media);
      expect(result.valid).toBe(false);
      expect(result.errors[`galleryFullText_1`]).toContain('must not carry full text');
    });

    it('passes for a valid text-bearing gallery image (alt text present, text_bearing classification, full text present)', () => {
      const metadata = createValidMetadata();
      const media = createValidMediaState();
      media.galleryImages[1].file = new File(['fake-img'], 'chart.png', { type: 'image/png' });
      media.galleryImages[1].altText = 'System architecture diagram';
      media.galleryImages[1].contentKind = 'text_bearing';
      media.galleryImages[1].fullText = 'Architecture block diagram: Sensors -> MCU -> Actuators';

      const result = validateFormIntake(metadata, media);
      expect(result.valid).toBe(true);
      expect(result.errors[`galleryImage_2`]).toBeUndefined();
      expect(result.errors[`galleryAlt_2`]).toBeUndefined();
      expect(result.errors[`galleryContentKind_2`]).toBeUndefined();
      expect(result.errors[`galleryFullText_2`]).toBeUndefined();
    });

    it('rejects a text-bearing gallery image missing full text', () => {
      const metadata = createValidMetadata();
      const media = createValidMediaState();
      media.galleryImages[1].file = new File(['fake-img'], 'chart.png', { type: 'image/png' });
      media.galleryImages[1].altText = 'System architecture diagram';
      media.galleryImages[1].contentKind = 'text_bearing';
      media.galleryImages[1].fullText = '   ';

      const result = validateFormIntake(metadata, media);
      expect(result.valid).toBe(false);
      expect(result.errors[`galleryFullText_2`]).toContain('Full textual equivalent is required');
    });

    it('rejects a gallery image missing content classification', () => {
      const metadata = createValidMetadata();
      const media = createValidMediaState();
      media.galleryImages[0].file = new File(['fake-img'], 'snapshot-1.png', { type: 'image/png' });
      media.galleryImages[0].altText = 'A team photo';
      media.galleryImages[0].contentKind = '';
      media.galleryImages[0].fullText = '';

      const result = validateFormIntake(metadata, media);
      expect(result.valid).toBe(false);
      expect(result.errors[`galleryContentKind_1`]).toContain('Content classification is required');
    });

    it('rejects a gallery image missing alt text', () => {
      const metadata = createValidMetadata();
      const media = createValidMediaState();
      media.galleryImages[0].file = new File(['fake-img'], 'snapshot-1.png', { type: 'image/png' });
      media.galleryImages[0].altText = '  ';
      media.galleryImages[0].contentKind = 'ordinary';

      const result = validateFormIntake(metadata, media);
      expect(result.valid).toBe(false);
      expect(result.errors[`galleryAlt_1`]).toContain('Alt text is required');
    });

    it('rejects full text exceeding technical limit', () => {
      const metadata = createValidMetadata();
      const media = createValidMediaState();
      media.galleryImages[2].file = new File(['fake-img'], 'slide.png', { type: 'image/png' });
      media.galleryImages[2].altText = 'Slide overview';
      media.galleryImages[2].contentKind = 'text_bearing';
      media.galleryImages[2].fullText = 'x'.repeat(ACCESSIBLE_CONTENT_LIMITS.snapshotFullText + 10);

      const result = validateFormIntake(metadata, media);
      expect(result.valid).toBe(false);
      expect(result.errors[`galleryFullText_3`]).toContain('exceeds');
    });

    it('rejects gallery accessibility metadata entered without selecting an image file', () => {
      const metadata = createValidMetadata();
      const media = createValidMediaState();
      media.galleryImages[4].file = null;
      media.galleryImages[4].altText = 'Description with no image';

      const result = validateFormIntake(metadata, media);
      expect(result.valid).toBe(false);
      expect(result.errors[`galleryImage_5`]).toContain('Gallery image is missing');
    });
  });
});
