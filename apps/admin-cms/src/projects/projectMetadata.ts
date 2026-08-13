import { z } from 'zod';

export const PROJECT_METADATA_LIMITS = {
  /** Public-card headings should remain compact and usable in existing layouts. */
  title: 200,
  /** Summary content is displayed in the public feed and should remain scannable. */
  summary: 1_000,
  /** Long-form public copy is capped to keep the local CMS payload bounded. */
  background: 10_000,
  solution: 10_000,
  minimumYear: 2000,
  maximumYear: 2100,
} as const;

/** PostgreSQL accepts canonical UUID text regardless of RFC version/variant bits. */
export const postgresUuidSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  'Enter a valid UUID.',
);
const normalisedText = (maximum: number, required: boolean) => z.string()
  .transform((value) => value.trim())
  .refine((value) => !required || value.length > 0, 'This field is required.')
  .refine((value) => value.length <= maximum, `Must be ${maximum} characters or fewer.`);

export const projectMetadataInputSchema = z.object({
  publicId: z.string().trim().min(1),
  title: normalisedText(PROJECT_METADATA_LIMITS.title, true),
  summary: normalisedText(PROJECT_METADATA_LIMITS.summary, true),
  background: normalisedText(PROJECT_METADATA_LIMITS.background, false),
  solution: normalisedText(PROJECT_METADATA_LIMITS.solution, false),
  year: z.string().trim().regex(/^\d{4}$/, 'Enter a four-digit year.')
    .transform((value) => Number(value))
    .refine((value) => value >= PROJECT_METADATA_LIMITS.minimumYear && value <= PROJECT_METADATA_LIMITS.maximumYear,
      `Year must be between ${PROJECT_METADATA_LIMITS.minimumYear} and ${PROJECT_METADATA_LIMITS.maximumYear}.`),
  programId: postgresUuidSchema,
  disciplineIds: z.array(postgresUuidSchema).min(1, 'Select at least one discipline.')
    .refine((ids) => new Set(ids).size === ids.length, 'Discipline selections must be unique.'),
  industryCategoryIds: z.array(postgresUuidSchema).min(1, 'Select at least one industry category.')
    .refine((ids) => new Set(ids).size === ids.length, 'Industry-category selections must be unique.'),
  expectedUpdatedAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'Expected version must be a timestamp.'),
}).strict();

export type ProjectMetadataInput = z.infer<typeof projectMetadataInputSchema>;

export type ProjectMetadataErrorCode =
  | 'VALIDATION_FAILED'
  | 'PERMISSION_DENIED'
  | 'PROJECT_NOT_FOUND'
  | 'STALE_VERSION'
  | 'APPROVAL_REOPEN_REQUIRED'
  | 'PUBLISHED_PROJECT_LOCKED'
  | 'PERSISTENCE_FAILED'
  | 'INTERNAL_FAILURE'
  | 'NO_CHANGES';

export type MetadataOption = { id: string; name: string };

export interface ProjectMetadataView {
  publicId: string;
  title: string;
  summary: string;
  background: string;
  solution: string;
  year: string;
  programId: string;
  disciplineIds: string[];
  industryCategoryIds: string[];
  expectedUpdatedAt: string;
}

export type ProjectMetadataActionResult =
  | { ok: true; metadata: ProjectMetadataView }
  | { ok: false; code: ProjectMetadataErrorCode; message: string; fieldErrors?: Record<string, string[]> };

export function metadataResultMessage(code: ProjectMetadataErrorCode): string {
  switch (code) {
    case 'STALE_VERSION':
      return 'This project changed after you opened it. Refresh and review the latest values before saving again.';
    case 'APPROVAL_REOPEN_REQUIRED': return 'This project is approved. Request changes before editing metadata.';
    case 'PUBLISHED_PROJECT_LOCKED': return 'Published project metadata is locked until a controlled revision workflow is available.';
    case 'PROJECT_NOT_FOUND':
      return 'This project is no longer available.';
    case 'PERMISSION_DENIED':
      return 'You do not have permission to edit this project.';
    case 'VALIDATION_FAILED':
      return 'Review the highlighted fields and try again.';
    default:
      return 'We could not save your changes. Please try again.';
  }
}
