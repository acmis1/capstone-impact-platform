import { z } from 'zod';
import { MAX_GALLERY_IMAGES } from './galleryConvention';
import { ACCESSIBLE_CONTENT_LIMITS } from '../domain/accessibleContent';
import { PROJECT_CONTROLLED_URL_MAX_LENGTH } from '../domain/projectControlledUrl';
import { MAX_PARTICIPANT_CONTACT_EMAIL_LENGTH } from '../domain/participantContactEmail';
import type { SnapshotImageContentKind } from '../domain/galleryTextEquivalent';

/**
 * Metadata fields captured by the standardized project intake form.
 * Directly maps to canonical columns in project-details.xlsx.
 */
export interface FormIntakeMetadata {
  publicId: string;
  title: string;
  summary: string;
  background?: string;
  solution?: string;
  teamMembers: string; // One per line or comma-separated
  groupName: string;
  participantContactEmail?: string;
  academicSupervisor?: string;
  industryPartner?: string;
  industry?: string;
  program: string;
  discipline: string;
  year: string;
  templateId?: string; // 'poster_showcase' | 'technical_detail' | 'media_rich'
  featuredMedia?: string; // 'poster' | 'snapshots' | 'video'
  posterText: string;
  accessibilityText: string;
  videoUrl?: string;
  demoUrl?: string;
  repositoryUrl?: string;
  snapshotAltText?: string;
  snapshot2AltText?: string;
  snapshot3AltText?: string;
  snapshot4AltText?: string;
  snapshot5AltText?: string;
  snapshot6AltText?: string;
  snapshot7AltText?: string;
  snapshot8AltText?: string;
  snapshot9AltText?: string;
  snapshot10AltText?: string;
  snapshot1ContentKind?: string;
  snapshot2ContentKind?: string;
  snapshot3ContentKind?: string;
  snapshot4ContentKind?: string;
  snapshot5ContentKind?: string;
  snapshot6ContentKind?: string;
  snapshot7ContentKind?: string;
  snapshot8ContentKind?: string;
  snapshot9ContentKind?: string;
  snapshot10ContentKind?: string;
  snapshot1FullText?: string;
  snapshot2FullText?: string;
  snapshot3FullText?: string;
  snapshot4FullText?: string;
  snapshot5FullText?: string;
  snapshot6FullText?: string;
  snapshot7FullText?: string;
  snapshot8FullText?: string;
  snapshot9FullText?: string;
  snapshot10FullText?: string;
}

/**
 * Client-side media files and accessibility metadata associated with the form intake.
 */
export interface FormIntakeGalleryItem {
  position: number;
  file: File | null;
  altText: string;
  contentKind: SnapshotImageContentKind | '';
  fullText: string;
}

export interface FormIntakeMediaState {
  posterImage: File | null;
  posterPdf: File | null;
  galleryImages: FormIntakeGalleryItem[];
}

/**
 * Initial empty metadata state for the intake form.
 */
export function createInitialFormIntakeMetadata(): FormIntakeMetadata {
  return {
    publicId: '',
    title: '',
    summary: '',
    background: '',
    solution: '',
    teamMembers: '',
    groupName: '',
    participantContactEmail: '',
    academicSupervisor: '',
    industryPartner: '',
    industry: '',
    program: '',
    discipline: '',
    year: new Date().getFullYear().toString(),
    templateId: 'poster_showcase',
    featuredMedia: 'poster',
    posterText: '',
    accessibilityText: '',
    videoUrl: '',
    demoUrl: '',
    repositoryUrl: '',
    snapshotAltText: '',
    snapshot2AltText: '',
    snapshot3AltText: '',
    snapshot4AltText: '',
    snapshot5AltText: '',
    snapshot6AltText: '',
    snapshot7AltText: '',
    snapshot8AltText: '',
    snapshot9AltText: '',
    snapshot10AltText: '',
    snapshot1ContentKind: '',
    snapshot2ContentKind: '',
    snapshot3ContentKind: '',
    snapshot4ContentKind: '',
    snapshot5ContentKind: '',
    snapshot6ContentKind: '',
    snapshot7ContentKind: '',
    snapshot8ContentKind: '',
    snapshot9ContentKind: '',
    snapshot10ContentKind: '',
    snapshot1FullText: '',
    snapshot2FullText: '',
    snapshot3FullText: '',
    snapshot4FullText: '',
    snapshot5FullText: '',
    snapshot6FullText: '',
    snapshot7FullText: '',
    snapshot8FullText: '',
    snapshot9FullText: '',
    snapshot10FullText: '',
  };
}

/**
 * Initial empty media state for the intake form.
 */
export function createInitialFormIntakeMediaState(): FormIntakeMediaState {
  const galleryImages: FormIntakeGalleryItem[] = [];
  for (let pos = 1; pos <= MAX_GALLERY_IMAGES; pos++) {
    galleryImages.push({
      position: pos,
      file: null,
      altText: '',
      contentKind: '',
      fullText: '',
    });
  }
  return {
    posterImage: null,
    posterPdf: null,
    galleryImages,
  };
}

