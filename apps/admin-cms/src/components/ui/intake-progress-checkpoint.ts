import { z } from 'zod';
import { ACCESSIBLE_CONTENT_LIMITS } from '../../domain/accessibleContent';
import type { FormIntakeMediaState, FormIntakeMetadata } from '../../import/formIntakeContract';
import type { AdminReferenceMappingConfig } from '../../import/adminReferenceSharedContract';

export const INTAKE_CHECKPOINT_VERSION = 1 as const;
// Bounded to support representative annual package manifests, never file bytes.
export const MAX_INTAKE_CHECKPOINT_BYTES = 512 * 1024;
const MAX_CHECKPOINT_TEXT = ACCESSIBLE_CONTENT_LIMITS.posterText;
const MAX_CHECKPOINT_NAME = 260;

const safeText = z.string().max(MAX_CHECKPOINT_TEXT);
const safeName = z.string().min(1).max(MAX_CHECKPOINT_NAME);
const mappingEntry = z.object({
  canonicalField: z.string().min(1).max(50),
  referenceColumn: z.string().min(1).max(100),
}).strict();
const mappingConfig = z.object({
  worksheet: z.string().min(1).max(100),
  matchMappings: z.array(mappingEntry).min(1).max(3),
  comparisonMappings: z.array(mappingEntry).min(1).max(20),
  reconciliationContractVersion: z.literal('admin-reference-reconciliation-v1'),
}).strict();

const safeManualMetadata = z.object({
  publicId: safeText.optional(),
  title: safeText.optional(),
  summary: safeText.optional(),
  background: safeText.optional(),
  solution: safeText.optional(),
  groupName: safeText.optional(),
  industry: safeText.optional(),
  program: safeText.optional(),
  discipline: safeText.optional(),
  year: safeText.optional(),
  templateId: safeText.optional(),
  featuredMedia: safeText.optional(),
  sectionOrder: safeText.optional(),
  hiddenSections: safeText.optional(),
  posterText: safeText.optional(),
  accessibilityText: safeText.optional(),
  videoUrl: safeText.optional(),
  demoUrl: safeText.optional(),
  repositoryUrl: safeText.optional(),
}).strict();
type SafeManualMetadata = z.infer<typeof safeManualMetadata>;

const galleryEntry = z.object({
  position: z.number().int().min(1).max(10),
  fileName: safeName.optional(),
  altText: safeText,
  contentKind: z.enum(['', 'ordinary', 'text_bearing']),
  fullText: safeText,
}).strict();

const manualCheckpoint = z.object({
  version: z.literal(INTAKE_CHECKPOINT_VERSION),
  kind: z.literal('manual-form'),
  warning: z.literal('Contains project information. Files and validation results are not included.'),
  createdAt: z.string().datetime(),
  metadata: safeManualMetadata,
  media: z.object({
    posterImageName: safeName.optional(),
    posterPdfName: safeName.optional(),
    galleryImages: z.array(galleryEntry).max(10).refine(items => new Set(items.map(item => item.position)).size === items.length, 'Gallery positions must be unique.'),
  }).strict(),
  visibleGalleryCount: z.number().int().min(1).max(10),
}).strict();

const packageCheckpoint = z.object({
  version: z.literal(INTAKE_CHECKPOINT_VERSION),
  kind: z.literal('package-selection'),
  warning: z.literal('Contains project information. Files and validation results are not included.'),
  createdAt: z.string().datetime(),
  selectedRootName: safeName.optional(),
  selectedFileNames: z.array(safeName).max(2500),
  selectedPackagePaths: z.array(safeName).max(2500),
  referenceFileName: safeName.optional(),
  referenceMapping: mappingConfig.optional(),
}).strict();

export const intakeProgressCheckpointSchema = z.discriminatedUnion('kind', [manualCheckpoint, packageCheckpoint]);
export type IntakeProgressCheckpoint = z.infer<typeof intakeProgressCheckpointSchema>;

const CHECKPOINT_WARNING = 'Contains project information. Files and validation results are not included.' as const;

function boundedJsonBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string') throw new Error('The checkpoint format is unsupported or malformed.');
  return new TextEncoder().encode(serialized).byteLength;
}

function enforceBound(value: unknown): void {
  if (boundedJsonBytes(value) > MAX_INTAKE_CHECKPOINT_BYTES) throw new Error('The checkpoint file is too large.');
}

function safeManualMetadataFrom(metadata: FormIntakeMetadata): SafeManualMetadata {
  const keys = [
    'publicId', 'title', 'summary', 'background', 'solution', 'groupName', 'industry', 'program',
    'discipline', 'year', 'templateId', 'featuredMedia', 'sectionOrder', 'hiddenSections',
    'posterText', 'accessibilityText', 'videoUrl', 'demoUrl', 'repositoryUrl',
  ] as const;
  return Object.fromEntries(keys.flatMap((key) => {
    const value = metadata[key];
    return typeof value === 'string' ? [[key, value]] : [];
  })) as SafeManualMetadata;
}

export function createManualIntakeCheckpoint(
  metadata: FormIntakeMetadata,
  media: FormIntakeMediaState,
  visibleGalleryCount: number,
): IntakeProgressCheckpoint {
  const checkpoint = {
    version: INTAKE_CHECKPOINT_VERSION,
    kind: 'manual-form' as const,
    warning: CHECKPOINT_WARNING,
    createdAt: new Date().toISOString(),
    metadata: safeManualMetadataFrom(metadata),
    media: {
      ...(media.posterImage ? { posterImageName: media.posterImage.name } : {}),
      ...(media.posterPdf ? { posterPdfName: media.posterPdf.name } : {}),
      galleryImages: media.galleryImages.map((item) => ({
        position: item.position,
        ...(item.file ? { fileName: item.file.name } : {}),
        altText: item.altText,
        contentKind: item.contentKind,
        fullText: item.fullText,
      })),
    },
    visibleGalleryCount,
  } satisfies IntakeProgressCheckpoint;
  enforceBound(checkpoint);
  return intakeProgressCheckpointSchema.parse(checkpoint);
}

export function createPackageIntakeCheckpoint(input: {
  selectedRootName: string | null;
  selectedFileNames: string[];
  selectedPackagePaths: string[];
  referenceFileName?: string;
  referenceMapping?: AdminReferenceMappingConfig;
}): IntakeProgressCheckpoint {
  const checkpoint = {
    version: INTAKE_CHECKPOINT_VERSION,
    kind: 'package-selection' as const,
    warning: CHECKPOINT_WARNING,
    createdAt: new Date().toISOString(),
    ...(input.selectedRootName ? { selectedRootName: input.selectedRootName } : {}),
    selectedFileNames: input.selectedFileNames,
    selectedPackagePaths: input.selectedPackagePaths,
    ...(input.referenceFileName ? { referenceFileName: input.referenceFileName } : {}),
    ...(input.referenceMapping ? { referenceMapping: input.referenceMapping } : {}),
  } satisfies IntakeProgressCheckpoint;
  enforceBound(checkpoint);
  return intakeProgressCheckpointSchema.parse(checkpoint);
}

export function parseIntakeProgressCheckpoint(input: string | unknown): IntakeProgressCheckpoint {
  if (typeof input === 'string') {
    if (new TextEncoder().encode(input).byteLength > MAX_INTAKE_CHECKPOINT_BYTES) throw new Error('The checkpoint file is too large.');
    try {
      input = JSON.parse(input) as unknown;
    } catch {
      throw new Error('The checkpoint file is not valid JSON.');
    }
  }
  enforceBound(input);
  const parsed = intakeProgressCheckpointSchema.safeParse(input);
  if (!parsed.success) throw new Error('The checkpoint format is unsupported or malformed.');
  return parsed.data;
}

export function downloadIntakeProgressCheckpoint(checkpoint: IntakeProgressCheckpoint, fileName: string): void {
  const validated = parseIntakeProgressCheckpoint(checkpoint);
  const payload = JSON.stringify(validated);
  enforceBound(validated);
  const blob = new Blob([payload], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