/**
 * Strict Zod schema for server-side payload validation when materializing the workbook.
 */
export const formIntakeMetadataSchema = z.object({
  publicId: z.string().min(1).max(100),
  title: z.string().min(1).max(500),
  summary: z.string().min(1).max(2000),
  background: z.string().max(5000).optional().default(''),
  solution: z.string().max(5000).optional().default(''),
  teamMembers: z.string().min(1).max(2000),
  groupName: z.string().min(1).max(200),
  participantContactEmail: z.string().max(MAX_PARTICIPANT_CONTACT_EMAIL_LENGTH).optional().default(''),
  academicSupervisor: z.string().max(200).optional().default(''),
  industryPartner: z.string().max(200).optional().default(''),
  industry: z.string().max(200).optional().default(''),
  program: z.string().min(1).max(200),
  discipline: z.string().min(1).max(200),
  year: z.string().min(1).max(10),
  templateId: z.string().max(50).optional().default('poster_showcase'),
  featuredMedia: z.string().max(50).optional().default('poster'),
  posterText: z.string().min(1).max(ACCESSIBLE_CONTENT_LIMITS.posterText),
  accessibilityText: z.string().min(1).max(ACCESSIBLE_CONTENT_LIMITS.accessibilityText),
  videoUrl: z.string().max(PROJECT_CONTROLLED_URL_MAX_LENGTH).optional().default(''),
  demoUrl: z.string().max(PROJECT_CONTROLLED_URL_MAX_LENGTH).optional().default(''),
  repositoryUrl: z.string().max(PROJECT_CONTROLLED_URL_MAX_LENGTH).optional().default(''),
  snapshotAltText: z.string().max(ACCESSIBLE_CONTENT_LIMITS.snapshotAltText).optional().default(''),
  snapshot2AltText: z.string().max(ACCESSIBLE_CONTENT_LIMITS.snapshotAltText).optional().default(''),
  snapshot3AltText: z.string().max(ACCESSIBLE_CONTENT_LIMITS.snapshotAltText).optional().default(''),
  snapshot4AltText: z.string().max(ACCESSIBLE_CONTENT_LIMITS.snapshotAltText).optional().default(''),
  snapshot5AltText: z.string().max(ACCESSIBLE_CONTENT_LIMITS.snapshotAltText).optional().default(''),
  snapshot6AltText: z.string().max(ACCESSIBLE_CONTENT_LIMITS.snapshotAltText).optional().default(''),
  snapshot7AltText: z.string().max(ACCESSIBLE_CONTENT_LIMITS.snapshotAltText).optional().default(''),
  snapshot8AltText: z.string().max(ACCESSIBLE_CONTENT_LIMITS.snapshotAltText).optional().default(''),
  snapshot9AltText: z.string().max(ACCESSIBLE_CONTENT_LIMITS.snapshotAltText).optional().default(''),
  snapshot10AltText: z.string().max(ACCESSIBLE_CONTENT_LIMITS.snapshotAltText).optional().default(''),
  snapshot1ContentKind: z.string().max(50).optional().default(''),
  snapshot2ContentKind: z.string().max(50).optional().default(''),
  snapshot3ContentKind: z.string().max(50).optional().default(''),
  snapshot4ContentKind: z.string().max(50).optional().default(''),
  snapshot5ContentKind: z.string().max(50).optional().default(''),
  snapshot6ContentKind: z.string().max(50).optional().default(''),
  snapshot7ContentKind: z.string().max(50).optional().default(''),
  snapshot8ContentKind: z.string().max(50).optional().default(''),
  snapshot9ContentKind: z.string().max(50).optional().default(''),
  snapshot10ContentKind: z.string().max(50).optional().default(''),
  snapshot1FullText: z.string().max(ACCESSIBLE_CONTENT_LIMITS.snapshotFullText).optional().default(''),
  snapshot2FullText: z.string().max(ACCESSIBLE_CONTENT_LIMITS.snapshotFullText).optional().default(''),
  snapshot3FullText: z.string().max(ACCESSIBLE_CONTENT_LIMITS.snapshotFullText).optional().default(''),
  snapshot4FullText: z.string().max(ACCESSIBLE_CONTENT_LIMITS.snapshotFullText).optional().default(''),
  snapshot5FullText: z.string().max(ACCESSIBLE_CONTENT_LIMITS.snapshotFullText).optional().default(''),
  snapshot6FullText: z.string().max(ACCESSIBLE_CONTENT_LIMITS.snapshotFullText).optional().default(''),
  snapshot7FullText: z.string().max(ACCESSIBLE_CONTENT_LIMITS.snapshotFullText).optional().default(''),
  snapshot8FullText: z.string().max(ACCESSIBLE_CONTENT_LIMITS.snapshotFullText).optional().default(''),
  snapshot9FullText: z.string().max(ACCESSIBLE_CONTENT_LIMITS.snapshotFullText).optional().default(''),
  snapshot10FullText: z.string().max(ACCESSIBLE_CONTENT_LIMITS.snapshotFullText).optional().default(''),
});
